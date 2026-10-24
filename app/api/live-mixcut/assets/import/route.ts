import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { registerManagedCopy, verifyAssetSources } from '@/lib/live-mixcut/media-catalog';
import { assertFormulaApiReady } from '@/lib/live-mixcut/formula/runtime-readiness';
import { assertFormulaBatch } from '@/lib/live-mixcut/formula/collection-store';
import { normalizeFormulaSourcePath, registerFormulaAssetBinding } from '@/lib/live-mixcut/formula/material-bindings';
import { FORMULA_VIDEO_UPLOAD_LIMITS } from '@/lib/live-mixcut/formula/video-upload';
import { BatchDomainError } from '@/lib/live-mixcut/errors';
import { SUPPORTED_VIDEO_MIME_BY_EXTENSION } from '@/lib/video-file-format';
import {
  BATCH_NO_STORE_HEADERS,
  batchRouteErrorResponse,
} from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_COUNT = FORMULA_VIDEO_UPLOAD_LIMITS.fileCount;
const MAX_FILE_BYTES = FORMULA_VIDEO_UPLOAD_LIMITS.fileBytes;
const MAX_REQUEST_BYTES = FORMULA_VIDEO_UPLOAD_LIMITS.requestBytes;

function safeDisplayName(name: string): string {
  const normalized = name.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base || `视频素材-${randomUUID()}.mp4`;
}

function publicImportError(error: unknown): string {
  if (error instanceof BatchDomainError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('仅支持')) return '仅支持 MP4、MOV、AVI、WebM 视频文件';
  if (message.includes('大小') || message.includes('上传')) return '视频文件大小校验失败';
  if (message.includes('空间') || (error && typeof error === 'object' && 'code' in error && error.code === 'ENOSPC')) return '磁盘空间不足，文件未完成导入';
  if (message.includes('扩展名') || message.includes('容器') || message.includes('媒体信息')) {
    return '无法读取视频容器或媒体信息，请确认文件未损坏';
  }
  return '视频素材导入失败，请确认文件可正常播放';
}

