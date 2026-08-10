import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { probeDurationSec, runFfmpeg } from '../../ffmpeg.ts';
import { assertTtsSpeed } from '../tts-speed.ts';
import type { AlignmentAdapter, AlignmentWordTiming } from './alignment.ts';
import { alignOrProportionallyTime, concatWavFiles, countTtsContent, isReusableNarrationChunk, splitTtsInput } from './tts-common.ts';

export const DOUBAO_PREVIEW_TEXT = '你好，我是豆包语音助手，这是当前音色和语速的试听效果。';

export const DOUBAO_VOICES = [
  { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0' },
  { id: 'zh_male_dayi_saturn_bigtts', label: '大壹' },
  { id: 'zh_female_mizai_saturn_bigtts', label: '黑猫侦探社咪仔' },
  { id: 'zh_female_jitangnv_saturn_bigtts', label: '鸡汤女' },
  { id: 'zh_female_meilinvyou_saturn_bigtts', label: '魅力女友' },
  { id: 'zh_female_santongyongns_saturn_bigtts', label: '流畅女声' },
  { id: 'zh_male_ruyayichen_saturn_bigtts', label: '儒雅逸辰' },
  { id: 'zh_female_xueayi_saturn_bigtts', label: '儿童绘本' },
] as const;

interface DoubaoProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface DoubaoChunk {
  code?: number;
  message?: string;
  data?: string;
  sentence?: {
    words?: Array<{ word?: string; startTime?: number; endTime?: number; confidence?: number }>;
  };
}

interface DoubaoSynthesisInput {
  provider: DoubaoProviderConfig;
  voice: string;
  speed: number;
  segments: Array<{ segmentId: string; narration: string }>;
  outputDir: string;
  relativeOutputPath: string;
  alignment: AlignmentAdapter;
  onSegmentComplete?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

export function doubaoSpeechUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/api/v3/tts/unidirectional')
    ? base
    : `${base}/api/v3/tts/unidirectional`;
}

function parseChunkedJson(raw: string): DoubaoChunk[] {
  const chunks: DoubaoChunk[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        chunks.push(JSON.parse(raw.slice(start, index + 1)) as DoubaoChunk);
        start = -1;
      }
    }
  }
  if (start >= 0) throw new Error('豆包 TTS 流式响应包含不完整 JSON');
  return chunks;
}

