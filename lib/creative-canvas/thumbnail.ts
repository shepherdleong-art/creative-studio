import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { runFfmpeg } from '../ffmpeg.ts';
import { authorizeManagedFileRead, registerManagedFile } from '../media-core/access-context.ts';
import { withMediaResource } from '../media-core/media-resource-gate.ts';
import { assertNoStorageSymlink } from '../media-core/storage-path.ts';
import { canvasAssetAbsolutePath, type CanvasAssetRecord } from './assets.ts';
import { CanvasError } from './errors.ts';

const SIZE = 160;
const pending = new Map<string, Promise<void>>();

async function writeThumbnail(source: string, target: string, kind: 'image' | 'video') {
  if (kind === 'image') {
    try {
      await sharp(source).rotate().resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 }).toFile(target);
      return;
    } catch {
      // 与画布导入一致，BMP 等本机 sharp 无法解码的素材交给 FFmpeg。
    }
  }
  await runFfmpeg([
    '-abort_on', 'empty_output', '-i', source, '-map', '0:v:0', '-frames:v', '1',
    '-vf', `scale='min(${SIZE},iw)':'min(${SIZE},ih)':force_original_aspect_ratio=decrease`,
    '-c:v', 'libwebp', '-quality', '75', '-threads', '1', '-y', target,
  ], { timeoutMs: 30_000 });
}

export async function materializeCanvasThumbnail(storageRoot: string, asset: CanvasAssetRecord): Promise<string> {
  const kind = asset.mediaKind;
  if (kind !== 'image' && kind !== 'video') throw new CanvasError('invalid_input', '该素材没有画面缩略图。');
  const source = canvasAssetAbsolutePath(asset, storageRoot);
  const grant = authorizeManagedFileRead(source);
  const key = createHash('sha256').update([asset.id, asset.contentHash, grant?.fileId ?? ''].join('\0')).digest('hex');
  const target = assertNoStorageSymlink(storageRoot, path.join('canvas-thumbnails', 'v1', key.slice(0, 2), `${key}.webp`));
  if (!existsSync(target)) {
    let job = pending.get(target);
    if (!job) {
      job = withMediaResource({ taskId: asset.id, step: 'canvas-thumbnail', wait: true }, async () => {
        if (existsSync(target)) return;
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp.webp`;
        try {
          await writeThumbnail(source, temporary, kind);
          await rename(temporary, target).catch((error: unknown) => {
            // 另一服务进程可能已经发布同一不可变素材的缩略图。
            if (!existsSync(target)) throw error;
          });
        } finally {
          await rm(temporary, { force: true });
        }
      }).finally(() => pending.delete(target));
      pending.set(target, job);
    }
    await job;
  }
  if (grant) registerManagedFile({ absolutePath: target, mimeType: 'image/webp', derivedFromFileId: grant.fileId });
  return target;
}
