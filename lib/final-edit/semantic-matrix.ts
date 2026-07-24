import crypto from 'node:crypto';

export const SEMANTIC_MATRIX_PROMPT_VERSION = '1';

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
  return {
    systemPrompt: '你是电商短视频的镜头匹配评分器。只返回严格 JSON，不返回解释或 Markdown。',
    userPrompt: `请一次性评估每个口播句段与每个候选场景的语义匹配度，并评估每个场景作为首镜头的吸引力。\n口播句段：${JSON.stringify(input.sentences)}\n候选场景：${JSON.stringify(input.scenes)}\n返回 {"score_matrix":[[0到1]],"hook_scores":[0到1]}。score_matrix 必须是 ${input.sentences.length} 行、每行 ${input.scenes.length} 列；hook_scores 必须有 ${input.scenes.length} 项。`,
  };
}
