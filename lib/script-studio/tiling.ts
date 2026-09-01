import fs from 'node:fs';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { ScriptStudioError } from './errors.ts';
import { getScriptStudioLimits, logLimitHit, type ScriptStudioLimits } from './limits.ts';
import {
  loadSourceSetImageRows,
  type SourceSetImageRow,
} from './source-sets.ts';

export interface ScriptStudioTile {
  mimeType: 'image/jpeg';
  imageBase64: string;
  pageIndex: number;
  tileIndex: number;
  width: number;
  height: number;
}

export interface TilePageResult {
  pageIndex: number;
  imageAssetId: string;
  filename: string;
  sourceWidth: number;
  sourceHeight: number;
  tiles: ScriptStudioTile[];
  degraded: boolean;
}

export interface TileSetResult {
  pages: TilePageResult[];
  totalTiles: number;
  maxImagesPerRequest: number;
  degraded: boolean;
}

function validOverlap(ratio: number, tileHeight: number): number {
  return Math.max(0, Math.min(tileHeight - 1, Math.round(tileHeight * ratio)));
}

function tileHeightForCount(
  sourceWidth: number,
  sourceHeight: number,
  limits: ScriptStudioLimits,
): { tileHeight: number; degraded: boolean } {
  const ratio = sourceWidth / Math.max(1, sourceHeight);
  const scaledWidth = Math.min(limits.maxImageWidth, sourceWidth);
  const scaledHeight = Math.round(scaledWidth / ratio);
  let tileHeight = limits.baseTileHeight;
  let attempts = 0;
  while (attempts < 6) {
    const overlap = validOverlap(limits.verticalOverlapRatio, tileHeight);
    const step = Math.max(1, tileHeight - overlap);
    const tileCount = Math.max(1, Math.ceil(Math.max(1, scaledHeight - overlap) / step));
    if (tileCount <= limits.maxImagesPerRequest) {
      return { tileHeight, degraded: tileHeight > limits.baseTileHeight };
    }
    tileHeight = Math.round(tileHeight * 1.35);
    attempts += 1;
  }
  throw new ScriptStudioError(
    'resource_limit',
    `当前详情页 ${sourceWidth}×${sourceHeight} 即使提高切片高度仍超过单请求 ${limits.maxImagesPerRequest} 张上限，请拆分为多页后重试`,
  );
}

export async function tileSourceImages(
  db: Database.Database,
  projectId: string,
  imageAssetIds: string[],
  options: { limits?: ScriptStudioLimits; signal?: AbortSignal } = {},
): Promise<TileSetResult> {
  const limits = options.limits ?? getScriptStudioLimits();
  if (options.signal?.aborted) throw new DOMException('图片读取已取消', 'AbortError');
  const rows = loadSourceSetImageRows(db, projectId, imageAssetIds);
  if (rows.length === 0) throw new ScriptStudioError('invalid_input', '没有可读取的详情页图片');
  const pages: TilePageResult[] = [];
  for (let pageIndex = 0; pageIndex < rows.length; pageIndex += 1) {
    const row = rows[pageIndex]!;
    pages.push(await tileSinglePage(row, pageIndex, limits));
    if (options.signal?.aborted) throw new DOMException('图片读取已取消', 'AbortError');
  }
  const totalTiles = pages.reduce((sum, page) => sum + page.tiles.length, 0);
  return {
    pages,
    totalTiles,
    maxImagesPerRequest: limits.maxImagesPerRequest,
    degraded: pages.some((page) => page.degraded),
  };
}

async function tileStripBuffer(
  filePath: string,
  sourceWidth: number,
  sourceHeight: number,
  resizeWidth: number,
  resizeHeight: number,
  top: number,
  height: number,
  jpegQuality: number,
): Promise<Buffer> {
  const ratio = sourceHeight / Math.max(1, resizeHeight);
  const srcTop = Math.max(0, Math.min(sourceHeight - 1, Math.floor(top * ratio)));
  const srcBottom = Math.max(srcTop + 1, Math.min(sourceHeight, Math.ceil((top + height) * ratio)));
  return sharp(filePath)
    .extract({ left: 0, top: srcTop, width: sourceWidth, height: srcBottom - srcTop })
    .resize({ width: resizeWidth, height, fit: 'fill' })
    .jpeg({ quality: jpegQuality })
    .toBuffer();
}

