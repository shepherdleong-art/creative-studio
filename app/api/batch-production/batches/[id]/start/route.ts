import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { startOrResumePhaseE } from '@/lib/batch-production/phase-e';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 冻结输入、执行幂等的全批联合分配，并把每条候选接入同一持久调度器。 */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    const result = startOrResumePhaseE(getDb(), projectId, id);
    ensureBatchSchedulerStarted();
    return NextResponse.json({
      batchId: id,
      status: 'running',
      batchVersionId: result.batchVersionId,
      allocationRunId: result.allocationRunId,
      allocationStatus: result.allocationStatus,
      outputCount: Object.keys(result.outputVersionIds).length,
      taskCount: Object.keys(result.taskIds).length,
    }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_start_failed', '批次启动失败');
  }
}
