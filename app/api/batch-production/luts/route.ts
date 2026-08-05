import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { importLut, listProjectLuts, LutImportError } from '@/lib/batch-production/lut-catalog';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// LUT 是纯文本 .cube 文件,常见 17/33/65 点位也只有几百 KB;8MB 已经是宽裕上限,
// 不需要 material-import 那种大文件流式暂存,整段读入内存即可安全处理。
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const includeArchived = request.nextUrl.searchParams.get('includeArchived') === '1';
  try {
    await assertBatchApiReady();
    const luts = listProjectLuts(getDb(), projectId, { includeArchived });
    return NextResponse.json({ luts }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'lut_list_failed', 'LUT 列表读取失败');
  }
}

/** 导入一份 LUT(浏览器文件选择上传);服务端不接受任意本机绝对路径。 */
export async function POST(request: NextRequest) {
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const form = await request.formData().catch(() => {
      throw new LutImportError('invalid_form_data', '无法解析上传表单');
    });
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new LutImportError('missing_file', '缺少上传文件');
    }
    if (file.size > MAX_REQUEST_BYTES) {
      throw new LutImportError('lut_too_large', 'LUT 文件超出大小限制');
    }
    const data = Buffer.from(await file.arrayBuffer());
    const db = getDb();
    const result = await importLut(db, projectId, {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      data,
    });
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof LutImportError) {
      return NextResponse.json({
        error: error.code,
        message: error.message,
      }, { status: error.status, headers: BATCH_NO_STORE_HEADERS });
    }
    return batchRouteErrorResponse(error, 'lut_import_failed', 'LUT 导入失败');
  }
}
