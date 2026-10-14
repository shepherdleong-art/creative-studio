import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveFfprobePath, runFfmpeg } from '../ffmpeg.ts';
import { FilmRenderError, requireInput } from './errors.ts';
import { projectFile } from './files.ts';
import { runCaptured, type ProcessOptions } from './process.ts';
import type { RenderSpec, Shot } from './types.ts';

// Provisional until Appendix A is checked: reassembled-film-render.py:22-41, 68-74.
export const LEGACY_VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '2'];
export const CLASSIC_BASE_FILTER = 'scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440,setsar=1,fps=24';
export interface MediaStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number;
  r_frame_rate?: string; avg_frame_rate?: string; nb_read_frames?: string;
  nb_frames?: string; duration?: string; start_time?: string;
}
export interface MediaProbe { streams: MediaStream[]; format: { duration?: string; start_time?: string } }

export function assertNewFile(file: string): void {
  requireInput(!fs.existsSync(file), 'OUTPUT_EXISTS', `输出文件已存在: ${file}`);
  requireInput(fs.existsSync(path.dirname(file)), 'OUTPUT_DIRECTORY_MISSING', `输出父目录不存在: ${file}`);
}

/** ffprobe writes to a private file, not an inherited stdout pipe (Windows deadlock). */
export async function probeMedia(file: string, workDir: string, options: ProcessOptions & { countFrames?: boolean } = {}): Promise<MediaProbe> {
  options.signal?.throwIfAborted();
  const output = path.join(workDir, `probe-${randomUUID()}.json`);
  const errorOutput = output + '.stderr';
  assertNewFile(output);
  try {
    await runCaptured(resolveFfprobePath(), ['-v', 'error', ...(options.countFrames ? ['-count_frames'] : []),
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration,start_time:format=duration,start_time',
      '-of', 'json', file], { ...options, timeoutMs: options.timeoutMs ?? 60_000,
      outputFiles: { stdout: output, stderr: errorOutput } });
    const result = JSON.parse(fs.readFileSync(output, 'utf8')) as MediaProbe;
    if (!Array.isArray(result.streams) || !result.format) throw new FilmRenderError('PROBE_INVALID', 'ffprobe 没有返回流信息', 4);
    return result;
  } finally { fs.rmSync(output, { force: true }); fs.rmSync(errorOutput, { force: true }); }
}

export async function assertAudioDuration(file: string, seconds: number, workDir: string, options: ProcessOptions = {}): Promise<number> {
  const probe = await probeMedia(file, workDir, options);
  const actual = Number(probe.format.duration);
  if (!Number.isFinite(actual) || Math.abs(actual - seconds) > .02) {
    throw new FilmRenderError('AUDIO_DURATION', `${path.basename(file)} 音频时长 ${actual}s 与目标 ${seconds}s 相差超过 0.02s`, 4);
  }
  return actual;
}

/** Extra four frames allow the next scene's blur transition to overlap real footage. */
export async function prepareShot(spec: RenderSpec, shot: Shot, output: string, tailFrames: number, options: ProcessOptions = {}): Promise<MediaProbe> {
  options.signal?.throwIfAborted();
  assertNewFile(output);
  const file = projectFile(spec.project.root, shot.file);
  const frames = shot.endFrame - shot.startFrame + tailFrames;
  requireInput(Number.isSafeInteger(frames) && frames > 0 && Number.isInteger(tailFrames) && tailFrames >= 0,
    'INVALID_TIMELINE', '片段准备帧数不合法');
  const meta = await probeMedia(file, path.dirname(output), options);
  const video = meta.streams.find(s => s.codec_type === 'video');
  const sourceDuration = Number(video?.duration ?? meta.format.duration);
  const required = shot.inSec + frames / 24 * shot.rate;
  requireInput(video && Number.isFinite(sourceDuration) && required <= sourceDuration + .05,
    'SOURCE_TOO_SHORT', `镜头 ${shot.id} 需源片至 ${required}s（含转场余量），仅有 ${sourceDuration}s`);
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-ss', String(shot.inSec), '-i', file,
    '-vf', `setpts=(PTS-STARTPTS)/${shot.rate},${CLASSIC_BASE_FILTER}`, '-an', '-frames:v', String(frames),
    ...LEGACY_VIDEO_ARGS, output], { ...options, timeoutMs: options.timeoutMs ?? 300_000 });
  const result = await probeMedia(output, path.dirname(output), { ...options, countFrames: true });
  const stream = result.streams.find(s => s.codec_type === 'video');
  if (Number(stream?.nb_read_frames) !== frames) throw new FilmRenderError('PREPARED_FRAME_COUNT', `镜头 ${shot.id} 实际解码帧数不足 ${frames}`, 4);
  return result;
}

export async function prepareShots(spec: RenderSpec, mediaDir: string, options: ProcessOptions = {}): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < spec.shots.length; i++) {
    const output = path.join(mediaDir, spec.shots[i].id + '.mp4');
    await prepareShot(spec, spec.shots[i], output, i < spec.shots.length - 1 ? 4 : 0, options);
    files.push(output);
  }
  return files;
}

/** Final picture is already encoded; edge correction awaits Appendix A and step 6. */
export async function muxFilm(spec: RenderSpec, picture: string, audio: string, output: string, options: ProcessOptions = {}): Promise<void> {
  assertNewFile(output);
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', picture, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-frames:v', String(spec.canvas.frames), '-t', String(spec.canvas.frames / 24), '-movflags', '+faststart', output],
    { ...options, timeoutMs: options.timeoutMs ?? 300_000 });
}

export async function extractCover(spec: RenderSpec, video: string, jpg: string, png: string, options: ProcessOptions = {}): Promise<void> {
  assertNewFile(jpg); assertNewFile(png);
  const frame = String(spec.output.coverFrame);
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', video, '-vf', `select=eq(n\\,${frame})`,
    '-frames:v', '1', '-threads', '1', png], { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', png, '-frames:v', '1', '-q:v', '2', '-threads', '1', jpg],
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
}
