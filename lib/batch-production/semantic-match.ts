import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { splitAllocationScriptBody } from './allocator.ts';
import { extractMatchKeywords } from '../media-core/match-keywords.ts';
import {
  SEMANTIC_MATRIX_PROMPT_VERSION,
  buildSemanticMatrixPrompt,
  scoreSemanticMatrixWithRetry,
  type SemanticScene,
  type SemanticSentence,
} from '../media-core/semantic-matrix.ts';
import { createBatchTask } from './tasks.ts';

/**
 * 批量“语义矩阵打分”的装配层:句段/场景构造、内容指纹键、矩阵持久化与
 * 打分调用。executor 与 allocation-store 都从这里取同一套句段与键,
 * 保证打分时的 prompt 顺序与分配装配时的键映射严格一致。
 *
 * matrixJson 形状(按句段保留完整矩阵维度):
 *   { scores: { "<sentenceId>": { "assetId:sceneIndex": number } },
 *     hooks: { "assetId:sceneIndex": number } }
 */

export type BatchSemanticSentence = SemanticSentence;
export type BatchSemanticScene = SemanticScene;

/** 每句的语义分:键 `assetId:sceneIndex`(正是 allocator semanticScore 消费的形状)。 */
export type BatchSemanticScoreMap = Record<string, Record<string, number>>;
export type BatchSemanticHookMap = Record<string, number>;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: unknown, fallback = 0.5): number {
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

/** 断句与分配器完全一致;id 为稳定形式 `segment-<i+1>`(prompt 与键映射都按它)。 */
export function buildBatchSentences(bodyText: string): BatchSemanticSentence[] {
  return splitAllocationScriptBody(bodyText).map((text, index) => ({
    id: `segment-${index + 1}`,
    text,
    keywords: extractMatchKeywords(text),
  }));
}

export interface BatchSemanticPoolRow {
  assetId: string;
  contentFingerprint: string;
  analysisJson: unknown;
}

/** 只收内容级分析(analysisLevel==='content' 且 scenes 非空)的行;technical 分析无场景。 */
export function buildBatchScenes(poolRows: readonly BatchSemanticPoolRow[]): BatchSemanticScene[] {
  const scenes: BatchSemanticScene[] = [];
  for (const row of poolRows) {
    const analysis = asRecord(parseJson(row.analysisJson));
    if (analysis.analysisLevel !== 'content') continue;
    const rawScenes = Array.isArray(analysis.scenes) ? analysis.scenes : [];
    if (!rawScenes.length) continue;
    rawScenes.forEach((rawScene, sceneIndex) => {
      const scene = asRecord(rawScene);
      scenes.push({
        assetKey: row.assetId,
        assetFingerprint: row.contentFingerprint,
        sceneIndex,
        startUs: Math.max(0, finite(scene.startUs)),
        endUs: Math.max(0, finite(scene.endUs)),
        labels: (Array.isArray(scene.labels) ? scene.labels : []).map(String).filter(Boolean),
        description: typeof scene.description === 'string' ? scene.description : '',
        quality: clamp01(scene.qualityScore ?? scene.quality),
      });
    });
  }
  return scenes;
}

/** 句段内容指纹:与打分/装配共用,任何句段文本或关键词变化都会换键。 */
export function batchSemanticScriptKey(sentences: readonly BatchSemanticSentence[]): string {
  return sha256Hex(JSON.stringify(sentences.map((sentence) => ({
    id: sentence.id,
    text: sentence.text,
    keywords: sentence.keywords,
  }))));
}

/** 素材池场景内容指纹。 */
export function batchSemanticPoolKey(scenes: readonly BatchSemanticScene[]): string {
  return sha256Hex(JSON.stringify(scenes.map((scene) => ({
    assetKey: scene.assetKey,
    assetFingerprint: scene.assetFingerprint,
    sceneIndex: scene.sceneIndex,
    startUs: scene.startUs,
    endUs: scene.endUs,
    labels: scene.labels,
    description: scene.description,
    quality: scene.quality,
  }))));
}

export interface BatchSemanticMatrixRecord {
  scores: BatchSemanticScoreMap;
  hooks: BatchSemanticHookMap;
}

function normalizeScoreMap(value: unknown): BatchSemanticScoreMap {
  const result: BatchSemanticScoreMap = {};
  for (const [sentenceId, row] of Object.entries(asRecord(value))) {
    const scores: Record<string, number> = {};
    for (const [sceneKey, score] of Object.entries(asRecord(row))) {
      scores[sceneKey] = clamp01(score, 0);
    }
    result[sentenceId] = scores;
  }
  return result;
}

function normalizeHookMap(value: unknown): BatchSemanticHookMap {
  const result: BatchSemanticHookMap = {};
  for (const [sceneKey, score] of Object.entries(asRecord(value))) {
    result[sceneKey] = clamp01(score, 0);
  }
  return result;
}

/** 读取该内容指纹组合下最新一条矩阵;没有则返回 undefined。 */
export function readBatchSemanticMatrix(
  db: Database.Database,
  projectId: string,
  scriptKey: string,
  poolKey: string,
): BatchSemanticMatrixRecord | undefined {
  const row = db.prepare(`
    SELECT matrixJson FROM batch_semantic_matrices
    WHERE projectId = ? AND scriptKey = ? AND poolKey = ?
    ORDER BY createdAt DESC, id DESC
    LIMIT 1
  `).get(projectId, scriptKey, poolKey) as { matrixJson: string } | undefined;
  if (!row) return undefined;
  const parsed = asRecord(parseJson(row.matrixJson));
  return {
    scores: normalizeScoreMap(parsed.scores),
    hooks: normalizeHookMap(parsed.hooks),
  };
}

/** 同 (projectId, scriptKey, poolKey, providerId, model) 已存在则跳过,返回既有行 id。 */
export function persistBatchSemanticMatrix(
  db: Database.Database,
  input: {
    projectId: string;
    scriptKey: string;
    poolKey: string;
    providerId: string;
    model: string;
    promptVersion?: string;
    scores: BatchSemanticScoreMap;
    hooks: BatchSemanticHookMap;
    now?: () => Date;
  },
): { created: boolean; id: string } {
  const existing = db.prepare(`
    SELECT id FROM batch_semantic_matrices
    WHERE projectId = ? AND scriptKey = ? AND poolKey = ? AND providerId = ? AND model = ?
    LIMIT 1
  `).get(input.projectId, input.scriptKey, input.poolKey, input.providerId, input.model) as { id: string } | undefined;
  if (existing) return { created: false, id: existing.id };
  const id = randomUUID();
  const matrixJson = JSON.stringify({ scores: input.scores, hooks: input.hooks });
  db.prepare(`
    INSERT INTO batch_semantic_matrices
      (id, projectId, scriptKey, poolKey, providerId, model, promptVersion, matrixJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    input.scriptKey,
    input.poolKey,
    input.providerId,
    input.model,
    input.promptVersion ?? SEMANTIC_MATRIX_PROMPT_VERSION,
    matrixJson,
    (input.now ?? (() => new Date()))().toISOString(),
  );
  return { created: true, id };
}

export type BatchSemanticScoreOutcome =
  | { fallback: true }
  | { fallback: false; scores: BatchSemanticScoreMap; hooks: BatchSemanticHookMap; model: string };

/**
 * 调 LLM 对 句段 × 场景 打分。fallback(0.6 均匀矩阵)直接返回 {fallback:true},
 * 由调用方决定不落库;成功时把按 prompt 顺序的矩阵转成
 * scores[sentenceId]["assetId:sceneIndex"] 键映射(scenes 数组顺序即 prompt 顺序)。
 */
export async function scoreBatchSemanticMatrix(input: {
  sentences: readonly BatchSemanticSentence[];
  scenes: readonly BatchSemanticScene[];
  providerId: string;
  /** 测试注入;默认 buildSemanticMatrixPrompt + completeJson(纯文本,无 COS 门禁)。 */
  score?: () => Promise<unknown>;
  model?: string;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<BatchSemanticScoreOutcome> {
  const score = input.score ?? (async () => {
    const prompts = buildSemanticMatrixPrompt({ sentences: [...input.sentences], scenes: [...input.scenes] });
    const { completeJson } = await import('../script-providers/index.ts');
    return completeJson({
      providerId: input.providerId,
      systemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      temperature: 0.2,
      // 推理型模型（GPT-5-5 等）的思考过程会吃 max_tokens 预算：1500 会被
      // 思考占满、可见输出为空（finish_reason=length），矩阵解析必败。
      maxTokens: 8000,
    });
  });
  const result = await scoreSemanticMatrixWithRetry({
    sentenceCount: input.sentences.length,
    sceneCount: input.scenes.length,
    score,
    sleep: input.sleep,
  });
  if (result.semanticFallback) return { fallback: true };
  const scores: BatchSemanticScoreMap = {};
  const hooks: BatchSemanticHookMap = {};
  input.scenes.forEach((scene, sceneIndex) => {
    hooks[`${scene.assetKey}:${scene.sceneIndex}`] = result.hookScores[sceneIndex] ?? 0;
  });
  input.sentences.forEach((sentence, sentenceIndex) => {
    const row: Record<string, number> = {};
    input.scenes.forEach((scene, sceneIndex) => {
      row[`${scene.assetKey}:${scene.sceneIndex}`] = result.semanticScores[sentenceIndex]?.[sceneIndex] ?? 0;
    });
    scores[sentence.id] = row;
  });
  return { fallback: false, scores, hooks, model: input.model ?? '' };
}

export interface BatchSemanticProviderRef {
  providerId: string;
  model: string;
}

export interface BatchSemanticProviderMetaLike {
  id: string;
  model: string;
  configured: boolean;
}

/**
 * 打分供应商解析顺序(触发处与 executor 共用同一规则):
 * 显式 providerId → 该批次最近一次内容分析请求的 providerId →
 * 第一个 configured 的脚本供应商。解析不到返回 undefined。
 * 未注入 listProviders 时动态加载供应商注册表(该模块存在无扩展名导入,
 * 只能在 Next 运行时解析;测试必须注入 listProviders)。
 */
export async function resolveBatchSemanticProvider(
  db: Database.Database,
  input: {
    batchVersionId: string;
    explicitProviderId?: string;
    /** 测试注入;默认 getAvailableProviders()。 */
    listProviders?: () => BatchSemanticProviderMetaLike[];
  },
): Promise<BatchSemanticProviderRef | undefined> {
  const listProviders = input.listProviders ?? (async () => {
    const { getAvailableProviders } = await import('../script-providers/index.ts');
    return getAvailableProviders();
  });
  const providers = await Promise.resolve(listProviders());
  if (input.explicitProviderId) {
    const meta = providers.find((provider) => provider.id === input.explicitProviderId);
    return { providerId: input.explicitProviderId, model: meta?.model ?? '' };
  }
  const requested = db.prepare(`
    SELECT r.providerId, r.model
    FROM batch_asset_analysis_requests r
    JOIN batch_production_versions v ON v.batchId = r.batchId
    WHERE v.id = ?
    ORDER BY r.createdAt DESC, r.taskId DESC
    LIMIT 1
  `).get(input.batchVersionId) as { providerId: string; model: string } | undefined;
  if (requested) return { providerId: requested.providerId, model: requested.model };
  const first = providers.find((provider) => provider.configured);
  return first ? { providerId: first.id, model: first.model } : undefined;
}

export interface QueueBatchSemanticScoreResult {
  /** 新建任务的 taskId 列表 */
  created: string[];
  /** 因幂等(任务已存在或矩阵已就绪)跳过的 scriptSnapshotId 列表 */
  skipped: string[];
}

/**
 * 开跑门禁自动复活失败打分任务的尝试上限:门禁会被前端自动续跑反复触发,
 * 没有上限时供应商持续失败会形成无限重试循环。手动「重新生成语义匹配」
 * 不受此限(用户在显式动作里已经知道自己在重试)。
 */
export const SEMANTIC_SCORE_MAX_AUTO_ATTEMPTS = 3;

/**
 * 对一个批次版本的每份脚本快照幂等创建 semantic_score 任务。
 * 无内容分析场景或解析不到供应商时静默返回空结果(分配有兜底)。
 * reviveFailed: 'always'(默认,手动入口)无条件复活失败任务;
 * 'auto'(开跑门禁)在尝试次数达上限后保留 failed,让开跑走关键词兜底。
 */
export async function queueBatchSemanticScoreTasks(
  db: Database.Database,
  projectId: string,
  batchId: string,
  batchVersionId: string,
  options: {
    explicitProviderId?: string;
    listProviders?: () => BatchSemanticProviderMetaLike[];
    now?: () => Date;
    reviveFailed?: 'always' | 'auto';
  } = {},
): Promise<QueueBatchSemanticScoreResult> {
  const result: QueueBatchSemanticScoreResult = { created: [], skipped: [] };
  const poolRows = db.prepare(`
    SELECT pool.assetId, assets.contentFingerprint, analysis.analysisJson
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    WHERE pool.batchVersionId = ?
    ORDER BY pool.createdAt, pool.id
  `).all(batchVersionId) as BatchSemanticPoolRow[];
  const scenes = buildBatchScenes(poolRows);
  if (!scenes.length) return result;
  const provider = await resolveBatchSemanticProvider(db, {
    batchVersionId,
    explicitProviderId: options.explicitProviderId,
    listProviders: options.listProviders,
  });
  if (!provider) return result;
  const poolKey = batchSemanticPoolKey(scenes);
  const providerDigest = sha256Hex(`${provider.providerId}:${provider.model}`).slice(0, 12);
  const snapshots = db.prepare(`
    SELECT id, bodyText FROM batch_script_snapshots
    WHERE batchVersionId = ?
    ORDER BY createdAt, id
  `).all(batchVersionId) as Array<{ id: string; bodyText: string }>;
  for (const snapshot of snapshots) {
    const sentences = buildBatchSentences(snapshot.bodyText);
    if (!sentences.length) {
      result.skipped.push(snapshot.id);
      continue;
    }
    const scriptKey = batchSemanticScriptKey(sentences);
    const requestKey = [
      'semantic_score',
      batchVersionId,
      snapshot.id,
      scriptKey.slice(0, 12),
      poolKey.slice(0, 12),
      providerDigest,
    ].join(':');
    if (readBatchSemanticMatrix(db, projectId, scriptKey, poolKey)) {
      result.skipped.push(snapshot.id);
      continue;
    }
    const existingTask = db.prepare(`
      SELECT id, status FROM batch_tasks WHERE requestKey = ? AND projectId = ?
    `).get(requestKey, projectId) as { id: string; status: string } | undefined;
    if (existingTask?.status === 'failed') {
      // 失败任务的复活分两档:
      // - always(手动「重新生成语义匹配」/确认快照):无条件原地回 queued;
      // - auto(开跑前门禁):只有尝试次数低于上限才复活。门禁会被前端自动续跑
      //   反复触发,无条件复活 + 供应商持续失败 = 无限重试循环(实测 21 分钟
      //   白打 306 次供应商 API);达到上限后保留 failed,由开跑流程走关键词兜底。
      const reviveFailed = options.reviveFailed ?? 'always';
      const autoAttempts = db.prepare(`
        SELECT COUNT(*) AS n FROM batch_task_attempts WHERE taskId = ?
      `).get(existingTask.id) as { n: number };
      if (reviveFailed === 'always' || autoAttempts.n < SEMANTIC_SCORE_MAX_AUTO_ATTEMPTS) {
        const updatedAt = (options.now ?? (() => new Date()))().toISOString();
        db.prepare(`
          UPDATE batch_tasks
          SET status = 'queued', expectedState = 'running', updatedAt = ?
          WHERE id = ? AND projectId = ? AND status = 'failed'
        `).run(updatedAt, existingTask.id, projectId);
        result.created.push(existingTask.id);
      } else {
        result.skipped.push(snapshot.id);
      }
      continue;
    }
    if (existingTask?.status === 'cancelled') {
      // 已取消是死路(典型场景:停止批次后再开跑同一版本)。交给 createBatchTask
      // 释放旧 requestKey 并重建新任务,而不是被下面的幂等跳过吞掉。
      const taskId = createBatchTask(db, projectId, {
        batchId,
        workType: 'semantic_score',
        targetKind: 'script_snapshot',
        targetId: snapshot.id,
        requestKey,
        now: options.now,
      });
      result.created.push(taskId);
      continue;
    }
    if (existingTask) {
      result.skipped.push(snapshot.id);
      continue;
    }
    const taskId = createBatchTask(db, projectId, {
      batchId,
      workType: 'semantic_score',
      targetKind: 'script_snapshot',
      targetId: snapshot.id,
      requestKey,
      now: options.now,
    });
    result.created.push(taskId);
  }
  return result;
}

/** 该版本仍未完成(queued/running)的语义匹配任务数。 */
export function countIncompleteBatchSemanticScoreTasks(db: Database.Database, batchVersionId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_tasks t
    JOIN batch_script_snapshots s ON s.id = t.targetId
    WHERE t.workType = 'semantic_score' AND t.targetKind = 'script_snapshot'
      AND s.batchVersionId = ?
      AND t.status IN ('queued', 'running')
  `).get(batchVersionId) as { n: number };
  return row.n;
}

/**
 * 「开始批量生产」的语义匹配保证:草稿版本开跑前先幂等排队打分,
 * 返回仍未完成的打分数;调用方据此决定立即开跑还是等打分完成后自动继续。
 * 无内容分析素材或无可用供应商时排队静默跳过,pending 为 0,不阻塞开跑。
 */
export async function prepareBatchSemanticScoreBeforeStart(
  db: Database.Database,
  projectId: string,
  batchId: string,
  batchVersionId: string,
  options: {
    explicitProviderId?: string;
    listProviders?: () => BatchSemanticProviderMetaLike[];
    now?: () => Date;
  } = {},
): Promise<{ pending: number }> {
  // 门禁会被前端自动续跑反复触发:失败复活走 auto 档(尝试上限 3 次),
  // 超过上限保留 failed,让开跑按设计意图走关键词兜底,而不是无限重试。
  await queueBatchSemanticScoreTasks(db, projectId, batchId, batchVersionId, { ...options, reviveFailed: 'auto' });
  return { pending: countIncompleteBatchSemanticScoreTasks(db, batchVersionId) };
}
