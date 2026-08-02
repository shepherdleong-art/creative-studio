import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { startBatchProduction } from '@/lib/batch-production/batch-flow';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 在同一事务中读取最新上游输入、校验精确计划数并永久冻结当前版本。 */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    startBatchProduction(getDb(), projectId, id);
    return NextResponse.json({ batchId: id, status: 'running' }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_start_failed', '批次启动失败');
  }
}
