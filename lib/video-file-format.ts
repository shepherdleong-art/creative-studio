import path from 'node:path';

/** Creative Studio 当前允许导入的视频扩展名与 MIME 类型。 */
export const SUPPORTED_VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
};

/** 校验 ffprobe/ffmpeg 识别出的容器是否与文件扩展名一致。 */
export function isDetectedVideoContainerCompatible(filePathOrExtension: string, detectedFormat: string | undefined): boolean {
  const extension = filePathOrExtension.startsWith('.')
    ? filePathOrExtension.toLowerCase()
    : path.extname(filePathOrExtension).toLowerCase();
  const formats = new Set(
    (detectedFormat || '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean),
  );
  if (extension === '.mp4' || extension === '.mov') return formats.has('mov') || formats.has('mp4');
  if (extension === '.avi') return formats.has('avi');
  if (extension === '.webm') return formats.has('webm');
  return false;
}
