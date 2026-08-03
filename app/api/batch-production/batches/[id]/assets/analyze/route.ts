import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { queueAssetPreparation } from '@/lib/batch-production/asset-preparation';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 在确认批次快照前为项目素材排队技术分析。分析版本属于项目素材库，
 * 所选 draft batch 只作为任务的调度/恢复载体；重复请求使用稳定 requestKey。
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { assetIds?: unknown } | null;
  if (!Array.isArray(body?.assetIds) || body.assetIds.length === 0 || body.assetIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({
      error: 'invalid_input',
      code: 'invalid_input',
      message: 'assetIds 必须是非空字符串数组',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }

  try {
    await assertBatchApiReady();
    const result = queueAssetPreparation(getDb(), projectId, batchId, body.assetIds as string[]);
    // 只有任务写入成功后才唤醒单例调度器；重复调用仍然幂等。
    ensureBatchSchedulerStarted();
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'asset_analysis_enqueue_failed', '素材分析排队失败');
  }
}
