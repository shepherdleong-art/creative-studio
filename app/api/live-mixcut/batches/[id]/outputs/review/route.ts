import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { setBatchPlanReviews } from '@/lib/live-mixcut/review';
import type { BatchReviewTarget } from '@/lib/live-mixcut/review-context';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批量写入审核决定(通过/返工/撤销),一次请求处理整组选中集。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    const body = await request.json().catch(() => ({})) as {
      items?: unknown;
      decision?: unknown;
    };
    const decision = body.decision === null || body.decision === undefined
      ? null
      : typeof body.decision === 'string' ? body.decision : 'invalid';
    const result = setBatchPlanReviews(getDb(), projectId, id, {
      items: (Array.isArray(body.items) ? body.items : []) as BatchReviewTarget[],
      decision: decision as 'approved' | 'rework' | 'cancelled' | null,
    });
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'live_mixcut_review_failed', '审核操作失败');
  }
}
