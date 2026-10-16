import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { runFfmpeg } from '../ffmpeg.ts';
import { createOutputDirectory, sha256 } from './files.ts';
import { imageSsim } from './verify.ts';
import { probeMedia } from './media.ts';
import { measureLoudness } from './audio.ts';
import { writeNewJson } from './manifest.ts';
import { requireInput } from './errors.ts';
import { isClassicSpec, type RenderSpec } from './types.ts';

export function comparisonFrames(spec: RenderSpec): number[] {
  const frames = new Set([0, 10, 19, spec.canvas.frames - 1]);
  for (const shot of spec.shots) {
    frames.add(Math.min(shot.endFrame - 1, shot.startFrame + 5));
    frames.add(Math.floor((shot.startFrame + shot.endFrame) / 2));
    if (isClassicSpec(spec) && Object.hasOwn(spec.classic.labels, shot.id)) frames.add(Math.floor((shot.startFrame + .18 * 24 + shot.endFrame - .02 * 24) / 2));
  }
  if (isClassicSpec(spec)) for (const item of spec.classic.callouts) frames.add(Math.floor((item.startFrame + item.endFrame) / 2));
  else for (const item of spec.packaging.pointCues ?? []) frames.add(Math.floor((item.startSec + item.endSec) * 12));
  return [...frames].sort((a, b) => a - b);
}

export async function compareFilms(input: { spec: RenderSpec; video: string; reference: string; workDir: string; threshold?: number; referenceHtml?: string; sheet?: string; signal?: AbortSignal }) {
  const { spec, video, reference, signal } = input, threshold = input.threshold ?? .98;
  requireInput(Number.isFinite(threshold) && threshold > 0 && threshold <= 1, 'COMPARE_THRESHOLD', 'SSIM 阈值必须在 0–1 之间');
  const workDir = createOutputDirectory(spec.project.root, input.workDir);
  const fresh = await probeMedia(video, workDir, { countFrames: true, signal });
  const old = await probeMedia(reference, workDir, { countFrames: true, signal });
  const videoFields = (p: typeof fresh) => {
    const v = p.streams.find(s => s.codec_type === 'video');
    return [v?.width, v?.height, v?.r_frame_rate, v?.avg_frame_rate, v?.nb_read_frames];
  };
  const sameVideo = JSON.stringify(videoFields(fresh)) === JSON.stringify(videoFields(old)) &&
    Math.abs(Number(fresh.format.duration) - Number(old.format.duration)) < 1e-5;
  const loudNew = await measureLoudness(video, spec.audio.loudness, { signal });
  const loudOld = await measureLoudness(reference, spec.audio.loudness, { signal });
  const audioDuration = (p: typeof fresh) => Number(p.streams.find(s => s.codec_type === 'audio')?.duration);
  const sameAudio = Math.abs(loudNew.integratedLufs - loudOld.integratedLufs) <= .5 && Math.abs(audioDuration(fresh) - audioDuration(old)) <= 1 / 24;
  const frames = comparisonFrames(spec);
  for (const [name, file] of [['new', video], ['old', reference]]) {
    fs.mkdirSync(path.join(workDir, name));
    await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', file, '-vf', `select=${frames.map(n => `eq(n\\,${n})`).join('+')}`,
      '-fps_mode', 'vfr', '-frames:v', String(frames.length), '-threads', '1', path.join(workDir, name, '%03d.png')], { signal, timeoutMs: 300_000 });
  }
  const samples = [];
  const tiles: sharp.OverlayOptions[] = [];
  for (const [index, frame] of frames.entries()) {
    const names = ['new', 'old'].map(name => path.join(workDir, name, `${String(index + 1).padStart(3, '0')}.png`));
    const ssim = await imageSsim(names[0], names[1], { signal });
    samples.push({ frame, ssim, ok: ssim >= threshold });
    for (const [side, file] of names.entries()) tiles.push({ input: await sharp(file).resize(270, 360).png().toBuffer(), left: index % 3 * 540 + side * 270, top: Math.floor(index / 3) * 390 + 30 });
    tiles.push({ input: Buffer.from(`<svg width="540" height="30"><text x="8" y="22" font-size="17" fill="white">Frame ${frame} | new / reference | SSIM ${ssim.toFixed(5)}</text></svg>`), left: index % 3 * 540, top: Math.floor(index / 3) * 390 });
  }
  const sheet = input.sheet ?? path.join(workDir, 'comparison.jpg');
  requireInput(!fs.existsSync(sheet), 'OUTPUT_EXISTS', `对照图已存在: ${sheet}`);
  await sharp({ create: { width: 1620, height: Math.ceil(frames.length / 3) * 390, channels: 3, background: '#222222' } }).composite(tiles).jpeg({ quality: 85 }).toFile(sheet);
  const compositionFile = isClassicSpec(spec) ? 'hf/index.html' : 'base/composition.json';
  const newHtml = path.join(path.dirname(video), compositionFile);
  const adjacentHtml = path.join(path.dirname(reference), compositionFile);
  const oldHtml = input.referenceHtml ?? (fs.existsSync(adjacentHtml) ? adjacentHtml : path.join(spec.project.root, 'variants', spec.project.variant, 'hf/index.html'));
  const htmlMatch = fs.existsSync(newHtml) && fs.existsSync(oldHtml) && fs.readFileSync(newHtml).equals(fs.readFileSync(oldHtml));
  const result = { ok: sameVideo && sameAudio && htmlMatch && samples.every(s => s.ok), threshold, sameVideo, sameAudio,
    inputs: { video, reference, videoSha256: sha256(video), referenceSha256: sha256(reference) },
    newVideo: fresh, referenceVideo: old, loudness: { new: loudNew, reference: loudOld }, html: { match: htmlMatch, newHtml, oldHtml },
    minSsim: Math.min(...samples.map(s => s.ssim)), samples, sheet, report: path.join(workDir, 'comparison.json') };
  writeNewJson(result.report, result); return result;
}
