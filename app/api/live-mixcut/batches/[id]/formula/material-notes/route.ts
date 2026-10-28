import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { readFormulaMaterialNotes, saveFormulaMaterialNote, organizeFormulaMaterialNotes } from '@/lib/live-mixcut/formula/material-notes';
import { listTextJsonModels, resolveTextJsonModel } from '@/lib/media-core/adapters/text-json';
import { listVideoContentModels, resolveVideoContentModel } from '@/lib/media-core/adapters/video-analysis';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function context(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
  await assertFormulaApiReady();
  const db = getDb();
  const notes = readFormulaMaterialNotes(db, projectId, id);
  return { db, id, projectId, notes };
}

async function readBody(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new BatchDomainError('invalid_input', '请求内容为空');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '素材说明请求超过 64 KiB'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || !Number.isSafeInteger(body.expectedRevision)) throw new Error();
    return body;
  } catch { throw new BatchDomainError('invalid_input', '缺少有效的素材资料版本'); }
}

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { notes } = await context(request, route.params);
    const aiProviders = await listTextJsonModels().catch(() => []);
    const videoProviders = await listVideoContentModels().catch(() => []);
    return NextResponse.json({ ...notes, aiProviders, videoProviders }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_material_notes_failed', '无法读取素材说明'); }
}

export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    const body = await readBody(request);
    if (typeof body.providerId !== 'string') throw new BatchDomainError('invalid_input', '请选择脚本模型');
    if (body.mode !== undefined && !['filename', 'video'].includes(body.mode)) throw new BatchDomainError('invalid_input', '请选择有效的素材分析方式');
    let model;
    try { model = body.mode === 'video' ? await resolveVideoContentModel(body.providerId)
      : await resolveTextJsonModel(body.providerId, { refType: 'formula_material_notes', refId: id }); }
    catch { throw new BatchDomainError('invalid_input', '所选脚本模型未配置或不可用，可先手动填写素材说明'); }
    const result = await organizeFormulaMaterialNotes(db, projectId, id, { expectedRevision: body.expectedRevision, signal: request.signal, mode: body.mode }, model);
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_material_organize_failed', '素材整理失败，请重试'); }
}

export async function PATCH(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    const body = await readBody(request);
    if (typeof body.bindingId !== 'string' || (body.expectedProfileId !== null && typeof body.expectedProfileId !== 'string')) throw new BatchDomainError('invalid_input', '缺少素材来源或说明版本');
    saveFormulaMaterialNote(db, projectId, id, body.bindingId, body);
    return NextResponse.json(readFormulaMaterialNotes(db, projectId, id), { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_material_note_save_failed', '素材说明保存失败'); }
}
