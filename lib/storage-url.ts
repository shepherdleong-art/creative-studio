import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './data-root.ts';

function relativeWithin(root: string, candidate: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function relocatedStorageRelativePath(filePath: string, storageRoot: string): string | null {
  const resolvedFile = path.resolve(filePath);
  const pathParts = resolvedFile.slice(path.parse(resolvedFile).root.length).split(path.sep);
  let storageIndex = -1;
  for (let index = pathParts.length - 1; index >= 0; index -= 1) {
    if (pathParts[index].toLocaleLowerCase('en-US') === 'storage') {
      storageIndex = index;
      break;
    }
  }
  if (storageIndex < 0 || storageIndex === pathParts.length - 1) return null;

  const relative = path.join(...pathParts.slice(storageIndex + 1));
  const candidate = path.resolve(storageRoot, relative);
  const candidateRelative = relativeWithin(storageRoot, candidate);
  if (!candidateRelative || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;

  const realRoot = fs.realpathSync(storageRoot);
  const realCandidate = fs.realpathSync(candidate);
  return relativeWithin(realRoot, realCandidate) ? candidateRelative : null;
}

export function resolveStorageRelativePath(
  filePath: string | null | undefined,
  storageRoot = path.resolve(dataRoot(), 'storage'),
): string | null {
  if (!filePath) return null;

  const currentRelative = relativeWithin(storageRoot, filePath);
  if (currentRelative) return currentRelative;

  return relocatedStorageRelativePath(filePath, storageRoot);
}

export function toStorageImageUrl(filePath: string | null | undefined, storageRoot = path.resolve(dataRoot(), 'storage')) {
  const relativePath = resolveStorageRelativePath(filePath, storageRoot);
  if (!relativePath) return '';

  const encodedRelativePath = relativePath
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');

  return `/api/images/${encodedRelativePath}`;
}
