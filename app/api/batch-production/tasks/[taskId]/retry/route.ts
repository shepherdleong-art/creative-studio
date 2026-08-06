import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { retryTask } from '@/lib/batch-production/scheduler';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../batches/response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 把失败的单个任务重新放入可领取队列;重试只增加任务尝试,不增加成片计划。 */
export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
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
    retryTask(db, projectId, taskId);
    return NextResponse.json({ taskId, status: 'queued' }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'task_retry_failed', '任务重试失败');
  }
}
