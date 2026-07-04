// lib/final-video/tts.ts
/**
 * 口播合成：DashScope qwen-tts（HTTP，非流式）→ 逐段音频 → 按时间线拼装整轨。
 * 语速用本地 atempo 实现（provider 无关）。API key: QWEN_TTS_API_KEY || DASHSCOPE_API_KEY。
 * 若 DashScope 响应结构与此处不符，以官方文档为准调整解析并在计划偏差记录注明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../ffmpeg.ts';
import type { TimelineSegment } from './types.ts';

const QWEN_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

export function resolveTtsApiKey(): string {
  return process.env.QWEN_TTS_API_KEY || process.env.DASHSCOPE_API_KEY || '';
}

async function synthesizeOne(text: string, voice: string, apiKey: string): Promise<Buffer> {
  const resp = await fetch(QWEN_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-tts', input: { text, voice } }),
  });
  if (!resp.ok) throw new Error(`qwen-tts HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { output?: { audio?: { url?: string } } };
  const url = data?.output?.audio?.url;
  if (!url) throw new Error(`qwen-tts 未返回音频 URL: ${JSON.stringify(data).slice(0, 300)}`);
  const audio = await fetch(url);
  if (!audio.ok) throw new Error(`口播音频下载失败 HTTP ${audio.status}`);
  return Buffer.from(await audio.arrayBuffer());
}

export async function synthesizeNarrationSegments(opts: {
  segments: Array<{ shotId: string; text: string }>;
  voice: string;
  speed: number;
  workDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ files: Record<string, string>; durations: Record<string, number> }> {
  const apiKey = resolveTtsApiKey();
  if (!apiKey) throw new Error('未配置口播 API key（QWEN_TTS_API_KEY 或 DASHSCOPE_API_KEY）');
  const speed = Math.min(2, Math.max(0.5, opts.speed || 1));
  const targets = opts.segments.filter((s) => s.text.trim());
  const files: Record<string, string> = {};
  const durations: Record<string, number> = {};
  let done = 0;
  for (const seg of targets) {
    const raw = path.join(opts.workDir, `tts-${seg.shotId}-raw.wav`);
    const final = path.join(opts.workDir, `tts-${seg.shotId}.m4a`);
    fs.writeFileSync(raw, await synthesizeOne(seg.text.trim(), opts.voice, apiKey));
    const atempo = Math.abs(speed - 1) > 0.01 ? ['-filter:a', `atempo=${speed}`] : [];
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
