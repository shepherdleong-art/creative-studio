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
import { runFfmpeg, probeDurationSec } from '../ffmpeg.ts';
import type { TimelineSegment } from './types.ts';
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

/** 按最终时间线拼装整轨：每段 apad 到 segmentDurationSec，无口播段填静音，片头前置静音。 */
export async function buildNarrationTrack(opts: {
  timeline: TimelineSegment[];
  files: Record<string, string>;
  introDurationSec: number;
  workDir: string;
}): Promise<string> {
  const out = path.join(opts.workDir, 'narration.m4a');
  const args: string[] = ['-hide_banner'];
  const parts: string[] = [];
  const labels: string[] = [];
  let inputIdx = 0;

  if (opts.introDurationSec > 0) {
    parts.push(`aevalsrc=0:d=${opts.introDurationSec}:s=44100[aintro]`);
    labels.push('[aintro]');
  }
  opts.timeline.forEach((seg, k) => {
    const file = opts.files[seg.shotId];
    if (file && seg.narrationDurationSec > 0) {
      args.push('-i', file);
      parts.push(`[${inputIdx}:a]apad=whole_dur=${seg.segmentDurationSec.toFixed(3)}[a${k}]`);
      inputIdx += 1;
    } else {
      parts.push(`aevalsrc=0:d=${seg.segmentDurationSec.toFixed(3)}:s=44100[a${k}]`);
    }
    labels.push(`[a${k}]`);
  });
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k', '-y', out);
  await runFfmpeg(args, { timeoutMs: 120_000 });
  return out;
}
