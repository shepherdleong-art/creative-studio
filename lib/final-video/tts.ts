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

export async function synthesizeNarrationSegments(opts: {
  segments: Array<{ shotId: string; text: string }>;
  voice: string;
  speed: number;
  workDir: string;
  /** 指定使用的口播供应商；缺省时自动挑第一个已配置的供应商。 */
  providerId?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ files: Record<string, string>; durations: Record<string, number> }> {
  const rt = await resolveNarrationRuntime(opts.providerId);
  const speed = Math.min(2, Math.max(0.5, opts.speed || 1));
  const targets = opts.segments.filter((s) => s.text.trim());
  const files: Record<string, string> = {};
  const durations: Record<string, number> = {};
  let done = 0;
  for (const seg of targets) {
    // 无扩展名：合成结果可能是 wav（qwen）或 mp3（openai 兼容），ffmpeg 按内容探测容器，无需扩展名提示。
    const raw = path.join(opts.workDir, `tts-${seg.shotId}-raw`);
    const final = path.join(opts.workDir, `tts-${seg.shotId}.m4a`);
    const { buffer, speedApplied } = await synthesizeOne(seg.text.trim(), opts.voice, speed, rt);
    fs.writeFileSync(raw, buffer);
    const atempo = !speedApplied && Math.abs(speed - 1) > 0.01 ? ['-filter:a', `atempo=${speed}`] : [];
    await runFfmpeg(['-i', raw, ...atempo, '-c:a', 'aac', '-b:a', '128k', '-y', final], { timeoutMs: 60_000 });
    fs.unlinkSync(raw);
    files[seg.shotId] = final;
    durations[seg.shotId] = await probeDurationSec(final);
    done += 1;
    opts.onProgress?.(done, targets.length);
  }
  return { files, durations };
}

const TIMING_EPSILON_SEC = 1e-6;

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
  if (!directory.startsWith(`${draftRoot}${path.sep}`)) throw new Error('draftId 路径不安全');
  return directory;
}

function safeGroupFileName(groupId: string): string {
  return `group-${createHash('sha256').update(groupId).digest('hex').slice(0, 24)}.m4a`;
}

function partitionTextByDuration(text: string, durations: number[], totalDurationSec: number): string[] {
  const characters = Array.from(text);
  const contentPositions = characters
    .map((character, index) => (/\s/u.test(character) ? -1 : index))
    .filter((index) => index >= 0);
  if (contentPositions.length < durations.length) {
    throw new Error('口播文本字符数不足，无法为每个时间窗口生成非空文本');
  }
  const result: string[] = [];
  let consumedContent = 0;
  let startCharacter = 0;
  let consumedDuration = 0;
  for (let index = 0; index < durations.length; index += 1) {
    consumedDuration += durations[index];
    const remainingWindows = durations.length - index - 1;
    const proportionalContentEnd = index === durations.length - 1
      ? contentPositions.length
      : Math.round((consumedDuration / totalDurationSec) * contentPositions.length);
    const contentEnd = Math.min(
      contentPositions.length - remainingWindows,
      Math.max(consumedContent + 1, proportionalContentEnd),
    );
    const endCharacter = index === durations.length - 1
      ? characters.length
      : contentPositions[contentEnd - 1] + 1;
    result.push(characters.slice(startCharacter, endCharacter).join(''));
    consumedContent = contentEnd;
    startCharacter = endCharacter;
  }
  return result;
}

