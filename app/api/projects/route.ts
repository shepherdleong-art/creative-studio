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
    const sceneSeedImageId: string | undefined = body.sceneSeedImageId;
    const scenePrompt: string = (body.scenePrompt || '').trim();
    const shotImageIds: string[] = body.shotImageIds || [];
    const shotPrompt: string = (body.shotPrompt || '').trim();
    const genCount = Math.max(1, Math.min(9, Number(body.generationCount) || 4));
    const hasFullCreation = sceneSeedImageId && scenePrompt && shotImageIds.length > 0;

    const defaultScenePrompt = '基于图1生成新的室内产品场景图。保留适合家居产品展示的空间关系，重构墙面、软装、灯光、窗帘、地面和整体氛围，使画面更适合电商生活方式图。不要添加文字。';
    const defaultShotPrompt = `图1 是待编辑分镜图，是本次修改的主要对象。
图2 是场景参考图。
请参考图2的空间风格、光线、墙面、软装和布置，重绘图1的场景。
保持图1中的产品结构、模特姿态、主体位置和画面构图尽量一致。`;

    db.transaction(() => {
      // Create project shell
      db.prepare(`
        INSERT INTO projects (id, name, productName, productCode, productCategory, providerId, model, prompt, negativePrompt, size, quality, concurrency, maxAttempts, status, referenceGuidanceMode, timeoutMs, workflowType, scenePrompt, shotPrompt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(projectId, body.name || '', body.productName || '', body.productCode || '', body.category || '',
        body.providerId, model, '', '', resolvedSize, quality, concurrency, maxAttempts, 'none', timeoutMs, 'complex_product',
        scenePrompt || defaultScenePrompt, shotPrompt || defaultShotPrompt);

      if (hasFullCreation) {
        // Bind scene seed image
        db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`).run(projectId, sceneSeedImageId);

        // Bind shot source images
        for (const imgId of shotImageIds) {
          db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`).run(projectId, imgId);
        }

        // Create scene generation jobs
        const insertJob = db.prepare(`
          INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode)
          VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, 'pending', 0, ?, 'none')
        `);
        for (let g = 0; g < genCount; g++) {
          insertJob.run(uuidv4(), projectId, sceneSeedImageId, body.providerId, model, scenePrompt, resolvedSize, quality, maxAttempts);
        }

        // Create draft ShotSet
        const setId = uuidv4();
        db.prepare(`INSERT INTO shot_sets (id, projectId, name, productCode, category) VALUES (?, ?, ?, ?, ?)`).run(setId, projectId, body.name || '默认分镜组', body.productCode || '', body.category || '');
        const insertShot = db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)`);
        shotImageIds.forEach((imgId, i) => insertShot.run(uuidv4(), setId, i + 1, imgId));
      }
    })();

    return NextResponse.json({ id: projectId, workflowType: 'complex_product' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
