import { requirePrincipal } from '@/lib/team-service/auth/request';
import { holdProductionForRestore, submitMaintenanceJob } from '@/lib/team-service/maintenance/control';
import { MaintenanceControlError, type MaintenanceTarget } from '@/lib/team-service/maintenance/jobs';
import { listTeamBackups } from '@/lib/team-service/maintenance/catalog';
import { readMaintenanceExecutionConfig } from '@/lib/team-service/maintenance/worker';
import { readTeamReleasePointer } from '@/lib/team-service/maintenance/release';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

async function __teamRoutePOST(request: Request) {
  const principal = requirePrincipal(request, { admin: true });
  let body: { idempotencyKey?: unknown; target?: unknown };
  try { body = await request.json() as typeof body; } catch {
    return Response.json({ error: 'invalid_input', message: '还原请求格式无效。' }, { status: 400 });
  }
  const target = body.target as { kind?: unknown; backupType?: unknown; backupId?: unknown } | null;
  if (typeof body.idempotencyKey !== 'string' || !target || typeof target !== 'object'
    || Object.keys(target).sort().join(',') !== 'backupId,backupType,kind'
    || target.kind !== 'restore' || typeof target.backupId !== 'string'
    || !['daily', 'manual', 'pre-upgrade', 'pre-restore'].includes(String(target.backupType))) {
    return Response.json({ error: 'invalid_target', message: '整套还原仅接受备份清单中的受管备份身份。' }, { status: 400 });
  }
  try {
    const config = readMaintenanceExecutionConfig();
    const raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8').replace(/^\uFEFF/, '')) as { deploymentRoot: string };
    const release = await readTeamReleasePointer(path.join(raw.deploymentRoot, 'service'));
    const listed = await listTeamBackups(config.backupRoot, config.deploymentId, release);
    const selected = listed.backups.find((backup) => backup.id === target.backupId && backup.type === target.backupType);
    if (!selected?.restorable) {
      return Response.json({ error: 'backup_not_restorable', message: '备份未通过完整性或当前版本兼容校验，不能用于还原。' }, { status: 409 });
    }
    const submitted = submitMaintenanceJob({
      principal, idempotencyKey: body.idempotencyKey,
      target: { kind: 'restore', backupType: selected.type, backupId: selected.id } as MaintenanceTarget,
      action: 'restore.execute',
    });
    if (submitted.created) holdProductionForRestore(principal, submitted.job.id);
    return Response.json(submitted, { status: submitted.created ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof MaintenanceControlError) {
      const status = ['maintenance_conflict', 'maintenance_review_required', 'idempotency_conflict'].includes(error.code) ? 409 : 400;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    return Response.json({ error: 'maintenance_unavailable', message: '还原前置校验或禁调度写入不可用；请按请求标识重连原作业，不要另行重复操作。' }, { status: 503 });
  }
}

export const POST = withTeamRoute('/api/team/maintenance/restores', 'POST', __teamRoutePOST);