/** 每个自然句只合成一次，再按真实音频时长切成连续 beat 时间窗口。 */
export async function synthesizeNarrationBeats(input: {
  draftId: string;
  beats: NarrationDraftBeat[];
  providerId: string;
  voice: string;
  speed: number;
  maxClipSeconds: number;
}): Promise<NarrationBeat[]> {
  requirePositiveFinite('speed', input.speed);
  requirePositiveFinite('maxClipSeconds', input.maxClipSeconds);
  if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error('beats 不能为空');
  if (!input.providerId.trim()) throw new Error('providerId 不能为空');
  if (!input.voice.trim()) throw new Error('voice 不能为空');

  const directory = narrationDirectory(input.draftId);
  const seenGroups = new Set<string>();
  const seenBeatIds = new Set<string>();
  const seenIndexes = new Set<number>();
  for (const [position, beat] of input.beats.entries()) {
    if (!beat || !beat.groupId?.trim()) throw new Error(`beats[${position}].groupId 不能为空`);
    if (!beat.beatId?.trim()) throw new Error(`beats[${position}].beatId 不能为空`);
    if (!beat.text?.trim()) throw new Error(`beats[${position}].text 不能为空`);
    if (!Number.isInteger(beat.index) || beat.index < 0) throw new Error(`beats[${position}].index 无效`);
    if (seenGroups.has(beat.groupId)) throw new Error(`重复 groupId：${beat.groupId}`);
    if (seenBeatIds.has(beat.beatId)) throw new Error(`重复 beatId：${beat.beatId}`);
    if (seenIndexes.has(beat.index)) throw new Error(`重复 index：${beat.index}`);
    seenGroups.add(beat.groupId);
    seenBeatIds.add(beat.beatId);
    seenIndexes.add(beat.index);
  }

  fs.mkdirSync(directory, { recursive: true });
  const rt = await resolveNarrationRuntime(input.providerId);
  const output: NarrationBeat[] = [];
  const outputBeatIds = new Set<string>();
  let contentStartSec = 0;

  for (const draftBeat of [...input.beats].sort((a, b) => a.index - b.index)) {
    const audioPath = path.join(directory, safeGroupFileName(draftBeat.groupId));
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
    const windows: number[] = [];
    let remainingSec = durationSec;
    while (remainingSec > TIMING_EPSILON_SEC) {
      const windowSec = Math.min(input.maxClipSeconds, remainingSec);
      windows.push(windowSec);
      remainingSec -= windowSec;
    }
    if (windows.length === 0) throw new Error('probed duration 未产生有效时间窗口');
    const windowTotal = windows.reduce((sum, value) => sum + value, 0);
    windows[windows.length - 1] += durationSec - windowTotal;
    const texts = partitionTextByDuration(draftBeat.text.trim(), windows, durationSec);

    let groupOffsetSec = 0;
    windows.forEach((windowSec, windowIndex) => {
      const beatId = windows.length === 1 ? draftBeat.beatId : `${draftBeat.beatId}-${windowIndex + 1}`;
      if (outputBeatIds.has(beatId)) throw new Error(`切分后产生重复 beatId：${beatId}`);
      outputBeatIds.add(beatId);
      output.push({
        beatId,
        groupId: draftBeat.groupId,
        index: output.length,
        text: texts[windowIndex],
        audioPath,
        durationSec: windowSec,
        startSec: contentStartSec + groupOffsetSec,
      });
      groupOffsetSec += windowSec;
    });
    contentStartSec += durationSec;
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
  const groups: NarrationBeat[][] = [];
  const closedGroups = new Set<string>();
  const seenBeatIds = new Set<string>();
  const seenIndexes = new Set<number>();
  let expectedStartSec = 0;
  for (const [position, beat] of ordered.entries()) {
    if (!beat.beatId?.trim() || seenBeatIds.has(beat.beatId)) throw new Error(`beats[${position}].beatId 无效或重复`);
    if (!Number.isInteger(beat.index) || seenIndexes.has(beat.index)) throw new Error(`beats[${position}].index 无效或重复`);
    if (!beat.groupId?.trim()) throw new Error(`beats[${position}].groupId 不能为空`);
    seenBeatIds.add(beat.beatId);
    seenIndexes.add(beat.index);
    requirePositiveFinite(`beats[${position}].durationSec`, beat.durationSec);
    if (!Number.isFinite(beat.startSec) || beat.startSec < 0) throw new Error(`beats[${position}].startSec 无效`);
    if (Math.abs(beat.startSec - expectedStartSec) > 0.01) throw new Error('beats startSec 不连续');
    expectedStartSec += beat.durationSec;
    const current = groups.at(-1);
    if (!current || current[0].groupId !== beat.groupId) {
      if (closedGroups.has(beat.groupId)) throw new Error(`groupId ${beat.groupId} 不连续`);
      if (current) closedGroups.add(current[0].groupId);
      groups.push([beat]);
    } else {
      if (current[0].audioPath !== beat.audioPath) throw new Error(`groupId ${beat.groupId} 的 audioPath 必须一致`);
      current.push(beat);
    }
  }

  const out = path.join(opts.workDir, 'narration.m4a');
  const args: string[] = ['-hide_banner'];
  const parts: string[] = [];
  const labels: string[] = [];
  if (opts.introDurationSec > 0) {
    parts.push(`aevalsrc=0:d=${opts.introDurationSec}:s=44100[aintro]`);
    labels.push('[aintro]');
  }
  groups.forEach((group, index) => {
    if (!group[0].audioPath || !fs.existsSync(group[0].audioPath)) throw new Error(`口播音频不存在：${group[0].audioPath}`);
    args.push('-i', group[0].audioPath);
    parts.push(`[${index}:a]anull[ag${index}]`);
    labels.push(`[ag${index}]`);
  });
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-y', out);
  await runFfmpeg(args, { timeoutMs: 120_000 });
  return out;
}