export async function requestDoubaoAudio(
  config: DoubaoProviderConfig,
  voice: string,
  text: string,
  destination: string,
  signal?: AbortSignal,
): Promise<{ wordTimings: AlignmentWordTiming[] }> {
  const response = await fetch(doubaoSpeechUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.apiKey,
      'X-Api-Resource-Id': config.model,
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker: voice,
        audio_params: { format: 'mp3', sample_rate: 24_000, enable_subtitle: true },
      },
    }),
    signal,
  });
  const raw = await response.text();
  const logId = response.headers.get('X-Tt-Logid') || '';
  let chunks: DoubaoChunk[] = [];
  try { chunks = parseChunkedJson(raw); }
  catch (error) {
    throw new Error(`豆包 TTS 响应无法解析${logId ? `（Log ID: ${logId}）` : ''}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const failure = chunks.find((chunk) => chunk.code !== 0 && chunk.code !== 20_000_000);
  if (!response.ok || failure) {
    const detail = failure?.message || raw.slice(0, 300) || response.statusText;
    throw new Error(`豆包 TTS ${response.status}${failure?.code == null ? '' : ` / ${failure.code}`}: ${detail}${logId ? `（Log ID: ${logId}）` : ''}`);
  }
  const audio = chunks.flatMap((chunk) => chunk.code === 0 && chunk.data ? [Buffer.from(chunk.data, 'base64')] : []);
  if (audio.length === 0 || audio.every((chunk) => chunk.length === 0)) {
    throw new Error(`豆包 TTS 响应没有音频数据${logId ? `（Log ID: ${logId}）` : ''}`);
  }
  fs.writeFileSync(destination, Buffer.concat(audio));
  const seen = new Set<string>();
  const wordTimings = chunks.flatMap((chunk) => chunk.sentence?.words || []).flatMap((word) => {
    const textValue = String(word.word || '').trim();
    const startUs = Math.round(Number(word.startTime) * 1_000_000);
    const endUs = Math.round(Number(word.endTime) * 1_000_000);
    const key = `${textValue}\u0000${startUs}\u0000${endUs}`;
    if (!textValue || !Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs <= startUs || seen.has(key)) return [];
    seen.add(key);
    return [{ text: textValue, startUs, endUs }];
  }).sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
  return { wordTimings };
}

function readCachedWordTimings(filePath: string): AlignmentWordTiming[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AlignmentWordTiming[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((word) => (
      typeof word.text === 'string'
      && Number.isFinite(word.startUs)
      && Number.isFinite(word.endUs)
      && word.endUs > word.startUs
    ));
  } catch {
    return [];
  }
}

function validateNativeWordTimings(
  words: AlignmentWordTiming[],
  narration: string,
  durationUs: number,
): AlignmentWordTiming[] | null {
  if (words.length === 0) return null;
  let lastEndUs = 0;
  for (const word of words) {
    if (word.startUs < lastEndUs || word.endUs <= word.startUs || word.endUs > durationUs) return null;
    lastEndUs = word.endUs;
  }
  const coverage = countTtsContent(words.map((word) => word.text).join('')) / Math.max(1, countTtsContent(narration));
  return coverage >= 0.95 ? words : null;
}

export async function synthesizeDoubaoNarration(input: DoubaoSynthesisInput) {
  if (!DOUBAO_VOICES.some((voice) => voice.id === input.voice)) throw new Error('不支持的豆包音色');
  assertTtsSpeed(input.speed);
  fs.mkdirSync(input.outputDir, { recursive: true });
  const segmentFiles: string[] = [];
  const segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }> = [];
  const wordTimings: AlignmentWordTiming[] = [];
  const alignmentDegradedSegmentIds: string[] = [];
  let cursorUs = 0;

  for (let segmentIndex = 0; segmentIndex < input.segments.length; segmentIndex += 1) {
    const segment = input.segments[segmentIndex];
    const chunkFiles: string[] = [];
    const nativeWordTimings: AlignmentWordTiming[] = [];
    let nativeCursorUs = 0;
    const chunks = splitTtsInput(segment.narration);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const rawPath = path.join(input.outputDir, `segment-${segmentIndex}-${chunkIndex}-raw.mp3`);
      const normalizedPath = path.join(input.outputDir, `segment-${segmentIndex}-${chunkIndex}.wav`);
      const timingPath = `${normalizedPath}.words.json`;
      const reusable = await isReusableNarrationChunk(normalizedPath);
      let chunkWords = reusable ? readCachedWordTimings(timingPath) : [];
      if (!reusable) {
        fs.rmSync(timingPath, { force: true });
        const synthesis = await requestDoubaoAudio(input.provider, input.voice, chunks[chunkIndex], rawPath, input.signal);
        const filters = input.speed === 1 ? ['aresample=48000'] : [`atempo=${input.speed.toFixed(2)}`, 'aresample=48000'];
        const temporaryPath = `${normalizedPath}.${process.pid}-${Date.now()}.tmp.wav`;
        const temporaryTimingPath = `${timingPath}.${process.pid}-${Date.now()}.tmp`;
        try {
          await runFfmpeg([
            '-i', rawPath, '-vn', '-af', filters.join(','),
            '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', temporaryPath,
          ], { timeoutMs: 180_000, signal: input.signal });
          if (!await isReusableNarrationChunk(temporaryPath)) throw new Error('豆包 TTS 分段音频标准化后不可读取');
          fs.rmSync(normalizedPath, { force: true });
          fs.renameSync(temporaryPath, normalizedPath);
          chunkWords = synthesis.wordTimings.map((word) => ({
            ...word,
            startUs: Math.round(word.startUs / input.speed),
            endUs: Math.round(word.endUs / input.speed),
          }));
          if (chunkWords.length > 0) {
            fs.writeFileSync(temporaryTimingPath, JSON.stringify(chunkWords));
            fs.renameSync(temporaryTimingPath, timingPath);
          }
        } finally {
          fs.rmSync(temporaryPath, { force: true });
          fs.rmSync(temporaryTimingPath, { force: true });
          fs.rmSync(rawPath, { force: true });
        }
      }
      chunkFiles.push(normalizedPath);
      const chunkDurationUs = Math.round(await probeDurationSec(normalizedPath) * 1_000_000);
      nativeWordTimings.push(...chunkWords.map((word) => ({
        ...word,
        startUs: word.startUs + nativeCursorUs,
        endUs: word.endUs + nativeCursorUs,
      })));
      nativeCursorUs += chunkDurationUs;
    }

    const segmentPath = path.join(input.outputDir, `segment-${segmentIndex}.wav`);
    await concatWavFiles(chunkFiles, segmentPath, input.signal);
    const durationUs = Math.round(await probeDurationSec(segmentPath) * 1_000_000);
    const nativeWords = validateNativeWordTimings(nativeWordTimings, segment.narration, durationUs);
    const aligned = nativeWords
      ? { words: nativeWords, degraded: false }
      : await alignOrProportionallyTime({
        alignment: input.alignment,
        audioPath: segmentPath,
        narration: segment.narration,
        durationUs,
        segmentId: segment.segmentId,
      });
    if (aligned.degraded) alignmentDegradedSegmentIds.push(segment.segmentId);
    wordTimings.push(...aligned.words.map((word) => ({
      ...word,
      startUs: word.startUs + cursorUs,
      endUs: word.endUs + cursorUs,
    })));
    segmentTimings.push({ segmentId: segment.segmentId, startUs: cursorUs, endUs: cursorUs + durationUs });
    cursorUs += durationUs;
    segmentFiles.push(segmentPath);
    input.onSegmentComplete?.(segmentIndex + 1, input.segments.length);
  }

  const outputPath = path.join(input.outputDir, 'narration.wav');
  await concatWavFiles(segmentFiles, outputPath, input.signal);
  return {
    relativePath: input.relativeOutputPath,
    absolutePath: outputPath,
    durationUs: cursorUs,
    segmentTimings,
    wordTimings,
    alignmentDegradedSegmentIds,
  };
}

export async function synthesizeDoubaoPreview(input: {
  provider: DoubaoProviderConfig;
  voice: string;
  speed: number;
  text: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!DOUBAO_VOICES.some((voice) => voice.id === input.voice)) throw new Error('不支持的豆包音色');
  assertTtsSpeed(input.speed);
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const rawPath = `${input.outputPath}.raw.mp3`;
  const temporaryOutputPath = `${input.outputPath}.${process.pid}-${Date.now()}.tmp.wav`;
  try {
    await requestDoubaoAudio(input.provider, input.voice, input.text, rawPath, input.signal);
    const filters = input.speed === 1 ? ['aresample=48000'] : [`atempo=${input.speed.toFixed(2)}`, 'aresample=48000'];
    await runFfmpeg([
      '-i', rawPath, '-vn', '-af', filters.join(','),
      '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', temporaryOutputPath,
    ], { timeoutMs: 180_000, signal: input.signal });
    if (!await isReusableNarrationChunk(temporaryOutputPath)) throw new Error('豆包 TTS 试听音频标准化后不可读取');
    fs.rmSync(input.outputPath, { force: true });
    fs.renameSync(temporaryOutputPath, input.outputPath);
  } finally {
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(temporaryOutputPath, { force: true });
  }
}
