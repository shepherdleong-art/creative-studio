import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../ffmpeg.ts';
import { resolveStoragePath, toStorageRelativePath } from './storage-path.ts';
import { authorizeManagedFileRead, registerManagedFile } from '../media-core/access-context.ts';
import { withMediaResource } from '../media-core/media-resource-gate.ts';

const inFlightFrames = new Map<string, Promise<void>>();

export async function materializeVideoFrame(input: {
  storageRoot: string;
  sourcePath: string;
  cacheNamespace: string;
  cacheKey: string;
  frameUs: number;
  outputSize?: { width: number; height: number };
  preserveSource?: boolean;
}): Promise<{ absolutePath: string; relativePath: string }> {
  const sourceRelativePath = toStorageRelativePath(input.storageRoot, input.sourcePath);
  const sourceAbsolutePath = resolveStoragePath(input.storageRoot, sourceRelativePath);
  const originalFileId = authorizeManagedFileRead(sourceAbsolutePath)?.fileId ?? null;
  if (!fs.existsSync(sourceAbsolutePath)) throw new Error('视频素材文件不存在');
  const safeKey = crypto.createHash('sha256').update(input.cacheKey).digest('hex');
  const relativePath = path.join('final-edits', 'previews', input.cacheNamespace, `${safeKey}.jpg`);
  const absolutePath = resolveStoragePath(input.storageRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    let frameJob = inFlightFrames.get(absolutePath);
    if (!frameJob) {
      frameJob = (async () => {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        const temporaryPath = `${absolutePath}.${crypto.randomUUID()}.tmp.jpg`;
        try {
          const videoFilter = input.preserveSource
            ? null
            : input.outputSize
            ? `scale=${Math.round(input.outputSize.width)}:${Math.round(input.outputSize.height)}:force_original_aspect_ratio=increase,crop=${Math.round(input.outputSize.width)}:${Math.round(input.outputSize.height)}`
            : 'scale=960:720:force_original_aspect_ratio=increase,crop=960:720';
          await withMediaResource({ taskId: safeKey, step: 'video-frame', wait: true }, () => runFfmpeg([
              '-ss', (Math.max(0, input.frameUs) / 1_000_000).toFixed(6),
              '-i', sourceAbsolutePath,
              '-frames:v', '1',
              ...(videoFilter ? ['-vf', videoFilter] : []),
              '-q:v', '2',
              '-y', temporaryPath,
            ], { timeoutMs: 30_000 }));
          try { fs.renameSync(temporaryPath, absolutePath); }
          catch (error) {
            if (!fs.existsSync(absolutePath)) throw error;
          }
        } finally {
          if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
      })();
      inFlightFrames.set(absolutePath, frameJob);
      void frameJob.finally(() => {
        if (inFlightFrames.get(absolutePath) === frameJob) inFlightFrames.delete(absolutePath);
      }).catch(() => undefined);
    }
    await frameJob;
  }
  if (originalFileId) {
    registerManagedFile({ absolutePath, mimeType: 'image/jpeg', derivedFromFileId: originalFileId });
  }
  return { absolutePath, relativePath };
}
