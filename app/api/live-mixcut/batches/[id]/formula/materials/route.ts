import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { getFormulaMaterialIndex, mapFormulaAssetBinding, refreshFormulaMaterialIndex } from '@/lib/live-mixcut/formula/material-bindings';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await route.params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    return NextResponse.json(await refreshFormulaMaterialIndex(getDb(), projectId, id, request.signal), { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_materials_failed', '无法读取视频编号'); }
}

export async function PATCH(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await route.params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
    await assertFormulaApiReady();
    const body = await request.json();
    if (!body || typeof body.bindingId !== 'string' || typeof body.logicalCode !== 'string' || !Number.isSafeInteger(body.expectedRevision)) throw new BatchDomainError('invalid_input', '请填写素材编号');
    mapFormulaAssetBinding(getDb(), projectId, id, body.bindingId, body);
    return NextResponse.json(getFormulaMaterialIndex(getDb(), projectId, id), { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_mapping_failed', '编号保存失败'); }
}
