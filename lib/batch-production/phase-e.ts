import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { resolveProjectExportDirName } from '../project-export-dir.ts';
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
import { startBatchProduction } from './batch-flow.ts';
import { freezeBatchMusicPool, readBatchBgmPool } from './bgm.ts';
import { BatchDomainError } from './errors.ts';
import { checkFormalExportPreflight } from './export-preflight.ts';
import { registerArtifact } from './artifacts.ts';
import { createBatchTask } from './tasks.ts';

// v2:成片开头加入 20 帧封面片头(与单条剪辑同一契约),渲染产物形状变了,
// 所以幂等身份必须换代——旧的 succeeded 渲染任务不该再挡住重渲染。
export const BATCH_RENDER_ADAPTER_VERSION = 'batch-render-v2';

/**
 * 渲染任务的幂等身份。封面被烤进片头之后,封面抽帧时间点就是成片内容的一部分,
 * 所以必须进 requestKey——否则换封面命中既有 succeeded 任务,成片开头会一直
 * 停留在旧封面。片段级编辑(trim/replace)就地改 clips,同理必须把 editRevision
 * 放进 key——否则编辑后的重渲染会被幂等去重跳过。
 */
function renderRequestKey(db: Database.Database, outputVersionId: string): string {
  const row = db.prepare(`
    SELECT COALESCE(json_extract(arrangementJson, '$.cover.timeUs'), -1) AS coverTimeUs,
           COALESCE(json_extract(arrangementJson, '$.editRevision'), 0) AS editRevision
    FROM batch_output_versions WHERE id = ?
  `).get(outputVersionId) as { coverTimeUs: number; editRevision: number } | undefined;
  const coverTimeUs = Number.isFinite(Number(row?.coverTimeUs)) ? Number(row?.coverTimeUs) : -1;
  const editRevision = Number.isSafeInteger(Number(row?.editRevision)) && Number(row?.editRevision) > 0
    ? Number(row?.editRevision)
    : 0;
  return `render:${outputVersionId}:${BATCH_RENDER_ADAPTER_VERSION}:cover:${coverTimeUs}:edit:${editRevision}`;
}

/** 就地改写 arrangement(换封面/片段编辑)后,重排当前候选版本的渲染。 */
function scheduleRenderForCurrentOutputVersion(
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
    targetKind: 'output_version',
    targetId: plan.outputVersionId,
    requestKey: renderRequestKey(db, plan.outputVersionId),
    now,
  });
}

/**
 * 换封面之后重排一次渲染。封面是片头的一部分,只换那张独立封面图会让成片
 * 开头与封面不一致。requestKey 含封面时间点,所以同一封面重复触发是幂等的。
 */
export function scheduleRenderAfterCoverChange(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  now?: () => Date,
): string | null {
  return scheduleRenderForCurrentOutputVersion(db, projectId, batchId, planId, now);
}

/**
 * 片段级编辑(trim/replace)之后重排一次渲染。requestKey 含 editRevision,
 * 每次生效的编辑都会产生新 key,既有 succeeded 任务不会吞掉这次重渲染;
 * 同一次编辑重复提交则命中同一 key 幂等去重。
 */
export function scheduleRenderAfterClipEdit(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  now?: () => Date,
): string | null {
  return scheduleRenderForCurrentOutputVersion(db, projectId, batchId, planId, now);
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
  // 候选指针切换后，旧版本尚未完成的 render 不再有提交资格。排队/失败
  // 任务立即取消；运行任务标为 stopped，由 runner 心跳中止并清理迟到结果。
  db.prepare(`
    UPDATE batch_tasks
    SET status = CASE WHEN status IN ('queued', 'failed') THEN 'cancelled' ELSE status END,
        expectedState = 'stopped', updatedAt = ?
    WHERE projectId = ? AND batchId = ? AND workType = 'render'
      AND targetKind = 'output_version'
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
        AND targetKind = 'output_version' AND status IN ('queued', 'running', 'failed')
        AND targetId IN (SELECT id FROM batch_output_versions WHERE planId = ?)
    `).run((now ?? (() => new Date()))().toISOString(), projectId, batchId, output.planId);
  }
  const taskIds: Record<string, string> = {};
  // 口播任务已在冻结后建立(先于分配),这里只建渲染任务。
  for (const [planId, outputVersionId] of Object.entries(allocation.outputVersionIds)) {
    taskIds[planId] = createBatchTask(db, projectId, {
      batchId,
      workType: 'render',
      targetKind: 'output_version',
      targetId: outputVersionId,
      requestKey: renderRequestKey(db, outputVersionId),
      now,
    });
  }
  return taskIds;
}

