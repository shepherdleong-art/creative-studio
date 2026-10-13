import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { runFfmpeg } from '../ffmpeg.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from './render-contract.ts';
import { buildPackagingVars, type FinalEditPackagingConfig } from './packaging-vars.ts';
import { buildTimelineVars, resolvePackagingDir, resolvePackagingNode, resolvePackagingTemplateDir, runPackagingPipeline } from './packaging-runtime.ts';
import { safeFontFilename, userFontDir } from './packaging-font.ts';
import { composeCoverJpg } from './cover-compose.ts';

/** Render into the caller's private job directory; publishing and lineage remain the caller's responsibility. */
export async function renderVideoPackaging(input: {
  videoPath: string; coverPath: string; config: FinalEditPackagingConfig; totalSec: number;
  signal?: AbortSignal; onProgress?: (value: number) => void;
}): Promise<void> {
  if (!input.config.enabled) return;
  input.signal?.throwIfAborted();
  const dir = resolvePackagingDir();
  const template = resolvePackagingTemplateDir(dir, input.config.template);
  const jobDir = path.dirname(input.videoPath);
  const output = path.join(jobDir, 'packaged.mp4');
  const coverSec = FINAL_EDIT_INTRO_DURATION_US / 1e6;
  const fonts: Record<string, string> = {};
  for (const slot of ['title', 'subtitle', 'point'] as const) {
    const font = input.config[`${slot}Font`];
    if (!font) continue;
    const file = safeFontFilename(font.file);
    if (!file) throw new Error('包装字体文件名无效');
    await fs.access(path.join(userFontDir(), file));
    fonts[`${slot}File`] = file;
  }
  const vars = buildTimelineVars({ vars: buildPackagingVars({ subtitleCues: [], overrides: input.config.varsOverrides }),
    totalSec: input.totalSec, coverSec, pointCues: input.config.pointCues ?? [], pointCuesMode: input.config.pointCuesMode ?? 'none', layouts: input.config.layouts, fonts });
  const varsPath = path.join(jobDir, 'packaging-vars.json');
  await fs.writeFile(varsPath, JSON.stringify(vars), 'utf8');
  await runPackagingPipeline({ nodeExe: resolvePackagingNode(), packagingDir: dir,
    args: [path.join(dir, 'package-video.mjs'), input.videoPath, varsPath, output, template], signal: input.signal, onStage: input.onProgress });
  input.signal?.throwIfAborted();
  const overlay = path.join(jobDir, 'overlay.webm');
  const coverOverlay = path.join(jobDir, 'packaging-cover.png');
  // 模板在封面结束前淡出；取中点可保留落定后的完整不透明包装。
  await runFfmpeg(['-y', '-c:v', 'libvpx-vp9', '-i', overlay, '-ss', Math.max(0.04, coverSec / 2).toFixed(6), '-frames:v', '1', '-pix_fmt', 'rgba', coverOverlay], { signal: input.signal, timeoutMs: 60_000 });
  const metadata = await sharp(input.coverPath).metadata();
  if (!metadata.width || !metadata.height) throw new Error('封面底图尺寸无效');
  const packagedCover = path.join(jobDir, 'packaging-cover.jpg');
  await composeCoverJpg({ coverSourcePath: input.coverPath, output: { width: metadata.width, height: metadata.height }, overlays: [coverOverlay], jpgPath: packagedCover });
  await fs.rename(packagedCover, input.coverPath);
  await fs.rename(output, input.videoPath);
  await Promise.all([fs.unlink(overlay), fs.unlink(coverOverlay)]);
}
