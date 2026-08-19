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
      SELECT vj.*
      FROM video_jobs vj
      WHERE vj.id = ?
    `).get(id) as {
      id: string; status: string; projectId: string;
    } | undefined;
    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled video jobs can be retried' }, { status: 400 });
    }

    // Retry only resets execution state. The task's frozen model and
    // multiShot choice must survive provider setting changes and retries.
    db.prepare(`UPDATE video_jobs SET status = 'pending', errorMessage = NULL WHERE id = ?`).run(id);

    // Auto-start video queue if idle so the retried job gets picked up
    const qStatus = getVideoQueueStatus(job.projectId);
    if (qStatus === 'idle') {
      const projectRow = db.prepare(`SELECT videoConcurrency FROM projects WHERE id = ?`).get(job.projectId) as { videoConcurrency?: number } | undefined;
      const concurrency = Math.max(1, Math.min(10, Number(projectRow?.videoConcurrency) || DEFAULT_VIDEO_CONCURRENCY));
      runVideoQueue({
        projectId: job.projectId,
        concurrency,
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
