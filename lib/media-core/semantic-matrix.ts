import crypto from 'node:crypto';

export const SEMANTIC_MATRIX_PROMPT_VERSION = '2';

export interface SemanticSentence {
  id: string;
  text: string;
  keywords: string[];
}

export interface SemanticScene {
  assetKey: string;
  assetFingerprint: string;
  sceneIndex: number;
  startUs: number;
  endUs: number;
  labels: string[];
  description: string;
  quality: number;
}

export interface SemanticMatrixInput {
  sentences: SemanticSentence[];
  scenes: SemanticScene[];
  providerId: string;
  model: string;
  promptVersion: string;
}

export interface SemanticMatrixResult {
  semanticScores: number[][];
  hookScores: number[];
  semanticFallback: boolean;
}

export function createSemanticMatrixCacheKey(input: SemanticMatrixInput): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    script: input.sentences.map((sentence) => ({ id: sentence.id, text: sentence.text, keywords: sentence.keywords })),
    scenes: input.scenes.map((scene) => ({
      assetKey: scene.assetKey,
      assetFingerprint: scene.assetFingerprint,
      sceneIndex: scene.sceneIndex,
      startUs: scene.startUs,
      endUs: scene.endUs,
      labels: scene.labels,
      description: scene.description,
      quality: scene.quality,
    })),
    providerId: input.providerId,
    model: input.model,
    promptVersion: input.promptVersion,
  })).digest('hex');
}

function fallback(sentenceCount: number, sceneCount: number): SemanticMatrixResult {
  return {
    semanticScores: Array.from({ length: sentenceCount }, () => Array(sceneCount).fill(0.6) as number[]),
    hookScores: Array(sceneCount).fill(0) as number[],
    semanticFallback: true,
  };
}

export function normalizeSemanticMatrix(raw: unknown, sentenceCount: number, sceneCount: number): SemanticMatrixResult {
  if (!raw || typeof raw !== 'object') return fallback(sentenceCount, sceneCount);
  const value = raw as Record<string, unknown>;
  const matrix = value.score_matrix ?? value.semanticScores ?? value.scoreMatrix;
  const hooks = value.hook_scores ?? value.hookScores;
  if (!Array.isArray(matrix) || matrix.length !== sentenceCount || !Array.isArray(hooks) || hooks.length !== sceneCount) return fallback(sentenceCount, sceneCount);
  const normalizedMatrix: number[][] = [];
  for (const row of matrix) {
    if (!Array.isArray(row) || row.length !== sceneCount || row.some((score) => !Number.isFinite(Number(score)))) return fallback(sentenceCount, sceneCount);
    normalizedMatrix.push(row.map((score) => Math.max(0, Math.min(1, Number(score)))));
  }
  if (hooks.some((score) => !Number.isFinite(Number(score)))) return fallback(sentenceCount, sceneCount);
  return {
    semanticScores: normalizedMatrix,
    hookScores: hooks.map((score) => Math.max(0, Math.min(1, Number(score)))),
    semanticFallback: false,
  };
}

export function buildSemanticMatrixPrompt(input: Pick<SemanticMatrixInput, 'sentences' | 'scenes'>): { systemPrompt: string; userPrompt: string } {
  const sentences = input.sentences.map((sentence, index) =>
    `句${index + 1}: ${JSON.stringify(sentence.text)}\n画面关键词: ${sentence.keywords.length ? sentence.keywords.join('、') : '无'}`,
  ).join('\n');
  const scenes = input.scenes.map((scene, index) =>
    `素材${index + 1}: ${scene.description || '无描述'}\n标签: ${scene.labels.length ? scene.labels.join('、') : '无'}`,
  ).join('\n');
  return {
    systemPrompt: '你是电商短视频的镜头匹配评分器。只返回严格 JSON，不返回解释或 Markdown。',
    userPrompt: `请一次性评估每个口播句段与每个候选场景的语义匹配度，并评估每个场景作为首镜头的吸引力。\n\n口播句段：\n${sentences}\n\n候选场景：\n${scenes}\n\n返回 {"score_matrix":[[0到1]],"hook_scores":[0到1]}。score_matrix 必须是 ${input.sentences.length} 行、每行 ${input.scenes.length} 列；hook_scores 必须有 ${input.scenes.length} 项。`,
  };
}

export interface SemanticMatrixRetryEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

function errorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && Number.isFinite(Number((error as { status?: unknown }).status))) {
    return Number((error as { status: number }).status);
  }
  const match = (error instanceof Error ? error.message : String(error)).match(/(?:error|status|http)\s*[:=]?\s*(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function retryableSemanticError(error: unknown): boolean {
  if (error instanceof InvalidSemanticMatrixError) return true;
  const status = errorStatus(error);
  if (status != null) return status === 429 || status === 502 || status === 503 || status === 504;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|connect|network|socket|remoteprotocol|fetch failed|空响应|无效\s*json|invalid\s*json/i.test(`${name} ${message}`);
}

class InvalidSemanticMatrixError extends Error {
  constructor() {
    super('semantic_matrix_invalid');
    this.name = 'InvalidSemanticMatrixError';
  }
}

export async function scoreSemanticMatrixWithRetry(input: {
  sentenceCount: number;
  sceneCount: number;
  score: () => Promise<unknown>;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: SemanticMatrixRetryEvent) => void;
  onFailure?: (error: unknown, attempts: number) => void;
}): Promise<SemanticMatrixResult> {
  const delays = [500, 1_000, 2_000] as const;
  const maxAttempts = delays.length + 1;
  let lastError: unknown = new InvalidSemanticMatrixError();
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const normalized = normalizeSemanticMatrix(await input.score(), input.sentenceCount, input.sceneCount);
      if (normalized.semanticFallback) throw new InvalidSemanticMatrixError();
      return normalized;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !retryableSemanticError(error)) break;
      const delayMs = delays[attempt - 1];
      input.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await (input.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
    }
  }
  input.onFailure?.(lastError, attempts);
  return fallback(input.sentenceCount, input.sceneCount);
}
