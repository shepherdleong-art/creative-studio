import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { resolveGptImage2Size, isValidGptImage2Size } from '@/lib/gpt-image-2-size-presets';

export async function GET() {
  try {
    const db = getDb();
    const projects = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id) as totalJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'succeeded') as completedJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'failed') as failedJobs,
        (SELECT COALESCE(SUM(estimatedCost), 0) FROM jobs WHERE projectId = p.id) as totalCost
      FROM projects p
      ORDER BY p.createdAt DESC
    `).all();
    return NextResponse.json(projects);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const workflowType = body.workflowType || 'complex_product';

    // Validate provider
    const provider = db.prepare(`SELECT id, enabled, apiKey, apiKeyEnv, type FROM providers WHERE id = ?`).get(body.providerId) as {
      id: string; enabled: number; apiKey: string; apiKeyEnv: string; type: string;
    } | undefined;
    if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 400 });
    if (!provider.enabled) return NextResponse.json({ error: 'Provider is disabled' }, { status: 400 });
    if (!provider.apiKey && !process.env[provider.apiKeyEnv]) return NextResponse.json({ error: 'Provider API key is not configured' }, { status: 400 });

    // Resolve size
    let resolvedSize: string;
    if (body.aspectRatio) {
      try { resolvedSize = resolveGptImage2Size(body.aspectRatio, body.resolution || '1k'); }
      catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }); }
    } else if (body.size && isValidGptImage2Size(body.size)) {
      resolvedSize = body.size;
    } else {
      return NextResponse.json({ error: `Invalid size: "${body.size || '(missing)'}"` }, { status: 400 });
    }

    const projectId = uuidv4();
    const model = body.model || 'gpt-image-2';
    const quality = body.quality || 'medium';
    const timeoutMs = body.timeoutMs || 600000;
    const maxAttempts = body.maxAttempts || 2;
    const concurrency = body.concurrency || 3;

    if (workflowType === 'legacy_batch_edit') {
      // ── Legacy: batch edit with reference + input images ──
      const prompt = body.prompt?.trim();
      if (!prompt) return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });

      db.prepare(`
        INSERT INTO projects (id, name, providerId, model, prompt, negativePrompt, size, quality, concurrency, maxAttempts, status, referenceGuidanceMode, timeoutMs, workflowType)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(projectId, body.name, body.providerId, model, prompt, body.negativePrompt || '',
        resolvedSize, quality, concurrency, maxAttempts, 'none', timeoutMs, 'legacy_batch_edit');

      const referenceImageIds: string[] = body.referenceImageIds || [];
      const inputImageIds: string[] = body.inputImageIds || [];

      if (referenceImageIds.length > 0) {
        const ph = referenceImageIds.map(() => '?').join(',');
        db.prepare(`UPDATE image_assets SET projectId = ?, role = 'reference' WHERE id IN (${ph})`).run(projectId, ...referenceImageIds);
      }

      if (inputImageIds.length > 0) {
        const refIdsJson = JSON.stringify(referenceImageIds);
        const count = Math.max(1, Math.min(10, Number(body.generationCount) || 1));
        const updateAsset = db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`);
        const insertJob = db.prepare(`
          INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        `);
        for (const imageId of inputImageIds) {
          updateAsset.run(projectId, imageId);
          for (let g = 0; g < count; g++) {
            insertJob.run(uuidv4(), projectId, imageId, refIdsJson, body.providerId, model, prompt, resolvedSize, quality, maxAttempts, 'none');
          }
        }
      }

      return NextResponse.json({ id: projectId, workflowType: 'legacy_batch_edit' });
    }

    // ── Complex product workflow ──
    const sceneSeedImageId: string = body.sceneSeedImageId;
    const scenePrompt: string = (body.scenePrompt || '').trim();
    const shotImageIds: string[] = body.shotImageIds || [];
    const shotPrompt: string = (body.shotPrompt || '').trim();
    const generationCount = Math.max(1, Math.min(9, Number(body.generationCount) || 4));

    if (!sceneSeedImageId) return NextResponse.json({ error: '场景图 A 不能为空' }, { status: 400 });
    if (!scenePrompt) return NextResponse.json({ error: '场景生成提示词不能为空' }, { status: 400 });
    if (shotImageIds.length === 0) return NextResponse.json({ error: '至少需要 1 张原始分镜图' }, { status: 400 });
    if (shotImageIds.length > 9) return NextResponse.json({ error: '分镜图最多 9 张' }, { status: 400 });

    db.transaction(() => {
      // Create project
      db.prepare(`
        INSERT INTO projects (id, name, productName, productCode, productCategory, providerId, model, prompt, negativePrompt, size, quality, concurrency, maxAttempts, status, referenceGuidanceMode, timeoutMs, workflowType, scenePrompt, shotPrompt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(projectId, body.name || '', body.productName || '', body.productCode || '', body.category || '',
        body.providerId, model, scenePrompt, '', resolvedSize, quality, concurrency, maxAttempts, 'none', timeoutMs, 'complex_product',
        scenePrompt, shotPrompt);

      // Bind scene seed image
      db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`).run(projectId, sceneSeedImageId);

      // Bind shot source images
      for (const imgId of shotImageIds) {
        db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`).run(projectId, imgId);
      }

      // Create scene B generation jobs (scene seed → scene candidates, no reference)
      const insertJob = db.prepare(`
        INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode)
        VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, 'pending', 0, ?, 'none')
      `);
      for (let g = 0; g < generationCount; g++) {
        insertJob.run(uuidv4(), projectId, sceneSeedImageId, body.providerId, model, scenePrompt, resolvedSize, quality, maxAttempts);
      }

      // Create draft ShotSet
      const setId = uuidv4();
      db.prepare(`INSERT INTO shot_sets (id, projectId, name, productCode, category) VALUES (?, ?, ?, ?, ?)`).run(setId, projectId, body.name || '默认分镜组', body.productCode || '', body.category || '');
      const insertShot = db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)`);
      shotImageIds.forEach((imgId, i) => insertShot.run(uuidv4(), setId, i + 1, imgId));

      // Save product brief as JSON field (simple approach)
      const brief = {
        targetAudience: body.targetAudience || '',
        tone: body.tone || '种草',
        platform: body.platform || '通用',
        sellingPoints: body.sellingPoints || [],
      };
      // Store brief in project record via a comment/summary field (use a separate table later if needed)
      // For now, attach to shotSet as metadata
      db.prepare(`UPDATE shot_sets SET category = ? WHERE id = ?`).run(JSON.stringify(brief), setId);
    })();

    return NextResponse.json({ id: projectId, workflowType: 'complex_product' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
