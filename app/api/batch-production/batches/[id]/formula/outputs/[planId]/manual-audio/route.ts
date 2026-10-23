import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/batch-production/errors';
import { assertFormulaApiReady } from '@/lib/batch-production/formula/runtime-readiness';
import { readFormulaManualAudio, saveFormulaManualAudio } from '@/lib/batch-production/formula/manual-audio-mapping';
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
  return { db, id, planId, projectId, view: readFormulaManualAudio(db, projectId, id, planId) };
}
export async function GET(request: NextRequest, route: Route) {
  try {
    const { view } = await context(request, route);
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_manual_audio_read_failed', '无法读取声音用途'); }
}
export async function POST(request: NextRequest, route: Route) {
  try {
    const { db, id, planId, projectId } = await context(request, route);
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少声音用途');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '声音用途请求超过 256 KiB'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '声音用途格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key =>
      !['requestKey', 'expectedStageId', 'expectedMappingStageId', 'expectedOutputVersionId', 'expectedEditRevision', 'confirmed', 'blocks'].includes(key))) {
      throw new BatchDomainError('invalid_input', '声音用途包含不支持的字段');
    }
    const saved = await saveFormulaManualAudio(db, projectId, id, planId, body, request.signal);
    ensureBatchSchedulerStarted();
    return NextResponse.json(saved, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_manual_audio_save_failed', '声音用途未保存，请重试'); }
}
