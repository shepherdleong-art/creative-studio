import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { getTask, updateTask } from '@/lib/script-studio/tasks';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';
import { requestScriptStudioTaskCancel } from '@/lib/script-studio/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, taskId } = await params;
    const db = getDb();
    const task = getTask(db, projectId, taskId);
    if (!task) throw new ScriptStudioError('not_found', '任务不存在或不属于当前项目');
    if (!['queued', 'running'].includes(task.status)) {
      throw new ScriptStudioError('conflict', '只有排队中或运行中的任务可以停止');
    }
    // running：打取消标记并中断执行信号，由 runner 落库为 cancelled；
    // queued（调度器未领取或已关闭）：直接落库，之后不会被领取。
    const wasRunning = requestScriptStudioTaskCancel(taskId);
    const next = wasRunning
      ? task
      : updateTask(db, projectId, taskId, {
          status: 'cancelled',
          currentStage: '',
          errorCode: 'cancelled',
          errorMessage: '已手动停止',
          leaseUntil: null,
        });
    return NextResponse.json({ task: toTaskSnapshot(getTask(db, projectId, next.id)!), cancelRequested: true }, { status: 202 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
