import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { downloadFormulaExportPackage } from '@/lib/live-mixcut/formula/export-package-download';
import { FormulaPackageError } from '@/lib/live-mixcut/formula/export-package';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/live-mixcut/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; packageId: string }> }) {
  try {
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertBatchApiReady(); // Historical packages remain readable when formula execution is off.
    const { id, packageId } = await context.params;
    const result = await downloadFormulaExportPackage(getDb(), projectId, id, packageId, request.signal);
    return new NextResponse(result.stream, { headers: { ...BATCH_NO_STORE_HEADERS, 'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="formula-export.zip"; filename*=UTF-8''${encodeURIComponent(result.filename)}` } });
  } catch (error) {
    if (error instanceof FormulaPackageError) return new NextResponse([error.message, ...error.items.map(item => item.message)].join('\n'),
      { status: 409, headers: { ...BATCH_NO_STORE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    return batchRouteErrorResponse(error, 'package_download_failed', '导出包下载失败，请重试');
  }
}
