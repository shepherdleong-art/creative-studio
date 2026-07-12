// lib/final-video/tts.ts
/**
 * 口播合成：多供应商 adapter（qwen-tts / openai-compatible-tts）→ 逐段音频 → 按时间线拼装整轨。
 * qwen-tts 无原生语速参数，用本地 atempo 变速；OpenAI 兼容后端可能返回二进制音频（原生支持 speed）
 * 或 DashScope 形态 JSON（如中转的 qwen3-tts-flash，speed 被忽略、退回本地 atempo），按响应 content-type 分流。
 * API key/baseUrl/model 来自 Settings → 口播配音 的统一供应商体系，不再读环境变量。
 * 若 DashScope / OpenAI 兼容响应结构与此处不符，以官方文档为准调整解析并在计划偏差记录注明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runFfmpeg, probeDurationSec } from '../ffmpeg.ts';
import { dataRoot } from '../data-root.ts';
import { assertPathWithinRoot } from './fs-safety.ts';
import type { NarrationBeat, NarrationDraftBeat } from './types.ts';
import type { NarrationProviderRuntimeConfig } from '../narration-providers/config.ts';

const QWEN_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/**
 * 解析口播供应商运行时配置（含 type/apiKey/baseUrl/model）。
 * providerId 缺省时退回第一个已启用且已配置的供应商；都没有则抛错。
 */
export async function resolveNarrationRuntime(providerId?: string): Promise<NarrationProviderRuntimeConfig> {
  const { resolveNarrationProvider } = await import('@/lib/narration-providers/store');
  const p = resolveNarrationProvider(providerId);
  if (!p) throw new Error('未配置口播供应商：请前往「设置」→「口播配音」配置');
  return p;
}

/** 规范化 OpenAI 兼容端点：baseUrl 可能已含 /v1，也可能没有。 */
function openaiSpeechUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(b) ? `${b}/audio/speech` : `${b}/v1/audio/speech`;
}

/**
 * 从 DashScope 形态的 TTS JSON 响应里取出音频字节：优先 output.audio.url（下载 OSS 上的 wav），
 * 否则 output.audio.data（base64 内联），两者皆空则抛错并附响应片段。
 * qwen-tts 直连、以及经 OpenAI 兼容中转代理的 qwen3-tts-flash 都是这个响应结构。
 */
async function resolveDashScopeAudio(json: unknown): Promise<Buffer> {
  const audio = (json as { output?: { audio?: { url?: string; data?: string } } })?.output?.audio;
  const url = audio?.url?.trim();
  if (url) {
    const audioResp = await fetch(url);
    if (!audioResp.ok) throw new Error(`口播音频下载失败 HTTP ${audioResp.status}`);
    return Buffer.from(await audioResp.arrayBuffer());
  }
  const data = audio?.data?.trim();
  if (data) return Buffer.from(data, 'base64');
  throw new Error(`TTS 响应未包含音频（output.audio.url/data 均为空）：${JSON.stringify(json).slice(0, 300)}`);
}

async function synthesizeQwen(text: string, voice: string, apiKey: string): Promise<Buffer> {
  const resp = await fetch(QWEN_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-tts', input: { text, voice } }),
  });
  if (!resp.ok) throw new Error(`qwen-tts HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resolveDashScopeAudio(await resp.json());
}

/**
 * OpenAI 兼容 TTS 合成。返回的 speedApplied 表示后端是否已原生处理 speed，取决于响应形态：
 * - 二进制音频流（真正的 OpenAI 兼容后端，如 tts-1）：已按 speed 合成 → speedApplied=true；
 * - JSON 响应（如中转代理的 qwen3-tts-flash，音频在 output.audio.url）：speed 被后端忽略
 *   → speedApplied=false，交由调用方本地 atempo 变速。
 * 按 Content-Type 是否为 json 分流，二者复用与 qwen-tts 相同的 DashScope 解析。
 */
async function synthesizeOpenaiCompatible(
  text: string,
  voice: string,
  speed: number,
  rt: NarrationProviderRuntimeConfig
): Promise<{ buffer: Buffer; speedApplied: boolean }> {
  const resp = await fetch(openaiSpeechUrl(rt.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${rt.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: rt.model || 'tts-1', input: text, voice, response_format: 'mp3', speed }),
  });
  if (!resp.ok) throw new Error(`openai-tts HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  if ((resp.headers.get('content-type') || '').includes('json')) {
    return { buffer: await resolveDashScopeAudio(await resp.json()), speedApplied: false };
  }
  return { buffer: Buffer.from(await resp.arrayBuffer()), speedApplied: true };
}

