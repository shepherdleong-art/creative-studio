import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../../data-root.ts';

/**
 * 模板库参考图片副本的受管存储（方案 §6.1：图片只保存副本和元数据，不依赖原工作簿继续存在；
 * 资产路径保存为 `dataRoot()/storage` 相对路径，读取端必须经受控路径守卫）。
 */

export interface StoredAsset {
  relativePath: string;
  contentSha256: string;
  width: number | null;
  height: number | null;
}

function assetDir(revisionId: string): string {
  return path.join(dataRoot(), 'storage', 'script-studio', 'catalogs', 'template', revisionId, 'assets');
}

/** 计算图片宽高（尽力而为，sharp 不可用/失败返回 null）。 */
async function probeImageSize(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(buffer).metadata();
    return { width: metadata.width ?? null, height: metadata.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

/** 把图片副本原子写入受管目录并返回相对路径与指纹。 */
export async function storeAssetImage(
  revisionId: string,
  buffer: Buffer,
  extension: string,
): Promise<StoredAsset> {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeExtension = /^[A-Za-z0-9]{1,6}$/.test(extension) ? extension.toLowerCase() : 'png';
  const dir = assetDir(revisionId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${sha256}.${safeExtension}`;
  const absolutePath = path.join(dir, filename);
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, buffer, { flag: 'wx' });
  }
  const { width, height } = await probeImageSize(buffer);
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  return {
    relativePath: path.relative(storageRoot, absolutePath).split(path.sep).join('/'),
    contentSha256: sha256,
    width,
    height,
  };
}

/**
 * 删除某修订已落盘的参考图副本目录。发布（DB 事务）失败时由调用方清理孤儿资产，
 * 保证「先落盘、后发布」不留下未入册的图片文件。
 */
export function removePersistedTemplateAssets(revisionId: string): void {
  try {
    const dir = assetDir(revisionId);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  } catch {
    // 清理尽力而为，不掩盖原始错误。
  }
}
