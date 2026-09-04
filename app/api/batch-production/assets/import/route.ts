import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { registerManagedCopy } from '@/lib/batch-production/media-catalog';
import { SUPPORTED_VIDEO_MIME_BY_EXTENSION } from '@/lib/video-file-format';
import {
  BATCH_NO_STORE_HEADERS,
  batchRouteErrorResponse,
} from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_COUNT = 100;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024 * 1024;

function safeDisplayName(name: string): string {
  const normalized = name.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base || `视频素材-${randomUUID()}.mp4`;
}

function publicImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('仅支持')) return '仅支持 MP4、MOV、AVI、WebM 视频文件';
  if (message.includes('大小') || message.includes('上传')) return '视频文件大小校验失败';
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
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
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
    const temporaryDirectory = await mkdtemp(path.join(dataRoot(), '.batch-media-import-'));
    const assetIds: string[] = [];
    const errors: Array<{ filename: string; message: string }> = [];
    try {
      for (const [index, file] of files.entries()) {
        const filename = safeDisplayName(file.name);
        const extension = path.extname(filename).toLowerCase();
        if (!SUPPORTED_VIDEO_MIME_BY_EXTENSION[extension]) {
          errors.push({ filename, message: '仅支持 MP4、MOV、AVI、WebM 视频文件' });
          continue;
        }
        const temporaryPath = path.join(temporaryDirectory, `upload-${index}${extension}`);
        try {
          await stageUploadedFile(file, temporaryPath, request.signal);
          const assetId = await registerManagedCopy(db, projectId, {
            sourcePath: temporaryPath,
            displayName: filename,
          });
          if (!assetIds.includes(assetId)) assetIds.push(assetId);
        } catch (error) {
          errors.push({ filename, message: publicImportError(error) });
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    return NextResponse.json({ assetIds, errors }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_media_import_failed', '自定义素材导入失败');
  }
}
