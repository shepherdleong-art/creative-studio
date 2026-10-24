/** 浏览器与 API 共用限额；这里只计算批次，不接触文件内容或本地路径。 */
export const FORMULA_VIDEO_UPLOAD_LIMITS = { fileBytes: 256 * 1024 * 1024, requestBytes: 512 * 1024 * 1024, fileCount: 100 } as const;

export function groupFormulaVideoUploads<T extends { name: string; size: number }>(files: T[]): {
  batches: T[][]; rejected: Array<{ file: T; message: string }>;
} {
  const batches: T[][] = [];
  const rejected: Array<{ file: T; message: string }> = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const file of files) {
    const message = !/\.(mp4|mov|avi|webm)$/i.test(file.name) ? '仅支持 MP4、MOV、AVI、WebM 视频文件'
      : !Number.isSafeInteger(file.size) || file.size <= 0 ? '文件为空或大小无效'
      : file.size > FORMULA_VIDEO_UPLOAD_LIMITS.fileBytes ? '单个视频不能超过 256 MiB' : '';
    if (message) { rejected.push({ file, message }); continue; }
    // 小批传输降低浏览器内存占用；单个大文件独立上传，仍受服务端硬上限约束。
    if (batch.length && (batch.length >= 20 || bytes + file.size > 64 * 1024 * 1024)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(file); bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  return { batches, rejected };
}
