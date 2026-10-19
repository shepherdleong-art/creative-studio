import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resumeCanvasTask } from '@/lib/creative-canvas/recovery';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 继续一个确定未提交的任务：用原设置启动原任务，不读取后来修改的草稿。 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { taskId } = await params;
    const task = resumeCanvasTask(getDb(), { taskId });
    return NextResponse.json({ task: { id: task.id, phase: task.phase } });
  } catch (error) {
    return canvasJsonError(error);
  }
}
