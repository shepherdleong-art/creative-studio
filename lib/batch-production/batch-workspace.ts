import type Database from 'better-sqlite3';
import { batchSourceReview, type BatchSourceConflictGroup } from './source-conflicts.ts';
import { batchArtifactPathsArePaired } from './artifact-pair.ts';
import { resolveProjectExportDirName } from '../project-export-dir.ts';
import { getCurrentExportDirName } from '../project-export-identity.ts';
import { isFormalArtifactOutdated, type FormalArtifactPreload } from './formal-artifact-freshness.ts';
import { resolveCoverContractHash, resolveFullRenderContractHash, type CoverContractOutputVersion, type CoverContractPreload } from './cover-contract.ts';
import { resolveModule4AssetGroupKeys } from './media-catalog.ts';
import type { FrozenCoverTitleRow } from './cover-title.ts';
import { BatchDomainError } from './errors.ts';
import type { BatchProductionStatus } from './versions.ts';
import type { BatchTaskExpectedState, BatchTaskStatus } from './tasks.ts';
import {
  buildCoverRenderTaskRequestKey,
  buildFullRenderTaskRequestKey,
  parseRenderTaskRequestKey,
} from './render-task-key.ts';

export type BatchWorkspacePhase =
  | 'prepare_materials'
  | 'analyze_materials'
  | 'prepare_scripts'
  | 'allocate'
  | 'export'
  | 'review';

export type BatchOutputCardStatus =
  | 'completed'
  | 'needs_attention'
  | 'processing'
  | 'waiting'
  | 'paused'
  | 'retryable_failed'
  | 'stopped';

export type BatchCoverTaskStatus = 'missing' | 'queued' | 'running' | 'succeeded' | 'failed';

export type BatchCardExportStatus = 'not_exported' | 'rendering' | 'failed' | 'exported';

export interface BatchWorkspaceArtifactView {
  id: string;
  outputVersionId: string;
  kind: 'video' | 'cover';
  relativePath: string;
  checksum: string;
  createdAt: string;
}

/** 当前正式成片:视频指针及其配对封面(同一导出对)。 */
export interface BatchFormalArtifactView {
  video: BatchWorkspaceArtifactView;
  cover: BatchWorkspaceArtifactView | null;
}

