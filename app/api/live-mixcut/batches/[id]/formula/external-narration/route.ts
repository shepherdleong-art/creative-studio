import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { readFormulaExternalNarrations, publicFormulaExternalNarrations, saveFormulaExternalNarration } from '@/lib/live-mixcut/formula/external-narration';
import { assertFormulaNarrationAudio } from '@/lib/live-mixcut/formula/narration';
import { projectAssetMediaResponse } from '@/lib/live-mixcut/project-asset-media-response';
import { projectAssetFileIdentity } from '@/lib/live-mixcut/project-asset-media';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function context(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params, projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
  await assertFormulaApiReady();
  const db = getDb();
  return { db, id, projectId, view: readFormulaExternalNarrations(db, projectId, id) };
}
export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { view, projectId } = await context(request, route.params), narrationId = request.nextUrl.searchParams.get('narrationId');
    if (narrationId) {
      const saved = view.items.find(item => item.saved?.id === narrationId)?.saved;
      if (!saved?.audio) throw new BatchDomainError('not_found', '这份外部配音不属于当前批次或已移除');
      const absolute = assertFormulaNarrationAudio(projectId, saved.text, saved.audio);
      return projectAssetMediaResponse(request, absolute, 'audio/wav', BATCH_NO_STORE_HEADERS, projectAssetFileIdentity(fs.statSync(absolute)));
    }
    return NextResponse.json(publicFormulaExternalNarrations(view), { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_external_narration_read_failed', '无法读取外部配音'); }
}
export async function PUT(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.startsWith('multipart/form-data;')) throw new BatchDomainError('invalid_input', '请同时上传音频和 SRT');
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少上传内容');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 61 * 1024 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '上传请求不能超过 61 MiB'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': contentType } }).formData();
    if ([...form.keys()].some(key => !['metadata', 'audio', 'srt'].includes(key)) || form.getAll('metadata').length !== 1
      || form.getAll('audio').length > 1 || form.getAll('srt').length > 1) throw new BatchDomainError('invalid_input', '上传字段无效');
    const metadata = form.get('metadata');
    if (typeof metadata !== 'string' || metadata.length > 4096) throw new BatchDomainError('invalid_input', '缺少脚本及确认信息');
    let input;
    try { input = JSON.parse(metadata); } catch { throw new BatchDomainError('invalid_input', '脚本信息格式无效'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key =>
      !['scriptKey', 'scriptsSessionId', 'expectedInputRevision', 'expectedNarrationRevision', 'confirmed', 'remove'].includes(key))) {
      throw new BatchDomainError('invalid_input', '脚本信息格式无效');
    }
    const audio = form.get('audio'), srt = form.get('srt');
    if (!input.remove && (!(audio instanceof File) || !(srt instanceof File) || srt.size > 256 * 1024)) {
      throw new BatchDomainError('invalid_input', '请选择音频和不超过 256 KiB 的 UTF-8 SRT');
    }
    let srtText: string | undefined;
    try { if (srt instanceof File) srtText = new TextDecoder('utf-8', { fatal: true }).decode(await srt.arrayBuffer()); }
    catch { throw new BatchDomainError('invalid_input', 'SRT 不是 UTF-8 编码，请另存为 UTF-8 后导入'); }
    const view = await saveFormulaExternalNarration(db, projectId, id, { ...input,
      filename: audio instanceof File ? audio.name : undefined, bytes: audio instanceof File ? Buffer.from(await audio.arrayBuffer()) : undefined,
      srt: srtText, signal: request.signal });
    return NextResponse.json(publicFormulaExternalNarrations(view), { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_external_narration_save_failed', '外部配音未保存，请重试'); }
}
