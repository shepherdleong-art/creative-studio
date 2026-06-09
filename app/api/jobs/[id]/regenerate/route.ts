import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_SOURCE_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'needs_check']);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json();
    const { prompt, markOriginal = true } = body;

    // Validate
    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const originalJob = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!originalJob) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (!ALLOWED_SOURCE_STATUSES.has(originalJob.status as string)) {
      return NextResponse.json(
        { error: `Cannot regenerate from status "${originalJob.status}". Must be succeeded, failed, canceled, or needs_check.` },
        { status: 400 }
      );
    }

    // Atomic transaction: calculate revision, insert new job, mark original
    const newJobId = uuidv4();
    const createRegeneration = db.transaction(() => {
      const latest = db.prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 as rev FROM jobs WHERE projectId = ? AND inputImageId = ?`
      ).get(originalJob.projectId, originalJob.inputImageId) as { rev: number };

      db.prepare(`
        INSERT INTO jobs (
          id, projectId, inputImageId, referenceImageIds, providerId, model,
          prompt, size, quality, status, attempt, maxAttempts,
          parentJobId, revision, referenceGuidanceMode
        )
        SELECT ?, projectId, inputImageId, referenceImageIds, providerId, model,
               ?, size, quality, 'pending', 0, maxAttempts,
               id, ?, referenceGuidanceMode
        FROM jobs
        WHERE id = ?
      `).run(newJobId, prompt.trim(), latest.rev, id);

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
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
