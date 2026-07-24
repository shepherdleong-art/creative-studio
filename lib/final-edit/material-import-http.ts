import { FinalEditError } from './workspace.ts';
import type { ExternalAssetUpload } from './material-import.ts';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024 * 1024;

async function readUploadedFiles(formData: FormData): Promise<ExternalAssetUpload[]> {
  const candidates = [...formData.getAll('files'), ...formData.getAll('file')];
  const uploadedFiles = candidates.filter((value): value is File => value instanceof File);
  if (uploadedFiles.length === 0) throw new FinalEditError('files_required', '请选择至少一个视频文件');
  if (uploadedFiles.length > 100) throw new FinalEditError('too_many_files', '单次最多导入 100 个文件');
  if (uploadedFiles.some((file) => file.size > MAX_FILE_BYTES)) {
    throw new FinalEditError('file_too_large', '单个视频不能超过 256 MB', 413);
  }
  if (uploadedFiles.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_BYTES) {
    throw new FinalEditError('upload_too_large', '单次导入总大小不能超过 512 MB', 413);
  }
  const uploads: ExternalAssetUpload[] = [];
  for (const file of uploadedFiles) {
    uploads.push({ filename: file.name, mimeType: file.type, data: Buffer.from(await file.arrayBuffer()) });
  }
  return uploads;
}

async function requestFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new FinalEditError('invalid_form_data', '请求必须使用 multipart/form-data');
  }
}

export async function readShotSetExternalAssetImportFormData(request: Request): Promise<{
  files: ExternalAssetUpload[];
}> {
  const formData = await requestFormData(request);
  return { files: await readUploadedFiles(formData) };
}
