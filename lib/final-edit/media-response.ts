import path from 'node:path';
import { dataRoot } from '../data-root';
import { fileResponse } from '../media-core/file-response.ts';
import { assertNoStorageSymlink } from './storage-path';

export function resolveFinalEditMedia(relativePath: string): string {
  const storageRoot = path.resolve(dataRoot(), 'storage');
  return assertNoStorageSymlink(storageRoot, relativePath);
}

export function mediaResponse(
  request: Request,
  relativePath: string,
  contentType: string,
  downloadName?: string,
): Response {
  return fileResponse(request, resolveFinalEditMedia(relativePath), contentType, {
    cacheControl: 'private, max-age=3600',
    downloadName,
  });
}
