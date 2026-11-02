import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
import { resumeImageJobPolling } from '@/lib/queue';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

/** Resume an accepted image task without creating another paid submission. */
async function __teamRoutePOST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = getDb().prepare('SELECT projectId, providerTaskId, providerStatus, remoteImageUrl FROM jobs WHERE id = ?')
      .get(id) as { projectId: string; providerTaskId: string | null; providerStatus: string | null; remoteImageUrl: string | null } | undefined;
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (!job.providerTaskId && !(job.providerStatus === 'download_failed' && job.remoteImageUrl)) {
      return NextResponse.json({ error: 'No accepted image task or result URL to resume' }, { status: 400 });
    }

    void resumeImageJobPolling(id).catch((error) => {
      writeLog({
        jobId: id,
        projectId: job.projectId,
        level: 'error',
        message: `补抓失败: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return NextResponse.json({ status: 'resumed-polling' }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/jobs/[id]/resume-poll', 'POST', __teamRoutePOST);
