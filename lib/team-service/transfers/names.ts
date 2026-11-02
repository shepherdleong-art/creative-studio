import path from 'node:path';
import { TransferError } from './errors.ts';

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_SEGMENT = /[\u0000-\u001f\u007f<>:"|?*]/;

export function normalizeRelativeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\u0000')) {
    throw new TransferError('invalid_relative_name', '文件相对名无效。');
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) {
    throw new TransferError('invalid_relative_name', '不允许使用绝对路径。');
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TransferError('invalid_relative_name', '文件相对名不能包含穿越或空目录。');
  }
  for (const segment of segments) {
    if (INVALID_SEGMENT.test(segment) || WINDOWS_DEVICE.test(segment) || /[. ]$/.test(segment)) {
      throw new TransferError('invalid_relative_name', '文件相对名包含 Windows 保留名称或非法字符。');
    }
  }
  return segments.join('/');
}

export function displayNameFromRelativePath(relativePath: string): string {
  return path.posix.basename(relativePath);
}
