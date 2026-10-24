import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { beginFormulaInputRevision } from '@/lib/live-mixcut/formula/input-revision';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/live-mixcut/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少当前制作版本');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new BatchDomainError('invalid_input', '修改请求过大'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '修改请求格式不正确'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BatchDomainError('invalid_input', '修改请求格式不正确');
    const { id } = await context.params;
    const state = beginFormulaInputRevision(getDb(), projectId, id, {
      expectedBatchVersionId: input.expectedBatchVersionId, expectedInputRevision: input.expectedInputRevision,
    });
    return NextResponse.json(state, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_input_revision_failed', '未能打开输入修改，请重试'); }
}
