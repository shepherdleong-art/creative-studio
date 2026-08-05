import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { setBatchProductionArchived } from '@/lib/batch-production/versions';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 归档/恢复批次。归档不删除任何数据,恢复后成片与导出文件完好。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { archived?: unknown } | null;
  const archived = body?.archived === true;
  try {
    await assertBatchApiReady();
    setBatchProductionArchived(getDb(), projectId, id, archived);
    return NextResponse.json({ batchId: id, archived }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_archive_failed', archived ? '批次归档失败' : '批次恢复失败');
  }
}
