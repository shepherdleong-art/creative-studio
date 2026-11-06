import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { reconcileCanvasTaskExecution, reconcileCanvasTaskNotCreated, reconcileCanvasTaskWithRemoteId } from '@/lib/creative-canvas/recovery';
import { assertCanvasApiReady, canvasJsonError, readCanvasJson } from '@/lib/creative-canvas/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { getTeamExecutionFacade } from '@/lib/team-service/runtime/index';


export const runtime = 'nodejs';

/**
 * 待核查任务的核查结论：确认远端没有创建（按失败收尾并释放名额），
 * 或填入实际远端任务 ID（接管原任务续查）。两者都不会重新提交。
 */
async function __teamRoutePOST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { taskId } = await params;
    const body = await readCanvasJson(request);
    const outcome = String(body.outcome ?? '');
    if (outcome === 'not_created') {
      if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server') {
        await reconcileCanvasTaskExecution(getDb(), getTeamExecutionFacade(), { taskId, outcome });
      }
      const task = reconcileCanvasTaskNotCreated(getDb(), { taskId });
      return NextResponse.json({ task: { id: task.id, phase: task.phase } });
    }
    if (outcome === 'remote_id') {
      const providerTaskId = String(body.providerTaskId ?? '');
      if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server') {
        await reconcileCanvasTaskExecution(getDb(), getTeamExecutionFacade(), { taskId, outcome, providerTaskId });
      }
      const task = reconcileCanvasTaskWithRemoteId(getDb(), {
        taskId,
        providerTaskId,
      });
      return NextResponse.json({ task: { id: task.id, phase: task.phase, providerTaskId: task.providerTaskId } });
    }
    throw new CanvasError('invalid_input', '核查结论必须是 not_created 或 remote_id。');
  } catch (error) {
    return canvasJsonError(error);
  }
}
export const POST = withTeamRoute('/api/canvas/tasks/[taskId]/reconcile', 'POST', __teamRoutePOST);
