import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ScriptStudioError } from './errors.ts';
import type {
  ScriptStudioTaskRecord,
  ScriptStudioTaskStageRecord,
  ScriptStudioTaskStatus,
} from './types.ts';

export interface CreateTaskInput {
  projectId: string;
  requestKey: string;
  mode: 'first_extraction' | 'reuse';
  sourceSetId?: string | null;
  libraryRevisionId?: string | null;
  inputSnapshot: Record<string, unknown>;
  requestedCount: number;
  parentTaskId?: string | null;
}

export interface ScriptStudioTaskRequestIdentity {
  projectId: string;
  mode: 'first_extraction' | 'reuse';
  sourceSetId?: string | null;
  libraryRevisionId?: string | null;
  targetDurationSec: number;
  requestedCount: number;
  creativeBrief?: string;
  providerId: string;
  providerModel: string;
}

/**
 * 自动幂等键必须覆盖任务的完整执行身份；尤其是同一供应商记录切换模型后，
 * 新提交不得命中旧模型任务。
 */
export function createScriptStudioTaskRequestKey(input: ScriptStudioTaskRequestIdentity): string {
  return createHash('sha256')
    .update([
      input.projectId,
      input.mode,
      input.sourceSetId || '',
      input.libraryRevisionId || '',
      String(input.targetDurationSec),
      String(input.requestedCount),
      input.creativeBrief || '',
      input.providerId,
      input.providerModel,
    ].join('|'))
    .digest('hex');
}

export interface TaskView extends ScriptStudioTaskRecord {
  stages: ScriptStudioTaskStageRecord[];
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function stageSeq(db: Database.Database, taskId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) AS seq FROM script_studio_task_stages WHERE taskId = ?
  `).get(taskId) as { seq: number };
  return Number(row.seq) + 1;
}

export function createTask(
  db: Database.Database,
  input: CreateTaskInput,
  now?: () => Date,
): { task: TaskView; created: boolean } {
  const existing = db.prepare(`
    SELECT * FROM script_studio_tasks WHERE projectId = ? AND requestKey = ?
  `).get(input.projectId, input.requestKey) as ScriptStudioTaskRecord | undefined;
  if (existing) return { task: getTask(db, input.projectId, existing.id)!, created: false };
  const createdAt = nowIso(now);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO script_studio_tasks
      (id, projectId, requestKey, mode, sourceSetId, libraryRevisionId, inputSnapshotJson,
       requestedCount, succeededCount, failedCount, status, currentStage, errorCode, errorMessage,
       leaseUntil, attemptCount, parentTaskId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'queued', '', NULL, NULL, NULL, 0, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    input.requestKey,
    input.mode,
    input.sourceSetId || null,
    input.libraryRevisionId || null,
    JSON.stringify(input.inputSnapshot),
    Math.max(1, Number(input.requestedCount) || 1),
    input.parentTaskId || null,
    createdAt,
    createdAt,
  );
  return { task: getTask(db, input.projectId, id)!, created: true };
}

export function getTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
): TaskView | undefined {
  const row = db.prepare(`
    SELECT * FROM script_studio_tasks WHERE id = ? AND projectId = ?
  `).get(taskId, projectId) as ScriptStudioTaskRecord | undefined;
  if (!row) return undefined;
  const stages = db.prepare(`
    SELECT * FROM script_studio_task_stages WHERE taskId = ? ORDER BY seq
  `).all(taskId) as ScriptStudioTaskStageRecord[];
  return { ...row, stages };
}

export function getTaskByRequestKey(
  db: Database.Database,
  projectId: string,
  requestKey: string,
): TaskView | undefined {
  const row = db.prepare(`
    SELECT * FROM script_studio_tasks WHERE projectId = ? AND requestKey = ?
  `).get(projectId, requestKey) as ScriptStudioTaskRecord | undefined;
  return row ? getTask(db, projectId, row.id) : undefined;
}

export function updateTask(
  db: Database.Database,
  projectId: string,
  taskId: string,
  patch: {
    status?: ScriptStudioTaskStatus;
    currentStage?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    leaseUntil?: string | null;
    attemptCount?: number;
    succeededCount?: number;
    failedCount?: number;
  },
  now?: () => Date,
): TaskView {
  const updatedAt = nowIso(now);
  const row = db.prepare(`
    SELECT * FROM script_studio_tasks WHERE id = ? AND projectId = ?
  `).get(taskId, projectId) as ScriptStudioTaskRecord | undefined;
  if (!row) throw new ScriptStudioError('not_found', '任务不存在或不属于当前项目');
  db.prepare(`
    UPDATE script_studio_tasks SET
      status = ?,
      currentStage = ?,
      errorCode = ?,
      errorMessage = ?,
      leaseUntil = ?,
      attemptCount = ?,
      succeededCount = ?,
      failedCount = ?,
      updatedAt = ?
    WHERE id = ? AND projectId = ?
  `).run(
    patch.status ?? row.status,
    patch.currentStage ?? row.currentStage,
    patch.errorCode === undefined ? row.errorCode : patch.errorCode,
    patch.errorMessage === undefined ? row.errorMessage : patch.errorMessage,
    patch.leaseUntil === undefined ? row.leaseUntil : patch.leaseUntil,
    patch.attemptCount ?? row.attemptCount,
    patch.succeededCount ?? row.succeededCount,
    patch.failedCount ?? row.failedCount,
    updatedAt,
    taskId,
    projectId,
  );
  return getTask(db, projectId, taskId)!;
}

export function ensureStage(
  db: Database.Database,
  projectId: string,
  taskId: string,
  stage: string,
  now?: () => Date,
): ScriptStudioTaskStageRecord {
  const task = getTask(db, projectId, taskId);
  if (!task) throw new ScriptStudioError('not_found', '任务不存在');
  const existing = task.stages.find((item) => item.stage === stage);
  if (existing) return existing;
  const seq = stageSeq(db, taskId);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO script_studio_task_stages
      (id, taskId, seq, stage, status, payloadJson, startedAt, finishedAt, errorCode)
    VALUES (?, ?, ?, ?, 'pending', '{}', NULL, NULL, NULL)
  `).run(id, taskId, seq, stage);
  return task.stages.find((item) => item.id === id) || {
    id,
    taskId,
    seq,
    stage,
    status: 'pending',
    payloadJson: '{}',
    startedAt: null,
    finishedAt: null,
    errorCode: null,
  };
}

