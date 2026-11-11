import { requiresReassembledUpstreamRework, REASSEMBLED_REWORK_REQUIRED } from '@/lib/reassembled-shot-guard';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveImageJobProvider } from '@/lib/image-provider-selection';
import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_MODEL_KEY,
  isUnifiedImageAnchorProvider,
  isUnifiedImageChannelProvider,
} from '@/lib/media-core/unified-media/catalog';
import {
  LEGACY_IMAGE2_UPGRADE_MESSAGE,
  requiresLegacyImage2Upgrade,
} from '@/lib/media-core/unified-media/project-migration';
import {
  buildUnifiedImageJobContract,
  isUnifiedImageJobProvider,
} from '@/lib/media-core/unified-media/project-jobs';
import { UnifiedImageRequestError } from '@/lib/media-core/unified-media/requests';
import {
  UnifiedJobRequestConflictError,
  findUnifiedJobRequestReplay,
  normalizeUnifiedJobRequestKey,
  unifiedJobRequestHash,
} from '@/lib/media-core/unified-media/job-idempotency';
import { v4 as uuidv4 } from 'uuid';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('shot_set', id, 'write');
    if (requiresReassembledUpstreamRework(db, id)) return NextResponse.json({ error: REASSEMBLED_REWORK_REQUIRED }, { status: 409 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const sceneReferenceId = body.sceneReferenceId as string;
    const promptTemplate = (body.prompt as string)?.trim();

    if (!sceneReferenceId) return NextResponse.json({ error: '缺少场景参考图' }, { status: 400 });
    if (!promptTemplate) return NextResponse.json({ error: '缺少提示词' }, { status: 400 });

    // Validate shot set
    const set = db.prepare(`SELECT ss.*, p.providerId, p.model, p.size, p.quality, p.maxAttempts FROM shot_sets ss JOIN projects p ON ss.projectId = p.id WHERE ss.id = ?`).get(id) as {
      projectId: string; status: string; kind?: string; providerId: string; model: string; size: string; quality: string; maxAttempts: number;
    } | undefined;
    if (!set) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });
    // 自由素材工位没有「用场景参考图重绘分镜图」这个动作。前端已经不展示
    // 入口,这里是服务端兜底:直接打接口不能把自由工位推进 generating。
    if (set.kind === 'free') {
      return NextResponse.json({ error: '自由素材工位不支持分镜生成' }, { status: 400 });
    }

    const requestedProviderId = typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : set.providerId;
    const requestedProvider = db.prepare(`
      SELECT id, name, type, model, enabled, apiKey
      FROM providers WHERE id = ?
    `).get(requestedProviderId) as {
      id: string; name: string; type: string; model: string; enabled: number; apiKey: string;
    } | undefined;
    if (!requestedProvider) return NextResponse.json({ error: '供应商不存在' }, { status: 400 });
    if (!requestedProvider.enabled) return NextResponse.json({ error: '供应商已禁用' }, { status: 400 });
    const legacyImage2Set = requiresLegacyImage2Upgrade({
      projectProviderId: set.providerId,
      projectModel: set.model,
      requestedProviderModel: requestedProvider.model,
    });
    if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() === 'server' && legacyImage2Set) {
      return NextResponse.json({
        error: 'legacy_image2_project_requires_upgrade',
        message: LEGACY_IMAGE2_UPGRADE_MESSAGE,
      }, { status: 409 });
    }
    if ((process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local') === 'server'
      && isUnifiedImageChannelProvider(requestedProvider)
      && !isUnifiedImageAnchorProvider(requestedProvider)) {
      return NextResponse.json({
        error: '团队版新图片任务请选择统一模型“Image 2”，不能直接指定真实通道。',
      }, { status: 400 });
    }

    const projectUsesUnified = set.providerId === UNIFIED_IMAGE_ANCHOR_ID
      && set.model === UNIFIED_IMAGE_MODEL_KEY;
    const unifiedImage = isUnifiedImageJobProvider(requestedProvider);
    if (unifiedImage !== projectUsesUnified) {
      return NextResponse.json({
        error: '统一 Image 2 项目不能绕过锚点切换到真实通道，真实通道项目也不能注入统一模型',
      }, { status: 400 });
    }

    let jobProvider: { providerId: string; model: string };
    if (unifiedImage) {
      jobProvider = { providerId: UNIFIED_IMAGE_ANCHOR_ID, model: UNIFIED_IMAGE_MODEL_KEY };
    } else {
      try {
        jobProvider = resolveImageJobProvider(db, body.providerId, {
          providerId: set.providerId,
          model: set.model,
        });
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    // Validate scene reference
    const sceneRef = db.prepare(`
      SELECT sr.imageAssetId, ia.projectId AS imageProjectId
      FROM scene_references sr
      JOIN image_assets ia ON ia.id = sr.imageAssetId
      WHERE sr.id = ? AND sr.projectId = ?
    `).get(sceneReferenceId, set.projectId) as {
      imageAssetId: string;
      imageProjectId: string | null;
    } | undefined;
    if (!sceneRef || (sceneRef.imageProjectId && sceneRef.imageProjectId !== set.projectId)) {
      return NextResponse.json({ error: '场景参考图不存在或不属于当前项目' }, { status: 400 });
    }
    if (access.kind === 'team') access.assertAccess('image', sceneRef.imageAssetId, 'read');

    // Get shots for this set
    const shots = db.prepare(`
      SELECT s.*, ia.projectId AS imageProjectId
      FROM shots s
      LEFT JOIN image_assets ia ON ia.id = s.sourceImageId
      WHERE s.shotSetId = ?
      ORDER BY s.indexNum
    `).all(id) as Array<{ id: string; sourceImageId: string; imageProjectId: string | null }>;
    if (shots.length === 0) return NextResponse.json({ error: '分镜组没有分镜图' }, { status: 400 });
    if (shots.some((shot) => shot.imageProjectId && shot.imageProjectId !== set.projectId)) {
      return NextResponse.json({ error: '分镜素材不属于当前项目，已拒绝生成' }, { status: 400 });
    }
    if (access.kind === 'team') {
      for (const shot of shots) access.assertAccess('image', shot.sourceImageId, 'read');
    }

    const creationSource = 'project_apply_scene';
    const requestKey = normalizeUnifiedJobRequestKey(body.requestKey);
    const requestHash = unifiedJobRequestHash({
      kind: 'apply-scene',
      projectId: set.projectId,
      shotSetId: id,
      sceneReferenceId,
      prompt: promptTemplate,
      providerId: jobProvider.providerId,
      model: jobProvider.model,
      shotIds: shots.map((shot) => shot.id),
      sourceImageIds: shots.map((shot) => shot.sourceImageId),
      unifiedImage,
    });
    const replay = findUnifiedJobRequestReplay(db, {
      projectId: set.projectId,
      requestKey,
      requestHash,
      expectedCount: shots.length,
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

    // ── Create one job per shot：同一请求写同一 createdAt、按分镜顺序写 creationIndex ──
    const createdJobs: string[] = [];
    db.transaction(() => {
      const batchCreatedAt = new Date().toISOString();
      const insertJob = db.prepare(`
        INSERT INTO jobs (
          id, projectId, inputImageId, referenceImageIds, providerId, model,
          prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex,
          unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource,
          creationRequestKey, creationRequestHash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      shots.forEach((shot, index) => {
        const jobId = uuidv4();
        const unifiedContract = unifiedImage
          ? buildUnifiedImageJobContract({
            projectSize: set.size,
            prompt: promptTemplate,
            inputImageId: shot.sourceImageId,
            referenceImageIds: [sceneRef.imageAssetId],
            referenceGuidanceMode: 'none',
          })
          : null;
        insertJob.run(
          jobId, set.projectId, shot.sourceImageId,
          JSON.stringify([sceneRef.imageAssetId]),
          jobProvider.providerId, jobProvider.model, promptTemplate,
          unifiedContract?.size ?? set.size,
          unifiedContract?.quality ?? set.quality,
          unifiedContract?.maxAttempts ?? (set.maxAttempts || 2),
          batchCreatedAt, index,
          unifiedContract?.unifiedModel ?? null,
          unifiedContract?.unifiedRuleVersion ?? null,
          unifiedContract?.unifiedRequestJson ?? null,
          creationSource,
          requestKey,
          requestHash,
        );
        db.prepare(`UPDATE shots SET latestJobId = ? WHERE id = ?`).run(jobId, shot.id);
        access.registerInheritedScope({
          resourceType: 'job', resourceId: jobId,
          parent: { resourceType: 'project', resourceId: set.projectId },
        });
        access.registerTaskPrincipal({
          module: 'image', taskId: jobId,
          scope: { resourceType: 'project', resourceId: set.projectId },
          creationSnapshot: {
            shotId: shot.id,
            sceneReferenceId,
            model: jobProvider.model,
            creationIndex: index,
            ...(unifiedContract ? {
              unifiedModel: unifiedContract.unifiedModel,
              unifiedRuleVersion: unifiedContract.unifiedRuleVersion,
              imageAssetId: shot.sourceImageId,
              referenceImageIds: [sceneRef.imageAssetId],
            } : {}),
          },
        });
        createdJobs.push(jobId);
      });
      db.prepare(`UPDATE shot_sets SET status = 'generating', sceneReferenceId = ? WHERE id = ?`).run(sceneReferenceId, id);
    }).immediate();

    return NextResponse.json({ success: true, jobCount: createdJobs.length, jobIds: createdJobs, replayed: false });
  } catch (err) {
    if (err instanceof UnifiedJobRequestConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: err instanceof UnifiedImageRequestError ? 400 : 500 },
    );
  }
}
export const POST = withTeamRoute('/api/shot-sets/[id]/apply-scene', 'POST', __teamRoutePOST);
