import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { setBatchProductionArchived } from '@/lib/live-mixcut/versions';
import { readLiveMixcutBatch } from '@/lib/live-mixcut/batches';
import { BATCH_NO_STORE_HEADERS, batchProjectIdFromRequest, batchRouteErrorResponse } from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 归档只改变列表可见性；素材、制作历史、成片和导出文件均保留。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  const body = await request.json().catch(() => ({})) as { archived?: unknown };
  if (typeof body.archived !== 'boolean') return NextResponse.json({ error: 'invalid_input', message: '请明确归档或恢复批次' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  try {
    await assertBatchApiReady();
    setBatchProductionArchived(getDb(), projectId, id, body.archived);
    return NextResponse.json({ batch: readLiveMixcutBatch(getDb(), projectId, id) }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'live_mixcut_batch_archive_failed', body.archived ? '批次归档失败' : '批次恢复失败');
  }
}
