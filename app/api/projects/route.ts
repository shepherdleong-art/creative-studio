import { NextRequest, NextResponse } from 'next/server';
import { syncShotPromptFromScene } from '@/lib/furniture-prompt';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { resolveGptImage2Size, isValidGptImage2Size } from '@/lib/gpt-image-2-size-presets';
import { validateImageAspectRatio, validateImageResolution, validateImagePresetSize } from '@/lib/image-generation-settings';
import { isPlaceholderValue } from '@/lib/video-auth';
import { toStorageImageUrl } from '@/lib/storage-url';
import { normalizeShotImageIds } from '@/lib/shot-set-domain';
import { getUsageSchemaReadiness } from '@/lib/usage-schema';
import { reconcileUsageLedger } from '@/lib/usage-ledger';
import { sumUsageCostByProject } from '@/lib/usage-query';
import {
  parseProductionIdentityInput,
  buildProjectBaseName,
  formatShanghaiIdentityDate,
  resolveUniqueProjectBaseName,
} from '@/lib/project-production-identity';
import { ProjectInfoValidationError } from '@/lib/project-info';
import { requireAccessContext, type ResourceAccessContext } from '@/lib/media-core/access-context';
import { bindImageScopeToProject } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { productionParamsFor } from '@/lib/team-service/production-defaults';
import {
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  isUnifiedImageChannelProvider,
  isUnifiedImageAnchorProvider,
} from '@/lib/media-core/unified-media/catalog';
import {
  UnifiedImageRequestError,
  freezeUnifiedImageRequest,
  resolveUnifiedImageOutput,
} from '@/lib/media-core/unified-media/requests';


function isRealApiKey(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  return !!trimmed && !isPlaceholderValue(trimmed);
}

function bindProjectImage(
  db: ReturnType<typeof getDb>,
  imageId: string,
  projectId: string,
  role: 'input',
  access: ResourceAccessContext,
  ownerUserId: string,
) {
  const result = db.prepare(`
    UPDATE image_assets
    SET projectId = ?, role = ?
    WHERE id = ? AND (projectId IS NULL OR projectId = ?)
  `).run(projectId, role, imageId, projectId);
  if (result.changes !== 1) {
    throw new Error(`Image asset is not available for this project: ${imageId}`);
  }
  if (access.kind === 'team') bindImageScopeToProject(db, imageId, projectId, ownerUserId);
}

