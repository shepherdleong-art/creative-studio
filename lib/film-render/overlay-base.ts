import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { runFfmpeg } from '../ffmpeg.ts';
import { createOverlaySubtitleRenderer } from './overlay-subtitles.ts';
import { projectFile } from './files.ts';
import { writeNewJson } from './manifest.ts';
import type { ProcessOptions } from './process.ts';
import type { OverlayRenderSpec } from './types.ts';

/** Lossless prepared clips → hard cuts + bundled Source Han subtitles → CRF 12 base. */
export async function renderOverlayBase(spec: OverlayRenderSpec, prepared: string[], runDir: string, options: ProcessOptions = {}) {
  const dir = path.join(runDir, 'base');
  fs.mkdirSync(dir);
  options.signal?.throwIfAborted();
  const cover = path.join(dir, 'cover.png');
  await sharp(projectFile(spec.project.root, spec.cover.image)).rotate().resize(1080, 1440, { fit: 'cover' }).removeAlpha().png().toFile(cover);
  const ff = (args: string[]) => runFfmpeg(['-nostdin', '-hide_banner', '-n', ...args], { ...options, timeoutMs: 300_000 });
  const coverVideo = path.join(dir, 'cover.mp4');
  await ff(['-loop', '1', '-framerate', '24', '-i', cover, '-an', '-vf', 'setsar=1', '-frames:v', '20',
    '-c:v', 'libx264', '-qp', '0', '-preset', 'fast', '-threads', '2', '-pix_fmt', 'yuv420p', coverVideo]);
  const concat = path.join(dir, 'concat.txt');
  // All paths are generated under this new run directory; escape ffconcat's quote syntax.
  fs.writeFileSync(concat, [coverVideo, ...prepared].map(file => `file '${path.relative(dir, file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', { flag: 'wx' });
  const joined = path.join(dir, 'joined.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', concat, '-an', '-c:v', 'copy', joined]);
  const subtitles = createOverlaySubtitleRenderer();
  const inputs: string[] = [], filters: string[] = [];
  for (const [index, cue] of spec.subtitles.entries()) {
    options.signal?.throwIfAborted();
    const image = path.join(dir, `subtitle-${index}.png`);
    const svg = subtitles.svg(cue.text);
    await sharp(Buffer.from(svg)).png().toFile(image);
    inputs.push('-i', image);
    filters.push(`[${index ? `sub${index}` : '0:v'}][${index + 1}:v]overlay=0:0:enable='gte(n,${cue.startFrame})*lt(n,${cue.endFrame})'[sub${index + 1}]`);
  }
  const picture = path.join(dir, 'picture.mp4');
  await ff(['-i', joined, ...inputs, ...(filters.length ? ['-filter_complex', filters.join(';'), '-map', `[sub${filters.length}]`] : []),
    '-an', '-frames:v', String(spec.canvas.frames), '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', '-threads', '2', '-pix_fmt', 'yuv420p', picture]);
  const composition = path.join(dir, 'composition.json');
  writeNewJson(composition, { version: 1, canvas: spec.canvas, cover: spec.cover, shots: spec.shots, subtitles: spec.subtitles, subtitleStyle: subtitles.style, subtitleFont: subtitles.font, packaging: spec.packaging, staticCover: true });
  return { picture, cover, composition };
}
