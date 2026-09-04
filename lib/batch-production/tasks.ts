import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import type { BatchProductionStatus } from './versions.ts';

/**
 * 任务与尝试的领域类型唯一权威定义。
 * scheduler.ts / runner.ts / batch-flow.ts 一律从这里导入,不得重新定义
 * 漂移的裸 string 状态。
 */
export type BatchTaskWorkType = 'asset_prepare' | 'render' | 'proxy_generate' | 'narration' | 'semantic_score';
// legacy_proxy_cache 只可能由 v15 把无法回溯谱系的 v14 异常任务隔离成 cancelled
// 历史记录；createBatchTask 的判别联合不接受它，运行时不能创建或调度这种目标。
export type BatchTaskTargetKind = 'asset' | 'output_version' | 'output_version_cover' | 'proxy_request' | 'script_snapshot' | 'legacy_proxy_cache';
export type BatchTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type BatchTaskAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type BatchTaskExpectedState = 'running' | 'paused' | 'stopped';
export type BatchControlState = 'running' | 'paused' | 'stopped';
export type BatchTaskCompletionStatus = Extract<
  BatchTaskAttemptStatus,
  'succeeded' | 'failed' | 'cancelled'
>;

export interface ClaimedBatchTask {
  task: {
    id: string;
    batchId: string;
    projectId: string;
    workType: BatchTaskWorkType;
    targetKind: BatchTaskTargetKind;
    targetId: string;
  };
  attempt: {
    id: string;
    attemptNumber: number;
  };
}

