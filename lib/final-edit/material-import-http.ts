import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FinalEditError } from './errors.ts';
import type {
  ExternalAssetImportResult,
  ExternalAssetUpload,
} from './material-import.ts';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024 * 1024;

function uploadedFiles(formData: FormData): File[] {
  const candidates = [...formData.getAll('files'), ...formData.getAll('file')];
  const files = candidates.filter((value): value is File => value instanceof File);
  if (files.length === 0) throw new FinalEditError('files_required', '请选择至少一个视频文件');
  if (files.length > 100) throw new FinalEditError('too_many_files', '单次最多导入 100 个文件');
  if (files.some((file) => file.size > MAX_FILE_BYTES)) {
    throw new FinalEditError('file_too_large', '单个视频不能超过 256 MB', 413);
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_BYTES) {
    throw new FinalEditError('upload_too_large', '单次导入总大小不能超过 512 MB', 413);
  }
  return files;
}

async function requestFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new FinalEditError('invalid_form_data', '请求必须使用 multipart/form-data');
  }
}

async function stageUploadedFile(file: File, temporaryPath: string, signal?: AbortSignal): Promise<void> {
  let writtenBytes = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.length;
      if (writtenBytes > MAX_FILE_BYTES || writtenBytes > file.size) {
        callback(new FinalEditError('file_too_large', '单个视频不能超过 256 MB', 413));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.from(file.stream() as unknown as AsyncIterable<Uint8Array>),
      byteLimit,
      fs.createWriteStream(temporaryPath, { flags: 'wx' }),
      { signal },
    );
    if (writtenBytes !== file.size) {
      throw new FinalEditError('invalid_upload_size', '上传文件大小与声明不一致');
    }
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const abortError = new Error('素材上传已取消');
      abortError.name = 'AbortError';
      throw abortError;
    }
    if (error instanceof FinalEditError) throw error;
    throw new FinalEditError('upload_staging_failed', '暂存上传文件失败，请重试', 500);
  }
}

/**
 * Request.formData() itself is not streaming in Next's Web Request API, but
 * the expensive second copy is bounded to one file at a time: each File is
 * streamed to a private temp file, imported, then unlinked before the next
 * file starts. The business importer never retains a whole multipart batch
 * as Buffers.
 */
export async function importShotSetExternalAssetsFromFormData(
  request: Request,
  importFiles: (files: ExternalAssetUpload[], signal?: AbortSignal) => Promise<ExternalAssetImportResult>,
): Promise<ExternalAssetImportResult> {
  const formData = await requestFormData(request);
  const files = uploadedFiles(formData);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-upload-'));
  const result: ExternalAssetImportResult = { assets: [], errors: [] };
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const temporaryPath = path.join(temporaryDirectory, `upload-${index}`);
      try {
        await stageUploadedFile(file, temporaryPath, request.signal);
        const imported = await importFiles([{
          filename: file.name,
          mimeType: file.type,
          temporaryPath,
          size: file.size,
        }], request.signal);
        result.assets.push(...imported.assets);
        result.errors.push(...imported.errors);
      } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
    }
    return result;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
