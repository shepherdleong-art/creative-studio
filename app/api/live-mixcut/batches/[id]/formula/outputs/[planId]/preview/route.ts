import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { readFormulaPreview } from '@/lib/live-mixcut/formula/preview';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '@/app/api/live-mixcut/batches/response';

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
