import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type BatchTaskWorkType = 'asset_prepare' | 'render';
export type BatchTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type BatchTaskAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BatchTaskRow {
  id: string;
  projectId: string;
  batchId: string;
  workType: BatchTaskWorkType;
  targetKind: string;
  targetId: string;
  status: BatchTaskStatus;
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
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 创建一个生产任务,服务于素材准备(asset_prepare)或某个成片版本(render)。
 * 具体状态机由后续调度票决定;这里只持久化工作类型、所属对象、状态与汇总进度。
 */
export function createBatchTask(
  db: Database.Database,
  projectId: string,
  input: {
    batchId: string;
    workType: BatchTaskWorkType;
    targetKind: string;
    targetId: string;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_tasks (id, projectId, batchId, workType, targetKind, targetId, status, progressJson, attemptCount, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', '{}', 0, ?, ?)
  `).run(id, projectId, input.batchId, input.workType, input.targetKind, input.targetId, createdAt, createdAt);
  return id;
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
    status: 'succeeded' | 'failed' | 'cancelled';
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