export function startStage(
  db: Database.Database,
  projectId: string,
  taskId: string,
  stage: string,
  now?: () => Date,
): void {
  const startedAt = nowIso(now);
  ensureStage(db, projectId, taskId, stage, now);
  db.prepare(`
    UPDATE script_studio_task_stages
    SET status = 'running', startedAt = COALESCE(startedAt, ?), errorCode = NULL, payloadJson = payloadJson
    WHERE taskId = ? AND stage = ?
  `).run(startedAt, taskId, stage);
}

export function finishStage(
  db: Database.Database,
  projectId: string,
  taskId: string,
  stage: string,
  status: 'succeeded' | 'failed' | 'skipped',
  payload: Record<string, unknown> = {},
  errorCode?: string | null,
  now?: () => Date,
): void {
  const finishedAt = nowIso(now);
  const row = db.prepare(`
    SELECT id FROM script_studio_task_stages WHERE taskId = ? AND stage = ?
  `).get(taskId, stage) as { id: string } | undefined;
  if (!row) ensureStage(db, projectId, taskId, stage, now);
  db.prepare(`
    UPDATE script_studio_task_stages
    SET status = ?, payloadJson = ?, finishedAt = ?, errorCode = ?
    WHERE taskId = ? AND stage = ?
  `).run(status, JSON.stringify(payload), finishedAt, errorCode || null, taskId, stage);
}

export function reorderStages(
  db: Database.Database,
  projectId: string,
  taskId: string,
  order: string[],
): void {
  const task = getTask(db, projectId, taskId);
  if (!task) throw new ScriptStudioError('not_found', '任务不存在');
  order.forEach((stage, index) => {
    db.prepare(`
      UPDATE script_studio_task_stages SET seq = ? WHERE taskId = ? AND stage = ?
    `).run(index + 1, taskId, stage);
  });
}

export function recoverInterruptedTasks(
  db: Database.Database,
  now?: () => Date,
): number {
  const cutoff = nowIso(now);
  const rows = db.prepare(`
    SELECT id FROM script_studio_tasks
    WHERE status = 'running' AND (leaseUntil IS NULL OR leaseUntil < ?)
  `).all(cutoff) as Array<{ id: string }>;
  for (const row of rows) {
    db.prepare(`
      UPDATE script_studio_tasks
      SET status = 'queued', leaseUntil = NULL, currentStage = '', updatedAt = ?
      WHERE id = ? AND status = 'running' AND (leaseUntil IS NULL OR leaseUntil < ?)
    `).run(cutoff, row.id, cutoff);
  }
  return rows.length;
}

export function cancelTask(db: Database.Database, projectId: string, taskId: string, now?: () => Date): TaskView {
  const task = getTask(db, projectId, taskId);
  if (!task) throw new ScriptStudioError('not_found', '任务不存在或不属于当前项目');
  if (task.status === 'queued' || task.status === 'running') {
    return updateTask(db, projectId, taskId, { status: 'cancelled', errorMessage: null }, now);
  }
  return task;
}
