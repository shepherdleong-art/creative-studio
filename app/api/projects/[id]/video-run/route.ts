import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cancelVideoQueue, getVideoQueueStatus, runVideoQueue, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import { writeLog } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { action?: string };
    if (body.action === 'cancel') {
      cancelVideoQueue(id);
      writeLog({ jobId: '', projectId: id, level: 'warn', message: 'Video queue canceled from frontend' });
      return NextResponse.json({ queueStatus: 'idle' });
    }

    const qStatus = getVideoQueueStatus(id);

    if (qStatus !== 'idle') {
      return NextResponse.json({ queueStatus: qStatus });
    }

    writeLog({ jobId: '', projectId: id, level: 'info', message: 'Video queue auto-started from frontend' });

    const projectRow = getDb().prepare(`SELECT videoConcurrency FROM projects WHERE id = ?`).get(id) as { videoConcurrency?: number } | undefined;
    const concurrency = Math.max(1, Math.min(10, Number(projectRow?.videoConcurrency) || DEFAULT_VIDEO_CONCURRENCY));

    runVideoQueue({
      projectId: id,
      concurrency,
      timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[VideoQueue] Fatal:`, msg);
      writeLog({ jobId: '', projectId: id, level: 'error', message: `Video queue fatal: ${msg}` });
    });

    return NextResponse.json({ queueStatus: 'running' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json({ queueStatus: getVideoQueueStatus(id) });
}
