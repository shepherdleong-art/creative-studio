import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getBatchWorkspace } from '@/lib/batch-production/batch-workspace';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 面向批量工作区的稳定聚合视图；卡片状态由服务端领域事实推导。 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    ensureBatchSchedulerStarted();
    return NextResponse.json(getBatchWorkspace(getDb(), projectId, id), {
      headers: BATCH_NO_STORE_HEADERS,
    });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_workspace_failed', '批次工作区读取失败');
  }
}
