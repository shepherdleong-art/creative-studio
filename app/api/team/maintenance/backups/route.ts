import { requirePrincipal } from '@/lib/team-service/auth/request';
import { readBackupPreview } from '@/lib/team-service/maintenance/preview';
import { readMaintenanceExecutionConfig } from '@/lib/team-service/maintenance/worker';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readTeamReleasePointer } from '@/lib/team-service/maintenance/release';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

async function __teamRouteGET(request: Request) {
  requirePrincipal(request, { admin: true });
  try {
    const config = readMaintenanceExecutionConfig();
    const raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8').replace(/^\uFEFF/, '')) as { deploymentRoot: string };
    const release = await readTeamReleasePointer(path.join(raw.deploymentRoot, 'service'));
    return Response.json(await readBackupPreview({ backupRoot: config.backupRoot, deploymentId: config.deploymentId, currentRelease: release }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'backup_catalog_unavailable', message: '备份清单暂时不可用，请核查维护存储。' }, { status: 503 });
  }
}

export const GET = withTeamRoute('/api/team/maintenance/backups', 'GET', __teamRouteGET);
