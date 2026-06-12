import fs from 'fs';
import path from 'path';

export interface UsagePrefixInfo {
  filePrefix: string;
  outputUsage: string;
}

/**
 * Maps an input image's usage role to a filename prefix and output usage tag.
 * Centralized so adding a new usage type only requires one edit.
 */
export function getUsagePrefix(usage: string): UsagePrefixInfo {
  switch (usage) {
    case 'scene_seed': return { filePrefix: '场景-', outputUsage: 'scene_gen' };
    case 'shot_source': return { filePrefix: '分镜-', outputUsage: 'shot_gen' };
    default: return { filePrefix: 'output-', outputUsage: '' };
  }
}

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
