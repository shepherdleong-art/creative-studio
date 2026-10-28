import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { createFormulaImportSession, confirmFormulaImportSession, readFormulaInputs, remapFormulaImportSession, analyzeFormulaImportSession, editFormulaScriptRow, reviseFormulaScriptImport, cancelFormulaImportAnalysis } from '@/lib/live-mixcut/formula/import-store';
import { listTextJsonModels, resolveTextJsonModel } from '@/lib/media-core/adapters/text-json';
import { FORMULA_WORKBOOK_LIMITS } from '@/lib/live-mixcut/formula/workbook-budget';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readBoundedBody(request: NextRequest, limit: number): Promise<Buffer> {
  if (Number(request.headers.get('content-length')) > limit) throw new BatchDomainError('invalid_input', '上传内容超过大小限制');
  const reader = request.body?.getReader();
  if (!reader) throw new BatchDomainError('invalid_input', '上传内容为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BatchDomainError('invalid_input', '上传内容超过大小限制');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function context(request: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目');
  await assertFormulaApiReady();
  const db = getDb();
  // 在接受上传前检查批次归属。
  readFormulaInputs(db, projectId, id);
  return { db, id, projectId };
}

export async function GET(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    return NextResponse.json({ ...readFormulaInputs(db, projectId, id), aiProviders: await listTextJsonModels() }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_read_failed', '无法读取公式资料'); }
}

/** 文件作为请求正文传输，读取中执行 10 MiB 上限，避免先解析无限 multipart。 */
export async function POST(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    const kind = request.nextUrl.searchParams.get('kind');
    if (kind !== 'materials' && kind !== 'scripts') throw new BatchDomainError('invalid_input', '请选择素材表或脚本表');
    const revision = request.nextUrl.searchParams.get('revision');
    if (revision === null) throw new BatchDomainError('invalid_input', '缺少资料版本');
    const session = await createFormulaImportSession(db, projectId, id, {
      kind, filename: request.nextUrl.searchParams.get('filename') ?? '工作簿.xlsx',
      expectedRevision: Number(revision), bytes: await readBoundedBody(request, FORMULA_WORKBOOK_LIMITS.bytes),
    });
    return NextResponse.json(session, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_import_failed', '工作簿读取失败，请检查文件格式'); }
}

export async function PUT(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    let body;
    try { body = JSON.parse((await readBoundedBody(request, 256 * 1024)).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '确认请求格式不正确'); }
    if (!body || typeof body.sessionId !== 'string' || !Number.isSafeInteger(body.expectedRevision)) throw new BatchDomainError('invalid_input', '缺少导入会话或资料版本');
    const receipt = confirmFormulaImportSession(db, projectId, id, body.sessionId, {
      expectedRevision: body.expectedRevision, expectedDraftRevision: body.expectedDraftRevision, excludedKeys: body.excludedKeys,
    });
    return NextResponse.json(receipt, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_confirm_failed', '资料确认失败'); }
}

export async function PATCH(request: NextRequest, route: { params: Promise<{ id: string }> }) {
  try {
    const { db, id, projectId } = await context(request, route.params);
    let body;
    try { body = JSON.parse((await readBoundedBody(request, 256 * 1024)).toString('utf8')); }
    catch { throw new BatchDomainError('invalid_input', '修改请求格式不正确'); }
    if (!body || typeof body.sessionId !== 'string' || !Number.isSafeInteger(body.expectedRevision)
      || (body.action !== 'revise_scripts' && !Number.isSafeInteger(body.expectedDraftRevision))) throw new BatchDomainError('invalid_input', '缺少导入会话或预览版本');
    const expected = { expectedRevision: body.expectedRevision, expectedDraftRevision: body.expectedDraftRevision };
    let session;
    if (body.action === 'revise_scripts') {
      session = await reviseFormulaScriptImport(db, projectId, id, body.sessionId, expected);
    } else if (body.action === 'edit_script') {
      if (typeof body.key !== 'string') throw new BatchDomainError('invalid_input', '缺少脚本行');
      session = await editFormulaScriptRow(db, projectId, id, body.sessionId, { ...expected, key: body.key, values: body.values });
    } else if (body.action === 'mapping') {
      if (!Array.isArray(body.mapping)) throw new BatchDomainError('invalid_input', '缺少列对应关系');
      session = await remapFormulaImportSession(db, projectId, id, body.sessionId, { ...expected, mapping: body.mapping });
    } else if (body.action === 'cancel_ai') {
      session = cancelFormulaImportAnalysis(db, projectId, id, body.sessionId, expected);
    } else if (body.action === 'ai') {
      if (typeof body.providerId !== 'string') throw new BatchDomainError('invalid_input', '请选择用于识别的脚本模型');
      let model;
      try { model = await resolveTextJsonModel(body.providerId, { projectId, refType: 'formula_import', refId: body.sessionId }); }
      catch { throw new BatchDomainError('invalid_input', '所选脚本模型未配置或不可用，请到设置中检查，也可手动选择列'); }
      session = await analyzeFormulaImportSession(db, projectId, id, body.sessionId, { ...expected, signal: request.signal }, model);
    } else throw new BatchDomainError('invalid_input', '不支持的导入操作');
    return NextResponse.json(session, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) { return batchRouteErrorResponse(error, 'formula_extraction_failed', '表格识别或修改失败'); }
}
