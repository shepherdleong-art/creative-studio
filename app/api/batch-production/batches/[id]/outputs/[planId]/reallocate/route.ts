import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { reallocateAndScheduleOutput } from '@/lib/batch-production/phase-e';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 只重分配目标计划；其他计划的候选版本和正式产物保持不变。 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; planId: string }> },
) {
  const { id: batchId, planId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 200)
    : 'manual';
  try {
    await assertBatchApiReady();
    const result = reallocateAndScheduleOutput(getDb(), projectId, batchId, planId, reason);
    ensureBatchSchedulerStarted();
    return NextResponse.json({
      batchId,
      planId,
      allocationRunId: result.allocationRunId,
      allocationStatus: result.allocationStatus,
      outputVersionId: result.outputVersionIds[planId] ?? null,
      taskId: result.taskIds[planId] ?? null,
    }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_reallocation_failed', '单条重新分配失败');
  }
}
