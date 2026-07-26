import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../../ffmpeg';
import { completeJson } from '../../script-providers';
import { detectVideoScenes } from '../scene-detect.ts';
import { buildVideoAnalysisPrompt } from './video-analysis-prompt.ts';

interface RawAnalysis {
  summary?: unknown;
  sellingPoints?: unknown;
  semanticTags?: unknown;
  usableRanges?: unknown;
  qualityIssues?: unknown;
  coverFrameTimesUs?: unknown;
  scenes?: unknown;
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
  const durationUs = Math.round(durationSec * 1_000_000);
  const detectedScenes = await detectVideoScenes({ filePath: input.filePath, durationUs });
  fs.mkdirSync(input.cacheDir, { recursive: true });
  const images: Array<{ mimeType: string; imageBase64: string }> = [];
  for (let index = 0; index < detectedScenes.length; index += 1) {
    const scene = detectedScenes[index];
    const timeSec = Math.min(durationSec - 0.05, Math.max(0.05, (scene.startUs + (scene.endUs - scene.startUs) * 0.3) / 1_000_000));
    const output = path.join(input.cacheDir, `${Math.round(timeSec * 1_000_000)}.jpg`);
    await runFfmpeg(['-ss', timeSec.toFixed(6), '-i', input.filePath, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', output], { timeoutMs: 60_000 });
    images.push({ mimeType: 'image/jpeg', imageBase64: fs.readFileSync(output).toString('base64') });
  }
  const result = await completeJson<RawAnalysis>({
    providerId: input.providerId,
    systemPrompt: '你是视频素材分析器。只描述视频本身，严格返回 JSON，不推断脚本文案。',
    userPrompt: buildVideoAnalysisPrompt(detectedScenes, durationSec),
    temperature: 0.2,
    images,
  });
  const rawScenes = Array.isArray(result.scenes) ? result.scenes : [];
  const scenes = detectedScenes.map((range, index) => {
    const raw = rawScenes[index] && typeof rawScenes[index] === 'object' ? rawScenes[index] as Record<string, unknown> : {};
    return {
      startUs: range.startUs,
      endUs: range.endUs,
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      labels: strings(raw.labels),
      qualityScore: Math.max(0, Math.min(1, Number(raw.qualityScore) || 0.5)),
    };
  });
  const usableRanges = (Array.isArray(result.usableRanges) ? result.usableRanges : scenes).map((raw) => {
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
    scenes,
  };
}
