import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { updateBatchAssetExclusionAndSchedule } from '@/lib/batch-production/phase-e';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 更改当前冻结批次版本内的素材排除，并重新执行整批联合分配。 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; assetId: string }> },
) {
  const { id: batchId, assetId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { excluded?: unknown; reason?: unknown } | null;
  if (typeof body?.excluded !== 'boolean') {
    return NextResponse.json({ error: 'invalid_input', message: 'excluded 必须是布尔值' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 200)
    : '用户从冻结素材池手工排除';
  try {
    await assertBatchApiReady();
    const result = updateBatchAssetExclusionAndSchedule(
      getDb(),
      projectId,
      batchId,
      assetId,
      body.excluded,
      reason,
    );
    ensureBatchSchedulerStarted();
    return NextResponse.json({
      batchId,
      assetId,
      excluded: body.excluded,
      allocationRunId: result.allocationRunId,
      allocationStatus: result.allocationStatus,
      outputCount: Object.keys(result.outputVersionIds).length,
      taskCount: Object.keys(result.taskIds).length,
    }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_asset_exclusion_failed', '批次素材排除修改失败');
  }
}
