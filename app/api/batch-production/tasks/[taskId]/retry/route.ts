import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { retryTask } from '@/lib/batch-production/scheduler';
import { clearBatchSubtitleOverridesForNarrationRetry } from '@/lib/batch-production/output-arrangement';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 把失败的单个任务重新放入可领取队列;重试只增加任务尝试,不增加成片计划。 */
export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    ensureBatchSchedulerStarted();
    const db = getDb();
    const task = db.prepare(`
      SELECT batchId, workType, targetKind, targetId, status
      FROM batch_tasks WHERE id = ? AND projectId = ?
    `).get(taskId, projectId) as {
      batchId: string;
      workType: string;
      targetKind: string;
      targetId: string;
      status: string;
    } | undefined;
    const shouldClearSubtitleOverride = task?.workType === 'narration'
      && task.targetKind === 'script_snapshot'
      && task.status === 'failed';
    retryTask(db, projectId, taskId);
    // 先确认重试成功再清除人工字幕,避免 retryTask 失败时破坏用户现有编辑。
    const subtitleOverrideCleared = shouldClearSubtitleOverride
      ? clearBatchSubtitleOverridesForNarrationRetry(db, projectId, task!.batchId, task!.targetId)
      : 0;
    return NextResponse.json({ taskId, status: 'queued', subtitleOverrideCleared }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'task_retry_failed', '任务重试失败');
  }
}
