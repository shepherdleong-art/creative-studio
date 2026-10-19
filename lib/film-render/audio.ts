import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpegPath, runFfmpeg } from '../ffmpeg.ts';
import { FilmRenderError, requireInput } from './errors.ts';
import { projectFile } from './files.ts';
import { roundEven } from './python-format.ts';
import { encodePcmWav, readPcmWav } from './wav.ts';
import { assertAudioDuration, assertNewFile, probeMedia } from './media.ts';
import { runCaptured, type ProcessOptions } from './process.ts';
import type { FilmAudio, RenderSpec } from './types.ts';

export interface LoudnessMeasurement { integratedLufs: number; truePeakDb: number; lra: number; threshold: number; offset: number }
export function parseLoudnorm(stderr: string): LoudnessMeasurement {
  const match = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)].at(-1);
  if (!match) throw new FilmRenderError('LOUDNESS_MEASUREMENT', 'ffmpeg 未返回 loudnorm 数据', 4);
  const data = JSON.parse(match[0]);
  const result = { integratedLufs: Number(data.input_i), truePeakDb: Number(data.input_tp), lra: Number(data.input_lra),
    threshold: Number(data.input_thresh), offset: Number(data.target_offset) };
  if (!Object.values(result).every(Number.isFinite)) throw new FilmRenderError('LOUDNESS_NONFINITE', '音频静音或响度数据不合法', 4);
  return result;
}
const loudnessFilter = (l: FilmAudio['loudness']) => `loudnorm=I=${l.integratedLufs}:TP=${l.truePeakDb}:LRA=${l.lra}`;

export async function measureLoudness(file: string, loudness: FilmAudio['loudness'], options: ProcessOptions = {}): Promise<LoudnessMeasurement> {
  const result = await runCaptured(resolveFfmpegPath(), ['-nostdin', '-hide_banner', '-i', file,
    '-map', '0:a:0', '-af', loudnessFilter(loudness) + ':print_format=json', '-f', 'null', '-'], options);
  return parseLoudnorm(result.stderr);
}

export function stitchNarration(spec: RenderSpec, output: string, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  assertNewFile(output);
  const samples = spec.canvas.frames * 2000;
  requireInput(Number.isSafeInteger(samples) && samples * 2 <= 0xffffffff - 36, 'INVALID_WAV', '配音长度超出 RIFF 上限');
  const pcm = Buffer.alloc(samples * 2);
  let previousEnd = 0;
  for (const v of spec.audio.voices) {
    signal?.throwIfAborted();
    const wav = readPcmWav(projectFile(spec.project.root, v.file));
    requireInput(wav.sampleRate === 48000 && wav.channels === 1, 'VOICE_FORMAT', '配音必须为 48kHz 单声道 PCM16 WAV');
    const start = roundEven(v.trimStart * 48000), end = roundEven(v.trimEnd * 48000);
    requireInput(Number.isFinite(start) && start >= 0 && start < end && end <= wav.sampleFrames, 'VOICE_TRIM', '配音裁切范围不合法');
    const offset = v.atFrame * 2000;
    requireInput(Number.isSafeInteger(offset) && offset >= previousEnd, 'VOICE_OVERLAP', '配音重叠或顺序不递增');
    previousEnd = offset + end - start;
    requireInput(previousEnd <= samples, 'VOICE_OVERFLOW', '配音超出片尾');
    wav.pcm.copy(pcm, offset * 2, start * 2, end * 2);
  }
  fs.writeFileSync(output, encodePcmWav(pcm), { flag: 'wx' });
}

export async function mixFilmAudio(spec: RenderSpec, audioDir: string, options: ProcessOptions = {}) {
  const narration = path.join(audioDir, 'narration.wav'), premix = path.join(audioDir, 'premix.wav'), final = path.join(audioDir, 'final.wav');
  [narration, premix, final].forEach(assertNewFile);
  const seconds = spec.canvas.frames / 24;
  const m = spec.audio.music, d = m.ducking;
  const musicFile = projectFile(spec.project.root, m.file);
  const musicProbe = await probeMedia(musicFile, audioDir, options);
  const musicDuration = Number(musicProbe.streams.find(s => s.codec_type === 'audio')?.duration ?? musicProbe.format.duration);
  requireInput(Number.isFinite(musicDuration) && musicDuration > 0, 'MUSIC_DURATION', '配乐时长必须大于零');
  // ffmpeg 6.0 on macOS can hang at teardown with -stream_loop -1. A finite
  // repetition count emits the same samples through the fixed atrim boundary.
  requireInput(m.inSec < musicDuration, 'MUSIC_OFFSET', '配乐入点必须小于源文件时长');
  const repeats = Math.max(0, Math.ceil((seconds + m.inSec) / musicDuration) - 1);
  stitchNarration(spec, narration, options.signal);
  const narrationDuration = await assertAudioDuration(narration, seconds, audioDir, options);
  const filters = [
    '[0:a]asplit=2[vo][duck]',
    `[1:a]aresample=48000,volume=${m.gainDb}dB,atrim=duration=${seconds},afade=t=in:d=${m.fadeInSec},afade=t=out:st=${seconds-m.fadeOutSec}:d=${m.fadeOutSec}[bgm]`,
    `[bgm][duck]sidechaincompress=threshold=${d.threshold}:ratio=${d.ratio}:attack=${d.attackMs}:release=${d.releaseMs}[music]`,
    '[vo][music]amix=inputs=2:normalize=0[mix]',
  ];
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', narration, '-ss', String(m.inSec), '-stream_loop', String(repeats),
    '-i', musicFile, '-filter_complex', filters.join(';'), '-map', '[mix]', '-t', String(seconds),
    '-c:a', 'pcm_s16le', premix], { ...options, timeoutMs: options.timeoutMs ?? 300_000 });
  const premixDuration = await assertAudioDuration(premix, seconds, audioDir, options);
  const first = await measureLoudness(premix, spec.audio.loudness, options);
  const filter = loudnessFilter(spec.audio.loudness) + `:measured_I=${first.integratedLufs}:measured_TP=${first.truePeakDb}` +
    `:measured_LRA=${first.lra}:measured_thresh=${first.threshold}:offset=${first.offset}:linear=true:print_format=json`;
  await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', premix, '-af', filter, '-ar', '48000', '-c:a', 'pcm_s16le', final],
    { ...options, timeoutMs: options.timeoutMs ?? 300_000 });
  const finalDuration = await assertAudioDuration(final, seconds, audioDir, options);
  const measured = await measureLoudness(final, spec.audio.loudness, options);
  if (measured.integratedLufs <= -17 || measured.integratedLufs >= -15 || measured.truePeakDb > -1.4) {
    throw new FilmRenderError('AUDIO_LOUDNESS', `混音响度/峰值不合格: ${JSON.stringify(measured)}`, 4);
  }
  return { narration, premix, final, firstPass: first, measured, durations: { narration: narrationDuration, premix: premixDuration, final: finalDuration } };
}
