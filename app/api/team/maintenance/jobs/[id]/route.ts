import { requirePrincipal } from '@/lib/team-service/auth/request';
import { getMaintenanceJob } from '@/lib/team-service/maintenance/control';
import { MaintenanceControlError } from '@/lib/team-service/maintenance/jobs';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const dynamic = 'force-dynamic';

async function __teamRouteGET(request: Request, context: { params: Promise<{ id: string }> }) {
  requirePrincipal(request, { admin: true });
  try { return Response.json(getMaintenanceJob((await context.params).id), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) {
    if (error instanceof MaintenanceControlError) return Response.json({ error: error.code, message: error.message }, { status: error.code === 'job_not_found' ? 404 : 400 });
    return Response.json({ error: 'maintenance_unavailable', message: '维护记录需要核查，暂不启动新操作。' }, { status: 503 });
  }
}

export const GET = withTeamRoute('/api/team/maintenance/jobs/[id]', 'GET', __teamRouteGET);
