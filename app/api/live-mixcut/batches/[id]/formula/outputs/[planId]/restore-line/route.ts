import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { restoreFormulaScheduleLine } from '@/lib/live-mixcut/formula/restore-line';
import { ensureBatchSchedulerStarted } from '@/lib/live-mixcut/bootstrap';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/live-mixcut/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ id: string; planId: string }> };

export async function POST(request: NextRequest, route: Route) {
  try {
    const { id, planId } = await route.params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少恢复设置');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '恢复请求超过 16 KiB'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '恢复设置格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['lineIndex', 'expectedOutputVersionId'].includes(key))) {
      throw new BatchDomainError('invalid_input', '恢复设置包含不支持的字段');
    }
    request.signal.throwIfAborted();
    const result = restoreFormulaScheduleLine(getDb(), projectId, id, planId,
      { lineIndex: body.lineIndex, expectedOutputVersionId: body.expectedOutputVersionId });
    ensureBatchSchedulerStarted();
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_restore_line_failed', '恢复这一行没有完成，请重试'); }
}
