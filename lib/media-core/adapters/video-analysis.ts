import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../../ffmpeg.ts';
import { detectVideoScenes } from '../scene-detect.ts';
import { buildVideoAnalysisPrompt, buildVideoFrameSamples } from './video-analysis-prompt.ts';

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
  model?: string;
  cacheDir: string;
  signal?: AbortSignal;
}) {
  const durationSec = await probeDurationSec(input.filePath);
  const durationUs = Math.round(durationSec * 1_000_000);
  const detectedScenes = await detectVideoScenes({ filePath: input.filePath, durationUs, signal: input.signal });
  fs.mkdirSync(input.cacheDir, { recursive: true });
  const images: Array<{ mimeType: string; imageBase64: string }> = [];
  const frames = buildVideoFrameSamples(detectedScenes);
  for (const frame of frames) {
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const timeSec = frame.timeUs / 1_000_000;
    const output = path.join(input.cacheDir, `${frame.timeUs}.jpg`);
    await runFfmpeg(['-ss', timeSec.toFixed(6), '-i', input.filePath, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', output], { timeoutMs: 60_000, signal: input.signal });
    images.push({ mimeType: 'image/jpeg', imageBase64: fs.readFileSync(output).toString('base64') });
  }
  const { completeJson } = await import('../../script-providers/index.ts');
  const result = await completeJson<RawAnalysis>({
    providerId: input.providerId,
    ...(input.model ? { model: input.model } : {}),
    systemPrompt: '你是视频素材分析器。只描述视频本身，严格返回 JSON，不推断脚本文案。',
    userPrompt: buildVideoAnalysisPrompt(detectedScenes, durationSec, frames),
    temperature: 0.2,
    images,
    signal: input.signal,
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

export type VideoContentAnalysis = Awaited<ReturnType<typeof analyzeVideoWithVision>>;
export interface VideoContentModel {
  id: string; name: string; model: string;
  analyze(input: { filePath: string; assetId: string; cacheDir: string; signal: AbortSignal }): Promise<VideoContentAnalysis>;
}

export async function listVideoContentModels(): Promise<Array<Pick<VideoContentModel, 'id' | 'name' | 'model'>>> {
  const { getAvailableProviders } = await import('../../script-providers/index.ts');
  return getAvailableProviders().filter(item => item.configured && item.enabled !== 0 && item.supportsVision)
    .map(({ id, name, model }) => ({ id, name, model }));
}

export async function resolveVideoContentModel(providerId: string): Promise<VideoContentModel> {
  const selected = (await listVideoContentModels()).find(item => item.id === providerId);
  if (!selected) throw new Error('请选择已配置并支持画面理解的模型');
  const { getProviderMeta } = await import('../../script-providers/index.ts');
  const executionScope = getProviderMeta(providerId)?.executionScope;
  return { ...selected, analyze: async input => {
    const current = (await listVideoContentModels()).find(item => item.id === selected.id);
    if (!current || current.model !== selected.model || getProviderMeta(providerId)?.executionScope !== executionScope) throw new Error('画面分析模型或运行方式已变化，请重新选择');
    return analyzeVideoWithVision({ ...input, videoJobId: input.assetId, providerId: selected.id, model: selected.model });
  } };
}
/** 画面结果也必须有实质描述；空 JSON 不能被记为分析成功。 */
export function assertVideoContentAnalysis(value: VideoContentAnalysis): void {
  if (!value.summary.trim() && !value.scenes.some(scene => scene.description.trim())) throw new Error('画面分析未返回有效内容说明');
}
