import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpegPath, runFfmpeg } from '../ffmpeg.ts';
import { FilmRenderError } from './errors.ts';
import { createOutputDirectory, projectFile } from './files.ts';
import { measureLoudness } from './audio.ts';
import { CLASSIC_BASE_FILTER, probeMedia } from './media.ts';
import { runCaptured, type ProcessOptions } from './process.ts';
import type { RenderSpec } from './types.ts';

export interface TechnicalCheck { code: string; ok: boolean; message: string; details?: unknown }
export interface VerifyResult { ok: boolean; checks: TechnicalCheck[]; checksPath: string }
// Windows references: RC2C media_pipeline.py:51–52; finish_variant.py:31–35.
export const VERIFY_THRESHOLDS = {
  coverMeanAbsoluteDifference: .8,
  firstFrameBlackFraction: .98,
  coverJpegSsim: .98,
  edgeBlackLuma: 8,
  edgeReferenceLuma: 16,
};

async function frameGray(file: string, frame: number, output: string, filter: string, options: ProcessOptions): Promise<Buffer> {
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', file, '-vf', `select=eq(n\\,${frame}),${filter}`,
    '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-threads', '1', output], { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  return fs.readFileSync(output);
}

export async function imageSsim(a: string, b: string, options: ProcessOptions = {}): Promise<number> {
  const { stderr } = await runCaptured(resolveFfmpegPath(), ['-nostdin', '-hide_banner', '-i', a, '-i', b,
    '-filter_complex', '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim', '-frames:v', '1', '-f', 'null', '-'], options);
  const match = [...stderr.matchAll(/All:([0-9.]+)/g)].at(-1);
  if (!match) throw new FilmRenderError('SSIM_MEASUREMENT', '没有取得 SSIM 数据', 4);
  return Number(match[1]);
}

export interface EdgeSample { frame: number; shot: string; rightLuma: number; adjacentLuma: number; sourceRightLuma: number | null; artificial: boolean }
function stripMeans(bytes: Buffer): [number, number] {
  if (bytes.length !== 16 * 180) throw new FilmRenderError('EDGE_FRAME_MISSING', '边缘检查未取得完整帧', 4);
  let left = 0, right = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (i % 16 < 8) left += bytes[i]; else right += bytes[i];
  }
  return [left / (8 * 180), right / (8 * 180)];
}

/** Detect only a generated right-edge strip. A black source edge is not a renderer fault. */
export async function inspectRightEdge(spec: RenderSpec, video: string, workDir: string, options: ProcessOptions = {}): Promise<EdgeSample[]> {
  const results: EdgeSample[] = [];
  const filter = 'crop=16:ih:iw-16:0,scale=16:180';
  for (const shot of spec.shots) {
    for (const frame of new Set([Math.min(shot.endFrame - 1, shot.startFrame + 5), Math.floor((shot.startFrame + shot.endFrame) / 2)])) {
      const output = path.join(workDir, `edge-${frame}.gray`);
      const [adjacent, right] = stripMeans(await frameGray(video, frame, output, filter, options));
      let sourceRight: number | null = null;
      if (right < VERIFY_THRESHOLDS.edgeBlackLuma && adjacent > VERIFY_THRESHOLDS.edgeReferenceLuma) {
        const source = projectFile(spec.project.root, shot.file);
        const at = shot.inSec + (frame - shot.startFrame) / 24 * shot.rate;
        const sourceOut = path.join(workDir, `source-edge-${frame}.gray`);
        await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-ss', String(at), '-i', source,
          '-vf', `${CLASSIC_BASE_FILTER},${filter}`, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-threads', '1', sourceOut],
          { ...options, timeoutMs: options.timeoutMs ?? 120_000 });
        sourceRight = stripMeans(fs.readFileSync(sourceOut))[1];
      }
      results.push({ frame, shot: shot.id, rightLuma: right, adjacentLuma: adjacent, sourceRightLuma: sourceRight,
        artificial: sourceRight !== null && sourceRight > VERIFY_THRESHOLDS.edgeReferenceLuma });
    }
  }
  return results;
}

