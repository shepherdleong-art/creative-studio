import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../../ffmpeg.ts';
import type { AlignmentAdapter, AlignmentWordTiming } from './alignment.ts';

export const VAPI_PREVIEW_TEXT = '你好，我是产品素材工作台语音助手，这是当前音色和语速的试听效果。';

export const VAPI_VOICES = [
  { id: 'Cherry', label: '芊悦' }, { id: 'Ethan', label: '晨煦' },
  { id: 'Nofish', label: '不吃鱼' }, { id: 'Jennifer', label: '詹妮弗' },
  { id: 'Ryan', label: '甜茶' }, { id: 'Katerina', label: '卡捷琳娜' },
  { id: 'Elias', label: '墨讲师' }, { id: 'Jada', label: '上海-阿珍' },
  { id: 'Dylan', label: '北京-晓东' }, { id: 'Sunny', label: '四川-晴儿' },
  { id: 'li', label: '南京-老李' }, { id: 'Marcus', label: '陕西-秦川' },
  { id: 'Roy', label: '闽南-阿杰' }, { id: 'Peter', label: '天津-李彼得' },
  { id: 'Rocky', label: '粤语-阿强' }, { id: 'Kiki', label: '粤语-阿清' },
  { id: 'Eric', label: '四川-程川' },
] as const;

export function speechUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
}

export function validateVapiAudioUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TTS 音频 URL 协议不安全');
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host)) {
    throw new Error('TTS 音频 URL 主机不在允许的阿里云 OSS 范围');
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url;
}

interface VapiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface SynthesisInput {
  provider: VapiProviderConfig;
  voice: string;
  speed: number;
  segments: Array<{ segmentId: string; narration: string }>;
  outputDir: string;
  relativeOutputPath: string;
  alignment: AlignmentAdapter;
}

function splitInput(text: string): string[] {
  if (Array.from(text).length <= 600) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (Array.from(remaining).length > 600) {
    const chars = Array.from(remaining);
    let cut = 600;
    for (let index = 599; index >= 300; index -= 1) {
      if (/[。！？；，,.!?;\s]/u.test(chars[index])) { cut = index + 1; break; }
    }
    parts.push(chars.slice(0, cut).join('').trim());
    remaining = chars.slice(cut).join('').trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

export async function requestVapiAudio(config: VapiProviderConfig, voice: string, input: string, destination: string): Promise<void> {
  const response = await fetch(speechUrl(config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input, voice }),
  });
  const raw = await response.text();
  let payload: { output?: { audio?: { data?: string; url?: string } }; error?: { message?: string } } = {};
  try { payload = JSON.parse(raw) as typeof payload; } catch { /* handled below */ }
  if (!response.ok) throw new Error(`V-API TTS ${response.status}: ${(payload.error?.message || raw).slice(0, 300)}`);
  const audio = payload.output?.audio;
  if (audio?.data) {
    fs.writeFileSync(destination, Buffer.from(audio.data, 'base64'));
    return;
  }
  if (!audio?.url) throw new Error('V-API TTS 响应缺少 output.audio.url/data');
  const audioResponse = await fetch(validateVapiAudioUrl(audio.url));
  if (!audioResponse.ok) throw new Error(`下载 V-API TTS 音频失败：HTTP ${audioResponse.status}`);
  fs.writeFileSync(destination, Buffer.from(await audioResponse.arrayBuffer()));
}

async function concatWavs(inputs: string[], output: string): Promise<void> {
  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], output);
    return;
  }
  const args = inputs.flatMap((input) => ['-i', input]);
  const labels = inputs.map((_, index) => `[${index}:a]`).join('');
  await runFfmpeg([...args, '-filter_complex', `${labels}concat=n=${inputs.length}:v=0:a=1[outa]`, '-map', '[outa]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', output], { timeoutMs: 180_000 });
}

