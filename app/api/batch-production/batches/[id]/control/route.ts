import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { pauseBatch, resumeBatch, stopBatch } from '@/lib/batch-production/scheduler';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批次控制:暂停(停止领取)、继续(恢复领取)、停止(结束未完成工作,保留成功结果)。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume' && action !== 'stop') {
    return NextResponse.json({
      error: 'invalid_action',
      message: 'action 必须是 pause、resume 或 stop',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    ensureBatchSchedulerStarted();
    const db = getDb();
    if (action === 'pause') {
      pauseBatch(db, projectId, id);
    } else if (action === 'resume') {
      resumeBatch(db, projectId, id);
    } else {
      stopBatch(db, projectId, id);
    }
    const controlState = (db.prepare(`
      SELECT controlState FROM batch_productions WHERE id = ?
    `).get(id) as { controlState: string }).controlState;
    return NextResponse.json({ batchId: id, controlState }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_control_failed', '批次控制失败');
  }
}