export interface BatchWorkspaceTaskView {
  id: string;
  status: BatchTaskStatus;
  expectedState: BatchTaskExpectedState;
  attemptCount: number;
  progress: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 该计划脚本快照对应的口播任务(渲染闸门的配套信息,供"重试配音"入口使用) */
export interface BatchWorkspaceNarrationTaskView {
  id: string;
  status: BatchTaskStatus;
  expectedState: BatchTaskExpectedState;
  errorMessage: string | null;
}

/** 换封面的可调范围:封面素材整段原片;无法解析时为 null */
export interface BatchCoverRangeView {
  assetId: string;
  startUs: number;
  endUs: number;
  /** 当前冻结的封面时间点;未设置时为 startUs */
  currentUs: number;
}

export interface BatchOutputCardView {
  planId: string;
  seq: number;
  scriptSnapshotId: string;
  scriptTitle: string;
  versionId: string | null;
  versionNumber: number | null;
  status: BatchOutputCardStatus;
  nextAction: string;
  /** 有当前候选版本且批次未停止 → 可以进入编辑器。 */
  reviewable: boolean;
  /** 口播和封面都已就绪 → 允许标记「通过」。 */
  approvable: boolean;
  /** 用户审核状态:当前成片版本 arrangement 的 review.decision === 'approved' */
  approved: boolean;
  /** 审核已通过、口播就绪、配音未失败、有当前版本 → 允许发起正式导出。 */
  exportEligible: boolean;
  /** 已有正式成片,但当前编辑方案比它更新(或对应渲染结果已找不到)。 */
  formalOutdated: boolean;
  /**
   * 正式导出状态(服务端统一判断,前端只消费,不得再从 fullRenderTask 自行拼):
   * exported(当前正式成片对应当前方案)/ rendering(整片渲染排队或进行中)/
   * failed(渲染失败)/ not_exported(尚未导出或渲染结果已过期)。
   */
  exportStatus: BatchCardExportStatus;
  /** 封面任务状态;missing 表示还没有独立封面任务(老批次回落到完整候选)。 */
  coverStatus: BatchCoverTaskStatus;
  /** 最近成功封面尝试 ID(封面墙/编辑器封面预览用;老批次为完整渲染尝试)。 */
  coverAttemptId: string | null;
  productionReady: boolean;
  /** 当前成片存在人工字幕覆盖;重试口播前需要明确提示会清除它。 */
  subtitleOverride: boolean;
  coverRange: BatchCoverRangeView | null;
  warnings: string[];
  /** 当前画面实时同源提醒，只提示，不影响审核与导出资格。 */
  sourceWarnings?: string[];
  sourceConflictAssetIds?: string[];
  sourceConflictGroups?: BatchSourceConflictGroup[];
  blockers: string[];
  /** 当前正式成片(视频 + 配对封面);未发布过为 null。 */
  currentFormalArtifact: BatchFormalArtifactView | null;
  /** 整片渲染任务(导出阶段按需创建)。 */
  fullRenderTask: BatchWorkspaceTaskView | null;
  /** 独立封面渲染任务。 */
  coverTask: BatchWorkspaceTaskView | null;
  narrationTask: BatchWorkspaceNarrationTaskView | null;
}

export interface BatchWorkspaceView {
  batch: {
    id: string;
    name: string;
    status: BatchProductionStatus;
    controlState: 'running' | 'paused' | 'stopped';
    currentVersionId: string | null;
  };
  phase: BatchWorkspacePhase;
  /** 成片导出目录名(`<产品编码>-<YYYYMMDD>`),前端展示成品文件夹时直接用 */
  exportDirName: string;
  counts: {
    total: number;
    reviewable: number;
    approvable: number;
    approved: number;
    processing: number;
    needsAttention: number;
    failed: number;
  };
  cards: BatchOutputCardView[];
  exclusions: Array<{ assetId: string; reason: string }>;
  allocationReport: unknown | null;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrangementHasManualSubtitleOverride(value: unknown): boolean {
  const subtitle = asRecord(asRecord(value)?.subtitle);
  return subtitle?.source === 'manual' || subtitle?.mode === 'manual';
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function durationFromSeconds(value: unknown): number | null {
  const durationSec = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const converted = Math.round(durationSec * 1_000_000);
  return Number.isSafeInteger(converted) && converted > 0 ? converted : null;
}

function poolAssetDurationUs(row: {
  analysisDurationUs: number | null;
  mediaDurationUs: number | null;
  mediaDurationSec: number | null;
}): number | null {
  for (const raw of [row.analysisDurationUs, row.mediaDurationUs]) {
    const durationUs = positiveSafeInteger(raw);
    if (durationUs !== null) return durationUs;
  }
  return durationFromSeconds(row.mediaDurationSec);
}

interface PoolFacts {
  durations: Map<string, number>;
  /** `${batchVersionId}\u0000${assetId}` → 池内冻结色彩快照(含 null)。 */
  colors: Map<string, string | null>;
  /** assetId → 内容指纹(池内素材一次取回,非池素材再补一次)。 */
  fingerprints: Map<string, string>;
}

/** 一次取回冻结素材池的时长、色彩快照与内容指纹,供整批工作区复用。 */
function loadPoolFacts(db: Database.Database, batchVersionId: string): PoolFacts {
  const rows = db.prepare(`
    SELECT pool.assetId,
      pool.colorJson AS poolColorJson,
      assets.contentFingerprint AS contentFingerprint,
      CASE WHEN json_valid(analysis.analysisJson) THEN json_extract(analysis.analysisJson, '$.durationUs') END AS analysisDurationUs,
      CASE WHEN json_valid(assets.mediaJson) THEN json_extract(assets.mediaJson, '$.durationUs') END AS mediaDurationUs,
      CASE WHEN json_valid(assets.mediaJson) THEN json_extract(assets.mediaJson, '$.durationSec') END AS mediaDurationSec
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    WHERE pool.batchVersionId = ?
  `).all(batchVersionId) as Array<{
    assetId: string;
    poolColorJson: string | null;
    contentFingerprint: string;
    analysisDurationUs: number | null;
    mediaDurationUs: number | null;
    mediaDurationSec: number | null;
  }>;
  const durations = new Map<string, number>();
  const colors = new Map<string, string | null>();
  const fingerprints = new Map<string, string>();
  for (const row of rows) {
    const durationUs = poolAssetDurationUs(row);
    if (durationUs !== null) durations.set(row.assetId, durationUs);
    colors.set(`${batchVersionId}\u0000${row.assetId}`, row.poolColorJson);
    fingerprints.set(row.assetId, row.contentFingerprint);
  }
  return { durations, colors, fingerprints };
}

/** 审核态:当前版本 arrangement.review.decision === 'approved' */
function arrangementReviewApproved(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const review = (value as Record<string, unknown>).review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return false;
  return (review as Record<string, unknown>).decision === 'approved';
}

/**
 * 换封面可调范围:与渲染器封面取材规则保持一致——
 * - 显式封面 clip(clipId/segmentId):取该 clip 的原片区间;
 * - 显式封面 assetId 即使不在时间线 clips 中,也按冻结素材池中的整段原片
 *   [0,duration)返回范围;
 * - 显式封面 clip 与无封面设置同样先解析出素材身份,再使用该素材整段原片。
 *   素材不在冻结池或没有可用时长时返回 null。
 */
function arrangementCoverRange(value: unknown, assetDurations: ReadonlyMap<string, number>): BatchCoverRangeView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawClips = record.clips;
  if (!Array.isArray(rawClips)) return null;
  const clips = rawClips
    .filter((clip): clip is Record<string, unknown> => Boolean(clip && typeof clip === 'object' && !Array.isArray(clip)))
    .sort((a, b) => (Number(a.timelineStartUs) || 0) - (Number(b.timelineStartUs) || 0));
  const cover = record.cover && typeof record.cover === 'object' && !Array.isArray(record.cover)
    ? record.cover as Record<string, unknown>
    : null;
  let selected: Record<string, unknown> | null = null;
  let assetId: string | null = null;
  const coverClipId = cover && (typeof cover.clipId === 'string' ? cover.clipId : typeof cover.segmentId === 'string' ? cover.segmentId : null);
  if (coverClipId) {
    selected = clips.find((clip) => clip.clipId === coverClipId || clip.segmentId === coverClipId) ?? null;
    if (!selected) return null;
    assetId = typeof selected.assetId === 'string' ? selected.assetId : null;
  } else if (cover && typeof cover.assetId === 'string') {
    assetId = cover.assetId;
  } else {
    selected = clips[0] ?? null;
    if (!selected) return null;
    assetId = typeof selected.assetId === 'string' ? selected.assetId : null;
  }
  if (!assetId) return null;
  const durationUs = assetDurations.get(assetId);
  if (!durationUs || !Number.isSafeInteger(durationUs) || durationUs <= 0) return null;
  const requested = cover
    ? (typeof cover.timeUs === 'number' ? cover.timeUs
      : typeof cover.frameTimeUs === 'number' ? cover.frameTimeUs
        : typeof cover.sourceTimeUs === 'number' ? cover.sourceTimeUs : null)
    : null;
  const requestedUs = typeof requested === 'number' && Number.isFinite(requested) ? requested : 0;
  const currentUs = Math.min(Math.max(0, requestedUs), Math.max(0, durationUs - 1));
  return { assetId, startUs: 0, endUs: durationUs, currentUs };
}

function diagnosticMessages(value: unknown, key: 'warnings' | 'blockers'): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const diagnostics = (value as Record<string, unknown>)[key];
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.flatMap((entry): string[] => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const message = typeof record.message === 'string'
        ? record.message
        : typeof record.code === 'string' ? record.code : '';
      return message ? [message] : [];
    }
    return [];
  });
}

