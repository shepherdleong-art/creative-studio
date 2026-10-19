import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getBatchSnapshotDetail } from '@/lib/batch-production/batch-flow';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批次详情(当前版本:脚本快照、素材池、成片计划),供卡片检查。 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    const db = getDb();
    const detail = getBatchSnapshotDetail(db, projectId, id);
    return NextResponse.json(detail, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_detail_failed', '批次详情读取失败');
  }
}
