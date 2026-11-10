import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveImageJobProvider } from '@/lib/image-provider-selection';
import { v4 as uuidv4 } from 'uuid';
import { syncShotPromptFromScene } from '@/lib/furniture-prompt';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { bindImageScopeToProject, assertScopeConsistency } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  isUnifiedImageAnchorProvider,
  isUnifiedImageChannelProvider,
} from '@/lib/media-core/unified-media/catalog';
import {
  LEGACY_IMAGE2_UPGRADE_MESSAGE,
  requiresLegacyImage2Upgrade,
} from '@/lib/media-core/unified-media/project-migration';
import {
  UnifiedImageRequestError,
  inferUnifiedImageOutputFromPreset,
} from '@/lib/media-core/unified-media/requests';
import { buildUnifiedImageJobContract } from '@/lib/media-core/unified-media/project-jobs';
import {
  UnifiedJobRequestConflictError,
  findUnifiedJobRequestReplay,
  normalizeUnifiedJobRequestKey,
  unifiedJobRequestHash,
} from '@/lib/media-core/unified-media/job-idempotency';


async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', id, 'write');
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const sceneSeedImageId = body.sceneSeedImageId as string;
    const scenePrompt = (body.scenePrompt as string || '').trim();
    const generationCount = Math.max(1, Math.min(9, Number(body.generationCount) || 4));

    if (!sceneSeedImageId) return NextResponse.json({ error: '缺少场景图 A' }, { status: 400 });
    if (!scenePrompt) return NextResponse.json({ error: '场景提示词不能为空' }, { status: 400 });

    // Validate project exists and is complex_product
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as {
      workflowType: string; providerId: string; model: string; size: string; quality: string; maxAttempts: number; shotPrompt: string;
    } | undefined;
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (project.workflowType !== 'complex_product') return NextResponse.json({ error: '只有复杂产品项目支持场景生成' }, { status: 400 });

    const requestedProviderId = typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : project.providerId;
    const provider = db.prepare('SELECT id, enabled, apiKey, type, model FROM providers WHERE id = ?')
      .get(requestedProviderId) as {
        id: string; enabled: number; apiKey: string; type: string; model: string;
      } | undefined;
    if (!provider) return NextResponse.json({ error: '供应商不存在' }, { status: 400 });
    if (!provider.enabled) return NextResponse.json({ error: '供应商已禁用' }, { status: 400 });
    const legacyImage2Project = requiresLegacyImage2Upgrade({
      projectProviderId: project.providerId,
      projectModel: project.model,
      requestedProviderModel: provider.model,
    });
    if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() === 'server' && legacyImage2Project) {
      return NextResponse.json({
        error: 'legacy_image2_project_requires_upgrade',
        message: LEGACY_IMAGE2_UPGRADE_MESSAGE,
      }, { status: 409 });
    }
    if ((process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local') === 'server'
      && isUnifiedImageChannelProvider(provider)
      && !isUnifiedImageAnchorProvider(provider)) {
      return NextResponse.json({
        error: '团队版新图片任务请选择统一模型“Image 2”，不能直接指定真实通道。',
      }, { status: 400 });
    }
    const unifiedProvider = isUnifiedImageAnchorProvider(provider);
    const projectUsesUnified = project.providerId === UNIFIED_IMAGE_ANCHOR_ID;
    let jobProvider: { providerId: string; model: string };
    let jobSize = project.size;
    let jobQuality = project.quality;
    let maxAttempts = Number(body.maxAttempts) || project.maxAttempts || 2;
    let unifiedRequestJson: string | null = null;
    if (unifiedProvider || projectUsesUnified) {
      if (!unifiedProvider || !projectUsesUnified || project.providerId !== requestedProviderId) {
        return NextResponse.json({ error: '统一 Image 2 项目不能绕过锚点切换到真实通道' }, { status: 400 });
      }
      if (typeof body.model === 'string' && body.model.trim() && body.model.trim() !== UNIFIED_IMAGE_MODEL_KEY) {
        return NextResponse.json({ error: '统一 Image 2 任务不能改写模型' }, { status: 400 });
      }
      const output = inferUnifiedImageOutputFromPreset(project.size);
      if (!output) return NextResponse.json({ error: '项目的 Image 2 清晰度和比例合同无效' }, { status: 400 });
      if (typeof body.aspectRatio === 'string' && body.aspectRatio !== output.ratio) {
        return NextResponse.json({ error: '场景任务不能改写项目锁定的画面比例' }, { status: 400 });
      }
      if (typeof body.resolution === 'string' && body.resolution.toLowerCase() !== output.tier) {
        return NextResponse.json({ error: '场景任务不能改写项目锁定的清晰度' }, { status: 400 });
      }
      try {
        const contract = buildUnifiedImageJobContract({
          projectSize: project.size,
          prompt: scenePrompt,
          inputImageId: sceneSeedImageId,
          referenceImageIds: [],
          referenceGuidanceMode: 'none',
        });
        jobSize = contract.size;
        jobQuality = contract.quality;
        maxAttempts = contract.maxAttempts;
        unifiedRequestJson = contract.unifiedRequestJson;
        jobProvider = { providerId: contract.providerId, model: contract.model };
      } catch (error) {
        return NextResponse.json({
          error: error instanceof UnifiedImageRequestError ? error.message : String(error),
        }, { status: 400 });
      }
    } else {
      try {
        jobProvider = resolveImageJobProvider(db, body.providerId, {
          providerId: project.providerId,
          model: project.model,
        });
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    // Validate image exists and belongs to this project or is unbound
    const img = db.prepare(`SELECT id, projectId FROM image_assets WHERE id = ?`).get(sceneSeedImageId) as { projectId: string | null } | undefined;
    if (!img) return NextResponse.json({ error: '场景图 A 不存在' }, { status: 400 });
    if (img.projectId && img.projectId !== id) return NextResponse.json({ error: '图片不属于当前项目' }, { status: 400 });
    if (access.kind === 'team') access.assertAccess('image', sceneSeedImageId, 'write');

    const creationSource = 'project_scene';
    const requestKey = normalizeUnifiedJobRequestKey(body.requestKey);
    const requestHash = unifiedJobRequestHash({
      kind: 'scene-batch',
      projectId: id,
      inputImageId: sceneSeedImageId,
      prompt: scenePrompt,
      generationCount,
      providerId: jobProvider.providerId,
      model: jobProvider.model,
      size: jobSize,
      quality: jobQuality,
      unifiedModel: unifiedRequestJson ? UNIFIED_IMAGE_MODEL_KEY : null,
    });
    const replay = findUnifiedJobRequestReplay(db, {
      projectId: id,
      requestKey,
      requestHash,
      expectedCount: generationCount,
      creationSource,
    });
    if (replay) {
      return NextResponse.json({
        success: true,
        jobCount: replay.length,
        jobIds: replay,
        replayed: true,
      });
    }

    const jobIds: string[] = [];
    db.transaction(() => {
      // Bind image to project
      db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input', usage = 'scene_seed' WHERE id = ?`).run(id, sceneSeedImageId);
      if (access.kind === 'team') {
        const owner = assertScopeConsistency(db, 'project', id).ownerUserId;
        bindImageScopeToProject(db, sceneSeedImageId, id, owner);
      }

      // Update project scenePrompt
      db.prepare(`UPDATE projects SET scenePrompt = ?, shotPrompt = ? WHERE id = ?`)
        .run(scenePrompt, syncShotPromptFromScene(scenePrompt, project.shotPrompt || ''), id);

      // Create scene generation jobs：同一请求写同一 createdAt、按提交顺序写 creationIndex。
      const batchCreatedAt = new Date().toISOString();
      const insertJob = db.prepare(`
        INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex, unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource, creationRequestKey, creationRequestHash)
        VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, 'pending', 0, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let g = 0; g < generationCount; g++) {
        const jobId = uuidv4();
        insertJob.run(
          jobId, id, sceneSeedImageId, jobProvider.providerId, jobProvider.model, scenePrompt,
          jobSize, jobQuality, maxAttempts, batchCreatedAt, g,
          unifiedRequestJson ? UNIFIED_IMAGE_MODEL_KEY : null,
          unifiedRequestJson ? UNIFIED_MEDIA_RULE_VERSION : null,
          unifiedRequestJson,
          creationSource,
          requestKey,
          requestHash,
        );
        access.registerInheritedScope({
          resourceType: 'job', resourceId: jobId,
          parent: { resourceType: 'project', resourceId: id },
        });
        access.registerTaskPrincipal({
          module: 'image', taskId: jobId,
          scope: { resourceType: 'project', resourceId: id },
          creationSnapshot: {
            inputImageId: sceneSeedImageId, model: jobProvider.model, creationIndex: g,
            ...(unifiedRequestJson ? {
              unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
              unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
            } : {}),
          },
        });
        jobIds.push(jobId);
      }
    }).immediate();

    return NextResponse.json({ success: true, jobCount: jobIds.length, jobIds, replayed: false });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: err instanceof UnifiedJobRequestConflictError || err instanceof UnifiedImageRequestError ? 409 : 500 },
    );
  }
}
export const POST = withTeamRoute('/api/projects/[id]/scene-jobs', 'POST', __teamRoutePOST);
