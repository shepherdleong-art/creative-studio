import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { retryCanvasTaskDownload } from '@/lib/creative-canvas/recovery';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 补下载原任务产物：用已保存的远端身份重新取回，不新增生成调用。 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { taskId } = await params;
    const task = retryCanvasTaskDownload(getDb(), { taskId });
    return NextResponse.json({ task: { id: task.id, phase: task.phase, providerTaskId: task.providerTaskId } });
  } catch (error) {
    return canvasJsonError(error);
  }
}
