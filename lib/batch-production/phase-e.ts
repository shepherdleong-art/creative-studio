import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { resolveProjectExportDirName } from '../project-export-dir.ts';
import {
  createExportIdentity,
  getOrCreateCurrentExportIdentity,
  hasExportIdentity,
  type ExportIdentityView,
} from '../project-export-identity.ts';
import { readProductionIdentityFields, deriveProjectNamingDate } from '../project-production-identity.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../media-core/storage-path.ts';
// 命名合约与单条模式共用同一处纯函数,避免两边各写一份后慢慢漂移。
import { formatShanghaiTaskDate } from '../media-core/export-identity.ts';
import {
  clearBatchAssetExclusion,
  persistBatchAllocation,
  persistOutputReallocation,
  setBatchAssetExclusion,
  type PersistedAllocationRun,
} from './allocation-store.ts';
import {
  publishBatchExportTarget,
  releaseBatchExportReservation,
  reserveBatchExportTarget,
  type BatchExportRenderContract,
} from './batch-export.ts';
import { readFrozenBatchExportIdentity, startBatchProduction } from './batch-flow.ts';
import { freezeBatchMusicPool, readBatchBgmPool } from './bgm.ts';
import { BatchDomainError } from './errors.ts';
import { checkFormalExportPreflight } from './export-preflight.ts';
import { registerArtifact } from './artifacts.ts';
import { batchArtifactPathsArePaired } from './artifact-pair.ts';
import { createBatchTask } from './tasks.ts';
import { resolveCoverContractHash, resolveFullRenderContractHash } from './cover-contract.ts';
import {
  buildCoverRenderTaskRequestKey,
  parseRenderTaskRequestKey,
} from './render-task-key.ts';

/** 封面任务的幂等身份：使用统一定义的 coverContractHash */
export function coverTaskRequestKey(db: Database.Database, outputVersionId: string): string {
  const hash = resolveCoverContractHash(db, outputVersionId);
  return buildCoverRenderTaskRequestKey(outputVersionId, hash);
}

