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
  warnings: string[];
  blockers: string[];
  currentVideo: BatchWorkspaceArtifactView | null;
  currentCover: BatchWorkspaceArtifactView | null;
  history: BatchWorkspaceArtifactView[];
  task: BatchWorkspaceTaskView | null;
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
      counts: { total: 0, exportable: 0, publishable: 0, processing: 0, needsAttention: 0, failed: 0 },
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
            AND t.workType = 'render' AND t.status = 'succeeded'
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
             a.errorCode, a.errorMessage, a.resultJson
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
      resultJson: string | null;
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
    const candidate = taskRow?.status === 'succeeded'
      ? renderCandidate(parseJson(taskRow.resultJson), plan.currentVersionId)
      : null;
    const candidateProductionReady = candidate?.productionReady === true;
    const productionReady = arrangementProductionReady(arrangement) || candidateProductionReady;
    const hasNewerCandidate = Boolean(
      currentVideo && plan.currentVersionId && currentVideo.outputVersionId !== plan.currentVersionId,
    );
    const state = deriveCardStatus({
      currentVideo,
      hasNewerCandidate,
      warnings,
      blockers,
      productionReady,
      task,
      batchControl: batch.controlState,
    });
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
      warnings,
      blockers,
      currentVideo,
      currentCover,
      history: artifactRows,
      task,
      candidate,
    };
  });

  const counts = {
    total: cards.length,
    exportable: cards.filter(({ exportable }) => exportable).length,
    publishable: cards.filter(({ publishable }) => publishable).length,
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