export async function verifyFilm(args: {
  spec: RenderSpec; video: string; cover: string; workDir: string; signal?: AbortSignal;
}): Promise<VerifyResult> {
  const { spec, video, cover, signal } = args;
  signal?.throwIfAborted();
  // The caller supplies a new review directory; verifying cannot overwrite an old report.
  const workDir = createOutputDirectory(spec.project.root, args.workDir);
  const options = { signal, timeoutMs: 300_000 };
  const checks: TechnicalCheck[] = [];
  const check = (code: string, ok: boolean, message: string, details?: unknown) => checks.push({ code, ok, message, ...(details === undefined ? {} : { details }) });
  const phase = async (code: string, action: () => Promise<void>) => {
    try { await action(); }
    catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      check(code, false, error instanceof Error ? error.message : String(error));
    }
  };
  await phase('PROBE_FAILED', async () => {
    const probe = await probeMedia(video, workDir, { ...options, countFrames: true });
    const v = probe.streams.find(s => s.codec_type === 'video');
    const a = probe.streams.find(s => s.codec_type === 'audio');
    const seconds = Number(probe.format.duration);
    const ratio = (value?: string) => { const [n, d] = (value ?? '').split('/').map(Number); return n / d; };
    check('VIDEO_FORMAT', v?.width === 1080 && v.height === 1440 && ratio(v.r_frame_rate) === 24 && ratio(v.avg_frame_rate) === 24,
      '1080×1440 / 恒定 24fps', v);
    check('VIDEO_FRAMES', Number(v?.nb_read_frames) === spec.canvas.frames, '实际解码帧数等于渲染单', { expected: spec.canvas.frames, decoded: Number(v?.nb_read_frames) });
    check('VIDEO_DURATION', seconds >= 15 && Math.abs(seconds - spec.canvas.frames / 24) <= 1 / 24,
      '片长至少 15 秒且与渲染单一致', { seconds });
    const audioDuration = Number(a?.duration), audioStart = Number(a?.start_time ?? 0);
    check('AUDIO_COVERAGE', !!a && Number.isFinite(audioDuration) && audioStart <= 1 / 24 && audioStart >= -1 / 24 &&
      Math.abs(seconds - audioDuration) <= 2 / 24 && audioStart + audioDuration >= seconds - 2 / 24,
      '音轨覆盖全片，容器与音轨时长差不超过 2 帧', { videoDuration: seconds, audioDuration, audioStart });
  });
  await phase('DECODE_FAILED', async () => {
    await runCaptured(resolveFfmpegPath(), ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-i', video, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], options);
    check('FULL_DECODE', true, '完整解码无错误');
  });
  await phase('LOUDNESS_FAILED', async () => {
    const measured = await measureLoudness(video, spec.audio.loudness, options);
    check('AUDIO_LOUDNESS', measured.integratedLufs > -17 && measured.integratedLufs < -15 && measured.truePeakDb <= -1.4,
      '整体响度 −17 至 −15 LUFS，真峰值不高于 −1.4 dBTP', measured);
  });
  await phase('BLACK_FRAMES_CHECK_FAILED', async () => {
    const { stderr } = await runCaptured(resolveFfmpegPath(), ['-nostdin', '-hide_banner', '-i', video,
      '-vf', 'blackdetect=d=0.1:pix_th=0.02', '-an', '-f', 'null', '-'], options);
    check('BLACK_FRAMES', !stderr.includes('black_start:'), '无连续 0.1 秒以上黑帧');
  });
  await phase('COVER_CHECK_FAILED', async () => {
    const raw = path.join(workDir, 'cover-frames.rgb');
    await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', video, '-frames:v', '20', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-threads', '1', raw], options);
    const bytes = fs.readFileSync(raw);
    const size = 1080 * 1440 * 3;
    if (bytes.length !== 20 * size) throw new FilmRenderError('COVER_FRAMES_MISSING', '封面不足 20 帧或尺寸不符', 4);
    const differences: number[] = [];
    let black = 0;
    for (let i = 0; i < size; i++) if (bytes[i] <= 8) black++;
    for (let frame = 1; frame < 20; frame++) {
      let difference = 0;
      for (let i = 0; i < size; i++) difference += Math.abs(bytes[frame * size + i] - bytes[i]);
      differences.push(difference / size);
    }
    check('COVER_STATIC', differences.every(d => d < VERIFY_THRESHOLDS.coverMeanAbsoluteDifference),
      '第 0–19 帧接近完全静止', { meanAbsoluteDifferencesFromFirst: differences, threshold: VERIFY_THRESHOLDS.coverMeanAbsoluteDifference });
    check('COVER_FIRST_FRAME', black / size < VERIFY_THRESHOLDS.firstFrameBlackFraction, '首帧不是黑帧（完整文案仍需视觉检查）', { blackFraction: black / size });
    const reference = path.join(workDir, 'cover-reference.png');
    await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', video, '-vf', `select=eq(n\\,${spec.output.coverFrame})`, '-frames:v', '1', '-threads', '1', reference], options);
    const similarity = await imageSsim(reference, cover, options);
    check('COVER_JPEG', similarity >= VERIFY_THRESHOLDS.coverJpegSsim, 'JPG 与静帧封面一致', { ssim: similarity, threshold: VERIFY_THRESHOLDS.coverJpegSsim });
  });
  await phase('RIGHT_EDGE_CHECK_FAILED', async () => {
    const samples = await inspectRightEdge(spec, video, workDir, options);
    check('RIGHT_EDGE', samples.every(s => !s.artificial), '右侧没有源片之外的渲染黑条', { samples });
  });
  const checksPath = path.join(workDir, 'checks.json');
  const result = { ok: checks.every(c => c.ok), checks, checksPath };
  fs.writeFileSync(checksPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
