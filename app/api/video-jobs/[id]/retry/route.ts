import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getVideoQueueStatus, runVideoQueue, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const job = db.prepare(`
      SELECT vj.*, vp.defaultModel
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      WHERE vj.id = ?
    `).get(id) as {
      id: string; status: string; projectId: string; defaultModel?: string | null;
    } | undefined;
    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled video jobs can be retried' }, { status: 400 });
    }

    const model = (job.defaultModel || '').trim();
    if (model) {
      db.prepare(`UPDATE video_jobs SET status = 'pending', model = ?, errorMessage = NULL WHERE id = ?`).run(model, id);
    } else {
      db.prepare(`UPDATE video_jobs SET status = 'pending', errorMessage = NULL WHERE id = ?`).run(id);
    }

    // Auto-start video queue if idle so the retried job gets picked up
    const qStatus = getVideoQueueStatus(job.projectId);
    if (qStatus === 'idle') {
      runVideoQueue({
        projectId: job.projectId,
        concurrency: DEFAULT_VIDEO_CONCURRENCY,
        timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
      }).catch((err) => {
        console.error(`[VideoQueue] Auto-restart on retry failed:`, err);
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
