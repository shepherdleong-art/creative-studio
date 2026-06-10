import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_SOURCE_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'needs_check']);

function safeParseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
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

    // ── Resolve reference image IDs ──
    const oldReferenceIds = safeParseStringArray(originalJob.referenceImageIds);
    const requestedReferenceIds: string[] = hasReferenceOverride
      ? (body.referenceImageIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : oldReferenceIds;
    // Remove base image from reference set (backend guarantee)
    const uniqueReferenceIds: string[] = [...new Set(requestedReferenceIds)].filter((rid) => rid !== newInputImageId);

    // ── Validate reference images belong to same project ──
    if (uniqueReferenceIds.length > 0) {
      // Bind any newly uploaded images (projectId IS NULL) to this project
      db.prepare(
        `UPDATE image_assets SET projectId = ?, role = 'reference' WHERE id IN (${uniqueReferenceIds.map(() => '?').join(',')}) AND projectId IS NULL`
      ).run(originalJob.projectId as string, ...uniqueReferenceIds);

      // Validate all requested images exist and belong to the project
      const placeholders = uniqueReferenceIds.map(() => '?').join(',');
      const projectId = originalJob.projectId as string;
      const queryParams: string[] = [...uniqueReferenceIds, projectId];
      const validImages = db.prepare(
        `SELECT id FROM image_assets WHERE id IN (${placeholders}) AND projectId = ? AND role IN ('input', 'reference', 'output')`
      ).all(...queryParams) as { id: string }[];

      const validIds = new Set(validImages.map((img) => img.id));
      const invalidIds = uniqueReferenceIds.filter((rid) => !validIds.has(rid));

      if (invalidIds.length > 0) {
        return NextResponse.json(
          { success: false, error: `以下参考图 ID 不属于当前项目或不存在: ${invalidIds.join(', ')}` },
          { status: 400 }
        );
      }
    }

    // ── Atomic transaction: calculate revision, insert new job, mark original ──
    const newJobId = uuidv4();
    const createRegeneration = db.transaction(() => {
      // Revision: track revisions per original input image to keep version chain stable
      const latest = db.prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 as rev FROM jobs WHERE projectId = ? AND inputImageId = ?`
      ).get(originalJob.projectId, originalJob.inputImageId) as { rev: number };

      db.prepare(`
        INSERT INTO jobs (
          id, projectId, inputImageId, referenceImageIds, providerId, model,
          prompt, size, quality, status, attempt, maxAttempts,
          parentJobId, revision, referenceGuidanceMode
        )
        SELECT ?, projectId, ?, ?, providerId, model,
               ?, size, quality, 'pending', 0, maxAttempts,
               id, ?, referenceGuidanceMode
        FROM jobs
        WHERE id = ?
      `).run(
        newJobId,
        newInputImageId,
        JSON.stringify(uniqueReferenceIds),
        prompt,
        latest.rev,
        id
      );

      if (markOriginal) {
        db.prepare(`UPDATE jobs SET reviewMark = 'rework' WHERE id = ?`).run(id);
      }

      return latest.rev;
    });

    const newRevision = createRegeneration();

    return NextResponse.json({
      success: true,
      projectId: originalJob.projectId,
      newJobId,
      revision: newRevision,
      inputImageId: newInputImageId,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