async function tileSinglePage(
  row: SourceSetImageRow,
  pageIndex: number,
  limits: ScriptStudioLimits,
): Promise<TilePageResult> {
  const filePath = row.originalPath || row.path;
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new ScriptStudioError('invalid_input', `详情页图片不可读：${row.filename}`);
  }
  const pipeline = sharp(filePath);
  const metadata = await pipeline.metadata();
  const sourceWidth = Number(metadata.width) || Number(row.originalWidth) || 0;
  const sourceHeight = Number(metadata.height) || Number(row.originalHeight) || 0;
  if (!sourceWidth || !sourceHeight) {
    throw new ScriptStudioError('invalid_input', `无法读取详情页图片尺寸：${row.filename}`);
  }
  const { tileHeight, degraded } = tileHeightForCount(sourceWidth, sourceHeight, limits);
  const resizeWidth = Math.max(1, Math.min(limits.maxImageWidth, sourceWidth));
  const resizeHeight = Math.max(1, Math.round(resizeWidth * sourceHeight / sourceWidth));
  const overlap = validOverlap(limits.verticalOverlapRatio, tileHeight);
  const step = Math.max(1, tileHeight - overlap);
  const tileHeightCount = Math.max(1, Math.ceil(Math.max(1, resizeHeight - overlap) / step));
  // 超大图不物化整页缩放结果，改为逐条带「源坐标裁剪 → 缩放」的流式管线，
  // 峰值内存只与单条带相关；超限仍记日志供保护值校准（§2.5）。
  const useStripPipeline = sourceWidth * sourceHeight > limits.sourcePixelLimit
    || resizeWidth * resizeHeight * 4 > limits.decodeBufferLimitBytes;
  if (sourceWidth * sourceHeight > limits.sourcePixelLimit) {
    logLimitHit('sourcePixels', sourceWidth * sourceHeight, limits.sourcePixelLimit);
  }
  if (useStripPipeline && resizeWidth * resizeHeight * 4 > limits.decodeBufferLimitBytes) {
    logLimitHit('decodeBufferBytes', resizeWidth * resizeHeight * 4, limits.decodeBufferLimitBytes);
  }
  const base = useStripPipeline ? null : sharp(filePath).resize({
    width: resizeWidth,
    height: resizeHeight,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const tiles: ScriptStudioTile[] = [];
  for (let tileIndex = 0; tileIndex < tileHeightCount; tileIndex += 1) {
    const top = Math.min(Math.max(0, tileIndex * step), Math.max(0, resizeHeight - tileHeight));
    const height = Math.min(tileHeight, resizeHeight - top);
    const buffer = base
      ? await sharp(await base.clone().toBuffer())
        .extract({ left: 0, top, width: resizeWidth, height })
        .jpeg({ quality: limits.jpegQuality })
        .toBuffer()
      : await tileStripBuffer(filePath, sourceWidth, sourceHeight, resizeWidth, resizeHeight, top, height, limits.jpegQuality);
    tiles.push({
      mimeType: 'image/jpeg',
      imageBase64: buffer.toString('base64'),
      pageIndex,
      tileIndex,
      width: resizeWidth,
      height,
    });
  }
  return {
    pageIndex,
    imageAssetId: row.id,
    filename: row.filename,
    sourceWidth,
    sourceHeight,
    tiles,
    degraded,
  };
}

// 模型按 prompt 约定返回 1-based 的 "tile_N" 编号；兼容裸数字与数字字符串。
// 解析失败时不猜（返回 null 由调用方兜底），避免核验时看错切片。
export function parseTileRefIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value >= 1 ? value - 1 : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/(\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return parsed >= 1 ? parsed - 1 : null;
}

export function selectEvidenceTiles(
  page: TilePageResult,
  tileIndex: number,
  radius = 1,
): ScriptStudioTile[] {
  const indices = new Set<number>();
  for (let index = tileIndex - radius; index <= tileIndex + radius; index += 1) {
    if (index >= 0 && index < page.tiles.length) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b).map((index) => page.tiles[index]!);
}
