import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { getBatchTasksView } from '@/lib/batch-production/tasks';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批次任务视图:任务、尝试与真实进度(阶段/完成数量),供主界面展示。 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  const { id } = await context.params;
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
    const view = getBatchTasksView(db, projectId, id);
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_tasks_failed', '任务列表读取失败');
  }
}
