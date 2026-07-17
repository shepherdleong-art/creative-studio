import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../../ffmpeg';
import { completeJson } from '../../script-providers';

interface RawAnalysis {
  summary?: unknown;
  sellingPoints?: unknown;
  semanticTags?: unknown;
  usableRanges?: unknown;
  qualityIssues?: unknown;
  coverFrameTimesUs?: unknown;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

export async function analyzeVideoWithVision(input: {
  filePath: string;
  videoJobId: string;
  providerId: string;
  cacheDir: string;
}) {
  const durationSec = await probeDurationSec(input.filePath);
  const sampleCount = Math.max(4, Math.min(8, Math.ceil(durationSec)));
  fs.mkdirSync(input.cacheDir, { recursive: true });
  const images: Array<{ mimeType: string; imageBase64: string }> = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const timeSec = Math.min(durationSec - 0.05, Math.max(0.05, durationSec * (index + 0.5) / sampleCount));
    const output = path.join(input.cacheDir, `${Math.round(timeSec * 1_000_000)}.jpg`);
    await runFfmpeg(['-ss', timeSec.toFixed(6), '-i', input.filePath, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', output], { timeoutMs: 60_000 });
    images.push({ mimeType: 'image/jpeg', imageBase64: fs.readFileSync(output).toString('base64') });
  }
  const result = await completeJson<RawAnalysis>({
    providerId: input.providerId,
    systemPrompt: '你是视频素材分析器。只描述视频本身，严格返回 JSON，不推断脚本文案。',
    userPrompt: `这些图片按时间顺序均匀抽自同一个完整视频（时长 ${durationSec.toFixed(3)} 秒）。请结合全部帧分析内容、卖点、景别、运镜、可用区间、质量问题和封面帧。返回 {summary,sellingPoints,semanticTags,usableRanges:[{startUs,endUs,qualityScore}],qualityIssues,coverFrameTimesUs}。所有时间使用整数微秒。`,
    temperature: 0.2,
    images,
  });
  const durationUs = Math.round(durationSec * 1_000_000);
  const usableRanges = (Array.isArray(result.usableRanges) ? result.usableRanges : []).map((raw) => {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      startUs: Math.max(0, Math.min(durationUs, Math.round(Number(value.startUs) || 0))),
      endUs: Math.max(0, Math.min(durationUs, Math.round(Number(value.endUs) || 0))),
      qualityScore: Math.max(0, Math.min(1, Number(value.qualityScore) || 0)),
    };
  }).filter((range) => range.endUs > range.startUs);
  return {
    summary: typeof result.summary === 'string' ? result.summary.trim() : '',
    sellingPoints: strings(result.sellingPoints),
    semanticTags: strings(result.semanticTags),
    usableRanges: usableRanges.length ? usableRanges : [{ startUs: 0, endUs: durationUs, qualityScore: 0.5 }],
    qualityIssues: strings(result.qualityIssues),
    coverFrameTimesUs: (Array.isArray(result.coverFrameTimesUs) ? result.coverFrameTimesUs : []).map(Number).filter((value) => Number.isFinite(value) && value >= 0 && value <= durationUs).map(Math.round),
  };
}
