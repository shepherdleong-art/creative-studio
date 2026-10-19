import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { Readable } from 'stream';
import { dataRoot } from './data-root';

export interface ZipImageEntry {
  filePath: string;
  filename: string;
}

export interface ZipNameRegistry {
  usedNames: Set<string>;
  baseCounts: Map<string, number>;
}

export function createZipNameRegistry(): ZipNameRegistry {
  return {
    usedNames: new Set<string>(),
    baseCounts: new Map<string, number>(),
  };
}

function sanitizeZipPathSegment(segment: string): string {
  return segment
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function sanitizeZipFilename(name: string): string {
  const segments = name
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map(sanitizeZipPathSegment)
    .filter((segment) => segment && segment !== '.' && segment !== '..');

  return segments.join('/') || 'image.png';
}

function appendDuplicateSuffix(cleanName: string, duplicateNumber: number): string {
  const dir = path.posix.dirname(cleanName);
  const filename = path.posix.basename(cleanName);
  const ext = path.posix.extname(filename);
  const base = ext ? path.posix.basename(filename, ext) : filename;
  const nextName = ext ? `${base}-${duplicateNumber}${ext}` : `${base}-${duplicateNumber}`;
  return dir === '.' ? nextName : `${dir}/${nextName}`;
}

export function reserveZipFilename(name: string, registry: ZipNameRegistry): string {
  const clean = sanitizeZipFilename(name);
  let candidate = clean;
  let duplicateNumber = registry.baseCounts.get(clean) || 1;

  while (registry.usedNames.has(candidate)) {
    duplicateNumber += 1;
    candidate = appendDuplicateSuffix(clean, duplicateNumber);
  }

  registry.baseCounts.set(clean, duplicateNumber);
  registry.usedNames.add(candidate);
  return candidate;
}

export function assertStorageImagePath(filePath: string): string {
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (!resolved.startsWith(storageRoot + path.sep)) {
    throw new Error('Image path is outside storage');
  }
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    throw new Error('Unsupported image extension');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('Image file not found');
  }
  return resolved;
}

const STORAGE_EXTENSIONS_IMAGE = ['.png', '.jpg', '.jpeg', '.webp'];
const STORAGE_EXTENSIONS_ALL = [...STORAGE_EXTENSIONS_IMAGE, '.mp4', '.mov', '.webm', '.txt', '.json'];

export function assertStoragePath(filePath: string, allowedExts: string[]): string {
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (!resolved.startsWith(storageRoot + path.sep)) {
    throw new Error('Path is outside storage');
  }
  if (!allowedExts.includes(ext)) {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('File not found');
  }
  return resolved;
}

export function buildZipStream(entries: ZipImageEntry[]): ReadableStream {
  return buildZipStreamWithExts(entries, STORAGE_EXTENSIONS_IMAGE);
}

export function buildGenericZipStream(entries: ZipImageEntry[]): ReadableStream {
  return buildZipStreamWithExts(entries, STORAGE_EXTENSIONS_ALL);
}

function buildZipStreamWithExts(entries: ZipImageEntry[], allowedExts: string[]): ReadableStream {
  const pass = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const registry = createZipNameRegistry();

  archive.on('error', (err) => pass.destroy(err));
  archive.pipe(pass);

  for (const entry of entries) {
    const resolved = assertStoragePath(entry.filePath, allowedExts);
    const zipName = reserveZipFilename(entry.filename, registry);
    archive.file(resolved, { name: zipName });
  }

  void archive.finalize();
  return Readable.toWeb(pass) as ReadableStream;
}
