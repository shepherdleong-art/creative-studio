import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requestCanvasTaskCancel } from '@/lib/creative-canvas/recovery';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

/** 停止任务：未提交的直接取消；已提交的只记录取消意图，按真实远端能力收尾。 */
async function __teamRoutePOST(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { taskId } = await params;
    const task = requestCanvasTaskCancel(getDb(), { taskId });
    return NextResponse.json({ task: { id: task.id, phase: task.phase, cancelRequestedAt: task.cancelRequestedAt } });
  } catch (error) {
    return canvasJsonError(error);
  }
}
export const POST = withTeamRoute('/api/canvas/tasks/[taskId]/cancel', 'POST', __teamRoutePOST);
