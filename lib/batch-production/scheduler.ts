import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import {
  type BatchControlState,
  type BatchTaskCompletionStatus,
  type BatchTaskExpectedState,
  type BatchTaskStatus,
  type BatchTaskTargetKind,
  type BatchTaskWorkType,
  type ClaimedBatchTask,
} from './tasks.ts';

// 任务/尝试/控制状态类型由 tasks.ts 唯一权威定义,这里只做再导出
export type { BatchControlState, BatchTaskAttemptStatus, BatchTaskExpectedState, BatchTaskStatus } from './tasks.ts';

export interface ClaimTaskOptions {
  workerId: string;
  now?: () => Date;
  leaseDurationMs?: number;
}

export interface CompleteTaskAttemptInput {
  workerId: string;
  status: BatchTaskCompletionStatus;
  progressJson?: unknown;
  resultJson?: unknown;
  errorCode?: string;
  errorMessage?: string;
  now?: () => Date;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

let schedulerDraining = false;

/** 进程停机时先关闭 claim 闸门，再等待已领取任务收尾。 */
export function setBatchSchedulerDraining(draining: boolean): void {
  schedulerDraining = draining;
}

/**
 * 原子领取一个可执行任务(生产任务)。
 * 只有任务处于 queued、用户期望运行,且批次未被暂停/停止时才可领取;
 * 领取在单个事务内完成:任务改为 running 并创建带有限期租约的新尝试。
 * 多 worker 竞争时,条件更新保证只有一个尝试获得租约。
 */
export function claimNextTask(
  db: Database.Database,
  options: ClaimTaskOptions,
): ClaimedBatchTask | null {
  if (schedulerDraining) return null;
  const { workerId, leaseDurationMs = 5 * 60_000 } = options;
  const startedAt = nowIso(options.now);
  return db.transaction(() => {
    const candidate = db.prepare(`
      SELECT t.id, t.batchId, t.workType, t.targetKind, t.targetId, t.attemptCount
      FROM batch_tasks t
      JOIN batch_productions p ON p.id = t.batchId
      WHERE t.status = 'queued'
        AND t.expectedState = 'running'
        AND p.controlState = 'running'
        AND p.deletedAt IS NULL
        -- 渲染闸门:render 必须等口播。plan 的脚本快照还有未成功的 narration
        -- 任务(queued/running/failed)时,render 不可领取;cancelled 不挡
        -- (旧版本被取代时取消的口播任务不该继续挡新版本的渲染);
        -- scriptSnapshotId 为 NULL 的无口播计划不受闸门影响。
        AND NOT EXISTS (
          SELECT 1
          FROM batch_output_versions ov
          JOIN batch_output_plans op ON op.id = ov.planId
          JOIN batch_tasks nt
            ON nt.batchId = t.batchId
           AND nt.workType = 'narration'
           AND nt.targetKind = 'script_snapshot'
           AND nt.targetId = op.scriptSnapshotId
          WHERE t.workType = 'render'
            AND t.targetKind = 'output_version'
            AND ov.id = t.targetId
            AND nt.status IN ('queued', 'running', 'failed')
        )
      ORDER BY t.createdAt, t.id
      LIMIT 1
    `).get() as {
      id: string;
      batchId: string;
      workType: BatchTaskWorkType;
      targetKind: BatchTaskTargetKind;
      targetId: string;
      attemptCount: number;
    } | undefined;
    if (!candidate) {
      return null;
    }
    // 条件更新:只有仍为 queued 的任务才能被本 worker 领取
    const claimed = db.prepare(`
      UPDATE batch_tasks SET status = 'running', updatedAt = ?
      WHERE id = ? AND status = 'queued'
    `).run(startedAt, candidate.id);
    if (claimed.changes === 0) {
      return null;
    }
    const attemptNumber = candidate.attemptCount + 1;
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(new Date(startedAt).getTime() + leaseDurationMs).toISOString();
    db.prepare(`
      INSERT INTO batch_task_attempts
        (id, taskId, attemptNumber, status, claimedBy, leaseExpiresAt, heartbeatAt, startedAt, createdAt)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `).run(attemptId, candidate.id, attemptNumber, workerId, leaseExpiresAt, startedAt, startedAt, startedAt);
    db.prepare(`
      UPDATE batch_tasks SET attemptCount = ? WHERE id = ?
    `).run(attemptNumber, candidate.id);
    return {
      task: {
        id: candidate.id,
        batchId: candidate.batchId,
        workType: candidate.workType,
        targetKind: candidate.targetKind,
        targetId: candidate.targetId,
      },
      attempt: { id: attemptId, attemptNumber },
    };
  })();
}

/**
 * 持有有效租约的 worker 续租。
 * 只有 claimedBy 匹配、尝试仍为 running 且租约尚未到期(到期时刻即视为过期)
 * 的 worker 才能续租;过期 worker 不能自行复活租约。
 */
export function renewLease(
  db: Database.Database,
  attemptId: string,
  options: ClaimTaskOptions,
): boolean {
  const heartbeatAt = nowIso(options.now);
  const leaseExpiresAt = new Date(new Date(heartbeatAt).getTime() + (options.leaseDurationMs ?? 5 * 60_000)).toISOString();
  const result = db.prepare(`
    UPDATE batch_task_attempts
    SET leaseExpiresAt = ?, heartbeatAt = ?
    WHERE id = ? AND claimedBy = ? AND status = 'running' AND leaseExpiresAt > ?
  `).run(leaseExpiresAt, heartbeatAt, attemptId, options.workerId, heartbeatAt);
  return result.changes > 0;
}

/** 尝试仍持有未过期租约(claimedBy 匹配 + running + 租约未到期)。 */
export function hasValidLease(
  db: Database.Database,
  attemptId: string,
  workerId: string,
  now?: () => Date,
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM batch_task_attempts
    WHERE id = ? AND claimedBy = ? AND status = 'running' AND leaseExpiresAt > ?
  `).get(attemptId, workerId, nowIso(now)) as { 1: number } | undefined;
  return Boolean(row);
}

/**
 * 结束一次任务尝试并更新任务终态。
 * 只有持有者、尝试仍为 running 且租约尚未到期的 worker 才能写结果;
 * 过期租约的迟到回调被拒绝,不能覆盖已被重新领取的新尝试,
 * 也不能在 expireStaleLeases 执行前自行提交成功结果。
 */
export function completeTaskAttempt(
  db: Database.Database,
  attemptId: string,
  input: CompleteTaskAttemptInput,
): void {
  const finishedAt = nowIso(input.now);
  db.transaction(() => {
    const attempt = db.prepare(`
      SELECT a.taskId, a.status, a.claimedBy, a.leaseExpiresAt,
             t.expectedState, p.controlState
      FROM batch_task_attempts a
      JOIN batch_tasks t ON t.id = a.taskId
      JOIN batch_productions p ON p.id = t.batchId
      WHERE a.id = ?
    `).get(attemptId) as {
      taskId: string;
      status: string;
      claimedBy: string | null;
      leaseExpiresAt: string | null;
      expectedState: string;
      controlState: string;
    } | undefined;
    if (!attempt) {
      throw new Error('任务尝试不存在');
    }
    if (attempt.status !== 'running' || attempt.claimedBy !== input.workerId) {
      throw new Error('尝试不再由该持有者运行(租约失效或已被重新领取)');
    }
    if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt <= finishedAt) {
      throw new Error('尝试租约已到期,不能提交结果');
    }
    if (
      input.status === 'succeeded'
      && (attempt.expectedState !== 'running' || attempt.controlState !== 'running')
    ) {
      throw new Error('任务不再处于运行期望或批次已停止,不能提交成功结果');
    }
    db.prepare(`
      UPDATE batch_task_attempts
      SET status = ?, progressJson = ?, resultJson = ?, errorCode = ?, errorMessage = ?, finishedAt = ?
      WHERE id = ?
    `).run(
      input.status,
      JSON.stringify(input.progressJson ?? {}),
      input.resultJson === undefined ? null : JSON.stringify(input.resultJson),
      input.errorCode ?? null,
      input.errorMessage ?? null,
      finishedAt,
      attemptId,
    );
    const taskStatus: BatchTaskStatus = input.status === 'succeeded'
      ? 'succeeded'
      : input.status === 'failed'
        ? 'failed'
        : 'cancelled';
    db.prepare(`
      UPDATE batch_tasks SET status = ?, updatedAt = ? WHERE id = ?
    `).run(taskStatus, finishedAt, attempt.taskId);
    refreshBatchProgress(db, attempt.taskId, input.now);
  })();
}

/** 重算任务所属批次的汇总进度并写回批次。 */
function refreshBatchProgress(db: Database.Database, taskId: string, now?: () => Date): void {
  const batchId = (db.prepare(`SELECT batchId FROM batch_tasks WHERE id = ?`).get(taskId) as { batchId: string }).batchId;
  refreshBatchProgressForBatch(db, batchId, now);
}

function refreshBatchProgressForBatch(
  db: Database.Database,
  batchId: string,
  now?: () => Date,
): void {
  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
      COALESCE(SUM(CASE WHEN status = 'failed' OR status = 'cancelled' THEN 1 ELSE 0 END), 0) AS failed,
      COUNT(*) AS total
    FROM batch_tasks WHERE batchId = ?
  `).get(batchId) as { succeeded: number; failed: number; total: number };
  db.prepare(`
    UPDATE batch_productions SET progressJson = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    JSON.stringify({ succeeded: counts.succeeded, failed: counts.failed, total: counts.total }),
    nowIso(now),
    batchId,
  );
}

/**
 * 把租约已过期的 running 尝试结束为 interrupted,并让对应任务回到
 * 可领取状态;失败的尝试和已成功的任务不受影响。
 */
export function expireStaleLeases(
  db: Database.Database,
  options: { now?: () => Date } = {},
): number {
  const now = nowIso(options.now);
  return db.transaction(() => {
    const stale = db.prepare(`
      SELECT id, taskId FROM batch_task_attempts
      WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
    `).all(now) as Array<{ id: string; taskId: string }>;
    for (const { id, taskId } of stale) {
      db.prepare(`
        UPDATE batch_task_attempts SET status = 'interrupted', finishedAt = ? WHERE id = ?
      `).run(now, id);
      settleRecoveredTask(db, taskId, now);
      refreshBatchProgress(db, taskId, options.now);
    }
    return stale.length;
  })();
}

/**
 * 应用启动恢复:所有 running 尝试都视为旧实例遗留,一律结束为
 * interrupted(不允许继续显示 running),任务回到可领取状态;
 * 已暂停或已停止批次的 controlState 保持不变,不会被擅自启动。
 */
export function recoverInterruptedWork(
  db: Database.Database,
  options: { now?: () => Date } = {},
): number {
  const now = nowIso(options.now);
  return db.transaction(() => {
    const running = db.prepare(`
      SELECT id, taskId FROM batch_task_attempts WHERE status = 'running'
    `).all() as Array<{ id: string; taskId: string }>;
    for (const { id, taskId } of running) {
      db.prepare(`
        UPDATE batch_task_attempts SET status = 'interrupted', finishedAt = ? WHERE id = ?
      `).run(now, id);
      settleRecoveredTask(db, taskId, now);
      refreshBatchProgress(db, taskId, options.now);
    }
    return running.length;
  })();
}

/**
 * 运行中的尝试被暂停/停止中断后,按批次期望把任务落成可继续或终态:
 * - batch_control:按持久控制状态落成 paused 可继续或 stopped 终态;
 * - scheduler_shutdown:应用退出,任务回 queued 且保持 running 期望;
 * - user_stop:调用方明确停止全部工作,任务进入 cancelled 终态。
 * - superseded:render 目标不再是计划当前版本,任务进入 cancelled 终态。
 * 尝试本身结束为 interrupted,保留可追溯记录。
 */
export type BatchTaskInterruptionReason =
  | 'batch_control'
  | 'scheduler_shutdown'
  | 'user_stop'
  | 'superseded';

export function settleInterruptedTask(
  db: Database.Database,
  attemptId: string,
  now?: () => Date,
  reason: BatchTaskInterruptionReason = 'batch_control',
): void {
  const finishedAt = nowIso(now);
  db.transaction(() => {
    const attempt = db.prepare(`
      SELECT taskId, status FROM batch_task_attempts WHERE id = ?
    `).get(attemptId) as { taskId: string; status: string } | undefined;
    if (!attempt) {
      return;
    }
    const interrupted = db.prepare(`
      UPDATE batch_task_attempts SET status = 'interrupted', finishedAt = ?
      WHERE id = ? AND status = 'running'
    `).run(finishedAt, attemptId);
    // 旧尝试可能已被租约恢复并产生新尝试;此时不得再覆盖当前任务状态。
    if (interrupted.changes === 0) return;
    const batch = db.prepare(`
      SELECT p.controlState, t.expectedState FROM batch_tasks t
      JOIN batch_productions p ON p.id = t.batchId
      WHERE t.id = ?
    `).get(attempt.taskId) as {
      controlState: BatchControlState;
      expectedState: BatchTaskExpectedState;
    } | undefined;
    if (
      reason === 'user_stop'
      || reason === 'superseded'
      || batch?.controlState === 'stopped'
      || batch?.expectedState === 'stopped'
    ) {
      db.prepare(`
        UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped', updatedAt = ?
        WHERE id = ? AND status = 'running'
      `).run(finishedAt, attempt.taskId);
    } else if (batch?.controlState === 'paused' || batch?.expectedState === 'paused') {
      db.prepare(`
        UPDATE batch_tasks SET status = 'queued', expectedState = 'paused', updatedAt = ?
        WHERE id = ? AND status = 'running'
      `).run(finishedAt, attempt.taskId);
    } else if (reason === 'scheduler_shutdown') {
      db.prepare(`
        UPDATE batch_tasks SET status = 'queued', expectedState = 'running', updatedAt = ?
        WHERE id = ? AND status = 'running'
      `).run(finishedAt, attempt.taskId);
    } else {
      db.prepare(`
        UPDATE batch_tasks SET status = 'queued', expectedState = 'paused', updatedAt = ?
        WHERE id = ? AND status = 'running'
      `).run(finishedAt, attempt.taskId);
    }
    refreshBatchProgress(db, attempt.taskId, now);
  })();
}

/** 崩溃/租约恢复必须尊重持久控制状态,停止批次直接进入取消终态。 */
function settleRecoveredTask(
  db: Database.Database,
  taskId: string,
  updatedAt: string,
): void {
  const task = db.prepare(`
    SELECT t.expectedState, p.controlState
    FROM batch_tasks t
    JOIN batch_productions p ON p.id = t.batchId
    WHERE t.id = ?
  `).get(taskId) as {
    expectedState: BatchTaskExpectedState;
    controlState: BatchControlState;
  } | undefined;
  if (!task) return;
  if (task.expectedState === 'stopped' || task.controlState === 'stopped') {
    db.prepare(`
      UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped', updatedAt = ?
      WHERE id = ? AND status = 'running'
    `).run(updatedAt, taskId);
    return;
  }
  if (task.expectedState === 'paused' || task.controlState === 'paused') {
    db.prepare(`
      UPDATE batch_tasks SET status = 'queued', expectedState = 'paused', updatedAt = ?
      WHERE id = ? AND status = 'running'
    `).run(updatedAt, taskId);
    return;
  }
  db.prepare(`
    UPDATE batch_tasks SET status = 'queued', expectedState = 'running', updatedAt = ?
    WHERE id = ? AND status = 'running'
  `).run(updatedAt, taskId);
}

/** 把失败的单个任务重新放入可领取队列(重试只增加任务尝试)。 */
export function retryTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
  now?: () => Date,
): void {
  const updatedAt = nowIso(now);
  db.transaction(() => {
    const task = db.prepare(`
      SELECT t.status, t.targetKind, t.targetId, p.controlState
      FROM batch_tasks t
      JOIN batch_productions p ON p.id = t.batchId
      WHERE t.id = ? AND t.projectId = ?
    `).get(taskId, projectId) as {
      status: BatchTaskStatus;
      targetKind: BatchTaskTargetKind;
      targetId: string;
      controlState: BatchControlState;
    } | undefined;
    if (!task) {
      throw new BatchDomainError('not_found', '任务不存在');
    }
    if (task.controlState === 'stopped') {
      throw new BatchDomainError('conflict', '已停止批次中的任务是终态,不能重试');
    }
    if (task.status !== 'failed' && !(task.status === 'succeeded' && task.targetKind === 'output_version')) {
      throw new BatchDomainError('conflict', '任务不是失败状态,不能重试');
    }
    db.prepare(`
      UPDATE batch_tasks SET status = 'queued', expectedState = 'running', updatedAt = ? WHERE id = ?
    `).run(updatedAt, taskId);
    if (task.targetKind === 'proxy_request') {
      db.prepare(`
        UPDATE batch_proxy_requests SET status = 'requested', updatedAt = ? WHERE id = ?
      `).run(updatedAt, task.targetId);
      db.prepare(`
        UPDATE batch_proxy_cache_items
        SET status = 'pending', updatedAt = ?
        WHERE id = (SELECT currentCacheItemId FROM batch_proxy_requests WHERE id = ?)
          AND status = 'failed'
      `).run(updatedAt, task.targetId);
    }
  })();
}

function assertBatchOwnership(
  db: Database.Database,
  projectId: string,
  batchId: string,
): void {
  const batch = db.prepare(`
    SELECT id FROM batch_productions
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId);
  if (!batch) {
    throw new BatchDomainError('not_found', '批次不存在');
  }
}

