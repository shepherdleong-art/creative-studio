import type Database from 'better-sqlite3';
import { batchArtifactPathsArePaired } from './artifact-pair.ts';
import { isFormalArtifactOutdated } from './formal-artifact-freshness.ts';
import { resolveFullRenderContractHash } from './cover-contract.ts';
import { BatchDomainError } from './errors.ts';
import { checkFormalExportPreflight } from './export-preflight.ts';
import { publishSelectedBatchOutputs } from './phase-e.ts';
import { createBatchTask, type BatchTaskStatus } from './tasks.ts';
import {
  buildFullRenderTaskRequestKey,
  parseRenderTaskRequestKey,
} from './render-task-key.ts';

/**
 * 默认唤醒:懒加载 bootstrap 的进程内调度器启动入口。
 * 用动态 import 而不是顶层静态导入——bootstrap 的依赖链含 extensionless
 * 相对导入,顶层静态导入会把整条链拉进「node scripts/*.test.ts 直跑」的
 * 模块图并炸掉测试;懒加载只在真实运行时(Next.js 路由)才解析这条链。
 */
async function defaultWakeScheduler(): Promise<void> {
  const { ensureBatchSchedulerStarted } = await import('./bootstrap.ts');
  ensureBatchSchedulerStarted();
}

export type BatchExportItemStatus =
  | 'skipped'
  | 'render_queued'
  | 'rendering'
  | 'render_failed'
  | 'already_published'
  | 'published';

export interface BatchExportOrchestrateItem {
  planId: string;
  status: BatchExportItemStatus;
  /** skipped / render_failed 的人话原因。 */
  reason?: string;
  /** 整片渲染任务 ID(创建或复用)。 */
  taskId?: string;
  /** 该任务当前进度(rendering 状态携带)。 */
  progress?: unknown;
  videoArtifactId?: string;
  coverArtifactId?: string;
  videoRelativePath?: string;
  coverRelativePath?: string;
}

export interface BatchExportOrchestrateResult {
  batchId: string;
  /** 本次新发布的条数(幂等命中的 already_published 不计入)。 */
  published: number;
  /** 幂等命中:当前正式成片已对应当前渲染契约,重复 POST 未复制新文件。 */
  alreadyPublished: number;
  pending: number;
  failed: number;
  skipped: number;
  items: BatchExportOrchestrateItem[];
}

/** 完整渲染任务的幂等 requestKey = 当前完整渲染契约哈希。 */
export function fullRenderRequestKeyForCurrentContract(
  db: Database.Database,
  outputVersionId: string,
): string {
  return buildFullRenderTaskRequestKey(outputVersionId, resolveFullRenderContractHash(db, outputVersionId));
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

function arrangementProductionReady(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.productionReady === 'boolean') return record.productionReady;
  const narration = asRecord(record.narration);
  return narration?.productionReady === true;
}

interface PlanLineageRow {
  batchVersionId: string;
  currentVersionId: string | null;
  versionNumber: number | null;
  arrangementJson: string | null;
  inputState: 'draft' | 'frozen';
  batchCurrentVersionId: string | null;
}