async function stageUploadedFile(file: File, targetPath: string, signal: AbortSignal): Promise<void> {
  let writtenBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.length;
      if (writtenBytes > MAX_FILE_BYTES || writtenBytes > file.size) {
        callback(new Error('上传文件超过大小限制'));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.from(file.stream() as unknown as AsyncIterable<Uint8Array>),
      limiter,
      createWriteStream(targetPath, { flags: 'wx' }),
      { signal },
    );
    if (writtenBytes !== file.size) throw new Error('上传文件大小校验失败');
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 浏览器上传视频到项目素材库;落库为托管副本,不依赖浏览器提供绝对路径。 */
export async function POST(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId');
  const formulaBatchId = request.nextUrl.searchParams.get('formulaBatchId');
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }

  // 在读取上传正文前检查项目/批次归属和能力，不能只依赖浏览器隐藏入口。
  try {
    await assertBatchApiReady();
    if (!getDb().prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new BatchDomainError('not_found', '项目不存在');
    if (formulaBatchId !== null) {
      await assertFormulaApiReady();
      assertFormulaBatch(getDb(), projectId, formulaBatchId, true);
    }
  } catch (error) { return batchRouteErrorResponse(error, 'live_mixcut_media_import_unavailable', '当前无法导入视频'); }

  let formData: FormData;
  let transportLimitExceeded = false;
  try {
    // multipart 解析前限制实际流量；不能只相信 Content-Length 或解析后的 file.size。
    const transportLimit = MAX_REQUEST_BYTES + 1024 * 1024;
    if (Number(request.headers.get('content-length')) > transportLimit) {
      transportLimitExceeded = true;
      throw new Error('upload_limit');
    }
    if (!request.body) throw new Error('empty_body');
    let bytes = 0;
    const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > transportLimit) {
        transportLimitExceeded = true;
        throw new Error('upload_limit');
      }
      controller.enqueue(chunk);
    } }));
    formData = await new Response(body, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
  } catch {
    if (transportLimitExceeded) {
      return NextResponse.json({ error: 'upload_too_large', message: '单次导入总大小不能超过 512 MiB，请分批上传' }, {
        status: 413,
        headers: BATCH_NO_STORE_HEADERS,
      });
    }
    return NextResponse.json({ error: 'invalid_form_data', message: '请求必须使用 multipart/form-data' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const files = formData.getAll('files').filter((value): value is File => value instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'files_required', message: '请选择至少一个视频文件' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  if (files.length > MAX_FILE_COUNT) {
    return NextResponse.json({ error: 'too_many_files', message: `单次最多导入 ${MAX_FILE_COUNT} 个视频文件` }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  if (files.some((file) => file.size > MAX_FILE_BYTES)) {
    return NextResponse.json({ error: 'file_too_large', message: '单个视频不能超过 256 MB' }, {
      status: 413,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'upload_too_large', message: '单次导入总大小不能超过 512 MB' }, {
      status: 413,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }

  try {
    await assertBatchApiReady();
    const db = getDb();
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
    if (!project) {
      return NextResponse.json({ error: 'project_not_found', message: '项目不存在' }, {
        status: 404,
        headers: BATCH_NO_STORE_HEADERS,
      });
    }

    await mkdir(dataRoot(), { recursive: true });
    let sourcePaths: string[] = files.map(file => file.name);
    if (formulaBatchId !== null) {
      const sourcePathsValue = formData.get('sourcePaths');
      if (sourcePathsValue !== null) {
        let parsed: unknown;
        try { parsed = JSON.parse(String(sourcePathsValue)); } catch { throw new BatchDomainError('invalid_input', '视频来源清单格式不正确'); }
        if (!Array.isArray(parsed) || parsed.length !== files.length || parsed.some(value => typeof value !== 'string')) throw new BatchDomainError('invalid_input', '视频来源清单与文件数量不一致');
        sourcePaths = parsed;
      }
      sourcePaths = sourcePaths.map(normalizeFormulaSourcePath);
      for (let i = 0; i < files.length; i++) {
        if (sourcePaths[i].split('/').at(-1) !== files[i].name) throw new BatchDomainError('invalid_input', '视频来源名称与上传文件不一致');
      }
      const disk = await statfs(dataRoot());
      const needed = files.reduce((total, file) => total + file.size, 0) * 2 + 64 * 1024 * 1024;
      if (disk.bavail * disk.bsize < needed) throw new BatchDomainError('invalid_input', '磁盘空间不足，无法安全复制本批视频');
    }
    const temporaryDirectory = await mkdtemp(path.join(dataRoot(), '.live-mixcut-import-'));
    const assetIds: string[] = [];
    const receipts: Array<{ index: number; filename: string; assetId: string; bindingId?: string }> = [];
    const errors: Array<{ index: number; filename: string; message: string }> = [];
    try {
      for (const [index, file] of files.entries()) {
        const filename = safeDisplayName(file.name);
        const extension = path.extname(filename).toLowerCase();
        if (!SUPPORTED_VIDEO_MIME_BY_EXTENSION[extension]) {
          errors.push({ index, filename, message: '仅支持 MP4、MOV、AVI、WebM 视频文件' });
          continue;
        }
        const temporaryPath = path.join(temporaryDirectory, `upload-${index}${extension}`);
        const rawRole = formData.get('role');
        const role = rawRole === 'opening' || rawRole === 'body' ? rawRole : undefined;
        try {
          await stageUploadedFile(file, temporaryPath, request.signal);
          const assetId = await registerManagedCopy(db, projectId, {
            sourcePath: temporaryPath,
            displayName: filename,
            role,
          });
          // 补传可修复丢失的托管副本；重新核验并恢复来源状态后才返回成功回执。
          if (formulaBatchId !== null) await verifyAssetSources(db, assetId);
          const binding = formulaBatchId !== null ? registerFormulaAssetBinding(db, projectId, formulaBatchId, { assetId, sourcePath: sourcePaths[index] }) : undefined;
          if (!assetIds.includes(assetId)) assetIds.push(assetId);
          receipts.push({ index, filename, assetId, ...(binding ? { bindingId: binding.id } : {}) });
        } catch (error) {
          errors.push({ index, filename, message: publicImportError(error) });
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
        if (request.signal.aborted) break;
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    return NextResponse.json({ assetIds, receipts, errors }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'live_mixcut_media_import_failed', '自定义素材导入失败');
  }
}
