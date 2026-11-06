import { NextRequest, NextResponse } from 'next/server';
import { getProjectLogs, getJobLogs } from '@/lib/logger';
import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');
    const limit = parseInt(searchParams.get('limit') || '200', 10);

    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', id, 'read');
    if (jobId) {
      const owner = getDb().prepare(`SELECT projectId FROM jobs WHERE id = ?`).get(jobId) as { projectId?: string } | undefined;
      if (owner?.projectId !== id) return NextResponse.json({ error: 'job_not_found' }, { status: 404 });
      if (access.kind === 'team') access.assertAccess('job', jobId, 'read');
      const logs = getJobLogs(jobId);
      return NextResponse.json(logs, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const logs = getProjectLogs(id, limit);
    return NextResponse.json(logs, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const GET = withTeamRoute('/api/projects/[id]/logs', 'GET', __teamRouteGET);
