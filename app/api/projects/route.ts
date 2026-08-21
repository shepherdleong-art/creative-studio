import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { resolveGptImage2Size, isValidGptImage2Size } from '@/lib/gpt-image-2-size-presets';
import { isPlaceholderValue } from '@/lib/video-auth';
import { toStorageImageUrl } from '@/lib/storage-url';
import { normalizeShotImageIds } from '@/lib/shot-set-domain';
import { getUsageSchemaReadiness } from '@/lib/usage-schema';
import { reconcileUsageLedger } from '@/lib/usage-ledger';
import { sumUsageCostByProject } from '@/lib/usage-query';

function isRealApiKey(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  return !!trimmed && !isPlaceholderValue(trimmed);
}

function bindProjectImage(db: ReturnType<typeof getDb>, imageId: string, projectId: string, role: 'input') {
  const result = db.prepare(`
    UPDATE image_assets
    SET projectId = ?, role = ?
    WHERE id = ? AND (projectId IS NULL OR projectId = ?)
  `).run(projectId, role, imageId, projectId);
  if (result.changes !== 1) {
    throw new Error(`Image asset is not available for this project: ${imageId}`);
  }
}

export async function GET() {
  try {
    const db = getDb();
    // 项目总成本以 usage ledger 为准（覆盖图片/视频/脚本/TTS 的核心模型用量）；
    // ledger 不可用或项目无 ledger 记录时回退旧的 jobs.estimatedCost 图片成本，
    // 消耗统计故障不得拖垮项目列表。
    let usageCostByProject: Map<string, number> | null = null;
    try {
      if (getUsageSchemaReadiness(db).available && reconcileUsageLedger(db).reason !== 'schema_unavailable') {
        usageCostByProject = sumUsageCostByProject(db);
      }
    } catch {
      usageCostByProject = null;
    }
    const projects = (db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id) as totalJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'succeeded') as completedJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'failed') as failedJobs,
        (SELECT COALESCE(SUM(estimatedCost), 0) FROM jobs WHERE projectId = p.id) as totalCost,
        thumb.path as thumbnailPath
      FROM projects p
      LEFT JOIN (
        SELECT projectId, path
        FROM (
          SELECT
            projectId,
            path,
            ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY createdAt ASC) as rn
          FROM image_assets
          WHERE role = 'output' AND usage = 'scene_gen'
        )
        WHERE rn = 1
      ) thumb ON thumb.projectId = p.id
      ORDER BY p.createdAt DESC
    `).all() as Array<Record<string, unknown>>).map((project) => {
      const thumbnailPath = typeof project.thumbnailPath === 'string' ? project.thumbnailPath : '';
      const legacyCostMicros = Math.round(Number(project.totalCost || 0) * 1_000_000);
      const usageCostMicros = usageCostByProject?.get(String(project.id)) ?? 0;
      const rest = { ...project };
      delete rest.thumbnailPath;
      return {
        ...rest,
        totalUsageCostMicros: usageCostMicros > 0 ? usageCostMicros : legacyCostMicros,
        thumbnailImageUrl: toStorageImageUrl(thumbnailPath),
      };
    });
    return NextResponse.json(projects);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Image asset is not available for this project:') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();

    // Validate provider
    const provider = db.prepare(`SELECT id, enabled, apiKey, apiKeyEnv, type FROM providers WHERE id = ?`).get(body.providerId) as {
      id: string; enabled: number; apiKey: string; apiKeyEnv: string; type: string;
    } | undefined;
    if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 400 });
    if (!provider.enabled) return NextResponse.json({ error: 'Provider is disabled' }, { status: 400 });
    if (!isRealApiKey(provider.apiKey)) return NextResponse.json({ error: 'Provider API key is not configured' }, { status: 400 });

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

    // ── Complex product workflow ──
    const sceneSeedImageId: string | undefined = body.sceneSeedImageId;
    const scenePrompt: string = (body.scenePrompt || '').trim();
    // 这条路径历史上既不去重也不限张数,和独立建组接口不一致。统一走共享
    // 领域函数;allowEmpty 覆盖「新建空项目根本不发 shotImageIds」的情况
    // (见 app/projects/new/page.tsx)。
    const normalizedShotImageIds = normalizeShotImageIds(body.shotImageIds, { allowEmpty: true });
    if (!normalizedShotImageIds.ok) {
      return NextResponse.json({ error: normalizedShotImageIds.error }, { status: 400 });
    }
    const shotImageIds = normalizedShotImageIds.ids;
    const shotPrompt: string = (body.shotPrompt || '').trim();
    const genCount = Math.max(1, Math.min(9, Number(body.generationCount) || 4));
    const hasFullCreation = sceneSeedImageId && scenePrompt && shotImageIds.length > 0;

    const defaultScenePrompt = '保持图中床的一致性不变，更换其他家具和软装布置，风格参考原图，让卧室温馨舒适，全景图';
    const defaultShotPrompt = `图1 是待编辑分镜图，是本次修改的主要对象。
图2 是场景参考图。
参考图2，修改图1，保持图中床和模特的一致性不变，更换卧室的其他家具和软装布置，构图参考图1。`;

    db.transaction(() => {
      // Create project shell
      db.prepare(`
        INSERT INTO projects (id, name, productName, productCode, productCategory, providerId, model, prompt, negativePrompt, size, quality, concurrency, maxAttempts, status, referenceGuidanceMode, timeoutMs, workflowType, scenePrompt, shotPrompt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(projectId, body.name || '', body.productName || '', body.productCode || '', body.category || '',
        body.providerId, model, '', '', resolvedSize, quality, concurrency, maxAttempts, 'none', timeoutMs, 'complex_product',
        scenePrompt || defaultScenePrompt, shotPrompt || defaultShotPrompt);

      if (hasFullCreation) {
        bindProjectImage(db, sceneSeedImageId, projectId, 'input');

        for (const imgId of shotImageIds) {
          bindProjectImage(db, imgId, projectId, 'input');
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
