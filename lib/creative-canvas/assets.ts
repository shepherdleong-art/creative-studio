/**
 * 画布素材导入与媒体读取（技术约定 C2／C7）。
 *
 * - 素材内容不可变：导入即落盘为受控路径下的本地副本，源文件后来移动不影响已导入素材。
 * - 只接受上传文件，不接受客户端传来的任意本机路径。
 * - 读取经过所属画布与文件边界检查，视频按需支持 Range。
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { assertNoStorageSymlink, resolveStoragePath } from '../media-core/storage-path.ts';
import { probeDurationSec } from '../ffmpeg.ts';
import { CanvasError } from './errors.ts';
import type { CanvasMediaKind } from './types.ts';

export interface CanvasAssetRecord {
  id: string;
  canvasId: string;
  mediaKind: CanvasMediaKind;
  relativePath: string;
  contentHash: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sourceTaskId: string | null;
  ready: boolean;
  createdAt: string;
}

/** 单文件上限，按媒体类型区分；与模型能力限制分开，先守住本地可处理范围。 */
export const CANVAS_ASSET_MAX_BYTES: Record<CanvasMediaKind, number> = {
  image: 32 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
};

const EXTENSION_MEDIA_KIND: Record<string, CanvasMediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
};

const MIME_MEDIA_KIND: Record<string, CanvasMediaKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
};

export const CANVAS_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
};

export function canvasStorageRoot(root: string): string {
  return path.join(root, 'storage');
}

export function canvasAssetDirectory(canvasId: string): string {
  return path.posix.join('canvas', canvasId, 'assets');
}

export function detectCanvasMediaKind(filename: string, mimeType: string): CanvasMediaKind | null {
  const extension = path.extname(filename).replace('.', '').toLowerCase();
  return EXTENSION_MEDIA_KIND[extension] ?? MIME_MEDIA_KIND[mimeType.toLowerCase()] ?? null;
}

function assertContentLooksValid(kind: CanvasMediaKind, extension: string, data: Buffer): void {
  if (data.byteLength === 0) {
    throw new CanvasError('invalid_input', '上传文件为空。');
  }
  if (kind !== 'image' && extension === 'mp4') {
    const brand = data.subarray(4, 8).toString('latin1');
    if (brand !== 'ftyp') {
      throw new CanvasError('invalid_input', 'MP4 文件头不合法，无法作为视频素材导入。');
    }
  }
}

async function probeImage(data: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const metadata = await sharp(data).metadata();
    return { width: metadata.width ?? null, height: metadata.height ?? null };
  } catch {
    throw new CanvasError('invalid_input', '图片无法解码，已拒绝导入。');
  }
}

function rowToAsset(row: Record<string, unknown>): CanvasAssetRecord {
  return {
    id: String(row.id),
    canvasId: String(row.canvasId),
    mediaKind: row.mediaKind as CanvasMediaKind,
    relativePath: String(row.relativePath),
    contentHash: String(row.contentHash),
    mimeType: String(row.mimeType),
    byteSize: Number(row.byteSize),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    durationSec: row.durationSec === null || row.durationSec === undefined ? null : Number(row.durationSec),
    sourceTaskId: row.sourceTaskId === null || row.sourceTaskId === undefined ? null : String(row.sourceTaskId),
    ready: Number(row.ready) === 1,
    createdAt: String(row.createdAt),
  };
}

