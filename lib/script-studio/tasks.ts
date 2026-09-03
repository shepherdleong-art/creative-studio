import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ScriptStudioError } from './errors.ts';
import { parseScriptStudioRequestedCount } from './generation-contract.ts';
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
  /** 冻结知识上下文指纹：不同策略/模板版本得到不同 key，不能误复用旧任务。 */
  knowledgeFingerprint?: string;
}

/**
 * 自动幂等键必须覆盖任务的完整执行身份；尤其是同一供应商记录切换模型后，
 * 新提交不得命中旧模型任务。知识/模板目录版本也参与派生 key。
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
      input.knowledgeFingerprint || '',
    ].join('|'))
    .digest('hex');
}

/** 递归地把对象键按字典序排序，得到稳定的规范化结构（数组顺序不变）。 */
function normalizeSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSnapshotValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = normalizeSnapshotValue(record[key]);
    return sorted;
  }
  return value;
}

/**
 * Canonical 请求身份（F2）：覆盖 CreateTaskInput 的全部持久字段——projectId、
 * mode、sourceSetId、libraryRevisionId、requestedCount、parentTaskId，以及规范化后的
 * 完整 inputSnapshot（不漏未来字段）。requestKey 是唯一索引本身，不参与身份比较。
 * 快速预查命中与原子插入冲突回读必须用同一函数，同 key 不同 body 才能稳定 409。
 */
export function buildTaskIdentity(input: CreateTaskInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      projectId: input.projectId,
      mode: input.mode,
      sourceSetId: input.sourceSetId || null,
      libraryRevisionId: input.libraryRevisionId || null,
      requestedCount: input.requestedCount,
      parentTaskId: input.parentTaskId || null,
      inputSnapshot: normalizeSnapshotValue(input.inputSnapshot),
    }))
    .digest('hex');
}

/** 从已存任务行构造其 canonical 身份（与 buildTaskIdentity 同构）。 */
export function taskStoredIdentity(
  task: Pick<ScriptStudioTaskRecord, 'projectId' | 'mode' | 'sourceSetId' | 'libraryRevisionId' | 'requestedCount' | 'parentTaskId' | 'inputSnapshotJson'>,
): string {
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = JSON.parse(task.inputSnapshotJson || '{}') as Record<string, unknown>;
  } catch {
    snapshot = {};
  }
  return createHash('sha256')
    .update(JSON.stringify({
      projectId: task.projectId,
      mode: task.mode,
      sourceSetId: task.sourceSetId || null,
      libraryRevisionId: task.libraryRevisionId || null,
      requestedCount: task.requestedCount,
      parentTaskId: task.parentTaskId || null,
      inputSnapshot: normalizeSnapshotValue(snapshot),
    }))
    .digest('hex');
}

