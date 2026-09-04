import type Database from 'better-sqlite3';
import { batchArtifactPathsArePaired } from './artifact-pair.ts';
import { resolveProjectExportDirName } from '../project-export-dir.ts';
import { getCurrentExportDirName } from '../project-export-identity.ts';
import { isFormalArtifactOutdated } from './formal-artifact-freshness.ts';
import { resolveCoverContractHash, resolveFullRenderContractHash } from './cover-contract.ts';
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

function loadPoolAssetDurations(db: Database.Database, batchVersionId: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT pool.assetId,
      CASE WHEN json_valid(analysis.analysisJson) THEN json_extract(analysis.analysisJson, '$.durationUs') END AS analysisDurationUs,
      CASE WHEN json_valid(assets.mediaJson) THEN json_extract(assets.mediaJson, '$.durationUs') END AS mediaDurationUs,
      CASE WHEN json_valid(assets.mediaJson) THEN json_extract(assets.mediaJson, '$.durationSec') END AS mediaDurationSec
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    WHERE pool.batchVersionId = ?
  `).all(batchVersionId) as Array<{
    assetId: string;
    analysisDurationUs: number | null;
    mediaDurationUs: number | null;
    mediaDurationSec: number | null;
  }>;
  const durations = new Map<string, number>();
  for (const row of rows) {
    const durationUs = poolAssetDurationUs(row);
    if (durationUs !== null) durations.set(row.assetId, durationUs);
  }
  return durations;
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

/** 完整渲染任务的状态视图(用于导出页进度与失败提示)。 */
function readFullRenderTaskView(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
  requestKey: string | null,
): BatchWorkspaceTaskView | null {
  if (!requestKey) return null;
  const row = db.prepare(`
    SELECT t.id, t.status, t.expectedState, t.attemptCount, t.progressJson,
           a.errorCode, a.errorMessage
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id
      AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND t.targetId = ?
      AND t.requestKey = ?
    ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
  `).get(projectId, batchId, outputVersionId, requestKey) as {
    id: string;
    status: BatchTaskStatus;
    expectedState: BatchTaskExpectedState;
    attemptCount: number;
    progressJson: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  } | undefined;
  if (!row) return null;
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

/**
 * 封面任务状态与最近成功尝试 ID(编辑器优先模型下封面的唯一事实来源)。
 * 必须按**当前**封面契约哈希选任务:封面 A→B→A 时复用旧 A 任务,
 * 不能把较新的 B 任务(或它的失败状态)当成 A 的事实展示。
 * 契约无法解析时只允许读取没有现代契约 key 的老任务；现代任务无法证明
 * 与当前安排一致时必须视为缺失，不能猜最近一条。
 */
function readCoverTaskFacts(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string | null,
  coverContractHash: string | null,
): { task: BatchWorkspaceTaskView | null; attemptId: string | null } {
  if (!outputVersionId) return { task: null, attemptId: null };
  // 任务 requestKey 是 `cover:<outputVersionId>:<hash>` 全串,过滤也按全串比。
  const coverRequestKey = coverContractHash
    ? buildCoverRenderTaskRequestKey(outputVersionId, coverContractHash)
    : null;
  const rows = db.prepare(`
    SELECT t.id, t.requestKey, t.status, t.expectedState, t.attemptCount, t.progressJson,
           a.errorCode, a.errorMessage,
           (SELECT sa.id FROM batch_task_attempts sa
             WHERE sa.taskId = t.id AND sa.status = 'succeeded'
             ORDER BY sa.attemptNumber DESC LIMIT 1) AS succeededAttemptId
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id
      AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version_cover' AND t.targetId = ?
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(projectId, batchId, outputVersionId) as Array<{
    id: string;
    requestKey: string | null;
    status: BatchTaskStatus;
    expectedState: BatchTaskExpectedState;
    attemptCount: number;
    progressJson: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    succeededAttemptId: string | null;
  }>;
  const row = coverRequestKey
    ? rows.find(({ requestKey }) => requestKey === coverRequestKey)
    : rows.find(({ requestKey }) => parseRenderTaskRequestKey(requestKey) === null);
  if (!row) return { task: null, attemptId: null };
  return {
    task: {
      id: row.id,
      status: row.status,
      expectedState: row.expectedState,
      attemptCount: row.attemptCount,
      progress: parseJson(row.progressJson),
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    },
    attemptId: row.succeededAttemptId,
  };
}

