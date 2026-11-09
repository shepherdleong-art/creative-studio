import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../../ffmpeg.ts';
import { detectVideoScenes } from '../scene-detect.ts';
import { buildVideoAnalysisPrompt, buildVideoFrameSamples, type VideoFrameSample } from './video-analysis-prompt.ts';
import { withMediaResource } from '../media-resource-gate.ts';
import { waitForAnalysisAdmission } from '../analysis-concurrency.ts';

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
  waitForExecution?: boolean;
  executionScope?: { resourceType: string; resourceId: string };
  executionTaskId?: string;
  inputRevision?: string;
  businessAttempt?: { id: string; number: number };
}) {
  const prepared = await withMediaResource({
    taskId: input.executionTaskId ?? `video-analysis:${input.videoJobId}`,
    step: 'analysis-frames',
    wait: true,
    signal: input.signal,
  }, async () => {
    const durationSec = await probeDurationSec(input.filePath);
    const durationUs = Math.round(durationSec * 1_000_000);
    const detectedScenes = await detectVideoScenes({ filePath: input.filePath, durationUs, signal: input.signal });
    fs.mkdirSync(input.cacheDir, { recursive: true });
    const extracted: Array<{ frame: VideoFrameSample; image: { mimeType: string; imageBase64: string } }> = [];
    for (const frame of buildVideoFrameSamples(detectedScenes)) {
      const scene = detectedScenes[frame.sceneIndex];
      // 容器/音轨可比视频长；FFmpeg 在最后一帧之后 seek 会退出 0 却不写图片。
      // 只在当前场景内有限回退，单帧短片最终尝试场景起点，不拿其他场景冒充。
      const candidates = [...new Set([frame.timeUs, frame.timeUs - 100_000, frame.timeUs - 500_000, scene.startUs]
        .map(timeUs => Math.max(scene.startUs, timeUs)))];
      let found = false;
      for (const timeUs of candidates) {
        if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const output = path.join(input.cacheDir, `${timeUs}.jpg`);
        // 重试不能把之前遗留的图片当作本次抽帧成功。
        fs.rmSync(output, { force: true });
        await runFfmpeg(['-ss', (timeUs / 1_000_000).toFixed(6), '-i', input.filePath, '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', output], { timeoutMs: 60_000, signal: input.signal });
        if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!fs.existsSync(output) || fs.statSync(output).size === 0) continue;
        extracted.push({ frame: { ...frame, timeUs }, image: { mimeType: 'image/jpeg', imageBase64: fs.readFileSync(output).toString('base64') } });
        found = true;
        break;
      }
      if (!found) throw new Error(`素材画面抽取失败：场景 ${frame.sceneIndex + 1} 在 ${(frame.timeUs / 1_000_000).toFixed(3)} 秒及场景内回退位置均未生成图片，请检查视频画面是否可解码`);
    }
    extracted.sort((left, right) => left.frame.timeUs - right.frame.timeUs);
    const frames = extracted.map(({ frame }, index) => ({ ...frame, imageIndex: index + 1 }));
    return {
      durationSec,
      durationUs,
      detectedScenes,
      frames,
      images: extracted.map(({ image }) => image),
    };
  });
  const { durationSec, durationUs, detectedScenes, frames, images } = prepared;
  const { completeJson } = await import('../../script-providers/index.ts');
  const request = () => completeJson<RawAnalysis>({
    providerId: input.providerId,
    ...(input.model ? { model: input.model } : {}),
    systemPrompt: '你是视频素材分析器。只描述视频本身，严格返回 JSON，不推断脚本文案。',
    userPrompt: buildVideoAnalysisPrompt(detectedScenes, durationSec, frames),
    temperature: 0.2,
    images,
    signal: input.signal,
    usageContext: {
      refType: 'video-analysis',
      refId: input.videoJobId,
    },
    executionContext: {
      taskId: input.executionTaskId ?? `video-analysis:${input.videoJobId}`,
      step: 'analyze:1',
      scope: input.executionScope ?? { resourceType: 'video_job', resourceId: input.videoJobId },
      inputRevision: input.inputRevision,
      businessAttempt: input.businessAttempt,
    },
  });
  const result = await (input.waitForExecution ? waitForAnalysisAdmission(request, input.signal) : request());
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
