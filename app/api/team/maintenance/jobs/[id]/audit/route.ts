import { requirePrincipal } from '@/lib/team-service/auth/request';
import { maintenanceAudit } from '@/lib/team-service/maintenance/control';
import { MaintenanceControlError } from '@/lib/team-service/maintenance/jobs';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const dynamic = 'force-dynamic';

async function __teamRouteGET(request: Request, context: { params: Promise<{ id: string }> }) {
  requirePrincipal(request, { admin: true });
  try { return Response.json(maintenanceAudit((await context.params).id), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) {
    if (error instanceof MaintenanceControlError) return Response.json({ error: error.code, message: error.message }, { status: error.code === 'job_not_found' ? 404 : 400 });
    return Response.json({ error: 'maintenance_unavailable', message: '维护审计需要核查。' }, { status: 503 });
  }
}

export const GET = withTeamRoute('/api/team/maintenance/jobs/[id]/audit', 'GET', __teamRouteGET);
