import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/batch-production/formula/runtime-readiness';
import { readFormulaAssetRanges, saveFormulaAssetRanges } from '@/lib/batch-production/formula/asset-ranges';
import { BatchDomainError } from '@/lib/batch-production/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function context(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
  await assertFormulaApiReady();
  const db = getDb();
  return { db, id, projectId, view: readFormulaAssetRanges(db, projectId, id) };
}

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { view } = await context(request, route.params);
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_ranges_read_failed', '无法读取可用区间'); }
}

export async function PUT(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少区间设置');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '区间请求超过 256 KiB'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '区间格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['assetId', 'contentFingerprint', 'expectedInputRevision', 'expectedRangeRevision', 'confirmed', 'ranges'].includes(key))) {
      throw new BatchDomainError('invalid_input', '区间格式不正确');
    }
    const view = await saveFormulaAssetRanges(db, projectId, id, { ...body, signal: request.signal });
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_ranges_save_failed', '可用区间未保存，请重试'); }
}
