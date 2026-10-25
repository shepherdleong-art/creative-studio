import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  buildSemanticMatrixPrompt,
  createSemanticMatrixCacheKey,
  normalizeSemanticMatrix,
  scoreSemanticMatrixWithRetry,
  SEMANTIC_MATRIX_PROMPT_VERSION,
  type SemanticMatrixResult,
  type SemanticMatrixRetryEvent,
  type SemanticScene,
  type SemanticSentence,
} from './semantic-matrix.ts';

export type SemanticScoreAdapter = (input: {
  providerId: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}) => Promise<unknown>;

interface ResolveSemanticScoresInput {
  db: Database.Database;
  sentences: SemanticSentence[];
  scenes: SemanticScene[];
  providerId: string;
  score?: SemanticScoreAdapter;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: SemanticMatrixRetryEvent) => void;
  onFailure?: (error: unknown, attempts: number) => void;
}

function parseCachedJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * 语义评分的持久化 seam：调用方只提供句子、场景和供应商，不必了解缓存键、
 * 模型身份、重试或降级。只有真实成功矩阵才写缓存，暂时性失败不能永久绑定输入。
 */
export async function resolveFinalEditSemanticScores({
  db, sentences, scenes, providerId, score, sleep, onRetry, onFailure,
}: ResolveSemanticScoresInput): Promise<SemanticMatrixResult> {
  const model = (() => {
    try { return String((db.prepare(`SELECT COALESCE(NULLIF(model, ''), defaultModel, '') AS model FROM script_providers WHERE id=?`).get(providerId) as { model?: string } | undefined)?.model || ''); }
    catch { return ''; } // 隔离数据集可以省略供应商表；缓存身份仍保持一致。
  })();
  const semanticInput = {
    sentences,
    scenes,
    providerId,
    model,
    promptVersion: SEMANTIC_MATRIX_PROMPT_VERSION,
  };
  const cacheKey = createSemanticMatrixCacheKey(semanticInput);
  const cached = db.prepare(`SELECT semanticScoresJson, hookScoresJson, semanticFallback FROM final_edit_semantic_matrix_cache WHERE cacheKey=?`).get(cacheKey) as { semanticScoresJson: string; hookScoresJson: string; semanticFallback: number } | undefined;
  const normalizedCached = cached
    ? normalizeSemanticMatrix({ score_matrix: parseCachedJson(cached.semanticScoresJson), hook_scores: parseCachedJson(cached.hookScoresJson) }, sentences.length, scenes.length)
    : normalizeSemanticMatrix(null, sentences.length, scenes.length);
  const cacheHit = Boolean(cached && !cached.semanticFallback && !normalizedCached.semanticFallback);
  if (cacheHit) return normalizedCached;
  if (!sentences.length || !scenes.length || !score) {
    return normalizeSemanticMatrix(null, sentences.length, scenes.length);
  }

  const prompt = buildSemanticMatrixPrompt(semanticInput);
  const result = await scoreSemanticMatrixWithRetry({
    sentenceCount: sentences.length,
    sceneCount: scenes.length,
    score: () => score({
      providerId,
      ...prompt,
      temperature: 0.2,
      // 推理型模型的思考过程也消耗 max_tokens；1500 可能只剩空答案。
      maxTokens: 8000,
    }),
    sleep,
    onRetry,
    onFailure,
  });
  if (!result.semanticFallback) {
    const scriptHash = crypto.createHash('sha256').update(JSON.stringify(sentences)).digest('hex');
    const scenesFingerprint = crypto.createHash('sha256').update(JSON.stringify(scenes)).digest('hex');
    const now = () => new Date().toISOString();
    db.prepare(`
      INSERT INTO final_edit_semantic_matrix_cache
        (cacheKey, scriptHash, scenesFingerprint, providerId, model, promptVersion, semanticScoresJson, hookScoresJson, semanticFallback, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cacheKey) DO UPDATE SET
        scriptHash=excluded.scriptHash, scenesFingerprint=excluded.scenesFingerprint,
        providerId=excluded.providerId, model=excluded.model, promptVersion=excluded.promptVersion,
        semanticScoresJson=excluded.semanticScoresJson, hookScoresJson=excluded.hookScoresJson,
        semanticFallback=excluded.semanticFallback, updatedAt=excluded.updatedAt
    `).run(
      cacheKey, scriptHash, scenesFingerprint, providerId, model, semanticInput.promptVersion,
      JSON.stringify(result.semanticScores), JSON.stringify(result.hookScores), 0, now(), now(),
    );
  }
  return result;
}
