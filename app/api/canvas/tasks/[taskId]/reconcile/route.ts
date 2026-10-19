import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { reconcileCanvasTaskNotCreated, reconcileCanvasTaskWithRemoteId } from '@/lib/creative-canvas/recovery';
import { assertCanvasApiReady, canvasJsonError, readCanvasJson } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/**
 * 待核查任务的核查结论：确认远端没有创建（按失败收尾并释放名额），
 * 或填入实际远端任务 ID（接管原任务续查）。两者都不会重新提交。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { taskId } = await params;
    const body = await readCanvasJson(request);
    const outcome = String(body.outcome ?? '');
    if (outcome === 'not_created') {
      const task = reconcileCanvasTaskNotCreated(getDb(), { taskId });
      return NextResponse.json({ task: { id: task.id, phase: task.phase } });
    }
    if (outcome === 'remote_id') {
      const task = reconcileCanvasTaskWithRemoteId(getDb(), {
        taskId,
        providerTaskId: String(body.providerTaskId ?? ''),
      });
      return NextResponse.json({ task: { id: task.id, phase: task.phase, providerTaskId: task.providerTaskId } });
    }
    throw new CanvasError('invalid_input', '核查结论必须是 not_created 或 remote_id。');
  } catch (error) {
    return canvasJsonError(error);
  }
}