/** 暂停批次:持久化期望状态为暂停,调度器立即停止领取新任务。 */
export function pauseBatch(
  db: Database.Database,
  projectId: string,
  batchId: string,
  now?: () => Date,
): void {
  db.transaction(() => {
    assertBatchOwnership(db, projectId, batchId);
    db.prepare(`
      UPDATE batch_productions SET controlState = 'paused', updatedAt = ? WHERE id = ?
    `).run(nowIso(now), batchId);
    db.prepare(`
      UPDATE batch_tasks SET expectedState = 'paused', updatedAt = ?
      WHERE batchId = ? AND status = 'queued'
    `).run(nowIso(now), batchId);
  })();
}

/** 继续批次:回到运行期望,等待中的任务重新可领取。 */
export function resumeBatch(
  db: Database.Database,
  projectId: string,
  batchId: string,
  now?: () => Date,
): void {
  db.transaction(() => {
    assertBatchOwnership(db, projectId, batchId);
    const batch = db.prepare(`
      SELECT controlState FROM batch_productions WHERE id = ?
    `).get(batchId) as { controlState: string };
    if (batch.controlState === 'stopped') {
      throw new BatchDomainError('conflict', '已停止的批次是终态,不能恢复');
    }
    db.prepare(`
      UPDATE batch_productions SET controlState = 'running', updatedAt = ? WHERE id = ?
    `).run(nowIso(now), batchId);
    db.prepare(`
      UPDATE batch_tasks SET expectedState = 'running', updatedAt = ?
      WHERE batchId = ? AND status = 'queued' AND expectedState = 'paused'
    `).run(nowIso(now), batchId);
  })();
}

