import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resumeVideoJobPolling } from '@/lib/video-queue';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRoutePOST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await resumeVideoJobPolling(id);
    const job = getDb().prepare('SELECT status, filename FROM video_jobs WHERE id = ?').get(id) as
      { status: string; filename: string | null } | undefined;
    return NextResponse.json({ success: true, status: job?.status, filename: job?.filename });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/video-jobs/[id]/resume-poll', 'POST', __teamRoutePOST);
