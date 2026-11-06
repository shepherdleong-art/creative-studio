import { requirePrincipal } from '@/lib/team-service/auth/request';
import { listTeamBackups } from '@/lib/team-service/maintenance/catalog';
import { readMaintenanceExecutionConfig } from '@/lib/team-service/maintenance/worker';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const dynamic = 'force-dynamic';

async function __teamRouteGET(request: Request) {
  requirePrincipal(request, { admin: true });
  try {
    const config = readMaintenanceExecutionConfig();
    return Response.json(await listTeamBackups(config.backupRoot, config.deploymentId), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'backup_catalog_unavailable', message: '备份清单暂时不可用，请核查维护存储。' }, { status: 503 });
  }
}

export const GET = withTeamRoute('/api/team/maintenance/backups', 'GET', __teamRouteGET);
