import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { readFormulaSettings, saveFormulaSettings } from '@/lib/live-mixcut/formula/settings-store';
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
  const view = readFormulaSettings(db, projectId, id);
  return { db, id, projectId, view };
}

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { view } = await context(request, route.params);
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_settings_read_failed', '无法读取生成设置'); }
}

export async function PUT(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    const reader = request.body?.getReader();
    if (!reader) throw new BatchDomainError('invalid_input', '缺少生成设置');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new BatchDomainError('invalid_input', '生成设置请求超过 256 KiB'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '生成设置格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BatchDomainError('invalid_input', '生成设置格式不正确');
    const view = await saveFormulaSettings(db, projectId, id, { expectedInputRevision: body.expectedInputRevision,
      expectedSettingsRevision: body.expectedSettingsRevision, scriptsSessionId: body.scriptsSessionId, settings: body.settings, signal: request.signal });
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_settings_save_failed', '生成设置未保存，请重试'); }
}
