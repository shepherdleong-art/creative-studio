import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { applyBatchOutputClipEdit } from '@/lib/batch-production/output-arrangement';
import { resolveCoverContract } from '@/lib/batch-production/cover-contract';
import { scheduleRenderAfterCoverChange } from '@/lib/batch-production/phase-e';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
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
    const plan = db.prepare(`
      SELECT p.currentVersionId
      FROM batch_output_plans p
      JOIN batch_production_versions v ON v.id = p.batchVersionId
      JOIN batch_productions b ON b.id = v.batchId
      WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
    `).get(planId, id, projectId) as { currentVersionId: string | null } | undefined;
    if (!plan?.currentVersionId) {
      return NextResponse.json({
        error: 'no_current_version',
        message: '当前成片版本还没有候选版本,不能换封面',
      }, { status: 409, headers: BATCH_NO_STORE_HEADERS });
    }
    // 保留当前封面素材,只改抽帧时间点(与渲染契约的封面素材解析一致)。
    const cover = resolveCoverContract(db, plan.currentVersionId);
    const result = applyBatchOutputClipEdit(db, projectId, id, planId, {
      type: 'set_cover',
      assetId: cover.assetId,
      timeUs: body.timeUs,
    });
    const coverTaskId = scheduleRenderAfterCoverChange(db, projectId, id, planId);
    if (coverTaskId) ensureBatchSchedulerStarted();
    return NextResponse.json({ ...result, coverTaskId }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_cover_failed', '换封面失败');
  }
}