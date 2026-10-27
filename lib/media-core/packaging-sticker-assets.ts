import fs from 'node:fs';
import path from 'node:path';
import { PackagingError } from './packaging-runtime.ts';
import { resolveStickerAssetFile, STICKER_STYLE_BY_TEMPLATE, type PackagingStickerInstance } from './packaging-stickers.ts';
import type { PackagingTemplateId } from './packaging-vars.ts';

export type ResolvedPackagingStickerAsset = {
  file: string;
  width: number;
  height: number;
  alpha_gt8_bbox: [number, number, number, number];
  sha256: string;
};

export type PackagingStickerAssetMap = Record<string, ResolvedPackagingStickerAsset>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveWithin(root: string, relativeFile: string): string | null {
  const resolved = path.resolve(root, relativeFile);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function catalogError(message: string): PackagingError {
  return new PackagingError('sticker_catalog_invalid', `贴纸目录无效：${message}`, 409);
}

function readCatalog(root: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf-8'));
  } catch (error) {
    throw catalogError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.assets)) throw catalogError('缺少 assets 数组');
  return parsed.assets;
}

function parseAsset(raw: unknown, expectedFile: string): ResolvedPackagingStickerAsset {
  if (!isRecord(raw) || raw.file !== expectedFile) throw catalogError(`缺少 ${expectedFile}`);
  const bbox = raw.alpha_gt8_bbox;
  if (typeof raw.width !== 'number' || !Number.isSafeInteger(raw.width) || raw.width <= 0
    || typeof raw.height !== 'number' || !Number.isSafeInteger(raw.height) || raw.height <= 0
    || !Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw catalogError(`${expectedFile} 的尺寸或有效包围框无效`);
  }
  const [left, top, right, bottom] = bbox as number[];
  if (left < 0 || top < 0 || right > raw.width || bottom > raw.height || right <= left || bottom <= top) {
    throw catalogError(`${expectedFile} 的有效包围框越界`);
  }
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw catalogError(`${expectedFile} 的 SHA-256 无效`);
  return {
    file: expectedFile,
    width: raw.width,
    height: raw.height,
    alpha_gt8_bbox: [left, top, right, bottom],
    sha256: raw.sha256,
  };
}

/** 按实例解析当前模板实际使用的原图；返回值只含相对路径与几何元数据，不带开发机绝对路径。 */
export function resolvePackagingStickerAssets(input: {
  packagingDir: string;
  template: string;
  stickers?: PackagingStickerInstance[];
}): PackagingStickerAssetMap {
  const stickers = input.stickers ?? [];
  if (stickers.length === 0) return {};
  if (!Object.prototype.hasOwnProperty.call(STICKER_STYLE_BY_TEMPLATE, input.template)) {
    throw new PackagingError('sticker_template_unsupported', '当前包装模板不支持贴纸', 409);
  }
  const root = path.resolve(input.packagingDir, 'stickers');
  const catalog = readCatalog(root);
  const byFile = new Map<string, unknown>();
  for (const item of catalog) {
    if (isRecord(item) && typeof item.file === 'string' && !byFile.has(item.file)) byFile.set(item.file, item);
  }
  const result: PackagingStickerAssetMap = {};
  for (const sticker of stickers) {
    const file = resolveStickerAssetFile(sticker, input.template as PackagingTemplateId);
    const asset = parseAsset(byFile.get(file), file);
    const absolute = resolveWithin(root, file);
    if (!absolute || !fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      throw new PackagingError('sticker_asset_missing', `贴纸原图缺失：${file}`, 409);
    }
    result[sticker.id] = asset;
  }
  return result;
}
