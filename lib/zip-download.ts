import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { Readable } from 'stream';

export interface ZipImageEntry {
  filePath: string;
  filename: string;
}

export function sanitizeZipFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image.png';
}

export function assertStorageImagePath(filePath: string): string {
  const storageRoot = path.resolve(path.join(process.cwd(), 'storage'));
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

export function buildZipStream(entries: ZipImageEntry[]): ReadableStream {
  const pass = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const used = new Map<string, number>();

  archive.on('error', (err) => pass.destroy(err));
  archive.pipe(pass);

  for (const entry of entries) {
    const resolved = assertStorageImagePath(entry.filePath);
    const clean = sanitizeZipFilename(entry.filename);
    const ext = path.extname(clean) || '.png';
    const base = path.basename(clean, ext);
    const count = used.get(clean) || 0;
    used.set(clean, count + 1);
    const zipName = count === 0 ? clean : `${base}-${count + 1}${ext}`;
    archive.file(resolved, { name: zipName });
  }

  void archive.finalize();
  return Readable.toWeb(pass) as ReadableStream;
}
