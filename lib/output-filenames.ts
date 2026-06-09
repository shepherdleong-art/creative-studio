import fs from 'fs';
import path from 'path';

export function sanitizeFilenameBase(filePathOrName: string): string {
  const parsed = path.parse(filePathOrName);
  return parsed.name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'image';
}

export function ensureUniqueFilename(dir: string, filename: string, fallbackSuffix: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const direct = path.join(dir, filename);
  if (!fs.existsSync(direct)) return filename;

  const withSuffix = `${base}-${fallbackSuffix}${ext}`;
  if (!fs.existsSync(path.join(dir, withSuffix))) return withSuffix;

  let i = 2;
  while (true) {
    const candidate = `${base}-${fallbackSuffix}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    i += 1;
  }
}