function assertTaskOwnership(
  db: Database.Database,
  projectId: string,
  taskId: string,
): { batchId: string; status: BatchTaskStatus; targetKind: BatchTaskTargetKind; targetId: string } {
  const task = db.prepare(`
    SELECT batchId, status, targetKind, targetId FROM batch_tasks WHERE id = ? AND projectId = ?
  `).get(taskId, projectId) as {
    batchId: string;
    status: BatchTaskStatus;
    targetKind: BatchTaskTargetKind;
    targetId: string;
  } | undefined;
  if (!task) {
    throw new BatchDomainError('not_found', '任务不存在');
  }
  return task;
}

/**
 * 单独暂停一个任务(不是整个批次):排队中的任务立刻不再被领取;
 * 正在运行的任务由调度心跳在下一个心跳周期内感知 expectedState 变化并中止,
 * 中止后回到可继续状态。不影响同批次的其他任务,也不改变批次 controlState。
 */
export function pauseTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
  now?: () => Date,
): void {
  db.transaction(() => {
    const task = assertTaskOwnership(db, projectId, taskId);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      throw new BatchDomainError('conflict', '任务已经是终态,不能暂停');
    }
    db.prepare(`
      UPDATE batch_tasks SET expectedState = 'paused', updatedAt = ? WHERE id = ?
    `).run(nowIso(now), taskId);
  })();
}