function arrangementProductionReady(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.productionReady === 'boolean') return record.productionReady;
  const narration = record.narration;
  return Boolean(
    narration
    && typeof narration === 'object'
    && !Array.isArray(narration)
    && (narration as Record<string, unknown>).productionReady === true,
  );
}

function allocationOutput(value: unknown, planId: string): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outputs = (value as Record<string, unknown>).outputs;
  if (!Array.isArray(outputs)) return null;
  return outputs.find((entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).planId === planId
  )) ?? null;
}

/** 画面片段引用的素材(同源检查只画面、不计封面)。 */
function clipAssetIdsOf(value: unknown): string[] {
  const clips = asRecord(value)?.clips;
  if (!Array.isArray(clips)) return [];
  return [...new Set(clips.flatMap((clip) => {
    const assetId = asRecord(clip)?.assetId;
    return typeof assetId === 'string' && assetId ? [assetId] : [];
  }))];
}

/** 契约解析可能引用的全部素材:片段 + 显式封面素材。 */
function referencedAssetIdsOf(value: unknown): string[] {
  const ids = new Set(clipAssetIdsOf(value));
  const coverAssetId = asRecord(asRecord(value)?.cover)?.assetId;
  if (typeof coverAssetId === 'string' && coverAssetId) ids.add(coverAssetId);
  return [...ids];
}