/** 为当前候选版本排一条独立封面任务。 */
function scheduleCoverForCurrentOutputVersion(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  now?: () => Date,
): string | null {
  const plan = db.prepare(`
    SELECT p.currentVersionId AS outputVersionId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as { outputVersionId: string | null } | undefined;
  if (!plan?.outputVersionId) return null;
  return createBatchTask(db, projectId, {
    batchId,
    workType: 'render',
    targetKind: 'output_version_cover',
    targetId: plan.outputVersionId,
    requestKey: coverTaskRequestKey(db, plan.outputVersionId),
    now,
  });
}

/**
 * 换封面之后排一次独立封面任务。requestKey 含 coverContractHash，
 * 所以相同封面契约重复触发是幂等的。
 */
export function scheduleRenderAfterCoverChange(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  now?: () => Date,
): string | null {
  return scheduleCoverForCurrentOutputVersion(db, projectId, batchId, planId, now);
}

export interface BatchAllocationSchedulingResult {
  status: 'running';
  batchId: string;
  batchVersionId: string;
  allocationRunId: string;
  allocationCreated: boolean;
  allocationStatus: PersistedAllocationRun['result']['status'];
  outputVersionIds: Record<string, string>;
  taskIds: Record<string, string>;
}

export interface BatchNarrationPendingResult {
  status: 'narration_pending';
  batchId: string;
  batchVersionId: string;
  narrationPending: number;
}

export type BatchPhaseEStartResult = BatchNarrationPendingResult | BatchAllocationSchedulingResult;

interface BatchLineageRow {
  currentVersionId: string | null;
  inputState: 'draft' | 'frozen' | null;
  controlState: 'running' | 'paused' | 'stopped';
}

function getBatchLineage(
  db: Database.Database,
  projectId: string,
  batchId: string,
): BatchLineageRow {
  const row = db.prepare(`
    SELECT b.currentVersionId, b.controlState, v.inputState
    FROM batch_productions b
    LEFT JOIN batch_production_versions v ON v.id = b.currentVersionId
    WHERE b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(batchId, projectId) as BatchLineageRow | undefined;
  if (!row) throw new BatchDomainError('not_found', '批次不存在');
  if (!row.currentVersionId || !row.inputState) {
    throw new BatchDomainError('conflict', '批次还没有任何输入快照,不能启动');
  }
  return row;
}

/** 该批次版本仍未完成(queued/running)的口播任务数。 */
function countIncompleteBatchNarrationTasks(db: Database.Database, batchVersionId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_tasks t
    JOIN batch_script_snapshots s ON s.id = t.targetId
    WHERE t.workType = 'narration' AND t.targetKind = 'script_snapshot'
      AND s.batchVersionId = ?
      AND t.status IN ('queued', 'running')
  `).get(batchVersionId) as { n: number };
  return row.n;
}

/** 冻结后为版本内每份脚本快照建一条口播任务(同脚本 N 条成片共用一条)。 */
function scheduleNarrationTasks(
  db: Database.Database,
  projectId: string,
  batchId: string,
  batchVersionId: string,
  now?: () => Date,
): Record<string, string> {
  const snapshotIds = db.prepare(`
    SELECT id FROM batch_script_snapshots WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(batchVersionId) as Array<{ id: string }>;
  const taskIds: Record<string, string> = {};
  for (const { id: snapshotId } of snapshotIds) {
    taskIds[`narration:${snapshotId}`] = createBatchTask(db, projectId, {
      batchId,
      workType: 'narration',
      targetKind: 'script_snapshot',
      targetId: snapshotId,
      requestKey: `narration:${batchVersionId}:${snapshotId}`,
      now,
    });
  }
  return taskIds;
}

function scheduleAllocationRenderTasks(
  db: Database.Database,
  projectId: string,
  batchId: string,
  allocation: PersistedAllocationRun,
  now?: () => Date,
): Record<string, string> {
  // 候选指针切换后，旧版本尚未完成的封面/整片渲染任务不再有提交资格。排队/失败
  // 任务立即取消；运行任务标为 stopped，由 runner 心跳中止并清理迟到结果。
  db.prepare(`
    UPDATE batch_tasks
    SET status = CASE WHEN status IN ('queued', 'failed') THEN 'cancelled' ELSE status END,
        expectedState = 'stopped', updatedAt = ?
    WHERE projectId = ? AND batchId = ? AND workType = 'render'
      AND targetKind IN ('output_version', 'output_version_cover')
      AND status IN ('queued', 'running', 'failed')
      AND targetId IN (
        SELECT o.id FROM batch_output_versions o
        JOIN batch_output_plans p ON p.id = o.planId
        WHERE p.batchVersionId = ?
          AND (p.currentVersionId IS NULL OR p.currentVersionId <> o.id)
      )
  `).run((now ?? (() => new Date()))().toISOString(), projectId, batchId, allocation.batchVersionId);
  for (const output of allocation.result.outputs.filter(({ status }) => status === 'blocked')) {
    db.prepare(`
      UPDATE batch_tasks
      SET status = CASE WHEN status IN ('queued', 'failed') THEN 'cancelled' ELSE status END,
          expectedState = 'stopped', updatedAt = ?
      WHERE projectId = ? AND batchId = ? AND workType = 'render'
        AND targetKind IN ('output_version', 'output_version_cover') AND status IN ('queued', 'running', 'failed')
        AND targetId IN (SELECT id FROM batch_output_versions WHERE planId = ?)
    `).run((now ?? (() => new Date()))().toISOString(), projectId, batchId, output.planId);
  }
  const taskIds: Record<string, string> = {};
  // 口播任务已在冻结后建立(先于分配)。编辑器优先模型下这里只建封面任务,
  // 整片 mp4 推迟到导出阶段按完整渲染契约排任务。
  for (const [planId, outputVersionId] of Object.entries(allocation.outputVersionIds)) {
    taskIds[planId] = createBatchTask(db, projectId, {
      batchId,
      workType: 'render',
      targetKind: 'output_version_cover',
      targetId: outputVersionId,
      requestKey: coverTaskRequestKey(db, outputVersionId),
      now,
    });
  }
  return taskIds;
}

/**
 * Freeze a draft batch (or resume a previously frozen start request), then run
 * the production pipeline in order: 口播 → 分配 → 封面。
 *
 * After the freeze point only narration tasks are enqueued; the batch-wide
 * allocation and cover tasks are deferred until every narration task of this
 * version has reached a terminal state. An unfinished narration returns
 * `narration_pending` (same resume mechanism as semantic scoring: PUT /start
 * is idempotent and re-entered by the frontend once tasks settle). Failed
 * narrations still proceed to allocation so silent preview candidates can be
 * checked; formal publishing stays behind `assertNarrationPublishable`.
 *
 * 编辑器优先模型:生产阶段只出封面,不渲染整片 mp4;完整视频渲染由导出
 * 阶段按完整渲染契约按需触发。
 *
 * BGM is a required output component: the shared library is snapshotted into
 * the frozen version at lock time, so later library changes never mutate an
 * already-locked batch. An empty library blocks start with a readable reason.
 */
export function startOrResumePhaseE(
  db: Database.Database,
  projectId: string,
  batchId: string,
  now?: () => Date,
): BatchPhaseEStartResult {
  let lineage = getBatchLineage(db, projectId, batchId);
  if (lineage.controlState === 'stopped') {
    throw new BatchDomainError('conflict', '批次已停止,不能再次启动生产');
  }
  if (lineage.inputState === 'draft') {
    // Phase B keeps its conservative default, while Phase E freezes the
    // selected pool and lets the allocator exclude offline/archived entries
    // per plan instead of rejecting every sibling before allocation.
    startBatchProduction(db, projectId, batchId, now, { allowUnavailableAssets: true });
    lineage = getBatchLineage(db, projectId, batchId);
  }
  const batchVersionId = lineage.currentVersionId!;
  // 曲库在锁定时快照进冻结版本;同一批次版本的重跑/重分配复用同一份池。
  const musicPool = readBatchBgmPool(db);
  if (musicPool.length === 0) {
    throw new BatchDomainError('conflict', '曲库为空：请先把背景音乐放入 storage/bgm/ 目录并重新扫描后再开始批量生产');
  }
  freezeBatchMusicPool(db, batchVersionId, musicPool);
  // 口播先于分配:冻结后只建口播任务,不再立即调 persistBatchAllocation。
  scheduleNarrationTasks(db, projectId, batchId, batchVersionId, now);
  const narrationPending = countIncompleteBatchNarrationTasks(db, batchVersionId);
  if (narrationPending > 0) {
    return {
      status: 'narration_pending',
      batchId,
      batchVersionId,
      narrationPending,
    };
  }
  const allocation = persistBatchAllocation(db, projectId, batchVersionId, { now });
  const taskIds = db.transaction(() => scheduleAllocationRenderTasks(
    db,
    projectId,
    batchId,
    allocation,
    now,
  ))();
  return {
    status: 'running',
    batchId,
    batchVersionId,
    allocationRunId: allocation.runId,
    allocationCreated: allocation.created,
    allocationStatus: allocation.result.status,
    outputVersionIds: allocation.outputVersionIds,
    taskIds,
  };
}

/** Reallocate one plan only and enqueue a render only when it gained a new version. */
export function reallocateAndScheduleOutput(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  reason = 'manual',
  now?: () => Date,
): BatchAllocationSchedulingResult {
  const lineage = getBatchLineage(db, projectId, batchId);
  if (lineage.inputState !== 'frozen') {
    throw new BatchDomainError('conflict', '批次尚未启动,不能重新分配成片');
  }
  if (lineage.controlState === 'stopped') {
    throw new BatchDomainError('conflict', '批次已停止,不能重新分配成片');
  }
  const batchVersionId = lineage.currentVersionId!;
  const allocation = persistOutputReallocation(
    db,
    projectId,
    batchVersionId,
    planId,
    reason,
    { now },
  );
  const taskIds = db.transaction(() => scheduleAllocationRenderTasks(
    db,
    projectId,
    batchId,
    allocation,
    now,
  ))();
  return {
    status: 'running' as const,
    batchId,
    batchVersionId,
    allocationRunId: allocation.runId,
    allocationCreated: allocation.created,
    allocationStatus: allocation.result.status,
    outputVersionIds: allocation.outputVersionIds,
    taskIds,
  };
}

/**
 * Update one frozen-version exclusion and immediately recompute the whole
 * batch. Existing formal artifacts remain selected until a new candidate is
 * explicitly published.
 */
export function updateBatchAssetExclusionAndSchedule(
  db: Database.Database,
  projectId: string,
  batchId: string,
  assetId: string,
  excluded: boolean,
  reason = '用户从冻结素材池手工排除',
  now?: () => Date,
): BatchAllocationSchedulingResult {
  const lineage = getBatchLineage(db, projectId, batchId);
  if (lineage.inputState !== 'frozen') {
    throw new BatchDomainError('conflict', '批次尚未冻结,不能设置联合分配排除');
  }
  if (lineage.controlState === 'stopped') {
    throw new BatchDomainError('conflict', '批次已停止,不能更改联合分配排除');
  }
  const batchVersionId = lineage.currentVersionId!;
  const allocation = db.transaction(() => {
    if (excluded) setBatchAssetExclusion(db, projectId, batchVersionId, assetId, reason, now);
    else clearBatchAssetExclusion(db, projectId, batchVersionId, assetId);
    return persistBatchAllocation(db, projectId, batchVersionId, {
      now,
      restoreExistingRunPointers: true,
    });
  })();
  const taskIds = db.transaction(() => scheduleAllocationRenderTasks(
    db,
    projectId,
    batchId,
    allocation,
    now,
  ))();
  return {
    status: 'running' as const,
    batchId,
    batchVersionId,
    allocationRunId: allocation.runId,
    allocationCreated: allocation.created,
    allocationStatus: allocation.result.status,
    outputVersionIds: allocation.outputVersionIds,
    taskIds,
  };
}

interface RenderAttemptResult extends BatchExportRenderContract {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
  planSeq: number;
  outputVersionNumber: number;
  videoRelativePath: string;
  coverRelativePath: string;
  videoChecksum: string;
  coverChecksum: string;
}

function readArrangementEditRevision(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return -1;
  const raw = (value as Record<string, unknown>).editRevision;
  if (raw === undefined) return 0;
  return Number.isSafeInteger(raw) && Number(raw) >= 0 ? Number(raw) : -1;
}

function readArrangementCoverTimeUs(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return -1;
  const cover = (value as Record<string, unknown>).cover;
  if (!cover || typeof cover !== 'object' || Array.isArray(cover)) return -1;
  const raw = (cover as Record<string, unknown>).timeUs;
  if (raw == null) return -1;
  return Number.isSafeInteger(raw) && Number(raw) >= 0 ? Number(raw) : -2;
}

/**
 * 发布前/最终事务里的渲染契约 CAS:requestKey 携带契约哈希时,必须与当前
 * 成片版本的完整渲染契约一致;旧任务(无契约哈希)不做该检查,保持兼容。
 */
function assertRenderContractCurrent(
  db: Database.Database,
  requestKey: string | null,
  outputVersionId: string,
): void {
  const parsed = parseRenderTaskRequestKey(requestKey);
  if (!parsed) return;
  if (
    parsed.kind !== 'full'
    || parsed.outputVersionId !== outputVersionId
    || parsed.contractHash !== resolveFullRenderContractHash(db, outputVersionId)
  ) {
    throw new BatchDomainError('conflict', '渲染期间成片内容已变化,旧结果不能成为正式成片,请重新导出');
  }
}

/**
 * 安排状态 CAS:重新核对修订号、封面时间点与审核结论。发布前先跑一遍,
 * 复制文件完成、替换当前指针前的最终事务里**必须再跑一遍**——复制期间
 * 用户仍可能编辑或撤销审核,撤销审核不递增 editRevision,只比对修订号
 * 拦不住它。
 */
function assertArrangementStateMatchesRender(
  db: Database.Database,
  outputVersionId: string,
  render: RenderAttemptResult,
): void {
  const row = db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = ?`).get(outputVersionId) as {
    arrangementJson: string | null;
  } | undefined;
  if (!row?.arrangementJson) throw new BatchDomainError('conflict', '成片安排已不可读,请重新导出');
  let arrangement: unknown;
  try {
    arrangement = JSON.parse(row.arrangementJson) as unknown;
  } catch {
    throw new BatchDomainError('conflict', '成片安排已损坏,请重新导出');
  }
  const currentEditRevision = readArrangementEditRevision(arrangement);
  const renderEditRevision = render.editRevision ?? 0;
  if (currentEditRevision < 0 || renderEditRevision !== currentEditRevision) {
    throw new BatchDomainError('conflict', '成片已被调整过，请等待重新渲染完成后再导出');
  }
  const currentCoverTimeUs = readArrangementCoverTimeUs(arrangement);
  if (render.coverTimeUs !== undefined && render.coverTimeUs !== currentCoverTimeUs) {
    throw new BatchDomainError('conflict', '封面已更换，请等待重新渲染完成后再导出');
  }
  const review = arrangement && typeof arrangement === 'object' && !Array.isArray(arrangement)
    ? (arrangement as Record<string, unknown>).review
    : undefined;
  const decision = review && typeof review === 'object' && !Array.isArray(review)
    ? (review as Record<string, unknown>).decision
    : undefined;
  if (decision !== 'approved') {
    throw new BatchDomainError('conflict', '该成片尚未审核通过,请先在检查页标记「通过」后再导出');
  }
}

function parseRenderResult(raw: string | null): RenderAttemptResult | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RenderAttemptResult>;
    if (
      typeof value.projectId !== 'string'
      || typeof value.batchId !== 'string'
      || typeof value.batchVersionId !== 'string'
      || typeof value.planId !== 'string'
      || typeof value.outputVersionId !== 'string'
      || !Number.isInteger(value.planSeq)
      || !Number.isInteger(value.outputVersionNumber)
      || typeof value.videoRelativePath !== 'string'
      || typeof value.coverRelativePath !== 'string'
      || typeof value.videoChecksum !== 'string'
      || typeof value.coverChecksum !== 'string'
      || (value.audioMode !== 'narration' && value.audioMode !== 'silent_placeholder')
      || typeof value.productionReady !== 'boolean'
      || (value.editRevision !== undefined
        && (!Number.isSafeInteger(value.editRevision) || Number(value.editRevision) < 0))
      || (value.coverTimeUs !== undefined
        && (!Number.isSafeInteger(value.coverTimeUs) || Number(value.coverTimeUs) < -1))
    ) return null;
    return value as RenderAttemptResult;
  } catch {
    return null;
  }
}

export interface BatchPublishItemResult {
  planId: string;
  status: 'published' | 'skipped' | 'already_published';
  reason?: string;
  videoArtifactId?: string;
  coverArtifactId?: string;
  videoRelativePath?: string;
  coverRelativePath?: string;
}

export interface BatchPublishSelectionResult {
  batchId: string;
  published: number;
  skipped: number;
  items: BatchPublishItemResult[];
}

async function unlinkPublishedPair(storageRoot: string, videoRelativePath: string, coverRelativePath: string): Promise<void> {
  const safeUnlink = async (relativePath: string): Promise<void> => {
    assertNoStorageSymlink(storageRoot, relativePath);
    await fs.unlink(resolveStoragePath(storageRoot, relativePath));
  };
  await Promise.allSettled([
    safeUnlink(videoRelativePath),
    safeUnlink(coverRelativePath),
  ]);
}

/**
 * Publish selected, production-ready render candidates. Invalid cards are
 * reported as skipped so one bad output does not discard successful siblings.
 *
 * `options.requireRenderContract` 打开后,发布前与最终事务里都会校验成功
 * 渲染任务 requestKey 携带的完整渲染契约与当前成片版本一致(渲染期间又编辑
 * 时,过期结果不得成为当前正式成片);旧任务没有契约哈希时保持原有修订号
 * 比对兼容。
 */
export async function publishSelectedBatchOutputs(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planIds: string[],
  options: {
    storageRoot?: string;
    now?: () => Date;
    requireRenderContract?: boolean;
    /** 测试/编排 seam:文件复制完成、进入最终注册事务前执行。 */
    beforeRegister?: () => Promise<void> | void;
  } = {},
): Promise<BatchPublishSelectionResult> {
  const uniquePlanIds = [...new Set(planIds.filter((value) => typeof value === 'string' && value.trim()))];
  if (uniquePlanIds.length === 0) {
    throw new BatchDomainError('invalid_input', '请至少选择一条成片进行正式导出');
  }
  const lineage = getBatchLineage(db, projectId, batchId);
  if (lineage.inputState !== 'frozen') {
    throw new BatchDomainError('conflict', '批次输入尚未冻结,不能正式导出');
  }
  const project = db.prepare(`SELECT productCode, createdAt, storeCode, productSubmodel, productionType, editorName, namingDate FROM projects WHERE id = ?`).get(projectId) as {
    productCode: string | null;
    createdAt: string | null;
    storeCode: string | null;
    productSubmodel: string | null;
    productionType: string | null;
    editorName: string | null;
    namingDate: string | null;
  } | undefined;
  if (!project) throw new BatchDomainError('not_found', '项目不存在');
  if (!project.productCode?.trim()) throw new BatchDomainError('conflict', '请先在项目信息中填写产品编码再正式导出');
  // 与单条模式一致:文件名里的日期取项目创建日期(上海时区),不是导出当天,
  // 这样同一项目的单条与批量成片落在同一个日期前缀下,重复导出也不会变名。
  const taskDate = formatShanghaiTaskDate(project.createdAt ?? '') || undefined;

  // 导出身份以批次冻结快照为准:start 时把当时的身份/目录名冻结进版本 defaultsJson,
  // 正式发布不再读「当前」项目字段,项目身份后续切换不影响已冻结批次的目录与命名。
  // 旧批次(本改动前已冻结,没有快照)回退到发布时解析当前身份,保持向后兼容。
  const frozenBatchIdentity = readFrozenBatchExportIdentity(db, lineage.currentVersionId!);
  let frozenIdentity: ExportIdentityView | null = null;
  let exportDirName: string;
  if (frozenBatchIdentity?.exportDirName) {
    exportDirName = frozenBatchIdentity.exportDirName;
    if (frozenBatchIdentity.identity) {
      // 首次正式导出才用冻结快照的字段创建身份修订;项目已有身份修订(含用户显式切换过)时
      // 直接用冻结名称发布,不再改动项目当前身份指针。
      if (!hasExportIdentity(db, projectId)) {
        frozenIdentity = createExportIdentity(db, { projectId, identity: frozenBatchIdentity.identity });
      }
    }
  } else {
    // 旧批次:发布时按当前项目身份解析并冻结(首次正式导出语义)。
    const identityFields = readProductionIdentityFields(project);
    const namingDate = deriveProjectNamingDate({ namingDate: project.namingDate ?? '', createdAt: project.createdAt });
    frozenIdentity = identityFields.storeCode && identityFields.productCode && identityFields.productionType && identityFields.editorName
      ? getOrCreateCurrentExportIdentity(db, projectId, { ...identityFields, namingDate })
      : null;
    exportDirName = frozenIdentity ? frozenIdentity.exportDirName : resolveProjectExportDirName(db, projectId);
  }

  const storageRoot = path.resolve(options.storageRoot ?? path.join(dataRoot(), 'storage'));
  const items: BatchPublishItemResult[] = [];
  for (const planId of uniquePlanIds) {
    let publishedPaths: { videoRelativePath: string; coverRelativePath: string } | null = null;
    try {
      const latestAllocation = db.prepare(`
        SELECT r.resultJson
        FROM batch_production_versions v
        LEFT JOIN batch_allocation_runs r ON r.id = v.currentAllocationRunId
        WHERE v.id = ?
      `).get(lineage.currentVersionId) as { resultJson: string } | undefined;
      const latestResult = latestAllocation ? JSON.parse(latestAllocation.resultJson) as { outputs?: unknown[] } : null;
      const latestOutput = latestResult?.outputs?.find((entry) => (
        entry && typeof entry === 'object' && !Array.isArray(entry)
        && (entry as Record<string, unknown>).planId === planId
      )) as { status?: unknown; blockers?: unknown } | undefined;
      if (!latestOutput || latestOutput.status !== 'available') {
        const blockers = Array.isArray(latestOutput?.blockers)
          ? latestOutput.blockers.filter((value): value is string => typeof value === 'string' && value.length > 0)
          : [];
        throw new BatchDomainError(
          'conflict',
          blockers.length ? `最新联合分配已阻塞：${blockers.join('；')}` : '最新联合分配已阻塞或缺少该成片计划',
        );
      }
      const row = db.prepare(`
        SELECT p.id AS planId, p.seq, p.currentVersionId, p.scriptSnapshotId,
               o.versionNumber, o.arrangementJson,
               t.requestKey AS requestKey,
               a.resultJson
        FROM batch_output_plans p
        JOIN batch_output_versions o ON o.id = p.currentVersionId
        JOIN batch_tasks t ON t.projectId = ? AND t.batchId = ?
          AND t.workType = 'render' AND t.targetKind = 'output_version'
          AND t.targetId = p.currentVersionId AND t.status = 'succeeded'
        JOIN batch_task_attempts a ON a.taskId = t.id
          AND a.attemptNumber = t.attemptCount AND a.status = 'succeeded'
        WHERE p.id = ? AND p.batchVersionId = ?
        ORDER BY t.createdAt DESC, t.id DESC
        LIMIT 1
      `).get(projectId, batchId, planId, lineage.currentVersionId) as {
        planId: string;
        seq: number;
        currentVersionId: string;
        scriptSnapshotId: string;
        versionNumber: number;
        arrangementJson: string;
        requestKey: string | null;
        resultJson: string | null;
      } | undefined;
      if (!row) throw new BatchDomainError('conflict', '当前成片版本还没有成功的渲染候选');
      const render = parseRenderResult(row.resultJson);
      if (!render) throw new BatchDomainError('conflict', '渲染候选结果损坏或缺少发布信息');
      if (
        render.projectId !== projectId
        || render.batchId !== batchId
        || render.batchVersionId !== lineage.currentVersionId
        || render.planId !== planId
        || render.outputVersionId !== row.currentVersionId
        || render.planSeq !== row.seq
        || render.outputVersionNumber !== row.versionNumber
      ) throw new BatchDomainError('conflict', '渲染候选谱系与当前成片版本不一致');
      if (!render.productionReady || render.audioMode !== 'narration') {
        throw new BatchDomainError('conflict', '当前只是静音视觉候选,需准备并核验口播后才能正式导出');
      }
      const pendingRender = db.prepare(`
        SELECT 1
        FROM batch_tasks
        WHERE projectId = ? AND batchId = ? AND workType = 'render'
          AND targetKind = 'output_version' AND targetId = ?
          AND status IN ('queued', 'running')
        LIMIT 1
      `).get(projectId, batchId, row.currentVersionId);
      if (pendingRender) throw new BatchDomainError('conflict', '成片正在重新渲染，请等待重新渲染完成后再导出');
      const arrangement = JSON.parse(row.arrangementJson) as {
        clips?: Array<{ assetId?: unknown }>;
        cover?: { assetId?: unknown; timeUs?: unknown };
        editRevision?: unknown;
        review?: { decision?: unknown };
      };
      // 修订号/封面时间点/审核结论 CAS——发布前先跑一遍;复制文件完成后、
      // 替换当前指针前的最终事务里还会再跑一遍(见下方 db.transaction)。
      assertArrangementStateMatchesRender(db, row.currentVersionId, render);
      // 渲染契约 CAS:导出编排开启时,成功任务必须对应当前完整渲染契约。
      if (options.requireRenderContract) {
        assertRenderContractCurrent(db, row.requestKey, row.currentVersionId);
      }
      const usedAssetIds = [...new Set([
        ...(Array.isArray(arrangement.clips) ? arrangement.clips.map(({ assetId }) => assetId) : []),
        arrangement.cover?.assetId,
      ].filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0))];
      if (usedAssetIds.length === 0) throw new BatchDomainError('conflict', '成片安排没有可核验的原片引用');
      const preflight = await checkFormalExportPreflight(db, lineage.currentVersionId!, { assetIds: usedAssetIds });
      if (!preflight.ready) {
        throw new BatchDomainError('conflict', preflight.blockers.map(({ message }) => message).join('；'));
      }
      const target = reserveBatchExportTarget({
        storageRoot,
        projectId,
        batchId,
        // 冻结快照存在时用快照里的型号/日期（baseName 缺省时才回退旧命名公式）。
        productCode: frozenBatchIdentity?.productCode || project.productCode || '',
        taskDate: frozenBatchIdentity?.taskDate || taskDate || options.now?.() || new Date(),
        planSeq: row.seq,
        outputVersion: row.versionNumber,
        exportDirName,
        ...(frozenIdentity ? { baseName: frozenIdentity.baseName } : {}),
        ...(frozenBatchIdentity?.baseName && !frozenIdentity ? { baseName: frozenBatchIdentity.baseName } : {}),
      });
      let output;
      try {
        output = await publishBatchExportTarget({
          storageRoot,
          target,
          videoSource: render.videoRelativePath,
          coverSource: render.coverRelativePath,
          renderResult: render,
          productionReady: true,
        });
      } catch (error) {
        try { releaseBatchExportReservation(storageRoot, target); } catch { /* best effort */ }
        throw error;
      }
      publishedPaths = {
        videoRelativePath: output.videoRelativePath,
        coverRelativePath: output.coverRelativePath,
      };
      if (output.videoChecksum !== render.videoChecksum || output.coverChecksum !== render.coverChecksum) {
        throw new BatchDomainError('conflict', '正式发布源内容与已核验渲染候选指纹不一致');
      }
      // 测试/编排 seam:文件复制完成、进入最终注册事务前执行(如模拟复制期间撤销审核)。
      if (options.beforeRegister) {
        await options.beforeRegister();
      }
      const createdAt = options.now?.() ?? new Date();
      let alreadyPublishedVideoId: string | null = null;
      const registered = db.transaction(() => {
        const current = db.prepare(`
          SELECT currentVersionId FROM batch_output_plans WHERE id = ? AND batchVersionId = ?
        `).get(planId, lineage.currentVersionId) as { currentVersionId: string | null } | undefined;
        if (!current || current.currentVersionId !== row.currentVersionId) {
          throw new BatchDomainError('conflict', '正式发布期间成片版本已变化,请重新检查');
        }
        // 复制文件期间用户仍可能编辑或撤销审核:替换当前指针前把安排状态
        // (修订号/封面时间点/审核结论)与渲染契约 CAS 全部重跑一遍;撤销审核
        // 不递增 editRevision,只比对修订号拦不住它,必须在事务内复核审核态。
        assertArrangementStateMatchesRender(db, row.currentVersionId, render);
        if (options.requireRenderContract) {
          assertRenderContractCurrent(db, row.requestKey, row.currentVersionId);
        }
        // 并发的重复 POST 竞态:同一渲染结果(版本 + 视频/封面成对指纹)已注册为当前
        // 正式成片时,本请求不再注册第二对 artifact;本次多复制的文件随后清理。
        // 只在编排路径(requireRenderContract,即 exports 路由)开启——旧直接
        // 发布入口保留「每次导出都追加一份」的历史语义(见 legacy 用例)。
        if (options.requireRenderContract) {
          const concurrentCurrent = db.prepare(`
            SELECT a.id, a.relativePath
            FROM batch_output_plans p
            JOIN batch_artifacts a ON a.id = p.currentArtifactId AND a.kind = 'video'
            WHERE p.id = ? AND a.outputVersionId = ? AND a.checksum = ?
          `).get(planId, row.currentVersionId, output.videoChecksum) as {
            id: string;
            relativePath: string;
          } | undefined;
          const coverCandidates = concurrentCurrent ? db.prepare(`
            SELECT relativePath
            FROM batch_artifacts
            WHERE outputPlanId = ? AND outputVersionId = ? AND kind = 'cover' AND checksum = ?
            ORDER BY createdAt DESC, id DESC
          `).all(planId, row.currentVersionId, output.coverChecksum) as Array<{ relativePath: string }> : [];
          const pairedCover = concurrentCurrent ? coverCandidates.find(({ relativePath }) => (
            batchArtifactPathsArePaired(concurrentCurrent.relativePath, String(relativePath))
          )) : undefined;
          if (concurrentCurrent && pairedCover) {
            alreadyPublishedVideoId = concurrentCurrent.id;
            return null;
          }
        }
        const coverArtifactId = registerArtifact(db, projectId, {
          batchId,
          batchVersionId: lineage.currentVersionId!,
          outputPlanId: planId,
          outputVersionId: row.currentVersionId,
          kind: 'cover',
          relativePath: output.coverRelativePath,
          checksum: output.coverChecksum,
          now: () => createdAt,
        });
        const videoArtifactId = registerArtifact(db, projectId, {
          batchId,
          batchVersionId: lineage.currentVersionId!,
          outputPlanId: planId,
          outputVersionId: row.currentVersionId,
          kind: 'video',
          relativePath: output.videoRelativePath,
          checksum: output.videoChecksum,
          now: () => createdAt,
        });
        return { videoArtifactId, coverArtifactId };
      })();
      if (registered === null) {
        // 唯一走到这里的路径是并发重复 POST(alreadyPublishedVideoId 已置):
        // 清理本次多复制的一对文件,不碰已注册的正式产物。
        await unlinkPublishedPair(storageRoot, output.videoRelativePath, output.coverRelativePath);
        publishedPaths = null;
        items.push({
          planId,
          status: 'already_published',
          videoArtifactId: alreadyPublishedVideoId!,
        });
        continue;
      }
      publishedPaths = null;
      items.push({
        planId,
        status: 'published',
        ...registered,
        videoRelativePath: output.videoRelativePath,
        coverRelativePath: output.coverRelativePath,
      });
    } catch (error) {
      if (publishedPaths) {
        await unlinkPublishedPair(storageRoot, publishedPaths.videoRelativePath, publishedPaths.coverRelativePath);
      }
      items.push({
        planId,
        status: 'skipped',
        reason: error instanceof Error ? error.message : '正式导出失败',
      });
    }
  }
  return {
    batchId,
    published: items.filter(({ status }) => status === 'published').length,
    skipped: items.filter(({ status }) => status === 'skipped').length,
    items,
  };
}
