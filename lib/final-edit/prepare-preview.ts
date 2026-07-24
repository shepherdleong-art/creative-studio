import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { runFfmpeg } from '../ffmpeg.ts';
import { resolveStoragePath } from './storage-path.ts';
import type { FinalEditVariantView, OutputPresetId, VideoTimeline } from './types.ts';

export function preparePreviewCacheKey(input: {
  timeline: VideoTimeline;
  sources: Array<{ videoJobId: string; fingerprint: string }>;
  narration: { fingerprint: string; durationUs: number };
  outputPreset: OutputPresetId;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    timeline: input.timeline,
    sources: [...input.sources].sort((left, right) => left.videoJobId.localeCompare(right.videoJobId)),
    narration: { fingerprint: input.narration.fingerprint, durationUs: input.narration.durationUs },
    outputPreset: input.outputPreset,
  })).digest('hex');
}

export interface PreparePreviewInput {
  storageRoot: string;
  relativePath: string;
  variant: FinalEditVariantView;
  sources: Array<{ videoJobId: string; absolutePath: string }>;
  narrationAbsolutePath: string;
}

const PREVIEW_SIZE = {
  '9x16': { width: 270, height: 480 },
  '3x4': { width: 360, height: 480 },
  '16x9': { width: 480, height: 270 },
} as const;

export async function warmPreparePreview(input: PreparePreviewInput): Promise<{ relativePath: string }> {
  const outputPath = resolveStoragePath(input.storageRoot, input.relativePath);
  if (fs.existsSync(outputPath) && fs.lstatSync(outputPath).isFile() && fs.statSync(outputPath).size > 0) {
    return { relativePath: input.relativePath };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const clips = [...input.variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
  if (!clips.length) throw new Error('低清预览没有可用视频片段');
  const sourceById = new Map(input.sources.map((source) => [source.videoJobId, source.absolutePath]));
  const realStorageRoot = fs.realpathSync(input.storageRoot);
  for (const source of input.sources) {
    const stat = fs.lstatSync(source.absolutePath);
    const relative = path.relative(realStorageRoot, fs.realpathSync(source.absolutePath));
    if (stat.isSymbolicLink() || !stat.isFile() || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('低清预览素材路径无效');
  }
  const args: string[] = [];
  for (const clip of clips) {
    const source = sourceById.get(clip.videoJobId);
    if (!source) throw new Error(`低清预览缺少素材：${clip.videoJobId}`);
    args.push('-ss', (clip.sourceInFrame / 24).toFixed(6), '-t', ((clip.sourceOutFrame - clip.sourceInFrame) / 24).toFixed(6), '-i', source);
  }
  args.push('-i', input.narrationAbsolutePath);
  const size = PREVIEW_SIZE[input.variant.outputPreset];
  const filters = clips.map((_, index) => `[${index}:v]fps=12,scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1,format=yuv420p[v${index}]`);
  filters.push(`${clips.map((_, index) => `[v${index}]`).join('')}concat=n=${clips.length}:v=1:a=0[video]`);
  const temporaryPath = `${outputPath}.${process.pid}.tmp.mp4`;
  try {
    await runFfmpeg([
      ...args,
      '-filter_complex', filters.join(';'),
      '-map', '[video]', '-map', `${clips.length}:a`, '-shortest',
      '-r', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
      '-c:a', 'aac', '-movflags', '+faststart', '-y', temporaryPath,
    ], { timeoutMs: 5 * 60_000 });
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return { relativePath: input.relativePath };
}
