import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { getTeamExecutionFacade } from '@/lib/team-service/runtime';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { productionParamsFor } from '@/lib/team-service/production-defaults';
import { teamServiceError } from '@/lib/team-service/http-error';
import { getQueueStatus, runQueue } from '@/lib/queue';
import { getVideoQueueStatus, runVideoQueue, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import {
  applyUnifiedReconcileAction,
  listUnifiedReconcileTasks,
  type UnifiedReconcileActionInput,
} from '@/lib/team-service/unified-reconcile';

function viewer() {
  const access = requireAccessContext();
  return { userId: access.actor.userId, role: access.actor.role };
}

function resumeSettlementAfterReconcile(mediaTaskId: string): void {
  const db = getDb();
  const task = db.prepare(`SELECT module, taskId, scopeId FROM execution_media_tasks WHERE id = ?`)
    .get(mediaTaskId) as { module: string; taskId: string; scopeId: string } | undefined;
  if (!task) return;
  const runtime = readRuntimeConfig();
  if (task.module === 'image') {
    const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(task.taskId) as string | undefined;
    if (!status || getQueueStatus(task.scopeId) !== 'idle') return;
    if (!['pending', 'retrying', 'deferred', 'needs_check', 'canceled'].includes(status)) return;
    const project = db.prepare('SELECT concurrency, maxAttempts, timeoutMs FROM projects WHERE id = ?')
      .get(task.scopeId) as { concurrency: number; maxAttempts: number; timeoutMs: number } | undefined;
    if (!project) return;
    const production = productionParamsFor(runtime, project);
    void runQueue({
      projectId: task.scopeId,
      jobId: task.taskId,
      concurrency: Math.max(1, production.projectConcurrency),
      maxAttempts: Math.max(1, project.maxAttempts || 1),
      timeoutMs: Math.max(1, production.timeoutMs),
    }).catch(() => undefined);
    return;
  }
  if (task.module === 'video') {
    const job = db.prepare('SELECT status FROM video_jobs WHERE id = ?')
      .get(task.taskId) as { status: string } | undefined;
    if (!job || getVideoQueueStatus(task.scopeId) !== 'idle') return;
    if (!['pending', 'deferred', 'needs_check', 'canceled'].includes(job.status)) return;
    const project = db.prepare('SELECT videoConcurrency FROM projects WHERE id = ?')
      .get(task.scopeId) as { videoConcurrency: number | null } | undefined;
    const concurrency = runtime.mode === 'server'
      ? productionParamsFor(runtime).videoConcurrency
      : Math.max(1, Math.min(10, Number(project?.videoConcurrency) || 10));
    void runVideoQueue({
      projectId: task.scopeId,
      jobId: task.taskId,
      concurrency,
      timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
    }).catch(() => undefined);
  }
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
    resumeSettlementAfterReconcile(String(body.mediaTaskId ?? ''));
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '核对动作执行失败。');
  }
}

export const GET = withTeamRoute('/api/team/reconcile', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/reconcile', 'POST', __teamRoutePOST);
