import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { createLiveMixcutBatch, listLiveMixcutBatches } from '@/lib/live-mixcut/batches';
import { BATCH_NO_STORE_HEADERS, batchProjectIdFromRequest, batchRouteErrorResponse } from './response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  try {
    await assertBatchApiReady();
    const includeArchived = request.nextUrl.searchParams.get('includeArchived') === '1';
    return NextResponse.json({ projectId, batches: listLiveMixcutBatches(getDb(), projectId, { includeArchived }) }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'list_live_mixcut_batches_failed', '批次列表读取失败');
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { projectId?: unknown; name?: unknown; sourceBatchId?: unknown; copyInputs?: unknown };
  const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
  if (!projectId) return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  try {
    await assertBatchApiReady();
    const batch = createLiveMixcutBatch(getDb(), projectId, body);
    return NextResponse.json({ batch }, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'create_live_mixcut_batch_failed', '批次创建失败');
  }
}
