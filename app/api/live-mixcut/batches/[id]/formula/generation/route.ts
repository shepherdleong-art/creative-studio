import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { createFormulaGenerationRequest } from '@/lib/live-mixcut/formula/generation';
import { ensureBatchSchedulerStarted } from '@/lib/live-mixcut/bootstrap';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 保存一次生成请求后，由原持久调度器逐条推进；响应不返回冻结输入中的服务配置。 */
export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少生成请求');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new BatchDomainError('invalid_input', '生成请求过大'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '生成请求格式不正确'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BatchDomainError('invalid_input', '生成请求格式不正确');
    const { id } = await route.params;
    const result = await createFormulaGenerationRequest(getDb(), projectId, id, {
      requestKey: input.requestKey, settingsId: input.settingsId, expectedInputRevision: input.expectedInputRevision, signal: request.signal,
    });
    await ensureBatchSchedulerStarted();
    return NextResponse.json({ requestId: result.id, batchVersionId: result.batchVersionId, outputCount: result.outputs.length }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_generation_failed', '制作未能开始，请重试'); }
}
