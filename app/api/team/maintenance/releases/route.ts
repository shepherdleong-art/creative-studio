import { requirePrincipal } from '@/lib/team-service/auth/request';
import { submitTeamReleaseExecution } from '@/lib/team-service/maintenance/control';
import { MaintenanceControlError } from '@/lib/team-service/maintenance/jobs';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const dynamic = 'force-dynamic';

async function __teamRoutePOST(request: Request): Promise<Response> {
  const principal = requirePrincipal(request, { admin: true });
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_input', message: '升级确认格式无效。' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'candidateId,confirmation,idempotencyKey') {
    return Response.json({ error: 'invalid_target', message: '只接受受管候选、版本确认和请求标识，不接受路径或命令。' }, { status: 400 });
  }
  const input = body as { candidateId?: unknown; idempotencyKey?: unknown; confirmation?: unknown };
  const confirmation = input.confirmation as Record<string, unknown> | null;
  if (typeof input.candidateId !== 'string' || typeof input.idempotencyKey !== 'string'
    || !confirmation || Object.keys(confirmation).sort().join(',') !== 'expectedReleaseId,impactAcknowledged,targetAppVersion'
    || confirmation.impactAcknowledged !== true || typeof confirmation.expectedReleaseId !== 'string'
    || typeof confirmation.targetAppVersion !== 'string') {
    return Response.json({ error: 'confirmation_required', message: '请核对当前与目标版本，并确认维护、停服、备份和在途证据保留影响。' }, { status: 400 });
  }
  try {
    const submitted = await submitTeamReleaseExecution({
      principal, candidateId: input.candidateId, idempotencyKey: input.idempotencyKey,
      confirmation: {
        expectedReleaseId: confirmation.expectedReleaseId,
        targetAppVersion: confirmation.targetAppVersion,
        impactAcknowledged: true,
      },
    });
    return Response.json(submitted, { status: submitted.created ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof MaintenanceControlError) {
      const status = ['maintenance_conflict', 'maintenance_review_required', 'idempotency_conflict', 'release_confirmation_changed'].includes(error.code) ? 409 : 422;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    return Response.json({ error: 'release_unavailable', message: error instanceof Error ? error.message : '候选复核失败，未启动升级。' }, { status: 422 });
  }
}

export const POST = withTeamRoute('/api/team/maintenance/releases', 'POST', __teamRoutePOST);
