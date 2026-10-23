import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { assertFormulaApiReady } from '@/lib/batch-production/formula/runtime-readiness';
import { createFormulaExportPackage, listFormulaExportPackages, FormulaPackageError } from '@/lib/batch-production/formula/export-package';
import { BatchDomainError } from '@/lib/batch-production/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/batch-production/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
function project(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('projectId');
  if (!id) throw new BatchDomainError('invalid_input', '缺少项目');
  return id;
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const projectId = project(request), { id } = await context.params;
    await assertBatchApiReady();
    return NextResponse.json({ packages: listFormulaExportPackages(getDb(), projectId, id) }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'package_list_failed', '导出包列表读取失败'); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const projectId = project(request), { id } = await context.params;
    await assertFormulaApiReady();
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少打包选择');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '打包请求过大'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '打包请求格式不正确'); }
    const saved = await createFormulaExportPackage(getDb(), projectId, id,
      { requestKey: body?.requestKey, items: body?.items, signal: request.signal });
    return NextResponse.json({ id: saved.id, createdAt: saved.createdAt, count: saved.manifest.items.length }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof FormulaPackageError) return NextResponse.json({ message: error.message, items: error.items }, { status: 409, headers: BATCH_NO_STORE_HEADERS });
    return batchRouteErrorResponse(error, 'package_create_failed', '打包失败，请重试');
  }
}