export async function synthesizeVapiNarration(input: SynthesisInput) {
  if (!input.alignment.configured) throw new Error('生产强制对齐尚未配置；为避免产生无效 TTS 费用，本次未调用供应商');
  if (!VAPI_VOICES.some((voice) => voice.id === input.voice)) throw new Error('不支持的 V-API 音色');
  if (input.speed < 0.75 || input.speed > 1.5) throw new Error('语速必须位于 0.75x～1.50x');
  fs.mkdirSync(input.outputDir, { recursive: true });
  const segmentFiles: string[] = [];
  const segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }> = [];
  const wordTimings: AlignmentWordTiming[] = [];
  let cursorUs = 0;

  for (let segmentIndex = 0; segmentIndex < input.segments.length; segmentIndex += 1) {
    const segment = input.segments[segmentIndex];
    const chunkFiles: string[] = [];
    const chunks = splitInput(segment.narration);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const rawPath = path.join(input.outputDir, `segment-${segmentIndex}-${chunkIndex}-raw.wav`);
      const normalizedPath = path.join(input.outputDir, `segment-${segmentIndex}-${chunkIndex}.wav`);
      await requestVapiAudio(input.provider, input.voice, chunks[chunkIndex], rawPath);
      const filters = input.speed === 1 ? ['aresample=48000'] : [`atempo=${input.speed.toFixed(2)}`, 'aresample=48000'];
      await runFfmpeg(['-i', rawPath, '-vn', '-af', filters.join(','), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', normalizedPath], { timeoutMs: 180_000 });
      chunkFiles.push(normalizedPath);
    }
    const segmentPath = path.join(input.outputDir, `segment-${segmentIndex}.wav`);
    await concatWavs(chunkFiles, segmentPath);
    const durationUs = Math.round(await probeDurationSec(segmentPath) * 1_000_000);
    const aligned = await input.alignment.align({ audioPath: segmentPath, text: segment.narration });
    let lastEndUs = 0;
    for (const word of aligned) {
      if (word.startUs < lastEndUs || word.endUs <= word.startUs || word.endUs > durationUs) throw new Error(`强制对齐时间越界或倒退：${segment.segmentId}`);
      lastEndUs = word.endUs;
    }
    const countContent = (value: string) => Array.from(value.replace(/[\p{P}\p{S}\s]/gu, '')).length;
    const coverage = countContent(aligned.map((word) => word.text).join('')) / Math.max(1, countContent(segment.narration));
    if (coverage < 0.95) throw new Error(`强制对齐覆盖率不足：${segment.segmentId} 仅 ${Math.round(coverage * 100)}%`);
    wordTimings.push(...aligned.map((word) => ({ ...word, startUs: word.startUs + cursorUs, endUs: word.endUs + cursorUs })));
    segmentTimings.push({ segmentId: segment.segmentId, startUs: cursorUs, endUs: cursorUs + durationUs });
    cursorUs += durationUs;
    segmentFiles.push(segmentPath);
  }

  const outputPath = path.join(input.outputDir, 'narration.wav');
  await concatWavs(segmentFiles, outputPath);
  return { relativePath: input.relativeOutputPath, absolutePath: outputPath, durationUs: cursorUs, segmentTimings, wordTimings };
}

export async function synthesizeVapiPreview(input: { provider: VapiProviderConfig; voice: string; speed: number; text: string; outputPath: string }): Promise<void> {
  if (!VAPI_VOICES.some((voice) => voice.id === input.voice)) throw new Error('不支持的 V-API 音色');
  if (input.speed < 0.75 || input.speed > 1.5) throw new Error('语速必须位于 0.75x～1.50x');
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const rawPath = `${input.outputPath}.raw.wav`;
  await requestVapiAudio(input.provider, input.voice, input.text, rawPath);
  const filters = input.speed === 1 ? ['aresample=48000'] : [`atempo=${input.speed.toFixed(2)}`, 'aresample=48000'];
  await runFfmpeg(['-i', rawPath, '-vn', '-af', filters.join(','), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', input.outputPath], { timeoutMs: 180_000 });
  fs.rmSync(rawPath, { force: true });
}
