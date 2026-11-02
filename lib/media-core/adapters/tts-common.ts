import fs from 'node:fs';
import { probeDurationSec, runFfmpeg } from '../../ffmpeg.ts';
import type { AlignmentAdapter, AlignmentWordTiming } from './alignment.ts';
import { speechContent } from './alignment.ts';
import type { SyncOperationContext } from '../execution/sync-operation.ts';
import { isExecutionControlError } from '../execution/waiting.ts';
import { withMediaResource } from '../media-resource-gate.ts';

const PCM_WAV_HEADER_BYTES = 44;

export function proportionalWordTimings(text: string, durationUs: number): AlignmentWordTiming[] {
  const units = Array.from(text).filter((value) => value.trim());
  return units.map((value, index) => ({
    text: value,
    startUs: Math.round(index * durationUs / Math.max(1, units.length)),
    endUs: Math.round((index + 1) * durationUs / Math.max(1, units.length)),
  })).filter((timing) => timing.endUs > timing.startUs);
}

export function splitTtsInput(text: string, maxCharacters = 600): string[] {
  if (Array.from(text).length <= maxCharacters) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (Array.from(remaining).length > maxCharacters) {
    const characters = Array.from(remaining);
    let cut = maxCharacters;
    for (let index = maxCharacters - 1; index >= Math.floor(maxCharacters / 2); index -= 1) {
      if (/[。！？；，,.!?;\s]/u.test(characters[index])) { cut = index + 1; break; }
    }
    parts.push(characters.slice(0, cut).join('').trim());
    remaining = characters.slice(cut).join('').trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

export async function isReusableNarrationChunk(filePath: string): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= PCM_WAV_HEADER_BYTES) return false;
    const durationSec = await probeDurationSec(filePath);
    return Number.isFinite(durationSec) && durationSec > 0;
  } catch {
    return false;
  }
}

export async function concatWavFiles(inputs: string[], output: string, signal?: AbortSignal): Promise<void> {
  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], output);
    return;
  }
  const args = inputs.flatMap((input) => ['-i', input]);
  const labels = inputs.map((_, index) => `[${index}:a]`).join('');
  await withMediaResource({ taskId: output, step: 'tts-concat', wait: false, signal }, () => runFfmpeg([
    ...args,
    '-filter_complex', `${labels}concat=n=${inputs.length}:v=0:a=1[outa]`,
    '-map', '[outa]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', output,
  ], { timeoutMs: 180_000, signal }));
}

export function countTtsContent(value: string): number {
  return Array.from(value.replace(/[\p{P}\p{S}\s]/gu, '')).length;
}

export function readCachedSegmentAlignment(
  filePath: string,
  durationUs: number,
): { words: AlignmentWordTiming[]; degraded: false } | null {
  try {
    const cached = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      durationUs?: number;
      degraded?: boolean;
      words?: AlignmentWordTiming[];
    };
    if (cached.durationUs !== durationUs || cached.degraded || !Array.isArray(cached.words) || cached.words.length === 0) return null;
    if (cached.words.some((word) => !Number.isSafeInteger(word.startUs) || !Number.isSafeInteger(word.endUs) || word.endUs <= word.startUs)) return null;
    return { words: cached.words, degraded: false };
  } catch {
    return null;
  }
}

export function writeCachedSegmentAlignment(
  filePath: string,
  input: { durationUs: number; words: AlignmentWordTiming[] },
): void {
  const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ durationUs: input.durationUs, degraded: false, words: input.words }));
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function alignOrProportionallyTime(input: {
  alignment: AlignmentAdapter;
  audioPath: string;
  narration: string;
  durationUs: number;
  segmentId: string;
  signal?: AbortSignal;
  execution?: SyncOperationContext;
}): Promise<{ words: AlignmentWordTiming[]; degraded: boolean }> {
  try {
    input.signal?.throwIfAborted();
    if (!input.alignment.configured) throw new Error('alignment unavailable');
    const words = await input.alignment.align({ audioPath: input.audioPath, text: input.narration, signal: input.signal, execution: input.execution });
    input.signal?.throwIfAborted();
    let lastEndUs = 0;
    for (const word of words) {
      if (!Number.isSafeInteger(word.startUs) || !Number.isSafeInteger(word.endUs)
        || word.startUs < lastEndUs || word.endUs <= word.startUs || word.endUs > input.durationUs) {
        throw new Error(`强制对齐时间越界或倒退：${input.segmentId}`);
      }
      lastEndUs = word.endUs;
    }
    const expected = speechContent(input.narration);
    if (!expected || speechContent(words.map(word => word.text).join('')) !== expected) {
      throw new Error(`强制对齐内容不一致：${input.segmentId}`);
    }
    return { words, degraded: false };
  } catch (error) {
    if (isExecutionControlError(error)) throw error;
    input.signal?.throwIfAborted();
    return { words: proportionalWordTimings(input.narration, input.durationUs), degraded: true };
  }
}
