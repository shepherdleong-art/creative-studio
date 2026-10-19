import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
import { getVideoQueueStatus, runVideoQueue, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const result = db.transaction(() => {
      const job = db.prepare(`SELECT * FROM video_jobs WHERE id = ?`).get(id) as {
        id: string; status: string; projectId: string; providerStatus: string | null;
        providerTaskId: string | null; remoteVideoUrl: string | null; localVideoPath: string | null;
        attempt: number;
      } | undefined;
      if (!job) return { error: 'Video job not found', status: 404 } as const;
      if (!['failed', 'canceled'].includes(job.status)) {
        return { error: 'Only failed or canceled video jobs can be retried', status: 400 } as const;
      }

      // Explicit manual retry may replace a confirmed remote failure only.
      // Unknown/canceled/download failures retain the task ID for recovery.
      const resubmit = job.status === 'failed' && job.providerStatus === 'failed'
        && !!job.providerTaskId && !job.remoteVideoUrl && !job.localVideoPath;
      if (resubmit) {
        db.prepare(`UPDATE video_jobs SET status = 'pending', errorMessage = NULL,
          providerTaskId = NULL, providerStatus = NULL, providerRawResponse = NULL,
          lastPolledAt = NULL, pollCount = 0, startedAt = NULL, finishedAt = NULL,
          attempt = 0, usageSnapshotJson = NULL WHERE id = ?`).run(id);
      } else {
        db.prepare(`UPDATE video_jobs SET status = 'pending', errorMessage = NULL WHERE id = ?`).run(id);
      }
      // Frozen model, multiShot, prompt and input assets survive every retry.
      return { job, resubmit };
    })();
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });
    const { job, resubmit } = result;
    if (resubmit) {
      writeLog({ jobId: id, projectId: job.projectId, level: 'info', attempt: job.attempt,
        message: `Manual retry of confirmed provider failure; previous task_id=${job.providerTaskId}; submitting a new task`,
      });
    }

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
