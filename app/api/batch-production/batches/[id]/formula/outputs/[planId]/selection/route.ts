import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/batch-production/errors';
import { assertFormulaApiReady } from '@/lib/batch-production/formula/runtime-readiness';
import { readFormulaSelectionHistory, reselectFormulaOutput } from '@/lib/batch-production/formula/reselection';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/batch-production/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ id: string; planId: string }> };

async function context(request: NextRequest, route: Route) {
  const { id, planId } = await route.params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
  await assertFormulaApiReady();
  const db = getDb();
  // 在读取请求正文或排队之前校验归属。
  const view = readFormulaSelectionHistory(db, projectId, id, planId);
  return { db, id, planId, projectId, view };
}

export async function GET(request: NextRequest, route: Route) {
  try {
    const { view } = await context(request, route);
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_selection_read_failed', '无法读取选片记录'); }
}

export async function POST(request: NextRequest, route: Route) {
  try {
    const { db, id, planId, projectId } = await context(request, route);
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少重选设置');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '重选请求超过 256 KiB'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '重选设置格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['requestKey','expectedStageId','expectedOutputVersionId','expectedEditRevision','overrides'].includes(key))) {
      throw new BatchDomainError('invalid_input', '重选设置包含不支持的字段');
    }
    request.signal.throwIfAborted();
    const view = reselectFormulaOutput(db, projectId, id, planId, body);
    ensureBatchSchedulerStarted();
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_reselection_failed', '重新选片未完成，请重试'); }
}
