import { getTeamAuthService } from '@/lib/team-service/auth/runtime';
import { requirePrincipal, sessionCookie } from '@/lib/team-service/auth/request';
import { confirmMaintenanceRestore, getMaintenanceJob } from '@/lib/team-service/maintenance/control';
import { MaintenanceControlError } from '@/lib/team-service/maintenance/jobs';
import { TeamAuthError } from '@/lib/team-service/auth/types';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readMaintenanceExecutionConfig } from '@/lib/team-service/maintenance/worker';
import { assertNoSymlinkPath } from '@/lib/team-service/maintenance/paths';

export const dynamic = 'force-dynamic';

async function __teamRoutePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  const principal = requirePrincipal(request, { admin: true });
  let body: { password?: unknown };
  try { body = await request.json() as typeof body; } catch {
    return Response.json({ error: 'invalid_input', message: '重新认证请求格式无效。' }, { status: 400 });
  }
  if (typeof body.password !== 'string' || !body.password || body.password.length > 512) {
    return Response.json({ error: 'invalid_credentials', message: '请输入当前管理员密码以确认整套切换。' }, { status: 401 });
  }
  try {
    const jobId = (await context.params).id;
    const job = getMaintenanceJob(jobId).job;
    if (job.action !== 'restore.execute' || job.status !== 'awaiting_confirmation' || job.requestedBy.userId !== principal.userId) {
      return Response.json({ error: 'restore_not_ready', message: '只能由发起人确认已校验的还原作业。' }, { status: 409 });
    }
    const reauthenticated = await getTeamAuthService().reauthenticate(principal, body.password);
    const config = readMaintenanceExecutionConfig();
    const deployment = JSON.parse(fs.readFileSync(config.configPath, 'utf8').replace(/^\uFEFF/, '')) as { deploymentRoot: string };
    const sessionDirectory = path.join(deployment.deploymentRoot, 'restore-operations', jobId);
    fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    assertNoSymlinkPath(sessionDirectory);
    const temporary = path.join(sessionDirectory, `.reauthentication-${reauthenticated.principal.sessionId}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1,
      tokenHash: createHash('sha256').update(reauthenticated.token).digest('hex'),
      principal: reauthenticated.principal,
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(sessionDirectory, 'reauthenticated-session.json'));
    const confirmed = confirmMaintenanceRestore(jobId, reauthenticated.principal);
    return Response.json({ ...confirmed, accessVerified: true }, {
      status: 200,
      headers: { 'Cache-Control': 'private, no-store', 'Set-Cookie': sessionCookie(reauthenticated.token, false) },
    });
  } catch (error) {
    if (error instanceof TeamAuthError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof MaintenanceControlError) {
      return Response.json({ error: error.code, message: error.message }, {
        status: ['restore_not_ready', 'restore_initiator_required'].includes(error.code) ? 409 : 400,
      });
    }
    return Response.json({ error: 'maintenance_unavailable', message: '切换确认未完成，实际活动状态未改变。' }, { status: 503 });
  }
}

export const POST = withTeamRoute('/api/team/maintenance/restores/[id]/confirm', 'POST', __teamRoutePOST);