/** 老批次的最近一次成功完整渲染尝试(封面回落与 fresh 判断的兼容事实)。 */
function readLatestFullRenderAttempt(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
): { attemptId: string; requestKey: string | null; resultJson: string | null } | null {
  const row = db.prepare(`
    SELECT t.requestKey AS requestKey, a.id AS attemptId, a.resultJson AS resultJson
    FROM batch_tasks t
    JOIN batch_task_attempts a ON a.id = (
      SELECT id FROM batch_task_attempts
      WHERE taskId = t.id AND status = 'succeeded'
      ORDER BY attemptNumber DESC LIMIT 1
    )
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND t.targetId = ?
    ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
  `).get(projectId, batchId, outputVersionId) as {
    attemptId: string;
    requestKey: string | null;
    resultJson: string | null;
  } | undefined;
  return row ?? null;
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
           ov.versionNumber, ov.arrangementJson
    FROM batch_output_plans p
    JOIN batch_script_snapshots s ON s.id = p.scriptSnapshotId
    LEFT JOIN batch_output_versions ov ON ov.id = p.currentVersionId
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
  const poolAssetDurations = loadPoolAssetDurations(db, batch.currentVersionId);

  const cards = plans.map((plan): BatchOutputCardView => {
    const arrangement = parseJson(plan.arrangementJson);
    const latestAllocationOutput = allocationOutput(allocationReport, plan.id);
    const latestArrangement = latestAllocationOutput && typeof latestAllocationOutput === 'object' && !Array.isArray(latestAllocationOutput)
      ? (latestAllocationOutput as Record<string, unknown>).arrangement
      : null;
    const warnings = [...new Set([
      ...diagnosticMessages(arrangement, 'warnings'),
      ...diagnosticMessages(latestAllocationOutput, 'warnings'),
      ...diagnosticMessages(latestArrangement, 'warnings'),
    ])];
    const blockers = [...new Set([
      ...diagnosticMessages(arrangement, 'blockers'),
      ...diagnosticMessages(latestAllocationOutput, 'blockers'),
      ...diagnosticMessages(latestArrangement, 'blockers'),
    ])];

    const artifactRows = db.prepare(`
      SELECT id, outputVersionId, kind, relativePath, checksum, createdAt
      FROM batch_artifacts WHERE outputPlanId = ? ORDER BY createdAt DESC, id DESC
    `).all(plan.id) as BatchWorkspaceArtifactView[];
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

    let fullRenderRequestKey: string | null = null;
    if (plan.currentVersionId) {
      try {
        fullRenderRequestKey = buildFullRenderTaskRequestKey(
          plan.currentVersionId,
          resolveFullRenderContractHash(db, plan.currentVersionId),
        );
      } catch {
        fullRenderRequestKey = null;
      }
    }
    const fullRenderTask = plan.currentVersionId
      ? readFullRenderTaskView(db, projectId, batchId, plan.currentVersionId, fullRenderRequestKey)
      : null;
    const latestFullAttempt = plan.currentVersionId
      ? readLatestFullRenderAttempt(db, projectId, batchId, plan.currentVersionId)
      : null;
    // 当前封面契约哈希:封面任务与封面事实都必须按它选(封面 A→B→A)。
    // 契约无法解析时 fail closed；只有不带现代契约 key 的老任务允许兼容回退。
    let coverContractHash: string | null = null;
    if (plan.currentVersionId) {
      try {
        coverContractHash = resolveCoverContractHash(db, plan.currentVersionId);
      } catch {
        coverContractHash = null;
      }
    }
    const coverFacts = readCoverTaskFacts(db, projectId, batchId, plan.currentVersionId, coverContractHash);
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

    const narrationTaskRow = plan.scriptSnapshotId ? db.prepare(`
      SELECT t.id, t.status, t.expectedState, a.errorMessage
      FROM batch_tasks t
      LEFT JOIN batch_task_attempts a ON a.taskId = t.id AND a.attemptNumber = t.attemptCount
      WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'narration'
        AND t.targetKind = 'script_snapshot' AND t.targetId = ?
      ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
    `).get(projectId, batchId, plan.scriptSnapshotId) as {
      id: string;
      status: BatchTaskStatus;
      expectedState: BatchTaskExpectedState;
      errorMessage: string | null;
    } | undefined : undefined;
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
    const coverRange = arrangementCoverRange(arrangement, poolAssetDurations);
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