export interface BatchTaskRow {
  id: string;
  projectId: string;
  batchId: string;
  workType: BatchTaskWorkType;
  targetKind: BatchTaskTargetKind;
  targetId: string;
  status: BatchTaskStatus;
  /** 幂等键:同一业务动作重复提交只返回既有任务 */
  requestKey: string | null;
  /** 用户期望状态:运行/暂停/停止 */
  expectedState: BatchTaskExpectedState;
  progressJson: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchTaskAttemptRow {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: BatchTaskAttemptStatus;
  progressJson: string;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** 领取者身份(调度 worker) */
  claimedBy: string | null;
  /** 有限期租约到期时间;到期后尝试失效,可被过期恢复接管 */
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  adapterVersion: string | null;
  /** 远端供应商任务 ID(本轮不实现远端确认,字段保留) */
  remoteTaskId: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 创建一个生产任务,服务于素材准备(asset_prepare)、口播合成(narration)、
 * 代理生成(proxy_generate)或某个成片版本(render)。
 * 批次必须属于该项目;render 任务的目标必须是存在的成片版本,
 * asset_prepare 任务的目标必须是存在的项目素材,
 * narration 任务的目标必须是该批次当前版本内的脚本快照。
 *
 * requestKey 是稳定业务身份的幂等键(如 `asset_prepare:<batchId>:<assetId>`),
 * 必须由调用方基于稳定身份生成,不能包含时间或随机值。同一个业务动作
 * 重复提交(包括并发提交)只返回既有任务,不会产生等价任务副本。
 */
export function createBatchTask(
  db: Database.Database,
  projectId: string,
  input: ({
    batchId: string;
    workType: 'render';
    targetKind: 'output_version';
    targetId: string;
    requestKey?: string;
    now?: () => Date;
  } | {
    batchId: string;
    workType: 'render';
    targetKind: 'output_version_cover';
    targetId: string;
    requestKey?: string;
    now?: () => Date;
  } | {
    batchId: string;
    workType: 'asset_prepare';
    targetKind: 'asset';
    targetId: string;
    requestKey?: string;
    now?: () => Date;
  } | {
    batchId: string;
    workType: 'proxy_generate';
    targetKind: 'proxy_request';
    /** 必须是一个真实存在的 batch_proxy_requests.id(稳定请求身份,cache 可删除但请求不悬空) */
    targetId: string;
    requestKey?: string;
    now?: () => Date;
  } | {
    batchId: string;
    workType: 'narration';
    targetKind: 'script_snapshot';
    /** 必须是该批次当前版本内的 batch_script_snapshots.id(配音按脚本快照复用) */
    targetId: string;
    requestKey?: string;
    now?: () => Date;
  } | {
    batchId: string;
    workType: 'semantic_score';
    targetKind: 'script_snapshot';
    /** 必须是该批次当前版本内的 batch_script_snapshots.id(语义矩阵按内容指纹复用) */
    targetId: string;
    requestKey?: string;
    now?: () => Date;
  }),
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const batch = db.prepare(`
      SELECT projectId FROM batch_productions WHERE id = ? AND deletedAt IS NULL
    `).get(input.batchId) as { projectId: string } | undefined;
    if (!batch) {
      throw new Error('批次不存在');
    }
    if (batch.projectId !== projectId) {
      throw new Error('批次不属于该项目');
    }
    // requestKey 幂等:同一业务动作重复提交返回既有任务。
    // 但已取消的任务是死路(没有自动重试路径),不能让它永久占住 requestKey——
    // 用户明确重新启用时,先释放旧任务持有的 requestKey(历史记录本身保留),
    // 再往下走创建流程,在同一业务身份上形成一个全新的任务与 attempt 链。
    // proxy_generate 额外约定:即使任务未取消,只要它指向的持久化请求的 cache
    // 已被清理(currentCacheItemId 为空或 cache 行已删除),这个任务就是死路,
    // 必须释放 requestKey 让同一业务身份形成新任务——不能被旧 succeeded/failed
    // 任务的历史记录永久卡死(见 ProxyMediaCache.requestProxy)。
    if (input.requestKey) {
      const existing = db.prepare(`
        SELECT id, batchId, status, targetId, targetKind FROM batch_tasks WHERE requestKey = ? AND projectId = ?
      `).get(input.requestKey, projectId) as {
        id: string;
        batchId: string;
        status: BatchTaskStatus;
        targetId: string;
        targetKind: BatchTaskTargetKind;
      } | undefined;
      if (existing) {
        if (existing.status !== 'cancelled') {
          const proxyTarget = existing.targetKind === 'proxy_request' ? db.prepare(`
            SELECT c.status AS cacheStatus, c.pendingDeleteAt AS pendingDeleteAt
            FROM batch_proxy_requests r
            JOIN batch_proxy_cache_items c ON c.id = r.currentCacheItemId
            WHERE r.id = ?
          `).get(existing.targetId) as {
            cacheStatus: 'pending' | 'ready' | 'failed';
            pendingDeleteAt: string | null;
          } | undefined : undefined;
          const targetStillValid = existing.targetKind !== 'proxy_request' || Boolean(
            proxyTarget
            && !proxyTarget.pendingDeleteAt
            && (
              existing.status === 'queued'
              || existing.status === 'running'
              || (existing.status === 'succeeded' && proxyTarget.cacheStatus === 'ready')
            )
          );
          if (targetStillValid) {
            if (
              existing.batchId !== input.batchId
              || existing.targetKind !== input.targetKind
              || existing.targetId !== input.targetId
            ) {
              throw new Error('requestKey 已属于其他批次或业务目标');
            }
            return existing.id;
          }
        }
        db.prepare(`UPDATE batch_tasks SET requestKey = NULL WHERE id = ?`).run(existing.id);
      }
    }
    if (input.workType === 'render') {
      if (input.targetKind !== 'output_version' && input.targetKind !== 'output_version_cover') {
        throw new Error('render 任务的目标类型必须是 output_version 或 output_version_cover');
      }
      const version = db.prepare(`
        SELECT v.batchId
        FROM batch_output_versions o
        JOIN batch_output_plans p ON p.id = o.planId
        JOIN batch_production_versions v ON v.id = p.batchVersionId
        WHERE o.id = ?
      `).get(input.targetId) as { batchId: string } | undefined;
      if (!version) {
        throw new Error('render 任务的目标成片版本不存在');
      }
      if (version.batchId !== input.batchId) {
        throw new Error('render 任务的目标成片版本不属于该批次');
      }
    } else if (input.workType === 'asset_prepare') {
      if (input.targetKind !== 'asset') {
        throw new Error('asset_prepare 任务的目标类型必须是 asset');
      }
      const asset = db.prepare(`
        SELECT projectId FROM batch_assets WHERE id = ?
      `).get(input.targetId) as { projectId: string } | undefined;
      if (!asset) {
        throw new Error('asset_prepare 任务的目标素材不存在');
      }
      if (asset.projectId !== projectId) {
        throw new Error('asset_prepare 任务的目标素材不属于该项目');
      }
    } else if (input.workType === 'proxy_generate') {
      if (input.targetKind !== 'proxy_request') {
        throw new Error('proxy_generate 任务的目标类型必须是 proxy_request');
      }
      // targetId 必须指向一个真实存在的持久化代理请求(不是可删除的 cache 行);
      // 请求身份稳定,cache 可删除但请求不悬空,任务不会因此失去目标。
      const request = db.prepare(`
        SELECT r.projectId, r.batchId, r.batchVersionId, v.batchId AS versionBatchId
        FROM batch_proxy_requests r
        JOIN batch_production_versions v ON v.id = r.batchVersionId
        WHERE r.id = ?
      `).get(input.targetId) as {
        projectId: string;
        batchId: string;
        batchVersionId: string;
        versionBatchId: string;
      } | undefined;
      if (!request) {
        throw new Error('proxy_generate 任务的目标代理请求不存在');
      }
      if (request.projectId !== projectId) {
        throw new Error('proxy_generate 任务的目标代理请求不属于该项目');
      }
      if (request.batchId !== input.batchId || request.versionBatchId !== input.batchId) {
        throw new Error('proxy_generate 任务的目标代理请求不属于该批次谱系');
      }
    } else if (input.workType === 'narration') {
      if (input.targetKind !== 'script_snapshot') {
        throw new Error('narration 任务的目标类型必须是 script_snapshot');
      }
      // targetId 必须是该批次当前版本内的脚本快照;快照冻结后配音按快照身份复用,
      // 不依赖可变的脚本正文行(正文变化会形成新版本,不会改写旧快照)。
      const snapshot = db.prepare(`
        SELECT s.batchVersionId, v.batchId
        FROM batch_script_snapshots s
        JOIN batch_production_versions v ON v.id = s.batchVersionId
        WHERE s.id = ?
      `).get(input.targetId) as { batchVersionId: string; batchId: string } | undefined;
      if (!snapshot) {
        throw new Error('narration 任务的目标脚本快照不存在');
      }
      if (snapshot.batchId !== input.batchId) {
        throw new Error('narration 任务的目标脚本快照不属于该批次谱系');
      }
    } else if (input.workType === 'semantic_score') {
      if (input.targetKind !== 'script_snapshot') {
        throw new Error('semantic_score 任务的目标类型必须是 script_snapshot');
      }
      // 与 narration 同一谱系校验:快照必须经 batchVersionId 属于该批次。
      const snapshot = db.prepare(`
        SELECT s.batchVersionId, v.batchId
        FROM batch_script_snapshots s
        JOIN batch_production_versions v ON v.id = s.batchVersionId
        WHERE s.id = ?
      `).get(input.targetId) as { batchVersionId: string; batchId: string } | undefined;
      if (!snapshot) {
        throw new Error('semantic_score 任务的目标脚本快照不存在');
      }
      if (snapshot.batchId !== input.batchId) {
        throw new Error('semantic_score 任务的目标脚本快照不属于该批次谱系');
      }
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_tasks (id, projectId, batchId, workType, targetKind, targetId, requestKey, status, progressJson, attemptCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', '{}', 0, ?, ?)
    `).run(
      id,
      projectId,
      input.batchId,
      input.workType,
      input.targetKind,
      input.targetId,
      input.requestKey ?? null,
      createdAt,
      createdAt,
    );
    return id;
  })();
}

export function getBatchTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
): (BatchTaskRow & { progressJson: unknown }) | undefined {
  const row = db.prepare(`
    SELECT * FROM batch_tasks WHERE id = ? AND projectId = ?
  `).get(taskId, projectId) as BatchTaskRow | undefined;
  if (!row) return undefined;
  return { ...row, progressJson: JSON.parse(row.progressJson) };
}

export function listBatchTasks(db: Database.Database, batchId: string): BatchTaskRow[] {
  return db.prepare(`
    SELECT * FROM batch_tasks WHERE batchId = ? ORDER BY createdAt, id
  `).all(batchId) as BatchTaskRow[];
}

/**
 * 开始一次真实执行(任务尝试)。每次重试都会产生新的尝试记录,
 * 任务本身不变 —— 重试不产生新任务,更不会产生新成片卡片。
 */
export function startTaskAttempt(db: Database.Database, taskId: string, now?: () => Date): string {
  const startedAt = nowIso(now);
  return db.transaction(() => {
    const task = db.prepare(`
      SELECT attemptCount FROM batch_tasks WHERE id = ?
    `).get(taskId) as { attemptCount: number } | undefined;
    if (!task) {
      throw new Error('生产任务不存在');
    }
    const attemptNumber = task.attemptCount + 1;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_task_attempts (id, taskId, attemptNumber, status, progressJson, startedAt, createdAt)
      VALUES (?, ?, ?, 'running', '{}', ?, ?)
    `).run(id, taskId, attemptNumber, startedAt, startedAt);
    db.prepare(`
      UPDATE batch_tasks SET status = 'running', attemptCount = ?, updatedAt = ? WHERE id = ?
    `).run(attemptNumber, startedAt, taskId);
    return id;
  })();
}

/**
 * 结束一次任务尝试,并把任务汇总状态更新为对应终态。
 * 部分成功可表达:其他任务失败不回滚已成功的结果。
 */
export function finishTaskAttempt(
  db: Database.Database,
  taskId: string,
  attemptId: string,
  input: {
    status: BatchTaskCompletionStatus;
    resultJson?: unknown;
    errorCode?: string;
    errorMessage?: string;
    now?: () => Date;
  },
): void {
  const finishedAt = nowIso(input.now);
  db.transaction(() => {
    const attempt = db.prepare(`
      SELECT taskId FROM batch_task_attempts WHERE id = ? AND taskId = ?
    `).get(attemptId, taskId);
    if (!attempt) {
      throw new Error('任务尝试不存在');
    }
    db.prepare(`
      UPDATE batch_task_attempts
      SET status = ?, progressJson = progressJson, resultJson = ?, errorCode = ?, errorMessage = ?, finishedAt = ?
      WHERE id = ?
    `).run(
      input.status,
      input.resultJson === undefined ? null : JSON.stringify(input.resultJson),
      input.errorCode ?? null,
      input.errorMessage ?? null,
      finishedAt,
      attemptId,
    );
    db.prepare(`
      UPDATE batch_tasks SET status = ?, updatedAt = ? WHERE id = ?
    `).run(input.status, finishedAt, taskId);
  })();
}

export function listTaskAttempts(db: Database.Database, taskId: string): BatchTaskAttemptRow[] {
  return db.prepare(`
    SELECT * FROM batch_task_attempts WHERE taskId = ? ORDER BY attemptNumber
  `).all(taskId) as BatchTaskAttemptRow[];
}

export interface BatchTaskAttemptView {
  id: string;
  attemptNumber: number;
  status: BatchTaskAttemptStatus;
  progressJson: unknown;
  resultJson: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BatchTaskView {
  id: string;
  workType: BatchTaskWorkType;
  targetKind: BatchTaskTargetKind;
  targetId: string;
  status: BatchTaskStatus;
  expectedState: BatchTaskExpectedState;
  attemptCount: number;
  progressJson: unknown;
  createdAt: string;
  attempts: BatchTaskAttemptView[];
}

export interface BatchTasksView {
  batch: {
    id: string;
    name: string;
    status: BatchProductionStatus;
    controlState: BatchControlState;
    progressJson: unknown;
  };
  tasks: BatchTaskView[];
}

/** 批次任务视图:任务、尝试与真实进度,供主界面展示阶段与完成数量。 */
export function getBatchTasksView(
  db: Database.Database,
  projectId: string,
  batchId: string,
): BatchTasksView {
  const batch = db.prepare(`
    SELECT id, name, status, controlState, progressJson FROM batch_productions
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId) as {
    id: string;
    name: string;
    status: BatchProductionStatus;
    controlState: BatchControlState;
    progressJson: string;
  } | undefined;
  if (!batch) {
    throw new BatchDomainError('not_found', '批次不存在');
  }
  const taskRows = db.prepare(`
    SELECT id, workType, targetKind, targetId, status, expectedState, attemptCount, progressJson, createdAt
    FROM batch_tasks WHERE batchId = ? ORDER BY createdAt, id
  `).all(batchId) as Array<{
    id: string;
    workType: BatchTaskWorkType;
    targetKind: BatchTaskTargetKind;
    targetId: string;
    status: BatchTaskStatus;
    expectedState: BatchTaskExpectedState;
    attemptCount: number;
    progressJson: string;
    createdAt: string;
  }>;
  const attemptRows = db.prepare(`
    SELECT id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, startedAt, finishedAt
    FROM batch_task_attempts WHERE taskId IN (${taskRows.map(() => '?').join(',') || "''"})
    ORDER BY attemptNumber
  `).all(...taskRows.map(({ id }) => id)) as Array<{
    id: string;
    taskId: string;
    attemptNumber: number;
    status: BatchTaskAttemptStatus;
    progressJson: string;
    resultJson: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
  const attemptsByTask = new Map<string, BatchTaskAttemptView[]>();
  for (const row of attemptRows) {
    const list = attemptsByTask.get(row.taskId) ?? [];
    list.push({
      id: row.id,
      attemptNumber: row.attemptNumber,
      status: row.status,
      progressJson: JSON.parse(row.progressJson),
      resultJson: row.resultJson ? JSON.parse(row.resultJson) : null,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
    attemptsByTask.set(row.taskId, list);
  }
  return {
    batch: {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      controlState: batch.controlState,
      progressJson: JSON.parse(batch.progressJson),
    },
    tasks: taskRows.map((row) => ({
      id: row.id,
      workType: row.workType,
      targetKind: row.targetKind,
      targetId: row.targetId,
      status: row.status,
      expectedState: row.expectedState,
      attemptCount: row.attemptCount,
      progressJson: JSON.parse(row.progressJson),
      createdAt: row.createdAt,
      attempts: attemptsByTask.get(row.id) ?? [],
    })),
  };
}
