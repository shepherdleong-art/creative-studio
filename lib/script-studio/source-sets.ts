import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { ScriptStudioError } from './errors.ts';
import { getScriptStudioLimits, logLimitHit, type ScriptStudioLimits } from './limits.ts';
import type { SourceSetRecord } from './types.ts';

export interface SourceSetImageRow {
  id: string;
  projectId: string | null;
  filename: string;
  path: string;
  originalPath: string | null;
  mimeType: string;
  originalWidth: number | null;
  originalHeight: number | null;
}

export interface SourceSetResourceReport {
  imageCount: number;
  sourcePixels: number;
  sourcePixelLimit: number;
  decodeBufferEstimateBytes: number;
  decodeBufferLimitBytes: number;
  overResourceLimit: boolean;
  messages: string[];
}

export interface CreateSourceSetResult {
  sourceSetId: string;
  contentFingerprint: string;
  imageAssetIds: string[];
  resourceReport: SourceSetResourceReport;
  existing: boolean;
}

function hashImageFile(filePath: string): string {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function computeSourceSetFingerprint(
  rows: SourceSetImageRow[],
): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    const filePath = row.originalPath || row.path;
    const fileHash = hashImageFile(filePath);
    hash.update(row.id);
    hash.update('\0');
    hash.update(fileHash || row.filename || row.path);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function estimateDecodeBufferBytes(
  rows: SourceSetImageRow[],
  limits: ScriptStudioLimits,
): number {
  // 切片管线对超大图按条带流式读取（tiling.ts），峰值内存是单条带而非整图，
  // 因此这里估算「单页单条带」的源缓冲与输出缓冲峰值，而不是整页全解码。
  let peak = 0;
  for (const row of rows) {
    const width = Math.max(1, Number(row.originalWidth) || limits.maxImageWidth);
    const height = Math.max(1, Number(row.originalHeight) || limits.baseTileHeight);
    const resizeWidth = Math.max(1, Math.min(limits.maxImageWidth, width));
    const stripSourceHeight = Math.min(height, Math.ceil(limits.baseTileHeight * (width / resizeWidth)));
    const stripSourceBytes = width * stripSourceHeight * 4;
    const stripOutputBytes = resizeWidth * Math.min(height, limits.baseTileHeight) * 4;
    peak = Math.max(peak, stripSourceBytes, stripOutputBytes);
  }
  return peak;
}

export function inspectSourceSetResources(
  rows: SourceSetImageRow[],
  limits: ScriptStudioLimits = getScriptStudioLimits(),
): SourceSetResourceReport {
  const sourcePixels = rows.reduce((sum, row) => (
    sum + Math.max(0, Number(row.originalWidth) || 0) * Math.max(0, Number(row.originalHeight) || 0)
  ), 0);
  const decodeBufferEstimateBytes = estimateDecodeBufferBytes(rows, limits);
  const messages: string[] = [];
  let overResourceLimit = false;

  if (sourcePixels > limits.sourcePixelLimit) {
    messages.push(`来源图片总像素 ${sourcePixels.toLocaleString('zh-CN')} 超过保护值 ${limits.sourcePixelLimit.toLocaleString('zh-CN')}，读取时将自动压缩（视觉读取宽度上限 ${limits.maxImageWidth}px）`);
    logLimitHit('sourcePixels', sourcePixels, limits.sourcePixelLimit);
  }
  if (decodeBufferEstimateBytes > limits.decodeBufferLimitBytes) {
    messages.push(`来源图片较大，读取时将分条处理（预计单条缓冲约 ${Math.round(decodeBufferEstimateBytes / 1024 / 1024)}MB，超过保护值 ${Math.round(limits.decodeBufferLimitBytes / 1024 / 1024)}MB）`);
    logLimitHit('decodeBufferBytes', decodeBufferEstimateBytes, limits.decodeBufferLimitBytes);
  }
  if (rows.length === 0) {
    overResourceLimit = true;
    messages.push('至少需要一张有效详情页图片');
  }
  return {
    imageCount: rows.length,
    sourcePixels,
    sourcePixelLimit: limits.sourcePixelLimit,
    decodeBufferEstimateBytes,
    decodeBufferLimitBytes: limits.decodeBufferLimitBytes,
    overResourceLimit,
    messages,
  };
}

export function loadSourceSetImageRows(
  db: Database.Database,
  projectId: string,
  imageAssetIds: string[],
): SourceSetImageRow[] {
  const uniqueIds = [...new Set(imageAssetIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, projectId, filename, path, originalPath, mimeType, originalWidth, originalHeight
    FROM image_assets
    WHERE projectId = ? AND id IN (${placeholders})
  `).all(projectId, ...uniqueIds) as SourceSetImageRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return uniqueIds.map((id) => byId.get(id)).filter((row): row is SourceSetImageRow => Boolean(row));
}

function assertImagesBelongToProject(
  db: Database.Database,
  projectId: string,
  imageAssetIds: string[],
): void {
  const rows = loadSourceSetImageRows(db, projectId, imageAssetIds);
  if (rows.length !== imageAssetIds.length) {
    throw new ScriptStudioError('invalid_input', '存在不属于当前项目的详情页图片或图片不存在');
  }
}

export function createOrFindSourceSet(
  db: Database.Database,
  projectId: string,
  imageAssetIds: string[],
  options: { now?: () => Date; limits?: ScriptStudioLimits } = {},
): CreateSourceSetResult {
  assertImagesBelongToProject(db, projectId, imageAssetIds);
  const rows = loadSourceSetImageRows(db, projectId, imageAssetIds);
  const resourceReport = inspectSourceSetResources(rows, options.limits);
  if (resourceReport.overResourceLimit) {
    throw new ScriptStudioError('resource_limit', resourceReport.messages.join('；'));
  }
  const contentFingerprint = computeSourceSetFingerprint(rows);
  const existing = db.prepare(`
    SELECT id FROM script_studio_source_sets
    WHERE projectId = ? AND contentFingerprint = ?
  `).get(projectId, contentFingerprint) as { id: string } | undefined;
  if (existing) {
    return {
      sourceSetId: existing.id,
      contentFingerprint,
      imageAssetIds: rows.map((row) => row.id),
      resourceReport,
      existing: true,
    };
  }
  const now = (options.now ?? (() => new Date()))();
  const sourceSetId = randomUUID();
  db.prepare(`
    INSERT INTO script_studio_source_sets
      (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sourceSetId,
    projectId,
    contentFingerprint,
    JSON.stringify(rows.map((row) => row.id)),
    now.toISOString(),
  );
  return {
    sourceSetId,
    contentFingerprint,
    imageAssetIds: rows.map((row) => row.id),
    resourceReport,
    existing: false,
  };
}

export function getSourceSet(
  db: Database.Database,
  projectId: string,
  sourceSetId: string,
): SourceSetRecord | undefined {
  return db.prepare(`
    SELECT id, projectId, contentFingerprint, imageAssetIdsJson, createdAt
    FROM script_studio_source_sets
    WHERE id = ? AND projectId = ?
  `).get(sourceSetId, projectId) as SourceSetRecord | undefined;
}

export function currentSourceSetForFingerprint(
  db: Database.Database,
  projectId: string,
  contentFingerprint: string,
): SourceSetRecord | undefined {
  return db.prepare(`
    SELECT id, projectId, contentFingerprint, imageAssetIdsJson, createdAt
    FROM script_studio_source_sets
    WHERE projectId = ? AND contentFingerprint = ?
  `).get(projectId, contentFingerprint) as SourceSetRecord | undefined;
}

export function storageRootForImages(): string {
  return path.join(dataRoot(), 'storage');
}
