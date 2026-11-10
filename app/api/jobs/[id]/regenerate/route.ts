import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveRegenerateImageJobProvider } from '@/lib/image-provider-selection';
import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_MODEL_KEY,
  isUnifiedImageChannelProvider,
} from '@/lib/media-core/unified-media/catalog';
import {
  buildUnifiedImageJobContract,
  isUnifiedImageJobProvider,
  unifiedImageProjectReferenceGuidance,
} from '@/lib/media-core/unified-media/project-jobs';
import { UnifiedImageRequestError } from '@/lib/media-core/unified-media/requests';
import {
  UnifiedJobRequestConflictError,
  findUnifiedJobRequestReplay,
  normalizeUnifiedJobRequestKey,
  unifiedJobRequestHash,
} from '@/lib/media-core/unified-media/job-idempotency';
import { v4 as uuidv4 } from 'uuid';
import { requiresReassembledImageRework, REASSEMBLED_REWORK_REQUIRED } from '@/lib/reassembled-shot-guard';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { bindImageScopeToProject, assertScopeConsistency } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readRuntimeConfig } from '@/lib/team-service/config';


const ALLOWED_SOURCE_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'needs_check']);

function safeParseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('job', id, 'write');
    if (requiresReassembledImageRework(db, id)) return NextResponse.json({ error: REASSEMBLED_REWORK_REQUIRED }, { status: 409 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const markOriginal = body.markOriginal !== false;
    const inputSource = (body.inputSource as string) === 'current_result' ? 'current_result' : 'original';
    const hasReferenceOverride = Array.isArray(body.referenceImageIds);

    // Validate
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const originalJob = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as {
      id: string; status: string; projectId: string;
      inputImageId: string; outputImageId: string | null;
      referenceImageIds: string;
      prompt: string;
      providerId: string; model: string; size: string; quality: string;
      maxAttempts: number; referenceGuidanceMode: string;
      unifiedModel: string | null;
    } | undefined;
    if (!originalJob) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (!ALLOWED_SOURCE_STATUSES.has(originalJob.status as string)) {
      return NextResponse.json(
        { error: `Cannot regenerate from status "${originalJob.status}". Must be succeeded, failed, canceled, or needs_check.` },
        { status: 400 }
      );
    }

    const requestedProviderId = typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : originalJob.providerId;
    const requestedProvider = db.prepare(`
      SELECT id, name, type, model, enabled, apiKey
      FROM providers WHERE id = ?
    `).get(requestedProviderId) as {
      id: string; name: string; type: string; model: string; enabled: number; apiKey: string;
    } | undefined;
    if (!requestedProvider) return NextResponse.json({ error: '供应商不存在' }, { status: 400 });
    if (!requestedProvider.enabled) return NextResponse.json({ error: '供应商已禁用' }, { status: 400 });
    const unifiedImage = isUnifiedImageJobProvider(requestedProvider)
      || (readRuntimeConfig().mode === 'server' && isUnifiedImageChannelProvider(requestedProvider));

    let jobProvider: { providerId: string; model: string };
    if (unifiedImage) {
      jobProvider = { providerId: UNIFIED_IMAGE_ANCHOR_ID, model: UNIFIED_IMAGE_MODEL_KEY };
    } else {
      try {
        jobProvider = resolveRegenerateImageJobProvider(db, body.providerId, {
          providerId: originalJob.providerId,
          model: originalJob.model,
        });
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }

    // ── Determine new input image ID ──
    let newInputImageId = originalJob.inputImageId as string;

    if (inputSource === 'current_result') {
      if (!originalJob.outputImageId) {
        return NextResponse.json(
          { success: false, error: '当前任务没有可用结果图，不能以当前结果作为编辑底图' },
          { status: 400 }
        );
      }
      newInputImageId = originalJob.outputImageId as string;
    }

    if (access.kind === 'team') access.assertAccess('image', newInputImageId, 'read');

    // ── Resolve reference image IDs ──
    const oldReferenceIds = safeParseStringArray(originalJob.referenceImageIds);
    const requestedReferenceIds: string[] = hasReferenceOverride
      ? (body.referenceImageIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : oldReferenceIds;
    // Remove base image from reference set (backend guarantee)
    const uniqueReferenceIds: string[] = [...new Set(requestedReferenceIds)].filter((rid) => rid !== newInputImageId);

    // ── Validate reference images belong to same project or are owned unbound uploads ──
    if (uniqueReferenceIds.length > 0) {
      const placeholders = uniqueReferenceIds.map(() => '?').join(',');
      const projectId = originalJob.projectId as string;
      const queryParams: string[] = [...uniqueReferenceIds, projectId];
      const validImages = db.prepare(
        `SELECT id FROM image_assets WHERE id IN (${placeholders}) AND (projectId = ? OR projectId IS NULL) AND role IN ('input', 'reference', 'output')`
      ).all(...queryParams) as { id: string }[];
      const validIds = new Set(validImages.map((img) => img.id));
      const invalidIds = uniqueReferenceIds.filter((rid) => !validIds.has(rid));
      if (invalidIds.length > 0) {
        return NextResponse.json(
          { success: false, error: `以下参考图 ID 不属于当前项目或不存在: ${invalidIds.join(', ')}` },
          { status: 400 }
        );
      }
      if (access.kind === 'team') {
        for (const imageId of uniqueReferenceIds) access.assertAccess('image', imageId, 'write');
      }
    }

    let unifiedContract: ReturnType<typeof buildUnifiedImageJobContract> | null = null;
    if (unifiedImage) {
      try {
        unifiedContract = buildUnifiedImageJobContract({
          projectSize: originalJob.size,
          prompt,
          inputImageId: newInputImageId,
          referenceImageIds: uniqueReferenceIds,
          referenceGuidanceMode: unifiedImageProjectReferenceGuidance(originalJob.referenceGuidanceMode),
        });
      } catch (error) {
        return NextResponse.json({
          error: error instanceof UnifiedImageRequestError
            ? error.message
            : '统一 Image 2 重新生成合同无效。',
        }, { status: 400 });
      }
    }

    const creationSource = 'project_regenerate';
    const requestKey = normalizeUnifiedJobRequestKey(body.requestKey);
    const requestHash = unifiedJobRequestHash({
      kind: 'regenerate',
      parentJobId: id,
      projectId: originalJob.projectId,
      inputImageId: newInputImageId,
      referenceImageIds: uniqueReferenceIds,
      prompt,
      providerId: jobProvider.providerId,
      model: jobProvider.model,
      unifiedRequestJson: unifiedContract?.unifiedRequestJson ?? null,
    });
    const replay = findUnifiedJobRequestReplay(db, {
      projectId: originalJob.projectId,
      requestKey,
      requestHash,
      expectedCount: 1,
      creationSource,
    });
    if (replay) {
      const existingRevision = db.prepare('SELECT revision FROM jobs WHERE id = ?').pluck().get(replay[0]) as number | undefined;
      return NextResponse.json({
        success: true,
        projectId: originalJob.projectId,
        newJobId: replay[0],
        revision: existingRevision ?? 0,
        inputImageId: newInputImageId,
        replayed: true,
      });
    }

    // ── Atomic transaction: calculate revision, insert new job, mark original ──
    const newJobId = uuidv4();
    const createRegeneration = db.transaction(() => {
      const projectId = originalJob.projectId as string;
      const ownerUserId = access.kind === 'team' ? assertScopeConsistency(db, 'project', projectId).ownerUserId : '';
      for (const imageId of uniqueReferenceIds) {
        db.prepare(`UPDATE image_assets SET projectId = ?, role = 'reference' WHERE id = ? AND projectId IS NULL`)
          .run(projectId, imageId);
        if (access.kind === 'team') bindImageScopeToProject(db, imageId, projectId, ownerUserId);
      }
      const placeholders = uniqueReferenceIds.map(() => '?').join(',');
      if (uniqueReferenceIds.length > 0) {
        const valid = db.prepare(`SELECT COUNT(*) AS count FROM image_assets WHERE id IN (${placeholders}) AND projectId = ?`)
          .get(...uniqueReferenceIds, projectId) as { count: number };
        if (valid.count !== uniqueReferenceIds.length) throw new Error('参考图项目归属校验失败');
      }
      // Revision: track revisions per original input image to keep version chain stable
      const latest = db.prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 as rev FROM jobs WHERE projectId = ? AND inputImageId = ?`
      ).get(originalJob.projectId, originalJob.inputImageId) as { rev: number };

      if (unifiedContract) {
        db.prepare(`
          INSERT INTO jobs (
            id, projectId, inputImageId, referenceImageIds, providerId, model,
            prompt, size, quality, status, attempt, maxAttempts,
            parentJobId, revision, referenceGuidanceMode, createdAt, creationIndex,
            unifiedModel, unifiedRuleVersion, unifiedRequestJson, creationSource,
            creationRequestKey, creationRequestHash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `).run(
          newJobId,
          projectId,
          newInputImageId,
          JSON.stringify(uniqueReferenceIds),
          unifiedContract.providerId,
          unifiedContract.model,
          prompt,
          unifiedContract.size,
          unifiedContract.quality,
          id,
          latest.rev,
          unifiedImageProjectReferenceGuidance(originalJob.referenceGuidanceMode),
          new Date().toISOString(),
          unifiedContract.unifiedModel,
          unifiedContract.unifiedRuleVersion,
          unifiedContract.unifiedRequestJson,
          creationSource,
          requestKey,
          requestHash,
        );
      } else {
        db.prepare(`
          INSERT INTO jobs (
            id, projectId, inputImageId, referenceImageIds, providerId, model,
            prompt, size, quality, status, attempt, maxAttempts,
            parentJobId, revision, referenceGuidanceMode, createdAt, creationIndex, creationSource,
            creationRequestKey, creationRequestHash
          )
          SELECT ?, projectId, ?, ?, ?, ?,
                 ?, size, quality, 'pending', 0, maxAttempts,
                 id, ?, referenceGuidanceMode, ?, 0, ?, ?, ?
          FROM jobs
          WHERE id = ?
        `).run(
          newJobId,
          newInputImageId,
          JSON.stringify(uniqueReferenceIds),
          jobProvider.providerId,
          jobProvider.model,
          prompt,
          latest.rev,
          new Date().toISOString(),
          creationSource,
          requestKey,
          requestHash,
          id
        );
      }

      access.registerInheritedScope({
        resourceType: 'job', resourceId: newJobId,
        parent: { resourceType: 'project', resourceId: originalJob.projectId },
      });
      access.registerTaskPrincipal({
        module: 'image', taskId: newJobId,
        scope: { resourceType: 'project', resourceId: originalJob.projectId },
        creationSnapshot: {
          parentJobId: id,
          inputImageId: newInputImageId,
          referenceImageIds: uniqueReferenceIds,
          ...(unifiedContract ? {
            unifiedModel: unifiedContract.unifiedModel,
            unifiedRuleVersion: unifiedContract.unifiedRuleVersion,
            providerId: unifiedContract.providerId,
            model: unifiedContract.model,
          } : {}),
        },
      });

      if (markOriginal) {
        db.prepare(`UPDATE jobs SET reviewMark = 'rework' WHERE id = ?`).run(id);
      }

      return latest.rev;
    });

    const newRevision = createRegeneration.immediate();

    return NextResponse.json({
      success: true,
      projectId: originalJob.projectId,
      newJobId,
      revision: newRevision,
      inputImageId: newInputImageId,
      replayed: false,
    });
  } catch (err) {
    if (err instanceof UnifiedJobRequestConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const POST = withTeamRoute('/api/jobs/[id]/regenerate', 'POST', __teamRoutePOST);