async function __teamRouteGET() {
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
    const access = requireAccessContext();
    const visibility = access.kind === 'local'
      ? { sql: '', params: [] }
      : {
          sql: `WHERE EXISTS (
            SELECT 1 FROM team_resource_scopes scope
            WHERE scope.resourceType = 'project' AND scope.resourceId = p.id
              AND scope.deletedAt IS NULL ${access.actor.role === 'admin' ? '' : 'AND scope.ownerUserId = ?'}
          )`,
          params: access.actor.role === 'admin' ? [] : [access.actor.userId],
        };
    const thumbnailLifecycle = access.kind === 'local' ? '' : `AND EXISTS (
      SELECT 1 FROM team_resource_scopes scope
      WHERE scope.resourceType = 'image' AND scope.resourceId = image_assets.id
        AND scope.deletedAt IS NULL
    )`;
    const projects = (db.prepare(`
      SELECT p.*,
        -- 任务计数 = 图片任务 + 视频任务，与下方金额的全口径（usage ledger 含视频/LLM/TTS）保持一致
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id)
          + (SELECT COUNT(*) FROM video_jobs WHERE projectId = p.id) as totalJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'succeeded')
          + (SELECT COUNT(*) FROM video_jobs WHERE projectId = p.id AND status = 'succeeded') as completedJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'failed')
          + (SELECT COUNT(*) FROM video_jobs WHERE projectId = p.id AND status = 'failed') as failedJobs,
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
          ${thumbnailLifecycle}
        )
        WHERE rn = 1
      ) thumb ON thumb.projectId = p.id
      ${visibility.sql}
      ORDER BY COALESCE(p.lastOpenedAt, p.createdAt) DESC
    `).all(...visibility.params) as Array<Record<string, unknown>>).map((project) => {
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

async function __teamRoutePOST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();

    // ── 生产身份：新项目只填写身份字段，项目名/日期由服务端生成，客户端 name 一律忽略 ──
    let identity;
    try {
      identity = parseProductionIdentityInput(body);
    } catch (err) {
      if (err instanceof ProjectInfoValidationError) {
        return NextResponse.json({ error: 'invalid_project_info', message: err.message }, { status: 400 });
      }
      throw err;
    }
    const namingDate = formatShanghaiIdentityDate(new Date());
    const baseName = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...identity, namingDate }));

    // Validate provider
    const provider = db.prepare(`SELECT id, enabled, apiKey, apiKeyEnv, type, model FROM providers WHERE id = ?`).get(body.providerId) as {
      id: string; enabled: number; apiKey: string; apiKeyEnv: string; type: string; model: string;
    } | undefined;
    if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 400 });
    if (!provider.enabled) return NextResponse.json({ error: 'Provider is disabled' }, { status: 400 });
    const unifiedProvider = isUnifiedImageAnchorProvider(provider);
    if (readRuntimeConfig().mode === 'server' && isUnifiedImageChannelProvider(provider)) {
      return NextResponse.json({
        error: '团队版新建项目请选择统一模型“Image 2”，不能直接指定真实通道。',
      }, { status: 400 });
    }
    if (!unifiedProvider && !isRealApiKey(provider.apiKey)) {
      return NextResponse.json({ error: 'Provider API key is not configured' }, { status: 400 });
    }

    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : '';
    const model = unifiedProvider
      ? UNIFIED_IMAGE_MODEL_KEY
      : (requestedModel || 'gpt-image-2');

    // Resolve size. The selected ratio is part of the generation contract; reject
    // unsupported company-gateway ratios instead of silently snapping to another ratio.
    let resolvedSize: string;
    if (unifiedProvider) {
      if (readRuntimeConfig().mode !== 'server') {
        return NextResponse.json({ error: '统一 Image 2 仅在团队模式可用' }, { status: 400 });
      }
      if (requestedModel && requestedModel !== UNIFIED_IMAGE_MODEL_KEY) {
        return NextResponse.json({ error: '统一 Image 2 项目不能改写模型' }, { status: 400 });
      }
      if (typeof body.aspectRatio !== 'string' || typeof body.resolution !== 'string') {
        return NextResponse.json({ error: '统一 Image 2 必须同时提供画面比例和清晰度' }, { status: 400 });
      }
      try {
        resolvedSize = resolveUnifiedImageOutput(body.resolution, body.aspectRatio).size;
      } catch (error) {
        return NextResponse.json({
          error: error instanceof UnifiedImageRequestError ? error.message : String(error),
        }, { status: 400 });
      }
    } else {
      if (typeof body.aspectRatio === 'string') {
        const aspectRatioError = validateImageAspectRatio(model, body.aspectRatio);
        if (aspectRatioError) return NextResponse.json({ error: aspectRatioError }, { status: 400 });
      }
      if (body.aspectRatio) {
        const resolutionError = validateImageResolution(model, body.aspectRatio, body.resolution || '1k');
        if (resolutionError) return NextResponse.json({ error: resolutionError }, { status: 400 });
        try { resolvedSize = resolveGptImage2Size(body.aspectRatio, body.resolution || '1k'); }
        catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }); }
      } else if (body.size && isValidGptImage2Size(body.size)) {
        resolvedSize = body.size;
      } else {
        return NextResponse.json({ error: `Invalid size: "${body.size || '(missing)'}"` }, { status: 400 });
      }
    }

    const sizeError = unifiedProvider ? null : validateImagePresetSize(model, resolvedSize);
    if (sizeError) return NextResponse.json({ error: sizeError }, { status: 400 });

    const projectId = uuidv4();
    const access = requireAccessContext();
    const ownerUserId = access.resolveOwner(body.ownerUserId);
    const quality = unifiedProvider ? 'auto' : (body.quality || 'medium');
    // ── 生产参数：server 模式一律取服务器默认值（请求里的同名字段作废）；本地版沿用请求值 ──
    const production = productionParamsFor(readRuntimeConfig(), body);
    const timeoutMs = production.timeoutMs;
    const maxAttempts = unifiedProvider ? 1 : (body.maxAttempts || 2);
    const concurrency = production.projectConcurrency;

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
    let unifiedRequestJson: string | null = null;
    if (unifiedProvider && hasFullCreation) {
      try {
        const output = resolveUnifiedImageOutput(body.resolution, body.aspectRatio);
        unifiedRequestJson = JSON.stringify(freezeUnifiedImageRequest({
          inputImageId: sceneSeedImageId,
          referenceImageIds: [],
          prompt: scenePrompt,
          tier: output.tier,
          ratio: output.ratio,
          referenceGuidanceMode: 'none',
        }));
      } catch (error) {
        return NextResponse.json({
          error: error instanceof UnifiedImageRequestError ? error.message : String(error),
        }, { status: 400 });
      }
    }

    const defaultScenePrompt = '保持图中床的一致性不变，更换其他家具和软装布置，风格跟原图差别较大，让卧室温馨舒适，全景图';
    const defaultShotPrompt = `图1是待编辑分镜图，是本次修改的主要对象。
图2是场景参考图。
参考图2，修改图1，保持图中床和模特的一致性不变，更换卧室的其他家具和软装布置，构图和机位景别严格参考图1。`;

    db.transaction(() => {
      // Create project shell：项目名由服务端按生产身份生成，旧 productName/productCategory 不写入。
      db.prepare(`
        INSERT INTO projects (id, name, productName, productCode, productCategory, providerId, model, prompt, negativePrompt, size, quality, concurrency, videoConcurrency, maxAttempts, status, referenceGuidanceMode, timeoutMs, workflowType, scenePrompt, shotPrompt, storeCode, productSubmodel, productionType, editorName, namingDate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, baseName, '', identity.productCode, '', body.providerId, model, '', '', resolvedSize, quality, concurrency, production.videoConcurrency, maxAttempts, 'draft', 'none', timeoutMs, 'complex_product',
        scenePrompt || defaultScenePrompt, syncShotPromptFromScene(scenePrompt || defaultScenePrompt, shotPrompt || defaultShotPrompt),
        identity.storeCode, identity.productSubmodel, identity.productionType, identity.editorName, namingDate);
      access.registerRootScope({ resourceType: 'project', resourceId: projectId, ownerUserId, visibility: 'private' });

      if (hasFullCreation) {
        bindProjectImage(db, sceneSeedImageId, projectId, 'input', access, ownerUserId);

        for (const imgId of shotImageIds) {
          bindProjectImage(db, imgId, projectId, 'input', access, ownerUserId);
        }

        // Create scene generation jobs：同一请求写同一 createdAt、按提交顺序写 creationIndex。
        const batchCreatedAt = new Date().toISOString();
        const insertJob = db.prepare(`
          INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex, unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource)
          VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, 'pending', 0, ?, 'none', ?, ?, ?, ?, ?, 'project_scene')
        `);
        for (let g = 0; g < genCount; g++) {
          const jobId = uuidv4();
          insertJob.run(
            jobId, projectId, sceneSeedImageId, body.providerId, model, scenePrompt,
            resolvedSize, quality, maxAttempts, batchCreatedAt, g,
            unifiedProvider ? UNIFIED_IMAGE_MODEL_KEY : null,
            unifiedProvider ? UNIFIED_MEDIA_RULE_VERSION : null,
            unifiedRequestJson,
          );
          access.registerInheritedScope({
            resourceType: 'job', resourceId: jobId,
            parent: { resourceType: 'project', resourceId: projectId },
          });
          access.registerTaskPrincipal({
            module: 'image', taskId: jobId,
            scope: { resourceType: 'project', resourceId: projectId },
            creationSnapshot: {
              inputImageId: sceneSeedImageId, model, creationIndex: g,
              ...(unifiedProvider ? {
                unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
                unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
              } : {}),
            },
          });
        }

        // Create draft ShotSet
        const setId = uuidv4();
        db.prepare(`INSERT INTO shot_sets (id, projectId, name, productCode, category) VALUES (?, ?, ?, ?, '')`).run(setId, projectId, baseName, identity.productCode);
        access.registerInheritedScope({
          resourceType: 'shot_set', resourceId: setId,
          parent: { resourceType: 'project', resourceId: projectId },
        });
        const insertShot = db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)`);
        shotImageIds.forEach((imgId, i) => {
          const shotId = uuidv4();
          insertShot.run(shotId, setId, i + 1, imgId);
          access.registerInheritedScope({
            resourceType: 'shot', resourceId: shotId,
            parent: { resourceType: 'shot_set', resourceId: setId },
          });
        });
      }
    }).immediate();

    return NextResponse.json({ id: projectId, workflowType: 'complex_product', name: baseName });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const GET = withTeamRoute('/api/projects', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/projects', 'POST', __teamRoutePOST);