/** 继续一个被单独暂停的任务;排队中的任务重新可领取。批次已停止时不能继续单个任务。 */
export function resumeTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
  now?: () => Date,
): void {
  db.transaction(() => {
    const task = assertTaskOwnership(db, projectId, taskId);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      throw new BatchDomainError('conflict', '任务已经是终态,不能继续');
    }
    const batch = db.prepare(`SELECT controlState FROM batch_productions WHERE id = ?`).get(task.batchId) as {
      controlState: BatchControlState;
    };
    if (batch.controlState === 'stopped') {
      throw new BatchDomainError('conflict', '批次已经停止,不能继续单个任务');
    }
    db.prepare(`
      UPDATE batch_tasks SET expectedState = 'running', updatedAt = ? WHERE id = ?
    `).run(nowIso(now), taskId);
  })();
}

/**
 * 单独取消一个任务(不是整个批次):排队中的任务立刻进入 cancelled 终态;
 * 正在运行的任务由调度心跳感知后中止并收敛为 cancelled(见 settleInterruptedTask)。
 * 不影响同批次的其他任务,也不停止整个批次;取消是终态,只能通过重新提交
 * 同一 requestKey 的业务动作在同一身份上形成新任务(见 createBatchTask)。
 */
export function cancelTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
  now?: () => Date,
): void {
  const updatedAt = nowIso(now);
  db.transaction(() => {
    const task = assertTaskOwnership(db, projectId, taskId);
    if (task.status === 'succeeded' || task.status === 'cancelled') {
      throw new BatchDomainError('conflict', '任务已经是终态,不能取消');
    }
    db.prepare(`
      UPDATE batch_tasks
      SET status = CASE WHEN status IN ('queued', 'failed') THEN 'cancelled' ELSE status END,
          expectedState = 'stopped', updatedAt = ?
      WHERE id = ?
    `).run(updatedAt, taskId);
    if (task.targetKind === 'proxy_request') {
      db.prepare(`
        UPDATE batch_proxy_requests SET status = 'cancelled', updatedAt = ? WHERE id = ?
      `).run(updatedAt, task.targetId);
    }
    refreshBatchProgress(db, taskId, now);
  })();
}