/** 两个 canonical 身份是否一致（快速预查与冲突回读共用的比较器）。 */
export function taskIdentitiesMatch(left: string, right: string): boolean {
  return left === right;
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

/**
 * 数据库层的原子 get-or-create：先校验数量（非法直接拒绝、不落库），再
 * `INSERT ... ON CONFLICT(projectId, requestKey) DO NOTHING` 后回读。
 * - 本次插入成功 → created:true；
 * - 命中既有任务 → 用 canonical identity 比较：一致 created:false，不一致 409 conflict。
 * 并发正确性由这个函数保证；route 外层预查只是快速路径，不再承担并发正确性。
 *
 * `ON CONFLICT DO NOTHING` 已在 SQL 层把唯一冲突处理成 0 行插入，所以这里**不**用
 * try/catch 吞错误：唯一冲突外的失败（NOT NULL、FK、磁盘满、schema 未就绪……）必须
 * 原样上抛，让调用方看到真实原因，而不是被伪装成 conflict。
 */
export function createTask(
  db: Database.Database,
  input: CreateTaskInput,
  now?: () => Date,
): { task: TaskView; created: boolean } {
  // 非法数量在写库前拒绝（F1）：不落库、不掩盖非法输入。
  const requestedCount = parseScriptStudioRequestedCount(input.requestedCount);
  const identity = buildTaskIdentity({ ...input, requestedCount });
  const createdAt = nowIso(now);
  const id = randomUUID();
  const result = db.prepare(`
    INSERT INTO script_studio_tasks
      (id, projectId, requestKey, mode, sourceSetId, libraryRevisionId, inputSnapshotJson,
       requestedCount, succeededCount, failedCount, status, currentStage, errorCode, errorMessage,
       leaseUntil, attemptCount, parentTaskId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'queued', '', NULL, NULL, NULL, 0, ?, ?, ?)
    ON CONFLICT(projectId, requestKey) DO NOTHING
  `).run(
    id,
    input.projectId,
    input.requestKey,
    input.mode,
    input.sourceSetId || null,
    input.libraryRevisionId || null,
    JSON.stringify(input.inputSnapshot),
    requestedCount,
    input.parentTaskId || null,
    createdAt,
    createdAt,
  );
  const inserted = result.changes > 0;
  const row = db.prepare(`
    SELECT * FROM script_studio_tasks WHERE projectId = ? AND requestKey = ?
  `).get(input.projectId, input.requestKey) as ScriptStudioTaskRecord | undefined;
  // 防御性兜底：插入成功但回读不到行属于内部异常（正常路径不可达），
  // 不能用 conflict 码——那是给「同 key 不同 body」的语义。这里抛普通 Error，
  // 经 errorResponse 落成 500 且保留真实信息。
  if (!row) throw new Error(`任务创建失败：插入后未能回读到任务行（requestKey=${input.requestKey}）`);
  const task = getTask(db, input.projectId, row.id)!;
  if (inserted) return { task, created: true };
  if (taskIdentitiesMatch(taskStoredIdentity(task), identity)) return { task, created: false };
  throw new ScriptStudioError('conflict', '同一 requestKey 已对应不同请求内容，不能复用');
}

export interface TaskRequestParams {
  projectId: string;
  mode: 'first_extraction' | 'reuse';
  sourceSetId?: string | null;
  libraryRevisionId?: string | null;
  targetDurationSec: number;
  requestedCount: number;
  creativeBrief: string;
  targetScriptId?: string;
  providerId: string;
  /** 显式幂等键（「再生成一组」的 action key）；缺省时按参数派生。 */
  explicitRequestKey?: string;
  /**
   * 冻结知识上下文（策略匹配 + 模板推荐）。在任务创建时解析一次写入快照，
   * runner 只读快照；其 fingerprint 参与派生 requestKey。
   */
  knowledgeContext?: Record<string, unknown>;
}

export interface TaskRequestDecision {
  requestKey: string;
  /** 命中既有任务（canonical identity 一致）→ 复用；否则为 null，走创建。 */
  existing: TaskView | null;
  /** 创建用的 inputSnapshot（含冻结的 providerId/providerModel）；复用路径为 null。 */
  snapshot: Record<string, unknown> | null;
}

/**
 * POST /tasks 的幂等决策（G5）：先走显式 key 快路径，命中既有任务就直接按冻结身份复用，
 * **不解析当前供应商**——丢包重试期间供应商被删/不可用也不影响安全重放；只有确认要创建
 * （显式 key 未命中，或派生 key）才调用 resolveProviders，冻结实际 providerId/providerModel
 * 参与派生 key 与创建快照。resolveProviders 每个请求至多调用一次。
 */
export function decideTaskRequest(
  db: Database.Database,
  input: TaskRequestParams,
  resolveProviders: (providerId: string) => { vision: { id: string; model: string } },
): TaskRequestDecision {
  const buildSnapshot = (pv: { id: string; model: string }, knowledgeContext?: Record<string, unknown>): Record<string, unknown> => ({
    targetDurationSec: input.targetDurationSec,
    requestedCount: input.requestedCount,
    creativeBrief: input.creativeBrief,
    providerId: pv.id,
    providerModel: pv.model,
    ...(input.targetScriptId ? { targetScriptId: input.targetScriptId } : {}),
    ...(knowledgeContext ? { knowledgeContext } : {}),
  });
  const knowledgeFingerprint = input.knowledgeContext
    && typeof input.knowledgeContext.fingerprint === 'string'
    ? input.knowledgeContext.fingerprint
    : '';
  const reuseIfMatches = (existing: TaskView, requestKey: string): TaskView => {
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(existing.inputSnapshotJson || '{}') as Record<string, unknown>;
    } catch {
      stored = {};
    }
    const storedProvider = {
      id: typeof stored.providerId === 'string' ? stored.providerId : '',
      model: typeof stored.providerModel === 'string' ? stored.providerModel : '',
    };
    const candidateIdentity = buildTaskIdentity({
      projectId: input.projectId,
      requestKey,
      mode: input.mode,
      sourceSetId: input.sourceSetId ?? null,
      libraryRevisionId: input.libraryRevisionId ?? null,
      requestedCount: input.requestedCount,
      parentTaskId: existing.parentTaskId,
      // 重放身份一律用已冻结快照里的知识上下文（provider 同理）：
      // 目录/卖点库切换后重试同一次动作不得按当前状态重算而误判冲突。
      inputSnapshot: buildSnapshot(storedProvider, stored.knowledgeContext as Record<string, unknown> | undefined),
    });
    if (!taskIdentitiesMatch(taskStoredIdentity(existing), candidateIdentity)) {
      throw new ScriptStudioError('conflict', '同一 requestKey 已对应不同请求内容，不能复用');
    }
    return existing;
  };

  const explicitKey = input.explicitRequestKey?.trim() || '';
  if (explicitKey) {
    const existing = getTaskByRequestKey(db, input.projectId, explicitKey);
    if (existing) return { requestKey: explicitKey, existing: reuseIfMatches(existing, explicitKey), snapshot: null };
    // 显式 key 未命中：需要创建，此刻才解析当前供应商。
    const providers = resolveProviders(input.providerId);
    return { requestKey: explicitKey, existing: null, snapshot: buildSnapshot(providers.vision, input.knowledgeContext) };
  }
  // 派生 key：解析当前供应商构造 key（key 含 providerId/model 与知识指纹），再查既有任务。
  const providers = resolveProviders(input.providerId);
  const requestKey = createScriptStudioTaskRequestKey({
    projectId: input.projectId,
    mode: input.mode,
    sourceSetId: input.sourceSetId ?? null,
    libraryRevisionId: input.libraryRevisionId ?? null,
    targetDurationSec: input.targetDurationSec,
    requestedCount: input.requestedCount,
    creativeBrief: input.creativeBrief,
    providerId: providers.vision.id,
    providerModel: providers.vision.model,
    knowledgeFingerprint,
  });
  const existing = getTaskByRequestKey(db, input.projectId, requestKey);
  if (existing) return { requestKey, existing: reuseIfMatches(existing, requestKey), snapshot: null };
  return { requestKey, existing: null, snapshot: buildSnapshot(providers.vision, input.knowledgeContext) };
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

/** 最近任务列表（倒序），供前端刷新后恢复运行中任务。 */
export function listRecentTasks(
  db: Database.Database,
  projectId: string,
  limit: number,
): TaskView[] {
  const rows = db.prepare(`
    SELECT id FROM script_studio_tasks WHERE projectId = ? ORDER BY createdAt DESC, id DESC LIMIT ?
  `).all(projectId, Math.max(1, Math.min(100, Math.floor(limit) || 10))) as Array<{ id: string }>;
  return rows
    .map((row) => getTask(db, projectId, row.id))
    .filter((task): task is TaskView => Boolean(task));
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
