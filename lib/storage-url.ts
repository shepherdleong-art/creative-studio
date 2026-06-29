import path from 'node:path';
import { dataRoot } from './data-root';

export function toStorageImageUrl(filePath: string | null | undefined, storageRoot = path.resolve(dataRoot(), 'storage')) {
  if (!filePath) return '';

  const resolvedRoot = path.resolve(storageRoot);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) return '';

  const relativePath = path
    .relative(resolvedRoot, resolvedFile)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');

  return relativePath ? `/api/images/${relativePath}` : '';
}
