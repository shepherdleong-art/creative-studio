import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { parseFormulaReplacementHints, FORMULA_REPLACEMENT_HINT_BYTES } from '@/lib/live-mixcut/formula/replacement-hints';
import { readFormulaReplacementHints, saveFormulaReplacementHints } from '@/lib/live-mixcut/formula/replacement-hints-store';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function context(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params, projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
  await assertFormulaApiReady();
  const db = getDb(), view = readFormulaReplacementHints(db, projectId, id);
  return { db, id, projectId, view };
}
export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json((await context(request, route.params)).view, { headers: BATCH_NO_STORE_HEADERS }); }
  catch (error) { return batchRouteErrorResponse(error, 'formula_hints_read_failed', '无法读取替换建议'); }
}
export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId, view } = await context(request, route.params);
    const query = request.nextUrl.searchParams, action = query.get('action'), revision = query.get('expectedRevision');
    if (!revision || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new BatchDomainError('invalid_input', '缺少有效的资料版本');
    const expectedInputRevision = Number(revision);
    if (action === 'clear') {
      request.signal.throwIfAborted();
      return NextResponse.json(saveFormulaReplacementHints(db, projectId, id, { expectedInputRevision, clear: true }), { headers: BATCH_NO_STORE_HEADERS });
    }
    if (action !== 'preview' && action !== 'save') throw new BatchDomainError('invalid_input', '请选择预览或保存建议');
    if (action === 'preview' && (!view.editable || view.inputRevision !== expectedInputRevision)) throw new BatchDomainError('conflict', '资料已更新或锁定，请重新读取');
    if (Number(request.headers.get('content-length')) > FORMULA_REPLACEMENT_HINT_BYTES) throw new BatchDomainError('invalid_input', '文件超过 256 KiB');
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '请选择替换建议文件');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > FORMULA_REPLACEMENT_HINT_BYTES) { await reader.cancel(); throw new BatchDomainError('invalid_input', '文件超过 256 KiB'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    request.signal.throwIfAborted();
    const filename = query.get('filename') ?? '', bytes = Buffer.concat(chunks, size);
    const result = action === 'preview' ? parseFormulaReplacementHints(filename, bytes)
      : saveFormulaReplacementHints(db, projectId, id, { expectedInputRevision, filename, bytes });
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_hints_save_failed', '替换建议未保存，请重试'); }
}
