import { requirePrincipal } from '@/lib/team-service/auth/request';
import { listMaintenanceJobs, submitMaintenanceJob } from '@/lib/team-service/maintenance/control';
import { MaintenanceControlError } from '@/lib/team-service/maintenance/jobs';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const dynamic = 'force-dynamic';

async function __teamRouteGET(request: Request) {
  requirePrincipal(request, { admin: true });
  return Response.json(listMaintenanceJobs(), { headers: { 'Cache-Control': 'private, no-store' } });
}

async function __teamRoutePOST(request: Request) {
  const principal = requirePrincipal(request, { admin: true });
  let body: { idempotencyKey?: unknown; target?: unknown };
  try { body = await request.json() as typeof body; } catch {
    return Response.json({ error: 'invalid_input', message: '维护请求格式无效。' }, { status: 400 });
  }
  const target = body.target as { kind?: unknown; backupType?: unknown } | null;
  if (typeof body.idempotencyKey !== 'string' || !target || typeof target !== 'object'
    || Object.keys(target).sort().join(',') !== 'backupType,kind'
    || target.kind !== 'backup' || target.backupType !== 'manual') {
    return Response.json({ error: 'invalid_target', message: '网页立即备份仅接受固定手动备份目标。' }, { status: 400 });
  }
  try {
    const submitted = submitMaintenanceJob({ principal, idempotencyKey: body.idempotencyKey, target: { kind: 'backup', backupType: 'manual' } });
    return Response.json(submitted, { status: submitted.created ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof MaintenanceControlError) {
      const status = ['maintenance_conflict', 'maintenance_review_required', 'idempotency_conflict'].includes(error.code) ? 409 : 400;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    return Response.json({ error: 'maintenance_unavailable', message: '维护作业存储不可用，未启动备份。' }, { status: 503 });
  }
}

export const GET = withTeamRoute('/api/team/maintenance/jobs', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/maintenance/jobs', 'POST', __teamRoutePOST);
