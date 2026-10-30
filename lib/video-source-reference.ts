import fs from 'node:fs';
import sharp from 'sharp';
import type Database from 'better-sqlite3';

/** sourceImageId is frozen on the job; never resolve the shot's latest image on retry. */
export async function readVideoSourceReference(db: Database.Database, imageId: string, projectId: string) {
  const image = db.prepare(`SELECT id, originalPath, processedPath, path FROM image_assets
    WHERE id = ? AND projectId = ?`).get(imageId, projectId) as {
      id: string; originalPath: string | null; processedPath: string | null; path: string;
    } | undefined;
  if (!image) throw new Error('当前分镜图不存在或不属于当前项目');
  const file = image.originalPath || image.processedPath || image.path;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    const metadata = await sharp(file).metadata();
    const mimeType = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[metadata.format ?? ''];
    if (!mimeType || (metadata.pages ?? 1) > 1) throw new Error('unsupported image');
    return { id: image.id, kind: 'image' as const, path: file, mimeType, byteSize: stat.size, durationSec: null };
  } catch {
    throw new Error('当前分镜图无法读取，请重新选择有效的 PNG、JPEG 或 WebP 图片');
  }
}