interface RenderTaskRow {
  id: string;
  targetId: string;
  requestKey: string | null;
  status: BatchTaskStatus;
  expectedState: BatchTaskExpectedState;
  attemptCount: number;
  progressJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface CoverTaskRow extends RenderTaskRow {
  succeededAttemptId: string | null;
}

interface SucceededAttemptRow {
  taskId: string;
  targetId: string;
  requestKey: string | null;
  attemptId: string;
  attemptNumber: number;
  resultJson: string | null;
  finishedAt: string | null;
}

interface NarrationTaskRow {
  id: string;
  targetId: string;
  status: BatchTaskStatus;
  expectedState: BatchTaskExpectedState;
  errorMessage: string | null;
}

function taskView(row: RenderTaskRow): BatchWorkspaceTaskView {
  return {
    id: row.id,
    status: row.status,
    expectedState: row.expectedState,
    attemptCount: row.attemptCount,
    progress: parseJson(row.progressJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

/** 完整渲染任务只认当前 requestKey;行已按 createdAt DESC, id DESC 预排序。 */
function selectFullRenderTask(
  rows: RenderTaskRow[] | undefined,
  requestKey: string | null,
): BatchWorkspaceTaskView | null {
  if (!requestKey) return null;
  const row = rows?.find((entry) => entry.requestKey === requestKey);
  return row ? taskView(row) : null;
}

/**
 * 封面任务状态与最近成功尝试 ID(编辑器优先模型下封面的唯一事实来源)。
 * 必须按**当前**封面契约哈希选任务:封面 A→B→A 时复用旧 A 任务,
 * 不能把较新的 B 任务(或它的失败状态)当成 A 的事实展示。
 * 契约无法解析时只允许读取没有现代契约 key 的老任务；现代任务无法证明
 * 与当前安排一致时必须视为缺失，不能猜最近一条。
 */
function selectCoverTaskFacts(
  rows: CoverTaskRow[] | undefined,
  outputVersionId: string | null,
  coverContractHash: string | null,
): { task: BatchWorkspaceTaskView | null; attemptId: string | null } {
  if (!outputVersionId) return { task: null, attemptId: null };
  // 任务 requestKey 是 `cover:<outputVersionId>:<hash>` 全串,过滤也按全串比。
  const coverRequestKey = coverContractHash
    ? buildCoverRenderTaskRequestKey(outputVersionId, coverContractHash)
    : null;
  const row = coverRequestKey
    ? rows?.find(({ requestKey }) => requestKey === coverRequestKey)
    : rows?.find(({ requestKey }) => parseRenderTaskRequestKey(requestKey) === null);
  if (!row) return { task: null, attemptId: null };
  return { task: taskView(row), attemptId: row.succeededAttemptId };
}

/** 老批次的最近一次成功完整渲染尝试(封面回落与 fresh 判断的兼容事实)。 */
function selectLatestFullRenderAttempt(
  latestTask: RenderTaskRow | undefined,
  attemptsByTask: ReadonlyMap<string, SucceededAttemptRow[]>,
): { attemptId: string; requestKey: string | null; resultJson: string | null } | null {
  if (!latestTask) return null;
  const attempts = attemptsByTask.get(latestTask.id);
  if (!attempts || attempts.length === 0) return null;
  let latest = attempts[0];
  for (const attempt of attempts) {
    if (attempt.attemptNumber > latest.attemptNumber) latest = attempt;
  }
  return { attemptId: latest.attemptId, requestKey: latestTask.requestKey, resultJson: latest.resultJson };
}

function firstByTarget<T extends { targetId: string }>(rows: T[]): Map<string, T> {
  const grouped = new Map<string, T>();
  for (const row of rows) {
    if (!grouped.has(row.targetId)) grouped.set(row.targetId, row);
  }
  return grouped;
}

/** 按 targetId 分组并保留 SQL 行序(调用方按「第一条最新」取值)。 */
function groupByTarget<T extends { targetId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.targetId) ?? [];
    list.push(row);
    grouped.set(row.targetId, list);
  }
  return grouped;
}

function deriveCardStatus(input: {
  reviewable: boolean;
  coverStatus: BatchCoverTaskStatus;
  fullRenderTask: BatchWorkspaceTaskView | null;
  narrationTask: BatchWorkspaceNarrationTaskView | null;
  productionReady: boolean;
  blockers: string[];
  approved: boolean;
  formalOutdated: boolean;
  hasFormalArtifact: boolean;
  batchControl: 'running' | 'paused' | 'stopped';
}): { status: BatchOutputCardStatus; nextAction: string } {
  if (input.batchControl === 'stopped') {
    return { status: 'stopped', nextAction: '批次已停止，只能查看' };
  }
  if (input.batchControl === 'paused') {
    return { status: 'paused', nextAction: '继续批次后恢复处理' };
  }
  if (!input.reviewable) {
    return input.blockers.length > 0
      ? { status: 'needs_attention', nextAction: '查看阻塞与分配提醒' }
      : { status: 'waiting', nextAction: '等待联合分配' };
  }
  if (
    input.narrationTask
    && (input.narrationTask.status === 'queued' || input.narrationTask.status === 'running')
    && !input.productionReady
  ) {
    return { status: 'waiting', nextAction: '等待配音完成' };
  }
  if (input.coverStatus === 'queued' || input.coverStatus === 'running') {
    return { status: 'processing', nextAction: '正在生成封面' };
  }
  if (input.coverStatus === 'failed') {
    return { status: 'retryable_failed', nextAction: '封面生成失败，请重试' };
  }
  if (input.fullRenderTask
    && (input.fullRenderTask.status === 'queued' || input.fullRenderTask.status === 'running')) {
    return { status: 'processing', nextAction: '正在渲染完整成片' };
  }
  if (input.narrationTask?.status === 'failed') {
    return { status: 'needs_attention', nextAction: '配音失败，请点「重试配音」' };
  }
  if (input.blockers.length > 0) {
    return { status: 'needs_attention', nextAction: '查看阻塞与分配提醒' };
  }
  if (input.hasFormalArtifact && input.formalOutdated) {
    return { status: 'needs_attention', nextAction: '当前修改尚未导出，请重新导出' };
  }
  if (input.approved) {
    return { status: 'completed', nextAction: '已通过审核，可到导出成片' };
  }
  return { status: 'needs_attention', nextAction: '待审核' };
}

/**
 * 聚合一个批次的稳定工作区视图。编辑器优先模型下,卡片状态由四类独立事实
 * 组合:封面任务、整片渲染任务、当前正式 artifact 与当前版本安排/审核。
 * React 不再把"最后一条任务状态"直接当成成片状态。
 */
export function getBatchWorkspace(
  db: Database.Database,
  projectId: string,
  batchId: string,
): BatchWorkspaceView {
  const batch = db.prepare(`
    SELECT id, name, status, controlState, currentVersionId
    FROM batch_productions
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId) as BatchWorkspaceView['batch'] | undefined;
  if (!batch) throw new BatchDomainError('not_found', '批次不存在');

  if (!batch.currentVersionId) {
    return {
      batch,
      phase: 'prepare_materials',
      exportDirName: getCurrentExportDirName(db, projectId) ?? resolveProjectExportDirName(db, projectId),
      counts: { total: 0, reviewable: 0, approvable: 0, approved: 0, processing: 0, needsAttention: 0, failed: 0 },
      cards: [],
      exclusions: [],
      allocationReport: null,
    };
  }

  const plans = db.prepare(`
    SELECT p.id, p.seq, p.scriptSnapshotId, p.currentVersionId, p.currentArtifactId,
           s.title AS scriptTitle,
           ov.versionNumber, ov.arrangementJson,
           bv.defaultsJson AS defaultsJson
    FROM batch_output_plans p
    JOIN batch_script_snapshots s ON s.id = p.scriptSnapshotId
    LEFT JOIN batch_output_versions ov ON ov.id = p.currentVersionId
    JOIN batch_production_versions bv ON bv.id = p.batchVersionId
    WHERE p.batchVersionId = ?
    ORDER BY p.seq, p.id
  `).all(batch.currentVersionId) as Array<{
    id: string;
    seq: number;
    scriptSnapshotId: string;
    currentVersionId: string | null;
    currentArtifactId: string | null;
    scriptTitle: string;
    versionNumber: number | null;
    arrangementJson: string | null;
    defaultsJson: string;
  }>;

  const allocationReportRow = db.prepare(`
    SELECT r.resultJson
    FROM batch_production_versions v
    LEFT JOIN batch_allocation_runs r ON r.id = v.currentAllocationRunId
    WHERE v.id = ?
  `).get(batch.currentVersionId) as { resultJson: string } | undefined;
  const allocationReport = parseJson(allocationReportRow?.resultJson);
  const exclusions = db.prepare(`
    SELECT assetId, reason FROM batch_asset_exclusions
    WHERE batchVersionId = ? ORDER BY assetId
  `).all(batch.currentVersionId) as Array<{ assetId: string; reason: string }>;
  const poolFacts = loadPoolFacts(db, batch.currentVersionId);

  // 解析后的 arrangement 只解析一次:同源分组、素材指纹、契约预加载共用。
  const parsedPlans = plans.map((plan) => ({ plan, arrangement: parseJson(plan.arrangementJson) }));

  // 素材指纹:池内素材已随 pool facts 取回,只补一次非池素材。
  const referencedAssetIds = [...new Set(parsedPlans.flatMap(({ arrangement }) => referencedAssetIdsOf(arrangement)))];
  const assetFingerprints = new Map(poolFacts.fingerprints);
  const missingFingerprintIds = referencedAssetIds.filter((assetId) => !assetFingerprints.has(assetId));
  if (missingFingerprintIds.length > 0) {
    const placeholders = missingFingerprintIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id, contentFingerprint FROM batch_assets WHERE id IN (${placeholders})
    `).all(...missingFingerprintIds) as Array<{ id: string; contentFingerprint: string }>;
    for (const row of rows) assetFingerprints.set(row.id, row.contentFingerprint);
  }

  // 契约预加载:当前输出版本 + 冻结封面标题配置(批次内一次取回)。
  const outputVersions = new Map<string, CoverContractOutputVersion>();
  for (const { plan } of parsedPlans) {
    if (!plan.currentVersionId || plan.arrangementJson === null) continue;
    outputVersions.set(plan.currentVersionId, {
      outputVersionId: plan.currentVersionId,
      planId: plan.id,
      arrangementJson: plan.arrangementJson,
      batchVersionId: batch.currentVersionId,
      planSeq: plan.seq,
      defaultsJson: plan.defaultsJson,
    });
  }
  const frozenTitleRows: ReadonlyMap<string, FrozenCoverTitleRow> = new Map(
    (db.prepare(`
      SELECT p.id AS planId, s.coverTitleJson AS coverTitleJson,
             s.sourceScriptId AS sourceScriptId, v.defaultsJson AS defaultsJson
      FROM batch_output_plans p
      JOIN batch_script_snapshots s ON s.id = p.scriptSnapshotId
      JOIN batch_production_versions v ON v.id = p.batchVersionId
      WHERE p.batchVersionId = ?
    `).all(batch.currentVersionId) as Array<FrozenCoverTitleRow & { planId: string }>)
      .map(({ planId, ...row }) => [planId, row] as const),
  );

  // 正式产物:按计划分组,保持 createdAt DESC, id DESC 的既有选取顺序。
  const artifactsByPlan = new Map<string, BatchWorkspaceArtifactView[]>();
  {
    const rows = db.prepare(`
      SELECT a.id, a.outputPlanId, a.outputVersionId, a.kind, a.relativePath, a.checksum, a.createdAt
      FROM batch_artifacts a
      JOIN batch_output_plans p ON p.id = a.outputPlanId
      WHERE p.batchVersionId = ?
      ORDER BY a.createdAt DESC, a.id DESC
    `).all(batch.currentVersionId) as Array<BatchWorkspaceArtifactView & { outputPlanId: string }>;
    for (const row of rows) {
      const list = artifactsByPlan.get(row.outputPlanId) ?? [];
      list.push({
        id: row.id,
        outputVersionId: row.outputVersionId,
        kind: row.kind,
        relativePath: row.relativePath,
        checksum: row.checksum,
        createdAt: row.createdAt,
      });
      artifactsByPlan.set(row.outputPlanId, list);
    }
  }

  // 任务:封面、整片、成功尝试、口播各一次批次级查询,行序沿用原文 ORDER BY。
  const coverTaskRows = db.prepare(`
    SELECT t.id, t.targetId, t.requestKey, t.status, t.expectedState, t.attemptCount, t.progressJson,
           a.errorCode, a.errorMessage,
           (SELECT sa.id FROM batch_task_attempts sa
             WHERE sa.taskId = t.id AND sa.status = 'succeeded'
             ORDER BY sa.attemptNumber DESC LIMIT 1) AS succeededAttemptId
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id
      AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version_cover'
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(projectId, batchId) as CoverTaskRow[];
  const coverTasksByTarget = groupByTarget(coverTaskRows);

  const fullRenderTaskRows = db.prepare(`
    SELECT t.id, t.targetId, t.requestKey, t.status, t.expectedState, t.attemptCount, t.progressJson,
           a.errorCode, a.errorMessage
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id
      AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version'
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(projectId, batchId) as RenderTaskRow[];
  const fullRenderTasksByTarget = groupByTarget(fullRenderTaskRows);

  const succeededAttemptRows = db.prepare(`
    SELECT t.id AS taskId, t.targetId AS targetId, t.requestKey AS requestKey,
           a.id AS attemptId, a.attemptNumber AS attemptNumber,
           a.resultJson AS resultJson, a.finishedAt AS finishedAt
    FROM batch_tasks t
    JOIN batch_task_attempts a ON a.taskId = t.id
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND a.status = 'succeeded'
    ORDER BY a.finishedAt DESC, a.id DESC
  `).all(projectId, batchId) as SucceededAttemptRow[];
  const succeededAttemptsByTask = new Map<string, SucceededAttemptRow[]>();
  for (const row of succeededAttemptRows) {
    const list = succeededAttemptsByTask.get(row.taskId) ?? [];
    list.push(row);
    succeededAttemptsByTask.set(row.taskId, list);
  }

  const narrationTaskRows = db.prepare(`
    SELECT t.id, t.targetId, t.status, t.expectedState, a.errorMessage
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'narration'
      AND t.targetKind = 'script_snapshot'
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(projectId, batchId) as NarrationTaskRow[];
  const narrationTasksByTarget = firstByTarget(narrationTaskRows);

  // 同源提醒:按批次把权威原图键算一次,再按卡片过滤。
  const sourceGroupKeys = resolveModule4AssetGroupKeys(
    db,
    [...new Set(parsedPlans.flatMap(({ arrangement }) => clipAssetIdsOf(arrangement)))],
  );

  const coverPreload: CoverContractPreload = {
    outputVersions,
    assetFingerprints,
    poolColors: poolFacts.colors,
    frozenTitleRows,
    coverContractHashes: new Map(),
  };
  const fullRenderContractHashes = new Map<string, string | null>();
  const arrangementJsonByVersion = new Map<string, string>();
  for (const { plan } of parsedPlans) {
    if (plan.currentVersionId && plan.arrangementJson !== null) {
      arrangementJsonByVersion.set(plan.currentVersionId, plan.arrangementJson);
    }
  }
  const formalPreload: FormalArtifactPreload = {
    succeededRenderAttempts: succeededAttemptRows,
    fullRenderContractHashes,
    arrangementJson: arrangementJsonByVersion,
  };

  const cards = parsedPlans.map(({ plan, arrangement }): BatchOutputCardView => {
    const { sourceWarnings, sourceConflictAssetIds, sourceConflictGroups } = batchSourceReview(db, arrangement, sourceGroupKeys);
    const latestAllocationOutput = allocationOutput(allocationReport, plan.id);
    const latestArrangement = latestAllocationOutput && typeof latestAllocationOutput === 'object' && !Array.isArray(latestAllocationOutput)
      ? (latestAllocationOutput as Record<string, unknown>).arrangement
      : null;
    const warnings = [...new Set([
      ...sourceWarnings,
      ...diagnosticMessages(arrangement, 'warnings'),
      ...diagnosticMessages(latestAllocationOutput, 'warnings'),
      ...diagnosticMessages(latestArrangement, 'warnings'),
    ])];
    const blockers = [...new Set([
      ...diagnosticMessages(arrangement, 'blockers'),
      ...diagnosticMessages(latestAllocationOutput, 'blockers'),
      ...diagnosticMessages(latestArrangement, 'blockers'),
    ])];

    const artifactRows = artifactsByPlan.get(plan.id) ?? [];
    const currentVideo = plan.currentArtifactId
      ? artifactRows.find(({ id, kind }) => id === plan.currentArtifactId && kind === 'video') ?? null
      : null;
    const currentCover = currentVideo
      ? artifactRows.find((artifact) => (
          artifact.kind === 'cover'
          && artifact.outputVersionId === currentVideo.outputVersionId
          && batchArtifactPathsArePaired(currentVideo.relativePath, artifact.relativePath)
        )) ?? null
      : null;

    // 封面契约哈希先行计算并缓存;完整渲染契约复用它,不再重复解析。
    let coverContractHash: string | null = null;
    let fullRenderContractHash: string | null = null;
    if (plan.currentVersionId) {
      try {
        coverContractHash = resolveCoverContractHash(db, plan.currentVersionId, undefined, coverPreload);
      } catch {
        coverContractHash = null;
      }
      try {
        fullRenderContractHash = resolveFullRenderContractHash(db, plan.currentVersionId, coverPreload);
      } catch {
        fullRenderContractHash = null;
      }
      fullRenderContractHashes.set(plan.currentVersionId, fullRenderContractHash);
    }
    const fullRenderRequestKey = plan.currentVersionId && fullRenderContractHash
      ? buildFullRenderTaskRequestKey(plan.currentVersionId, fullRenderContractHash)
      : null;
    const fullRenderTask = plan.currentVersionId
      ? selectFullRenderTask(fullRenderTasksByTarget.get(plan.currentVersionId), fullRenderRequestKey)
      : null;
    const latestFullAttempt = plan.currentVersionId
      ? selectLatestFullRenderAttempt(fullRenderTasksByTarget.get(plan.currentVersionId)?.[0], succeededAttemptsByTask)
      : null;
    const coverFacts = selectCoverTaskFacts(
      plan.currentVersionId ? coverTasksByTarget.get(plan.currentVersionId) : undefined,
      plan.currentVersionId,
      coverContractHash,
    );
    // 老批次没有独立封面任务:最近一次成功完整渲染的封面继续可检查、可预览。
    let coverStatus: BatchCoverTaskStatus;
    let coverAttemptId: string | null;
    if (coverFacts.task) {
      coverStatus = coverFacts.task.status === 'cancelled' ? 'failed' : coverFacts.task.status;
      coverAttemptId = coverFacts.attemptId;
    } else if (
      latestFullAttempt
      && (
        coverContractHash !== null
        || parseRenderTaskRequestKey(latestFullAttempt.requestKey) === null
      )
    ) {
      const legacyResult = asRecord(parseJson(latestFullAttempt.resultJson));
      coverStatus = typeof legacyResult?.coverRelativePath === 'string' ? 'succeeded' : 'missing';
      coverAttemptId = coverStatus === 'succeeded' ? latestFullAttempt.attemptId : null;
    } else {
      coverStatus = 'missing';
      coverAttemptId = null;
    }

    const narrationTaskRow = plan.scriptSnapshotId
      ? narrationTasksByTarget.get(plan.scriptSnapshotId)
      : undefined;
    const narrationTask = narrationTaskRow ? {
      id: narrationTaskRow.id,
      status: narrationTaskRow.status,
      expectedState: narrationTaskRow.expectedState,
      errorMessage: narrationTaskRow.errorMessage,
    } : null;

    const latestFullResult = asRecord(parseJson(latestFullAttempt?.resultJson));
    // 老批次兼容:arrangement 尚无真实口播时,成功渲染候选的生产就绪位仍可信。
    const productionReady = arrangementProductionReady(arrangement)
      || (latestFullResult?.productionReady === true);
    const approved = arrangementReviewApproved(arrangement);
    const reviewable = Boolean(
      plan.currentVersionId
      && batch.controlState !== 'stopped',
    );
    const approvable = Boolean(
      plan.currentVersionId
      && productionReady
      && coverStatus === 'succeeded'
      && batch.controlState !== 'stopped',
    );
    const exportEligible = Boolean(
      approvable
      && approved
      && narrationTask?.status !== 'failed',
    );
    const formalOutdated = Boolean(
      currentVideo
      && plan.currentVersionId
      && isFormalArtifactOutdated(
        db,
        projectId,
        batchId,
        plan.currentVersionId,
        { video: currentVideo, cover: currentCover },
        formalPreload,
      ),
    );
    // 正式导出状态由服务端统一判断:前端只消费 exportStatus,不得再从
    // fullRenderTask 自行拼渲染/失败/已导出。
    const exportStatus: BatchCardExportStatus = (currentVideo && !formalOutdated)
      ? 'exported'
      : fullRenderTask?.status === 'failed'
        ? 'failed'
        : (fullRenderTask?.status === 'queued' || fullRenderTask?.status === 'running')
          ? 'rendering'
          : 'not_exported';
    // 配音失败必须显式暴露为 blocker,否则用户只看到渲染一直没动静。
    const effectiveBlockers = narrationTask?.status === 'failed'
      ? [...blockers, `配音失败：${narrationTask.errorMessage || '未知原因'}，请点「重试配音」`]
      : blockers;
    const state = deriveCardStatus({
      reviewable,
      coverStatus,
      fullRenderTask,
      narrationTask,
      productionReady,
      blockers: effectiveBlockers,
      approved,
      formalOutdated,
      hasFormalArtifact: Boolean(currentVideo),
      batchControl: batch.controlState,
    });
    const coverRange = arrangementCoverRange(arrangement, poolFacts.durations);
    return {
      planId: plan.id,
      seq: plan.seq,
      scriptSnapshotId: plan.scriptSnapshotId,
      scriptTitle: plan.scriptTitle,
      versionId: plan.currentVersionId,
      versionNumber: plan.versionNumber,
      status: state.status,
      nextAction: state.nextAction,
      reviewable,
      approvable,
      approved,
      exportEligible,
      formalOutdated,
      exportStatus,
      coverStatus,
      coverAttemptId,
      productionReady,
      subtitleOverride: arrangementHasManualSubtitleOverride(arrangement),
      coverRange,
      warnings,
      sourceWarnings,
      sourceConflictAssetIds,
      sourceConflictGroups,
      blockers: effectiveBlockers,
      currentFormalArtifact: currentVideo
        ? { video: currentVideo, cover: currentCover }
        : null,
      fullRenderTask,
      coverTask: coverFacts.task,
      narrationTask,
    };
  });

  const counts = {
    total: cards.length,
    reviewable: cards.filter(({ reviewable }) => reviewable).length,
    approvable: cards.filter(({ approvable }) => approvable).length,
    approved: cards.filter(({ approved }) => approved).length,
    processing: cards.filter(({ status }) => ['processing', 'waiting', 'paused'].includes(status)).length,
    needsAttention: cards.filter(({ status }) => status === 'needs_attention').length,
    failed: cards.filter(({ status }) => status === 'retryable_failed').length,
  };
  let phase: BatchWorkspacePhase;
  const versionCount = cards.filter(({ versionId }) => Boolean(versionId)).length;
  if (plans.length === 0) phase = 'prepare_scripts';
  else if (versionCount < plans.length) phase = 'allocate';
  else phase = 'review';

  return { batch, phase, exportDirName: getCurrentExportDirName(db, projectId) ?? resolveProjectExportDirName(db, projectId), counts, cards, exclusions, allocationReport };
}
