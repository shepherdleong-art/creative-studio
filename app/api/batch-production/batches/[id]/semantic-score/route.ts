import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { queueBatchSemanticScoreTasks } from '@/lib/batch-production/semantic-match';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 手动(重)触发当前版本的语义矩阵打分。body 可带 providerId 换供应商
 * (新供应商摘要会形成新 requestKey);同供应商重复调用幂等跳过。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { providerId?: unknown } | null;
  const explicitProviderId = typeof body?.providerId === 'string' && body.providerId.trim()
    ? body.providerId.trim()
    : undefined;
  try {
    await assertBatchApiReady();
    const db = getDb();
    const batch = db.prepare(`
      SELECT currentVersionId FROM batch_productions
      WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(id, projectId) as { currentVersionId: string | null } | undefined;
    if (!batch) throw new BatchDomainError('not_found', '批次不存在');
    if (!batch.currentVersionId) throw new BatchDomainError('conflict', '批次尚未确认整体输入,请先建立快照');
    const result = await queueBatchSemanticScoreTasks(db, projectId, id, batch.currentVersionId, {
      explicitProviderId,
    });
    if (result.created.length > 0) ensureBatchSchedulerStarted();
    return NextResponse.json(result, { status: 200, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'semantic_score_trigger_failed', '语义匹配触发失败');
  }
}
