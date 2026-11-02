import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getBatchSnapshotDetail } from '@/lib/batch-production/batch-flow';
import { deleteBatchProduction } from '@/lib/batch-production/versions';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 批次详情(当前版本:脚本快照、素材池、成片计划),供卡片检查。 */
async function __teamRouteGET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
async function __teamRouteDELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400, headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    deleteBatchProduction(getDb(), projectId, id);
    return NextResponse.json({ success: true, mode: 'soft' }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_delete_failed', '批次删除失败');
  }
}

export const GET = withTeamRoute('/api/batch-production/batches/[id]', 'GET', __teamRouteGET);
export const DELETE = withTeamRoute('/api/batch-production/batches/[id]', 'DELETE', __teamRouteDELETE);
