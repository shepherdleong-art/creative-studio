import { NextRequest, NextResponse } from 'next/server';
import { getVideoQueueStatus, runVideoQueue, DEFAULT_VIDEO_CONCURRENCY } from '@/lib/video-queue';
import { writeLog } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const qStatus = getVideoQueueStatus(id);

    if (qStatus !== 'idle') {
      return NextResponse.json({ queueStatus: qStatus });
    }

    writeLog({ jobId: '', projectId: id, level: 'info', message: 'Video queue auto-started from frontend' });

    runVideoQueue({
      projectId: id,
      concurrency: DEFAULT_VIDEO_CONCURRENCY,
      timeoutMs: 600000,
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
