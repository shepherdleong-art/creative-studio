import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../ffmpeg.ts';
import { resolveStoragePath, toStorageRelativePath } from './storage-path.ts';

const inFlightFrames = new Map<string, Promise<void>>();

export async function materializeVideoFrame(input: {
  storageRoot: string;
  sourcePath: string;
  cacheNamespace: string;
  cacheKey: string;
  frameUs: number;
}): Promise<{ absolutePath: string; relativePath: string }> {
  const sourceRelativePath = toStorageRelativePath(input.storageRoot, input.sourcePath);
  const sourceAbsolutePath = resolveStoragePath(input.storageRoot, sourceRelativePath);
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
          await runFfmpeg([
            '-ss', (Math.max(0, input.frameUs) / 1_000_000).toFixed(6),
            '-i', sourceAbsolutePath,
            '-frames:v', '1',
            '-vf', 'scale=960:720:force_original_aspect_ratio=increase,crop=960:720',
            '-q:v', '2',
            '-y', temporaryPath,
          ], { timeoutMs: 30_000 });
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
  return { absolutePath, relativePath };
}
