import path from 'node:path';
import { dataRoot } from './data-root.ts';

function toStorageUrl(filePath: string | null | undefined, prefix: string, storageRoot: string) {
  if (!filePath) return '';

  const resolvedRoot = path.resolve(storageRoot);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) return '';

  const relativePath = path
    .relative(resolvedRoot, resolvedFile)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');

  return relativePath ? `${prefix}/${relativePath}` : '';
}

export function toStorageImageUrl(filePath: string | null | undefined, storageRoot = path.resolve(dataRoot(), 'storage')) {
  return toStorageUrl(filePath, '/api/images', storageRoot);
}

export function toStorageVideoUrl(filePath: string | null | undefined, storageRoot = path.resolve(dataRoot(), 'storage')) {
  return toStorageUrl(filePath, '/api/videos', storageRoot);
}