/**
 * 停止批次:未完成的工作不再领取,已成功的结果保留;
 * 停止不是删除,历史尝试与成功产物继续存在。
 */
export function stopBatch(
  db: Database.Database,
  projectId: string,
  batchId: string,
  now?: () => Date,
): void {
  db.transaction(() => {
    assertBatchOwnership(db, projectId, batchId);
    db.prepare(`
      UPDATE batch_productions SET controlState = 'stopped', updatedAt = ? WHERE id = ?
    `).run(nowIso(now), batchId);
    db.prepare(`
      UPDATE batch_proxy_requests
      SET status = 'cancelled', updatedAt = ?
      WHERE id IN (
        SELECT targetId FROM batch_tasks
        WHERE batchId = ? AND workType = 'proxy_generate' AND targetKind = 'proxy_request'
          AND status IN ('queued', 'running', 'failed')
      )
    `).run(nowIso(now), batchId);
    db.prepare(`
      UPDATE batch_tasks
      SET status = CASE WHEN status IN ('queued', 'failed') THEN 'cancelled' ELSE status END,
          expectedState = 'stopped', updatedAt = ?
      WHERE batchId = ? AND status IN ('queued', 'running', 'failed', 'cancelled')
    `).run(nowIso(now), batchId);
    refreshBatchProgressForBatch(db, batchId, now);
  })();
}
