import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requestCanvasTaskCancel } from '@/lib/creative-canvas/recovery';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 停止任务：未提交的直接取消；已提交的只记录取消意图，按真实远端能力收尾。 */
export async function POST(
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
