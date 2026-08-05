import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import type { BatchProductionStatus } from './versions.ts';
import type { BatchTaskExpectedState, BatchTaskStatus } from './tasks.ts';

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

export interface BatchWorkspaceArtifactView {
  id: string;
  outputVersionId: string;
  kind: 'video' | 'cover';
  relativePath: string;
  checksum: string;
  createdAt: string;
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

export interface BatchWorkspaceCandidateView {
  outputVersionId: string;
  audioMode: 'narration' | 'silent_placeholder';
  productionReady: boolean;
  durationUs: number;
  subtitleCueCount: number;
  coverAvailable: boolean;
}

export interface BatchOutputVersionListItem {
  id: string;
  versionNumber: number;
  hasCandidate: boolean;
  hasArtifact: boolean;
}

/** 换封面的可调范围:第一镜头(或显式封面 clip)的原片区间;无法解析时为 null */
export interface BatchCoverRangeView {
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
  /** 该计划全部成片版本(按版本号倒序),供历史版本切换 */
  versions: BatchOutputVersionListItem[];
  status: BatchOutputCardStatus;
  nextAction: string;
  exportable: boolean;
  productionReady: boolean;
  publishable: boolean;
  /** 用户审核状态:当前成片版本 arrangement 的 review.decision === 'approved' */
  approved: boolean;
  coverRange: BatchCoverRangeView | null;
  warnings: string[];
  blockers: string[];
  currentVideo: BatchWorkspaceArtifactView | null;
  currentCover: BatchWorkspaceArtifactView | null;
  history: BatchWorkspaceArtifactView[];
  task: BatchWorkspaceTaskView | null;
  narrationTask: BatchWorkspaceNarrationTaskView | null;
  candidate: BatchWorkspaceCandidateView | null;
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
  counts: {
    total: number;
    exportable: number;
    publishable: number;
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
 * - 只给 assetId(分配器默认写法):取使用该素材的首个时间线 clip 的原片区间
 *   (渲染器对该封面素材用的是整段原片 [0,duration),clip 区间必然落在其中,
 *   后端不会拒绝);封面素材不在时间线内时无法从 arrangement 推导,返回 null;
 * - 无封面设置:取第一镜头的原片区间。
 */
function arrangementCoverRange(value: unknown): BatchCoverRangeView | null {
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
  const coverClipId = cover && (typeof cover.clipId === 'string' ? cover.clipId : typeof cover.segmentId === 'string' ? cover.segmentId : null);
  if (coverClipId) {
    selected = clips.find((clip) => clip.clipId === coverClipId || clip.segmentId === coverClipId) ?? null;
    if (!selected) return null;
  } else if (cover && typeof cover.assetId === 'string') {
    selected = clips.find((clip) => clip.assetId === cover.assetId) ?? null;
    if (!selected) return null; // 封面素材不在时间线内:无法从 arrangement 推导原片时长
  } else {
    selected = clips[0] ?? null;
    if (!selected) return null;
  }
  const startUs = Number(selected.sourceStartUs);
  const endUs = Number(selected.sourceEndUs);
  if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs <= startUs) return null;
  const requested = cover
    ? (typeof cover.timeUs === 'number' ? cover.timeUs
      : typeof cover.frameTimeUs === 'number' ? cover.frameTimeUs
        : typeof cover.sourceTimeUs === 'number' ? cover.sourceTimeUs : null)
    : null;
  const currentUs = typeof requested === 'number' && Number.isFinite(requested) ? requested : startUs;
  return { startUs, endUs, currentUs };
}

function mediaPairKey(relativePath: string): string {
  return relativePath.replace(/\.[^./\\]+$/u, '');
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

function renderCandidate(value: unknown, outputVersionId: string | null): BatchWorkspaceCandidateView | null {
  if (!outputVersionId || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.outputVersionId !== outputVersionId
    || (record.audioMode !== 'narration' && record.audioMode !== 'silent_placeholder')
    || typeof record.productionReady !== 'boolean'
    || record.productionReady !== (record.audioMode === 'narration')
    || !Number.isSafeInteger(record.durationUs)
    || Number(record.durationUs) <= 0
    || typeof record.videoRelativePath !== 'string'
    || typeof record.coverRelativePath !== 'string'
  ) return null;
  return {
    outputVersionId,
    audioMode: record.audioMode,
    productionReady: record.productionReady,
    durationUs: Number(record.durationUs),
    subtitleCueCount: Array.isArray(record.subtitleCues) ? record.subtitleCues.length : 0,
    coverAvailable: true,
  };
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

function deriveCardStatus(input: {
  currentVideo: BatchWorkspaceArtifactView | null;
  hasNewerCandidate: boolean;
  warnings: string[];
  blockers: string[];
  productionReady: boolean;
  task: BatchWorkspaceTaskView | null;
  narrationTask: BatchWorkspaceNarrationTaskView | null;
  batchControl: 'running' | 'paused' | 'stopped';
}): { status: BatchOutputCardStatus; nextAction: string } {
  const hasAttention = input.warnings.length > 0 || input.blockers.length > 0 || !input.productionReady;
  if (input.currentVideo && (hasAttention || input.hasNewerCandidate || input.task?.status === 'failed')) {
    return { status: 'needs_attention', nextAction: '查看原因；旧版仍可播放和导出' };
  }
  if (input.currentVideo) return { status: 'completed', nextAction: '播放、选择导出或查看历史' };
  if (input.batchControl === 'stopped' || input.task?.status === 'cancelled') {
    return { status: 'stopped', nextAction: '查看已停止任务详情' };
  }
  if (input.batchControl === 'paused' || input.task?.expectedState === 'paused') {
    return { status: 'paused', nextAction: '继续批次后恢复处理' };
  }
  // 口播未完成且还没有渲染候选:渲染闸门会挡住 render,这里给出明确等待提示。
  if (
    input.narrationTask
    && (input.narrationTask.status === 'queued' || input.narrationTask.status === 'running')
    && !input.currentVideo
  ) {
    return { status: 'waiting', nextAction: '等待配音完成' };
  }
  if (input.task?.status === 'running') return { status: 'processing', nextAction: '查看真实渲染进度' };
  if (input.task?.status === 'failed') return { status: 'retryable_failed', nextAction: '重试这一条或查看详情' };
  if (hasAttention) return { status: 'needs_attention', nextAction: '查看阻塞与分配提醒' };
  return { status: 'waiting', nextAction: '等待联合分配或渲染调度' };
}

/**
 * 聚合一个批次的稳定工作区视图。卡片状态来自计划、候选版本、任务与正式
 * artifact 的组合事实，React 不再把“最后一条任务状态”直接当成成片状态。
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
      counts: { total: 0, exportable: 0, publishable: 0, approved: 0, processing: 0, needsAttention: 0, failed: 0 },
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

  const cards = plans.map((plan): BatchOutputCardView => {
    const arrangement = parseJson(plan.arrangementJson);
    const versionRows = db.prepare(`
      SELECT o.id, o.versionNumber,
        EXISTS(
          SELECT 1 FROM batch_tasks t
          WHERE t.targetKind = 'output_version' AND t.targetId = o.id
            AND t.workType = 'render'
            AND EXISTS(
              SELECT 1 FROM batch_task_attempts a
              WHERE a.taskId = t.id AND a.status = 'succeeded'
            )
        ) AS hasCandidate,
        EXISTS(
          SELECT 1 FROM batch_artifacts a WHERE a.outputVersionId = o.id
        ) AS hasArtifact
      FROM batch_output_versions o
      WHERE o.planId = ?
      ORDER BY o.versionNumber DESC
    `).all(plan.id) as Array<{
      id: string;
      versionNumber: number;
      hasCandidate: number;
      hasArtifact: number;
    }>;
    const versions: BatchOutputVersionListItem[] = versionRows.map(({ id, versionNumber, hasCandidate, hasArtifact }) => ({
      id,
      versionNumber,
      hasCandidate: hasCandidate === 1,
      hasArtifact: hasArtifact === 1,
    }));
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
          && mediaPairKey(artifact.relativePath) === mediaPairKey(currentVideo.relativePath)
        )) ?? null
      : null;
    const taskRow = plan.currentVersionId ? db.prepare(`
      SELECT t.id, t.status, t.expectedState, t.attemptCount, t.progressJson,
             a.errorCode, a.errorMessage
      FROM batch_tasks t
      LEFT JOIN batch_task_attempts a ON a.taskId = t.id
        AND a.attemptNumber = t.attemptCount
      WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
        AND t.targetKind = 'output_version' AND t.targetId = ?
      ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
    `).get(projectId, batchId, plan.currentVersionId) as {
      id: string;
      status: BatchTaskStatus;
      expectedState: BatchTaskExpectedState;
      attemptCount: number;
      progressJson: string;
      errorCode: string | null;
      errorMessage: string | null;
    } | undefined : undefined;
    const task = taskRow ? {
      id: taskRow.id,
      status: taskRow.status,
      expectedState: taskRow.expectedState,
      attemptCount: taskRow.attemptCount,
      progress: parseJson(taskRow.progressJson),
      errorCode: taskRow.errorCode,
      errorMessage: taskRow.errorMessage,
    } : null;
    // 候选一律取"该任务最近一次成功的尝试",不看任务当前状态:
    // 重渲染(queued/running/failed)期间与之后,老版本仍然可播放。
    const candidateRow = plan.currentVersionId ? db.prepare(`
      SELECT a.resultJson
      FROM batch_tasks t
      JOIN batch_task_attempts a ON a.id = (
        SELECT id FROM batch_task_attempts
        WHERE taskId = t.id AND status = 'succeeded'
        ORDER BY attemptNumber DESC LIMIT 1
      )
      WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
        AND t.targetKind = 'output_version' AND t.targetId = ?
      ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
    `).get(projectId, batchId, plan.currentVersionId) as {
      resultJson: string | null;
    } | undefined : undefined;
    const candidate = candidateRow
      ? renderCandidate(parseJson(candidateRow.resultJson), plan.currentVersionId)
      : null;
    // 口播任务(渲染闸门的配套信息):失败时给用户「重试配音」入口,否则
    // 渲染被闸门挡住会变成看不到原因的静默等待。
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
    const candidateProductionReady = candidate?.productionReady === true;
    const productionReady = arrangementProductionReady(arrangement) || candidateProductionReady;
    const hasNewerCandidate = Boolean(
      currentVideo && plan.currentVersionId && currentVideo.outputVersionId !== plan.currentVersionId,
    );
    // 配音失败必须显式暴露为 blocker,否则用户只看到渲染一直没动静。
    const effectiveBlockers = narrationTask?.status === 'failed'
      ? [...blockers, `配音失败：${narrationTask.errorMessage || '未知原因'}，请点「重试配音」`]
      : blockers;
    const state = deriveCardStatus({
      currentVideo,
      hasNewerCandidate,
      warnings,
      blockers: effectiveBlockers,
      productionReady,
      task,
      narrationTask,
      batchControl: batch.controlState,
    });
    // 审核态与换封面范围都来自当前版本 arrangement(就地 JSON 升级,零迁移);
    // reallocate 生成的新版本没有 review 字段,天然回到未审核态。
    const approved = arrangementReviewApproved(arrangement);
    const coverRange = arrangementCoverRange(arrangement);
    return {
      planId: plan.id,
      seq: plan.seq,
      scriptSnapshotId: plan.scriptSnapshotId,
      scriptTitle: plan.scriptTitle,
      versionId: plan.currentVersionId,
      versionNumber: plan.versionNumber,
      versions,
      status: state.status,
      nextAction: state.nextAction,
      exportable: Boolean(currentVideo),
      productionReady,
      publishable: candidateProductionReady,
      approved,
      coverRange,
      warnings,
      blockers: effectiveBlockers,
      currentVideo,
      currentCover,
      history: artifactRows,
      task,
      narrationTask,
      candidate,
    };
  });

  const counts = {
    total: cards.length,
    exportable: cards.filter(({ exportable }) => exportable).length,
    publishable: cards.filter(({ publishable }) => publishable).length,
    approved: cards.filter(({ approved }) => approved).length,
    processing: cards.filter(({ status }) => ['processing', 'waiting', 'paused'].includes(status)).length,
    needsAttention: cards.filter(({ status }) => status === 'needs_attention').length,
    failed: cards.filter(({ status }) => status === 'retryable_failed').length,
  };
  let phase: BatchWorkspacePhase;
  const versionCount = cards.filter(({ versionId }) => Boolean(versionId)).length;
  if (plans.length === 0) phase = 'prepare_scripts';
  else if (versionCount < plans.length) phase = 'allocate';
  else if (counts.processing > 0) phase = 'export';
  else phase = 'review';

  return { batch, phase, counts, cards, exclusions, allocationReport };
}
