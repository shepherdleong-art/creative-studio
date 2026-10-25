import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { changeBatchOutputCoverFrame } from '@/lib/batch-production/output-editing';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 历史兼容的换封面入口:改 arrangement.cover.timeUs 后走独立封面任务重新抽帧,
 * 不再依赖「先有一条完整视频候选」。与片段编辑的 set_cover 共用同一编辑入口,
 * 封面任务 requestKey 是统一 coverContractHash,同一契约重复触发幂等。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const body = await request.json().catch(() => ({})) as { timeUs?: unknown };
    if (typeof body.timeUs !== 'number' || !Number.isSafeInteger(body.timeUs) || body.timeUs < 0) {
      return NextResponse.json({
        error: 'invalid_time',
        message: '封面抽帧时间点必须是安全整数(微秒)',
      }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
    }
    const db = getDb();
    const result = await changeBatchOutputCoverFrame(db, projectId, id, planId, body.timeUs);
    if (!result) {
      return NextResponse.json({
        error: 'no_current_version',
        message: '当前成片版本还没有候选版本,不能换封面',
      }, { status: 409, headers: BATCH_NO_STORE_HEADERS });
    }
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_cover_failed', '换封面失败');
  }
}