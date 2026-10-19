import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FinalEditError } from './errors.ts';
import type { BgmImportBatchResult, BgmUpload } from './bgm-import.ts';

export const MAX_BGM_FILES = 100;
export const MAX_BGM_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_BGM_REQUEST_BYTES = 512 * 1024 * 1024;

export function bgmImportResponseStatus(
  result: BgmImportBatchResult,
): 200 | 201 | 422 {
  if (result.imported.length > 0) return 201;
  if (result.reused.length > 0) return 200;
  return 422;
}

export function validateBgmUploadMetadata(
  entries: Array<{ name: string; size: number }>,
): void {
  if (entries.length === 0) {
    throw new FinalEditError('files_required', '请选择至少一个音乐文件');
  }
  if (entries.length > MAX_BGM_FILES) {
    throw new FinalEditError('too_many_files', `单次最多导入 ${MAX_BGM_FILES} 个文件`);
  }
  const oversized = entries.find((entry) => entry.size > MAX_BGM_FILE_BYTES);
  if (oversized) {
    throw new FinalEditError('file_too_large', `"${oversized.name}" 超过单文件 ${MAX_BGM_FILE_BYTES / (1024 * 1024)} MB 限制`, 413);
  }
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalSize > MAX_BGM_REQUEST_BYTES) {
    throw new FinalEditError('upload_too_large', `单次上传总大小不能超过 ${MAX_BGM_REQUEST_BYTES / (1024 * 1024)} MB`, 413);
  }
}

async function stageUploadedFile(file: File, temporaryPath: string): Promise<void> {
  let writtenBytes = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.length;
      if (writtenBytes > MAX_BGM_FILE_BYTES || writtenBytes > file.size) {
        callback(new FinalEditError('file_too_large', '单个音乐不能超过 256 MB', 413));
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
    );
    if (writtenBytes !== file.size) {
      throw new FinalEditError('invalid_upload_size', '上传文件大小与声明不一致');
    }
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    if (error instanceof FinalEditError) throw error;
    throw new FinalEditError('upload_staging_failed', '暂存上传文件失败，请重试', 500);
  }
}

async function requestFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new FinalEditError('invalid_form_data', '请求必须使用 multipart/form-data');
  }
}

function uploadedBgmFiles(formData: FormData): File[] {
  const files = formData.getAll('files').filter((value): value is File => value instanceof File);
  if (files.length === 0) throw new FinalEditError('files_required', '请选择至少一个音乐文件');
  return files;
}

export async function importFinalEditBgmFromFormData(
  request: Request,
  importFiles: (files: BgmUpload[]) => Promise<BgmImportBatchResult>,
): Promise<BgmImportBatchResult> {
  const formData = await requestFormData(request);
  const files = uploadedBgmFiles(formData);
  const entries = files.map((file) => ({ name: file.name, size: file.size }));
  validateBgmUploadMetadata(entries);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-bgm-upload-'));
  const imported: BgmImportBatchResult['imported'] = [];
  const reused: BgmImportBatchResult['reused'] = [];
  const errors: BgmImportBatchResult['errors'] = [];
  let firstSuccessfulTrackId: string | null = null;

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const temporaryPath = path.join(temporaryDirectory, `upload-${index}`);
      try {
        await stageUploadedFile(file, temporaryPath);
        const batch = await importFiles([{
          filename: file.name,
          mimeType: file.type,
          temporaryPath,
          size: file.size,
        }]);
        imported.push(...batch.imported);
        reused.push(...batch.reused);
        errors.push(...batch.errors);
        if (firstSuccessfulTrackId === null && batch.firstSuccessfulTrackId !== null) {
          firstSuccessfulTrackId = batch.firstSuccessfulTrackId;
        }
      } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
    }
    return { firstSuccessfulTrackId, imported, reused, errors };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