/**
 * 按供应商类型分流合成一段音频。speedApplied=true 表示供应商已原生处理语速，本地跳过 atempo。
 * 导出供 §5-C 的 TTS 试听端点复用（app/api/providers/narration/[id]/preview）。
 */
export async function synthesizeOne(
  text: string,
  voice: string,
  speed: number,
  rt: NarrationProviderRuntimeConfig
): Promise<{ buffer: Buffer; speedApplied: boolean }> {
  if (rt.type === 'openai-compatible-tts') {
    return synthesizeOpenaiCompatible(text, voice, speed, rt);
  }
  // qwen-tts（及未知类型兜底）：DashScope 无 speed 参数，交由调用方本地 atempo。
  return { buffer: await synthesizeQwen(text, voice, rt.apiKey), speedApplied: false };
}

function requirePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是有限正数`);
}

function atempoFilter(speed: number): string {
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9) factors.push(remaining);
  return factors.map((factor) => `atempo=${factor}`).join(',');
}

function narrationDirectory(draftId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(draftId)) {
    throw new Error('draftId 含不安全字符');
  }
  const draftRoot = path.resolve(dataRoot(), 'storage', 'final-video-drafts');
  const directory = path.resolve(draftRoot, draftId, 'narration');
  return assertPathWithinRoot(draftRoot, directory, 'draftId 路径不安全');
}

function safeBeatFileName(beatId: string): string {
  return `beat-${createHash('sha256').update(beatId).digest('hex').slice(0, 24)}.m4a`;
}

/** 一句合成一次，真实音频时长即该句的段时长。不再切窗口。 */
export async function synthesizeNarrationBeats(input: {
  draftId: string;
  beats: NarrationDraftBeat[];
  providerId: string;
  voice: string;
  speed: number;
}): Promise<NarrationBeat[]> {
  requirePositiveFinite('speed', input.speed);
  if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error('beats 不能为空');
  if (!input.providerId.trim()) throw new Error('providerId 不能为空');
  if (!input.voice.trim()) throw new Error('voice 不能为空');

  const directory = narrationDirectory(input.draftId);
  const seenBeatIds = new Set<string>();
  const seenIndexes = new Set<number>();
  for (const [position, beat] of input.beats.entries()) {
    if (!beat?.beatId?.trim()) throw new Error(`beats[${position}].beatId 不能为空`);
    if (!beat.text?.trim()) throw new Error(`beats[${position}].text 不能为空`);
    if (!beat.shotId?.trim()) throw new Error(`beats[${position}].shotId 不能为空`);
    if (!Number.isInteger(beat.index) || beat.index < 0) throw new Error(`beats[${position}].index 无效`);
    if (seenBeatIds.has(beat.beatId)) throw new Error(`重复 beatId：${beat.beatId}`);
    if (seenIndexes.has(beat.index)) throw new Error(`重复 index：${beat.index}`);
    seenBeatIds.add(beat.beatId);
    seenIndexes.add(beat.index);
  }

  fs.mkdirSync(directory, { recursive: true });
  const rt = await resolveNarrationRuntime(input.providerId);
  const output: NarrationBeat[] = [];
  let startSec = 0;

  for (const draftBeat of [...input.beats].sort((a, b) => a.index - b.index)) {
    const audioPath = path.join(directory, safeBeatFileName(draftBeat.beatId));
    const rawPath = `${audioPath}.raw`;
    const { buffer, speedApplied } = await synthesizeOne(draftBeat.text.trim(), input.voice, input.speed, rt);
    fs.writeFileSync(rawPath, buffer);
    try {
      const atempo = !speedApplied && Math.abs(input.speed - 1) > 0.01
        ? ['-filter:a', atempoFilter(input.speed)]
        : [];
      await runFfmpeg(['-i', rawPath, ...atempo, '-c:a', 'aac', '-b:a', '128k', '-y', audioPath], { timeoutMs: 60_000 });
    } finally {
      fs.rmSync(rawPath, { force: true });
    }

    const durationSec = await probeDurationSec(audioPath);
    requirePositiveFinite('probed duration', durationSec);

    output.push({
      beatId: draftBeat.beatId,
      index: output.length,
      text: draftBeat.text.trim(),
      subtitleText: draftBeat.subtitleText.trim() || draftBeat.text.trim(),
      shotId: draftBeat.shotId,
      imageAssetId: draftBeat.imageAssetId,
      audioPath,
      durationSec,
      startSec,
    });
    startSec += durationSec;
  }
  return output;
}

interface BeatNarrationTrackInput {
  beats: NarrationBeat[];
  introDurationSec: number;
  workDir: string;
}

function validateTrackBase(input: { introDurationSec: number; workDir: string }): void {
  if (!Number.isFinite(input.introDurationSec) || input.introDurationSec < 0) {
    throw new Error('introDurationSec 必须是有限非负数');
  }
  if (!input.workDir.trim()) throw new Error('workDir 不能为空');
  fs.mkdirSync(input.workDir, { recursive: true });
}

export async function buildNarrationTrack(opts: BeatNarrationTrackInput): Promise<string> {
  validateTrackBase(opts);
  return buildBeatNarrationTrack(opts);
}

async function buildBeatNarrationTrack(opts: BeatNarrationTrackInput): Promise<string> {
  if (!Array.isArray(opts.beats) || opts.beats.length === 0) throw new Error('beats 不能为空');
  const ordered = [...opts.beats].sort((a, b) => a.index - b.index);
  const seenBeatIds = new Set<string>();
  const seenIndexes = new Set<number>();
  let expectedStartSec = 0;
  for (const [position, beat] of ordered.entries()) {
    if (!beat.beatId?.trim() || seenBeatIds.has(beat.beatId)) throw new Error(`beats[${position}].beatId 无效或重复`);
    if (!Number.isInteger(beat.index) || seenIndexes.has(beat.index)) throw new Error(`beats[${position}].index 无效或重复`);
    seenBeatIds.add(beat.beatId);
    seenIndexes.add(beat.index);
    requirePositiveFinite(`beats[${position}].durationSec`, beat.durationSec);
    if (!Number.isFinite(beat.startSec) || beat.startSec < 0) throw new Error(`beats[${position}].startSec 无效`);
    if (Math.abs(beat.startSec - expectedStartSec) > 0.01) throw new Error('beats startSec 不连续');
    expectedStartSec += beat.durationSec;
  }

  const out = path.join(opts.workDir, 'narration.m4a');
  const args: string[] = ['-hide_banner'];
  const parts: string[] = [];
  const labels: string[] = [];
  if (opts.introDurationSec > 0) {
    parts.push(`aevalsrc=0:d=${opts.introDurationSec}:s=44100[aintro]`);
    labels.push('[aintro]');
  }
  ordered.forEach((beat, index) => {
    if (!beat.audioPath || !fs.existsSync(beat.audioPath)) throw new Error(`口播音频不存在：${beat.audioPath}`);
    args.push('-i', beat.audioPath);
    parts.push(`[${index}:a]anull[ag${index}]`);
    labels.push(`[ag${index}]`);
  });
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-y', out);
  await runFfmpeg(args, { timeoutMs: 120_000 });
  return out;
}