function readPlanLineage(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
): PlanLineageRow {
  const row = db.prepare(`
    SELECT p.batchVersionId, p.currentVersionId,
           o.versionNumber, o.arrangementJson,
           v.inputState, b.currentVersionId AS batchCurrentVersionId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    LEFT JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as PlanLineageRow | undefined;
  if (!row) throw new BatchDomainError('not_found', '成片计划不存在');
  return row;
}

interface FullRenderTaskView {
  id: string;
  requestKey: string | null;
  status: BatchTaskStatus;
  progressJson: string | null;
  attemptErrorCode: string | null;
  attemptErrorMessage: string | null;
  latestAttemptProgressJson: string | null;
}

function readFullRenderTaskForRequestKey(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
  requestKey: string,
): FullRenderTaskView | null {
  const row = db.prepare(`
    SELECT t.id, t.requestKey, t.status, t.progressJson,
           a.errorCode AS attemptErrorCode, a.errorMessage AS attemptErrorMessage,
           (SELECT pa.progressJson FROM batch_task_attempts pa
             WHERE pa.taskId = t.id AND pa.attemptNumber = t.attemptCount) AS latestAttemptProgressJson
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND t.targetId = ?
      AND t.requestKey = ?
    ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
  `).get(projectId, batchId, outputVersionId, requestKey) as FullRenderTaskView | undefined;
  return row ?? null;
}

/** 老批次没有 rnd_ 契约 key；只允许复用其成功候选并交给发布 CAS 继续复核。 */
function readLatestLegacySucceededFullRenderTask(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
): FullRenderTaskView | null {
  const rows = db.prepare(`
    SELECT t.id, t.requestKey, t.status, t.progressJson,
           a.errorCode AS attemptErrorCode, a.errorMessage AS attemptErrorMessage,
           a.progressJson AS latestAttemptProgressJson
    FROM batch_tasks t
    LEFT JOIN batch_task_attempts a ON a.taskId = t.id AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND t.targetId = ? AND t.status = 'succeeded'
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(projectId, batchId, outputVersionId) as FullRenderTaskView[];
  return rows.find(({ requestKey }) => parseRenderTaskRequestKey(requestKey) === null) ?? null;
}

function currentFormalArtifactPair(
  db: Database.Database,
  planId: string,
): {
  video: { id: string; outputVersionId: string; checksum: string; relativePath: string };
  cover: { id: string; outputVersionId: string; checksum: string; relativePath: string } | null;
} | null {
  const video = db.prepare(`
    SELECT a.id, a.outputVersionId, a.checksum, a.relativePath
    FROM batch_output_plans p
    JOIN batch_artifacts a ON a.id = p.currentArtifactId AND a.kind = 'video'
    WHERE p.id = ?
  `).get(planId) as {
    id: string;
    outputVersionId: string;
    checksum: string;
    relativePath: string;
  } | undefined;
  if (!video) return null;
  const covers = db.prepare(`
    SELECT id, outputVersionId, checksum, relativePath
    FROM batch_artifacts
    WHERE outputPlanId = ? AND outputVersionId = ? AND kind = 'cover'
    ORDER BY createdAt DESC, id DESC
  `).all(planId, video.outputVersionId) as Array<{
    id: string;
    outputVersionId: string;
    checksum: string;
    relativePath: string;
  }>;
  const cover = covers.find(({ relativePath }) => (
    batchArtifactPathsArePaired(video.relativePath, relativePath)
  )) ?? null;
  return { video, cover };
}

/** 取消旧契约的渲染任务(版本未变但编辑内容已变),为当前契约腾出队列。 */
function cancelOutdatedFullRenderTasks(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
  currentRequestKey: string,
  now?: () => Date,
): void {
  db.prepare(`
    UPDATE batch_tasks
    SET status = CASE WHEN status IN ('queued', 'failed') THEN 'cancelled' ELSE status END,
        expectedState = 'stopped', updatedAt = ?
    WHERE projectId = ? AND batchId = ? AND workType = 'render'
      AND targetKind = 'output_version' AND targetId = ?
      AND requestKey IS NOT ? AND status IN ('queued', 'running', 'failed')
  `).run(
    (now ?? (() => new Date()))().toISOString(),
    projectId,
    batchId,
    outputVersionId,
    currentRequestKey,
  );
}

function createFullRenderTask(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
): string {
  return createBatchTask(db, projectId, {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: outputVersionId,
    requestKey: fullRenderRequestKeyForCurrentContract(db, outputVersionId),
  });
}

/**
 * 导出编排的唯一入口:路由只调用这里,前端只消费返回状态。
 *
 * 每条计划依次:预检 →(幂等判断)→ 必要时排整片渲染 → 渲染完成后正式发布。
 * 已发布且未过期的正式成片重复 POST 返回 already_published,不复制新文件。
 * 新建或复用了待执行渲染任务时,编排模块自己唤醒并等待调度器启动(幂等)；
 * 唤醒失败显式报错,调用方不需要也不应该再关心任务什么时候被领取。
 */
export async function orchestrateBatchExport(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planIds: string[],
  options: {
    storageRoot?: string;
    now?: () => Date;
    /** 依赖注入 seam:默认唤醒进程内批量调度器;测试传空操作。 */
    wakeScheduler?: () => void | Promise<void>;
    /** 测试 seam：两次并发请求可在文件复制后、最终注册事务前建立屏障。 */
    beforeRegister?: () => Promise<void> | void;
  } = {},
): Promise<BatchExportOrchestrateResult> {
  const uniquePlanIds = [...new Set(planIds.filter((value) => typeof value === 'string' && value.trim()))];
  if (uniquePlanIds.length === 0) {
    throw new BatchDomainError('invalid_input', '请至少选择一条成片进行正式导出');
  }
  const wakeScheduler = options.wakeScheduler === undefined ? defaultWakeScheduler : options.wakeScheduler;
  const batch = db.prepare(`
    SELECT currentVersionId, controlState FROM batch_productions
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId) as { currentVersionId: string | null; controlState: 'running' | 'paused' | 'stopped' } | undefined;
  if (!batch) throw new BatchDomainError('not_found', '批次不存在');
  if (batch.controlState === 'stopped') {
    throw new BatchDomainError('conflict', '批次已停止,不能正式导出');
  }
  if (!batch.currentVersionId) {
    throw new BatchDomainError('conflict', '批次还没有冻结输入快照,不能正式导出');
  }

  const items: BatchExportOrchestrateItem[] = [];
  for (const planId of uniquePlanIds) {
    items.push(await orchestrateOne(db, projectId, batchId, planId, {
      batchCurrentVersionId: batch.currentVersionId,
      storageRoot: options.storageRoot,
      now: options.now,
      beforeRegister: options.beforeRegister,
    }));
  }
  // 新建或复用排队/运行任务都幂等唤醒一次：上次唤醒可能失败，重试不能只
  // 因为任务已经存在就再也不启动 worker。
  if (items.some(({ status }) => status === 'render_queued' || status === 'rendering')) {
    try {
      await wakeScheduler();
    } catch {
      throw new BatchDomainError('conflict', '正式渲染任务已排队，但调度器启动失败，请重试导出');
    }
  }
  return {
    batchId,
    published: items.filter(({ status }) => status === 'published').length,
    alreadyPublished: items.filter(({ status }) => status === 'already_published').length,
    pending: items.filter(({ status }) => status === 'render_queued' || status === 'rendering').length,
    failed: items.filter(({ status }) => status === 'render_failed').length,
    skipped: items.filter(({ status }) => status === 'skipped').length,
    items,
  };
}

async function orchestrateOne(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  context: {
    batchCurrentVersionId: string;
    storageRoot?: string;
    now?: () => Date;
    beforeRegister?: () => Promise<void> | void;
  },
): Promise<BatchExportOrchestrateItem> {
  const lineage = readPlanLineage(db, projectId, batchId, planId);
  if (lineage.inputState !== 'frozen') {
    return { planId, status: 'skipped', reason: '批次输入尚未冻结,不能正式导出' };
  }
  if (lineage.batchCurrentVersionId !== lineage.batchVersionId) {
    return { planId, status: 'skipped', reason: '成片计划不属于批次当前版本' };
  }
  if (!lineage.currentVersionId) {
    return { planId, status: 'skipped', reason: '该成片还没有候选版本,不能导出' };
  }
  const outputVersionId = lineage.currentVersionId;
  const arrangement = asRecord(parseJson(lineage.arrangementJson));
  const review = asRecord(arrangement?.review);
  if (review?.decision !== 'approved') {
    return { planId, status: 'skipped', reason: '该成片尚未审核通过,请先在检查页标记「通过」后再导出' };
  }
  if (!arrangementProductionReady(arrangement)) {
    return { planId, status: 'skipped', reason: '口播尚未就绪,请先在检查页确认配音完成后再导出' };
  }
  // 排昂贵渲染前先跑正式导出预检(素材冻结完整性/色彩/LUT 等)。
  const usedAssetIds = [...new Set([
    ...(Array.isArray(arrangement?.clips)
      ? arrangement.clips.flatMap((entry) => asRecord(entry)?.assetId)
      : []),
    asRecord(arrangement?.cover)?.assetId,
  ].filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0))];
  if (usedAssetIds.length === 0) {
    return { planId, status: 'skipped', reason: '成片安排没有可核验的原片引用' };
  }
  const preflight = await checkFormalExportPreflight(db, lineage.batchVersionId, { assetIds: usedAssetIds });
  if (!preflight.ready) {
    return {
      planId,
      status: 'skipped',
      reason: preflight.blockers.map(({ message }) => message).join('；'),
    };
  }

  const requestKey = fullRenderRequestKeyForCurrentContract(db, outputVersionId);
  // 幂等:当前正式成片仍对应当前渲染契约时,重复 POST 不复制新文件。
  const currentArtifact = currentFormalArtifactPair(db, planId);
  if (currentArtifact && !isFormalArtifactOutdated(
    db, projectId, batchId, outputVersionId, currentArtifact,
  )) {
    return {
      planId,
      status: 'already_published',
      videoArtifactId: currentArtifact.video.id,
    };
  }

  cancelOutdatedFullRenderTasks(
    db,
    projectId,
    batchId,
    outputVersionId,
    requestKey,
    context.now,
  );
  const task = readFullRenderTaskForRequestKey(
    db,
    projectId,
    batchId,
    outputVersionId,
    requestKey,
  ) ?? readLatestLegacySucceededFullRenderTask(db, projectId, batchId, outputVersionId);
  if (!task) {
    return {
      planId,
      status: 'render_queued',
      taskId: createFullRenderTask(db, projectId, batchId, outputVersionId),
    };
  }
  const taskMatchesContract = task.requestKey === requestKey;
  if (task.status === 'queued' || task.status === 'running') {
    if (taskMatchesContract) {
      return {
        planId,
        status: 'rendering',
        taskId: task.id,
        progress: parseJson(task.latestAttemptProgressJson) ?? parseJson(task.progressJson),
      };
    }
    // 防御性分支：旧契约活动任务已在上方批量停止；若仍观察到则按当前契约新建。
    return {
      planId,
      status: 'render_queued',
      taskId: createFullRenderTask(db, projectId, batchId, outputVersionId),
    };
  }
  if (task.status === 'failed') {
    if (taskMatchesContract) {
      return {
        planId,
        status: 'render_failed',
        taskId: task.id,
        reason: task.attemptErrorMessage || '整片渲染失败,请重试或回检查页修改',
      };
    }
    return {
      planId,
      status: 'render_queued',
      taskId: createFullRenderTask(db, projectId, batchId, outputVersionId),
    };
  }
  if (task.status === 'cancelled') {
    return {
      planId,
      status: 'render_queued',
      taskId: createFullRenderTask(db, projectId, batchId, outputVersionId),
    };
  }
  // succeeded:新契约任务直接发布(老任务由发布函数内按修订号/契约 CAS 复核)。
  if (parseRenderTaskRequestKey(task.requestKey) && task.requestKey !== requestKey) {
    return {
      planId,
      status: 'render_queued',
      taskId: createFullRenderTask(db, projectId, batchId, outputVersionId),
    };
  }
  const publish = await publishSelectedBatchOutputs(
    db,
    projectId,
    batchId,
    [planId],
    {
      storageRoot: context.storageRoot,
      now: context.now,
      requireRenderContract: true,
      beforeRegister: context.beforeRegister,
    },
  );
  const item = publish.items[0];
  if (!item) {
    return {
      planId,
      status: 'skipped',
      reason: '正式导出失败',
    };
  }
  // 并发重复 POST 竞态由 phase-e 最终事务内的同契约检查兜住:第二份请求
  // 不再注册 artifact,返回 already_published 并清理自己多复制的文件。
  if (item.status === 'already_published') {
    return {
      planId,
      status: 'already_published',
      videoArtifactId: item.videoArtifactId,
    };
  }
  if (item.status !== 'published') {
    return {
      planId,
      status: 'skipped',
      reason: item.reason || '正式导出失败',
    };
  }
  return {
    planId,
    status: 'published',
    videoArtifactId: item.videoArtifactId,
    coverArtifactId: item.coverArtifactId,
    videoRelativePath: item.videoRelativePath,
    coverRelativePath: item.coverRelativePath,
  };
}
