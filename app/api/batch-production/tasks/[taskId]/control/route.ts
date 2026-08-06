import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { cancelTask, pauseTask, resumeTask } from '@/lib/batch-production/scheduler';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../batches/response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单个任务级控制:暂停/继续/取消,只影响这一个任务,不影响同批次的其他任务
 * 或整个批次的 controlState。与批次级 .../batches/[id]/control 是不同的 seam。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    return NextResponse.json({
      error: 'invalid_action',
      message: 'action 必须是 pause、resume 或 cancel',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  if (action === 'resume') {
    const managedGuard = await guardManagedWorkbench();
    if (managedGuard) return managedGuard;
  }
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
    const db = getDb();
    if (action === 'pause') {
      pauseTask(db, projectId, taskId);
    } else if (action === 'resume') {
      resumeTask(db, projectId, taskId);
      ensureBatchSchedulerStarted();
    } else {
      cancelTask(db, projectId, taskId);
    }
    const status = db.prepare(`
      SELECT status, expectedState FROM batch_tasks WHERE id = ? AND projectId = ?
    `).get(taskId, projectId) as { status: string; expectedState: string } | undefined;
    return NextResponse.json({ taskId, ...status }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'task_control_failed', '任务控制失败');
  }
}
