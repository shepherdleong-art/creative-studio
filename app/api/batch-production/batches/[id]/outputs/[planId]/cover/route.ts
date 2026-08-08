import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { regenerateBatchOutputCover } from '@/lib/batch-production/batch-renderer';
import { scheduleRenderAfterCoverChange } from '@/lib/batch-production/phase-e';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 换封面:改写 arrangement.cover.timeUs 后从原片重新抽帧,仍走原片不变量。 */
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
    const result = await regenerateBatchOutputCover({
      db,
      projectId,
      batchId: id,
      planId,
      timeUs: body.timeUs,
    });
    // 封面是成片片头的一部分,换封面必须重渲染这一条,否则成片开头留在旧封面。
    // requestKey 含封面时间点,所以同一封面重复触发不会重复排队。
    const renderTaskId = scheduleRenderAfterCoverChange(db, projectId, id, planId);
    if (renderTaskId) ensureBatchSchedulerStarted();
    return NextResponse.json({ ...result, renderTaskId }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_cover_failed', '换封面失败');
  }
}