export function getCanvasAsset(db: Database.Database, assetId: string): CanvasAssetRecord | null {
  const row = db.prepare(`SELECT * FROM creative_canvas_assets WHERE id = ?`).get(assetId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAsset(row) : null;
}

/** 归属校验：素材必须属于指定画布，否则按未找到处理。 */
export function requireCanvasAsset(
  db: Database.Database,
  assetId: string,
  canvasId?: string,
): CanvasAssetRecord {
  const asset = getCanvasAsset(db, assetId);
  if (!asset) throw new CanvasError('not_found', '素材不存在。');
  if (canvasId && asset.canvasId !== canvasId) {
    throw new CanvasError('not_found', '素材不属于该画布。');
  }
  return asset;
}

export interface ImportCanvasAssetParams {
  db: Database.Database;
  canvasId: string;
  storageRoot: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  now?: () => Date;
}

/**
 * 导入本地上传的素材：校验类型与大小 → 落盘不可变副本 → 登记资产。
 * 同一画布内内容相同的素材复用既有资产身份，避免重复占用磁盘。
 */
export async function importCanvasAsset(params: ImportCanvasAssetParams): Promise<CanvasAssetRecord> {
  const { db, canvasId, storageRoot, filename, mimeType, data, now = () => new Date() } = params;
  const canvas = db.prepare(`SELECT id FROM creative_canvases WHERE id = ?`).get(canvasId);
  if (!canvas) throw new CanvasError('not_found', '画布不存在。');

  const extension = path.extname(filename).replace('.', '').toLowerCase();
  const mediaKind = detectCanvasMediaKind(filename, mimeType);
  if (!mediaKind) {
    throw new CanvasError('invalid_input', `不支持的文件类型：${filename}。`);
  }
  const maxBytes = CANVAS_ASSET_MAX_BYTES[mediaKind];
  if (data.byteLength > maxBytes) {
    throw new CanvasError(
      'invalid_input',
      `${filename} 超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限。`,
    );
  }
  assertContentLooksValid(mediaKind, extension, data);

  const contentHash = createHash('sha256').update(data).digest('hex');
  const existing = db.prepare(
    `SELECT * FROM creative_canvas_assets WHERE canvasId = ? AND contentHash = ? AND ready = 1 LIMIT 1`,
  ).get(canvasId, contentHash) as Record<string, unknown> | undefined;
  if (existing) return rowToAsset(existing);

  const dimensions = mediaKind === 'image' ? await probeImage(data) : { width: null, height: null };
  const assetId = randomUUID();
  const assetDirectory = canvasAssetDirectory(canvasId);
  const relativePath = path.posix.join(assetDirectory, `${assetId}.${extension}`);
  const absoluteDirectory = resolveStoragePath(storageRoot, assetDirectory);
  const absolutePath = resolveStoragePath(storageRoot, relativePath);
  fs.mkdirSync(absoluteDirectory, { recursive: true });

  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  await fsPromises.writeFile(temporaryPath, data, { flag: 'wx' });
  await fsPromises.rename(temporaryPath, absolutePath);

  const createdAt = now().toISOString();
  // 视频／音频尽力探测时长：探测失败不阻塞导入，交付前的时长检查会按「未知」放行。
  const durationSec = mediaKind === 'image' ? null : await probeDurationSafe(absolutePath);
  db.prepare(`
    INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, width, height, durationSec, sourceTaskId, ready, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    assetId,
    canvasId,
    mediaKind,
    relativePath,
    contentHash,
    MIME_MEDIA_KIND[mimeType.toLowerCase()] ? mimeType.toLowerCase() : CANVAS_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
    data.byteLength,
    dimensions.width,
    dimensions.height,
    durationSec,
    null,
    createdAt,
  );

  return requireCanvasAsset(db, assetId);
}

async function probeDurationSafe(filePath: string): Promise<number | null> {
  try {
    const duration = await probeDurationSec(filePath);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export function canvasAssetAbsolutePath(asset: CanvasAssetRecord, storageRoot: string): string {
  return assertNoStorageSymlink(storageRoot, asset.relativePath);
}

export function canvasResultDirectory(canvasId: string): string {
  return path.posix.join('canvas', canvasId, 'results');
}

export interface RegisterCanvasResultAssetParams {
  db: Database.Database;
  canvasId: string;
  storageRoot: string;
  taskId: string;
  mediaKind: Exclude<CanvasMediaKind, 'audio'>;
  mimeType: string;
  data: Buffer;
  now?: () => Date;
}

/**
 * 登记一次任务的正式产物。与素材导入不同，产物**不做内容去重**：
 * 每个任务只关联一个正式输出（数据库唯一索引），复用同一 assetId 会直接冲突。
 */
export async function registerCanvasResultAsset(
  params: RegisterCanvasResultAssetParams,
): Promise<CanvasAssetRecord> {
  const { db, canvasId, storageRoot, taskId, mediaKind, mimeType, data, now = () => new Date() } = params;
  if (data.byteLength === 0) {
    throw new CanvasError('invalid_input', '生成结果为空文件。');
  }
  const dimensions = mediaKind === 'image' ? await probeImage(data) : { width: null, height: null };
  const extension = mediaKind === 'image'
    ? (mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png')
    : 'mp4';

  const assetId = randomUUID();
  const resultDirectory = canvasResultDirectory(canvasId);
  const relativePath = path.posix.join(resultDirectory, `${assetId}.${extension}`);
  const absoluteDirectory = resolveStoragePath(storageRoot, resultDirectory);
  const absolutePath = resolveStoragePath(storageRoot, relativePath);
  fs.mkdirSync(absoluteDirectory, { recursive: true });

  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  await fsPromises.writeFile(temporaryPath, data, { flag: 'wx' });
  await fsPromises.rename(temporaryPath, absolutePath);

  db.prepare(`
    INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, width, height, durationSec, sourceTaskId, ready, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?)
  `).run(
    assetId,
    canvasId,
    mediaKind,
    relativePath,
    createHash('sha256').update(data).digest('hex'),
    mimeType,
    data.byteLength,
    dimensions.width,
    dimensions.height,
    taskId,
    now().toISOString(),
  );

  return requireCanvasAsset(db, assetId);
}

export interface CanvasAssetReadResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
  filePath: string;
  start: number;
  end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * 解析 Range 头。返回 null 表示范围非法（调用方按 416 处理）。
 * 只支持单段 range——视频按需播放够用，也避免引入多段边界解析。
 */
export function parseCanvasByteRange(
  rangeHeader: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = RANGE_PATTERN.exec(rangeHeader.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function readCanvasAsset(params: {
  db: Database.Database;
  storageRoot: string;
  assetId: string;
  canvasId?: string;
  rangeHeader?: string | null;
}): CanvasAssetReadResult {
  const { db, storageRoot, assetId, canvasId, rangeHeader } = params;
  const asset = requireCanvasAsset(db, assetId, canvasId);
  const filePath = canvasAssetAbsolutePath(asset, storageRoot);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new CanvasError('not_found', '素材文件缺失。');
  }
  const size = fs.statSync(filePath).size;
  const baseHeaders: Record<string, string> = {
    'Content-Type': asset.mimeType,
    'Cache-Control': 'private, max-age=3600',
    'Accept-Ranges': 'bytes',
  };

  if (rangeHeader) {
    const range = parseCanvasByteRange(rangeHeader, size);
    if (!range) {
      return {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
        body: null,
        filePath,
        start: 0,
        end: size - 1,
      };
    }
    const length = range.end - range.start + 1;
    return {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(length),
      },
      body: fs.readFileSync(filePath).subarray(range.start, range.end + 1),
      filePath,
      start: range.start,
      end: range.end,
    };
  }

  return {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) },
    body: fs.readFileSync(filePath),
    filePath,
    start: 0,
    end: size - 1,
  };
}
