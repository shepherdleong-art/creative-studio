import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { getTeamExecutionFacade } from '@/lib/team-service/runtime';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { teamServiceError } from '@/lib/team-service/http-error';
import {
  applyUnifiedReconcileAction,
  listUnifiedReconcileTasks,
  type UnifiedReconcileActionInput,
} from '@/lib/team-service/unified-reconcile';

function viewer() {
  const access = requireAccessContext();
  return { userId: access.actor.userId, role: access.actor.role };
}

async function __teamRouteGET(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') === 'all' ? 'all' : 'attention';
    return Response.json(listUnifiedReconcileTasks(getDb(), viewer(), { status }), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return teamServiceError(error, '待核对任务读取失败。');
  }
}

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await request.json() as Partial<UnifiedReconcileActionInput>;
    const result = await applyUnifiedReconcileAction(
      getDb(),
      getTeamExecutionFacade(),
      viewer(),
      {
        mediaTaskId: String(body.mediaTaskId ?? ''),
        channelKey: String(body.channelKey ?? ''),
        attemptId: String(body.attemptId ?? ''),
        action: String(body.action ?? '') as UnifiedReconcileActionInput['action'],
        evidence: String(body.evidence ?? ''),
        expectedVersion: Number(body.expectedVersion),
        idempotencyKey: String(body.idempotencyKey ?? ''),
        remoteId: body.remoteId === undefined || body.remoteId === null ? null : String(body.remoteId),
        actualCostMinor: body.actualCostMinor === undefined || body.actualCostMinor === null
          ? null
          : Number(body.actualCostMinor),
        resultRef: body.resultRef === undefined || body.resultRef === null ? null : String(body.resultRef),
      },
    );
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '核对动作执行失败。');
  }
}

export const GET = withTeamRoute('/api/team/reconcile', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/reconcile', 'POST', __teamRoutePOST);