/**
 * Freeze a draft batch (or resume a previously frozen start request), then run
 * the production pipeline in order: 口播 → 分配 → 渲染。
 *
 * After the freeze point only narration tasks are enqueued; the batch-wide
 * allocation and render tasks are deferred until every narration task of this
 * version has reached a terminal state. An unfinished narration returns
 * `narration_pending` (same resume mechanism as semantic scoring: PUT /start
 * is idempotent and re-entered by the frontend once tasks settle). Failed
 * narrations still proceed to allocation so silent preview candidates can be
 * rendered; formal publishing stays behind `assertNarrationPublishable`.
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
    ) return null;
    return value as RenderAttemptResult;
  } catch {
    return null;
  }
}

export interface BatchPublishItemResult {
  planId: string;
  status: 'published' | 'skipped';
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
 */
export async function publishSelectedBatchOutputs(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planIds: string[],
  options: { storageRoot?: string; now?: () => Date } = {},
): Promise<BatchPublishSelectionResult> {
  const uniquePlanIds = [...new Set(planIds.filter((value) => typeof value === 'string' && value.trim()))];
  if (uniquePlanIds.length === 0) {
    throw new BatchDomainError('invalid_input', '请至少选择一条成片进行正式导出');
  }
  const lineage = getBatchLineage(db, projectId, batchId);
  if (lineage.inputState !== 'frozen') {
    throw new BatchDomainError('conflict', '批次输入尚未冻结,不能正式导出');
  }
  const project = db.prepare(`SELECT productCode, createdAt FROM projects WHERE id = ?`).get(projectId) as {
    productCode: string | null;
    createdAt: string | null;
  } | undefined;
  if (!project) throw new BatchDomainError('not_found', '项目不存在');
  if (!project.productCode?.trim()) throw new BatchDomainError('conflict', '请先在项目信息中填写产品编码再正式导出');
  // 与单条模式一致:文件名里的日期取项目创建日期(上海时区),不是导出当天,
  // 这样同一项目的单条与批量成片落在同一个日期前缀下,重复导出也不会变名。
  const taskDate = formatShanghaiTaskDate(project.createdAt ?? '') || undefined;

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
      const arrangement = JSON.parse(row.arrangementJson) as {
        clips?: Array<{ assetId?: unknown }>;
        cover?: { assetId?: unknown };
        review?: { decision?: unknown };
      };
      // 审核门禁:正式导出只接受用户已标记「通过」的成片(权威的服务端单点判断)。
      if (arrangement.review?.decision !== 'approved') {
        throw new BatchDomainError('conflict', '该成片尚未审核通过,请先在检查页标记「通过」后再导出');
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
        productCode: project.productCode,
        taskDate: taskDate ?? options.now?.() ?? new Date(),
        planSeq: row.seq,
        outputVersion: row.versionNumber,
        exportDirName: resolveProjectExportDirName(db, projectId),
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
      const createdAt = options.now?.() ?? new Date();
      const registered = db.transaction(() => {
        const current = db.prepare(`
          SELECT currentVersionId FROM batch_output_plans WHERE id = ? AND batchVersionId = ?
        `).get(planId, lineage.currentVersionId) as { currentVersionId: string | null } | undefined;
        if (!current || current.currentVersionId !== row.currentVersionId) {
          throw new BatchDomainError('conflict', '正式发布期间成片版本已变化,请重新检查');
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
