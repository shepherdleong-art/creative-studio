import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/batch-production/errors';
import { assertFormulaApiReady } from '@/lib/batch-production/formula/runtime-readiness';
import { readFormulaPreview } from '@/lib/batch-production/formula/preview';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/batch-production/batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, route: { params: Promise<{ id: string; planId: string }> }) {
  try {
    const { id, planId } = await route.params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    return NextResponse.json(readFormulaPreview(getDb(), projectId, id, planId), { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_preview_failed', '无法读取排片预览'); }
}
