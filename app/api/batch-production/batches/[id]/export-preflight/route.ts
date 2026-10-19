import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { checkFormalExportPreflight } from '@/lib/batch-production/export-preflight';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 正式输出前置检查(交接文档 §4.3):只读校验批次当前版本是否具备正式导出条件,
 * 不建立 render 任务、不修改任何数据。Phase E 的正式 renderer 落地前,这个 route
 * 让用户和后续调用方都能提前看到"为什么还不能导出"的可操作原因。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    const batch = db.prepare(`
      SELECT currentVersionId FROM batch_productions WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(batchId, projectId) as { currentVersionId: string | null } | undefined;
    if (!batch) {
      throw new BatchDomainError('not_found', '批次不存在');
    }
    if (!batch.currentVersionId) {
      throw new BatchDomainError('conflict', '批次还没有任何输入快照');
    }
    const result = await checkFormalExportPreflight(db, batch.currentVersionId);
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'export_preflight_failed', '正式输出前置检查失败');
  }
}
