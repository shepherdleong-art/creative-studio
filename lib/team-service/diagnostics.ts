import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ExecutionErrorCapture } from '../media-core/execution/context.ts';
import { getTaskPrincipal } from './task-principals.ts';

export const TEAM_ERROR_STAGES = [
  'upload', 'remote_submit', 'remote_poll', 'download', 'local_media',
  'client_update', 'client_ui', 'server_release', 'server_config', 'server_api', 'storage',
] as const;
export type TeamErrorStage = typeof TEAM_ERROR_STAGES[number];
export type TeamErrorOrigin = 'server' | 'server_api' | 'worker' | 'client';
export type TeamErrorOutcome = 'final' | 'recovered';

export interface TeamViewer {
  userId: string;
  role: 'employee' | 'admin';
}

export class TeamDiagnosticsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TeamDiagnosticsError';
    this.status = status;
    this.code = code;
  }
}

export interface TeamErrorView {
  errorId: string;
  actorUserId: string;
  employeeId?: string;
  actorDisplayName?: string;
  module: string;
  taskId: string | null;
  operationId: string | null;
  attemptId: string | null;
  transferId: string | null;
  phase: string | null;
  scope: { resourceType: string; resourceId: string } | null;
  stage: TeamErrorStage;
  code: string;
  statusCode: number | null;
  safeMessage: string;
  actionHint: string;
  origin: TeamErrorOrigin;
  outcome: TeamErrorOutcome;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  eventKey: string | null;
  scopeName: string | null;
  model: string | null;
  taskHref: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  configVersion: string | null;
  createdAt: string;
}

interface ErrorRow {
  providerSnapshotJson?: string | null;
  remotePollRecovered?: number;
  id: string;
  actorUserId: string;
  employeeId?: string;
  displayName?: string;
  module: string;
  taskId: string | null;
  operationId: string | null;
  attemptId: string | null;
  transferId: string | null;
  phase: string | null;
  scopeType: string | null;
  scopeId: string | null;
  stage: TeamErrorStage;
  code: string;
  statusCode: number | null;
  safeMessage: string;
  actionHint: string;
  origin: TeamErrorOrigin;
  outcome: TeamErrorOutcome;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  eventKey: string | null;
  scopeName: string | null;
  model: string | null;
  taskHref: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  configVersion: string | null;
  createdAt: string;
}

function associationForResource(db: Database.Database, resourceType: string, resourceId: string): (ExecutionAssociation & { attemptId: string | null }) | null {
  const operation = db.prepare(`
    SELECT id AS operationId, actorId, module, taskId, scopeType, scopeId,
      configVersion, clientVersion, serverReleaseId, currentAttemptId
    FROM execution_operations WHERE scopeType = ? AND scopeId = ? ORDER BY updatedAt DESC, id DESC LIMIT 1
  `).get(resourceType, resourceId) as ExecutionAssociation | undefined;
  if (operation) {
    const latestAttempt = db.prepare('SELECT id FROM execution_attempts WHERE operationId = ? ORDER BY transportSeq DESC LIMIT 1')
      .pluck().get(operation.operationId) as string | undefined;
    return { ...operation, attemptId: latestAttempt ?? operation.currentAttemptId };
  }
  const principal = db.prepare(`
    SELECT actorUserId, module, taskId, scopeType, scopeId FROM team_task_principals
    WHERE scopeType = ? AND scopeId = ? ORDER BY createdAt DESC LIMIT 1
  `).get(resourceType, resourceId) as {
    actorUserId: string; module: string; taskId: string; scopeType: string; scopeId: string;
  } | undefined;
  if (!principal) return null;
  return {
    operationId: '', actorId: principal.actorUserId, module: principal.module,
    taskId: principal.taskId, scopeType: principal.scopeType, scopeId: principal.scopeId,
    configVersion: null, clientVersion: null, serverReleaseId: null,
    currentAttemptId: null, attemptId: null,
  };
}

interface ExecutionAssociation {
  operationId: string;
  actorId: string;
  module: string;
  taskId: string;
  scopeType: string;
  scopeId: string;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  currentAttemptId: string | null;
  attemptId?: string | null;
  model?: string | null;
}

const STAGE_MESSAGES: Record<TeamErrorStage, string> = {
  upload: '上传失败，请检查本机磁盘和网络后重试。',
  remote_submit: '上游提交失败，请凭错误编号联系管理员核查。',
  remote_poll: '上游结果查询失败，请凭错误编号联系管理员核查。',
  download: '下载失败，请检查网络和本机磁盘后重试。',
  local_media: '本地媒体处理失败，请凭错误编号联系管理员核查。',
  client_update: '客户端更新失败，当前版本仍保留，请联系管理员修复。',
  client_ui: '客户端界面运行失败，请凭错误编号联系管理员核查。',
  server_release: '服务端发布失败，请联系管理员检查发布记录。',
  server_config: '服务端配置不可用，请联系管理员检查配置版本。',
  server_api: '服务端处理请求时发生故障，请稍后重试；若持续失败，请凭错误编号联系管理员。',
  storage: '结果保存或存储处理失败，请检查服务磁盘后重试；若持续失败，请联系管理员。',
};

export function teamErrorActionHint(stage: TeamErrorStage): string {
  if (stage === 'download') return '确认网络和服务磁盘可用后重试下载，不要重新提交已受理的生成任务。';
  if (stage === 'storage' || stage === 'local_media') return '保留当前任务，检查服务磁盘与媒体运行环境后重试；不要重复提交已受理任务。';
  if (stage === 'server_api') return '稍后重试当前操作；若持续失败，请将错误编号提供给管理员排查。';
  if (stage === 'remote_poll') return '保留任务并继续核查远端结果；不要重复提交生成，必要时凭错误编号联系管理员。';
  return '按当前任务提供的重试入口操作；若仍失败，请凭错误编号联系管理员。';
}

function teamErrorOrigin(stage: TeamErrorStage): TeamErrorOrigin {
  if (['upload', 'download', 'client_update', 'client_ui'].includes(stage)) return 'client';
  if (stage === 'server_api') return 'server_api';
  if (['local_media', 'storage'].includes(stage)) return 'worker';
  return 'server';
}

const EXPECTED_ERROR_CODES = new Set([
  'cancelled', 'stage_canceled', 'aborted', 'abort_error', 'invalid_input', 'invalid_request',
  'invalid_receipt', 'validation_failed', 'bad_request', 'not_found', 'csrf_invalid',
  'execution_deferred', 'execution_not_ready', 'pool_capacity', 'personal_concurrency',
]);

export function isReportableTeamError(code: string): boolean {
  return !EXPECTED_ERROR_CODES.has(code) && !/^(?:cancel|abort)/i.test(code);
}

export function safeTeamProviderModel(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const safeToken = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^[a-z0-9][a-z0-9_./:+-]{0,119}$/i.test(trimmed) ? trimmed : null;
  };
  const record = snapshot as Record<string, unknown>;
  for (const key of ['requestModel', 'model', 'modelAlias']) {
    const model = safeToken(record[key]);
    if (model) return model;
  }
  for (const key of ['provider', 'providerConfig', 'snapshot']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const model = safeTeamProviderModel(nested);
      if (model) return model;
    }
  }
  return null;
}

function requiredToken(value: unknown, fallback: string, maximum = 80): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return /^[a-z][a-z0-9_.-]*$/i.test(normalized) && normalized.length <= maximum
    ? normalized
    : fallback;
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/i.test(value) ? value : null;
}

function optionalVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9_.-]*$/i.test(normalized) && normalized.length <= 80 ? normalized : null;
}

function optionalStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : null;
}

function safeProviderSnapshotModel(serialized: string | null | undefined): string | null {
  if (!serialized) return null;
  try { return safeTeamProviderModel(JSON.parse(serialized)); } catch { return null; }
}

function mapError(row: ErrorRow): TeamErrorView {
  const remotePollRecovered = row.remotePollRecovered === 1;
  return {
    errorId: row.id,
    actorUserId: row.actorUserId,
    ...(row.employeeId !== undefined ? { employeeId: row.employeeId } : {}),
    ...(row.displayName !== undefined ? { actorDisplayName: row.displayName } : {}),
    module: row.module,
    taskId: row.taskId,
    operationId: row.operationId,
    attemptId: row.attemptId,
    transferId: row.transferId ?? null,
    phase: row.phase ?? null,
    scope: row.scopeType && row.scopeId
      ? { resourceType: row.scopeType, resourceId: row.scopeId }
      : null,
    stage: row.stage,
    code: row.code,
    statusCode: row.statusCode,
    safeMessage: STAGE_MESSAGES[row.stage] ?? '发生故障，请凭错误编号联系管理员。',
    actionHint: remotePollRecovered
      ? '该任务已有成功结果，历史诊断已保留，无需重复生成。'
      : teamErrorActionHint(row.stage),
    origin: ['server', 'server_api', 'worker', 'client'].includes(row.origin)
      ? row.origin as TeamErrorOrigin : teamErrorOrigin(row.stage),
    outcome: remotePollRecovered || row.outcome === 'recovered' ? 'recovered' : 'final',
    resolvedAt: row.resolvedAt ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    eventKey: row.eventKey ?? null,
    scopeName: row.scopeName ?? null,
    model: row.model ?? safeProviderSnapshotModel(row.providerSnapshotJson),
    taskHref: row.taskId ? `/team/errors/${encodeURIComponent(row.id)}/task` : null,
    clientVersion: optionalVersion(row.clientVersion),
    serverReleaseId: optionalVersion(row.serverReleaseId),
    configVersion: optionalVersion(row.configVersion),
    createdAt: row.createdAt,
  };
}

/** 原 attempt 或同一统一制作任务的备用通道成功，表示远端错误已恢复；不跨人工重开的生成轮次。 */
function recoveredRemotePollSql(db: Database.Database): string {
  if (!tableExists(db, 'execution_attempts')) return '0';
  const successfulAttempt = `(e.code = 'provider_poll_failed' AND EXISTS (
    SELECT 1 FROM execution_attempts recovered_attempt
    WHERE recovered_attempt.id = e.attemptId AND recovered_attempt.operationId = e.operationId
      AND recovered_attempt.terminalState = 'succeeded'
  ))`;
  const successfulUnifiedTask = tableExists(db, 'execution_media_tasks') && tableExists(db, 'execution_operations')
    ? `(e.code IN ('provider_poll_failed', 'provider_failed') AND EXISTS (
      SELECT 1 FROM execution_attempts original_attempt
      JOIN execution_operations original_operation ON original_operation.id = original_attempt.operationId
      JOIN execution_media_tasks recovered_task ON recovered_task.id = original_operation.mediaTaskId
      WHERE original_attempt.id = e.attemptId AND original_operation.id = e.operationId
        AND recovered_task.taskId = e.taskId AND recovered_task.module = e.module
        AND recovered_task.actorId = e.actorUserId AND recovered_task.status = 'succeeded'
    ))`
    : '0';
  return `(e.stage = 'remote_poll' AND (${successfulAttempt} OR ${successfulUnifiedTask}))`;
}

function getError(db: Database.Database, errorId: string): TeamErrorView | null {
  const row = db.prepare(`SELECT e.*, ${recoveredRemotePollSql(db)} AS remotePollRecovered
    FROM team_error_records e WHERE e.id = ?`).get(errorId) as ErrorRow | undefined;
  return row ? mapError(row) : null;
}

function associationForAttempt(db: Database.Database, attemptId: string): (ExecutionAssociation & { attemptId: string }) | null {
  const row = db.prepare(`
    SELECT o.id AS operationId, o.actorId, o.module, o.taskId, o.scopeType, o.scopeId,
      o.configVersion, o.clientVersion, o.serverReleaseId, o.currentAttemptId,
      a.providerSnapshotJson, a.id AS attemptId
    FROM execution_attempts a JOIN execution_operations o ON o.id = a.operationId
    WHERE a.id = ?
  `).get(attemptId) as (ExecutionAssociation & { attemptId: string }) | undefined;
  return row ?? null;
}

function associationForTask(db: Database.Database, taskId: string): (ExecutionAssociation & { attemptId: string | null }) | null {
  const operation = db.prepare(`
    SELECT id AS operationId, actorId, module, taskId, scopeType, scopeId,
      configVersion, clientVersion, serverReleaseId, currentAttemptId
    FROM execution_operations WHERE taskId = ? ORDER BY updatedAt DESC, id DESC LIMIT 1
  `).get(taskId) as ExecutionAssociation | undefined;
  if (operation) {
    const latestAttempt = db.prepare(`
      SELECT id FROM execution_attempts WHERE operationId = ? ORDER BY transportSeq DESC LIMIT 1
    `).pluck().get(operation.operationId) as string | undefined;
    return { ...operation, attemptId: latestAttempt ?? operation.currentAttemptId };
  }
  const principal = db.prepare(`
    SELECT actorUserId, module, taskId, scopeType, scopeId
    FROM team_task_principals WHERE taskId = ? ORDER BY createdAt DESC LIMIT 1
  `).get(taskId) as {
    actorUserId: string; module: string; taskId: string; scopeType: string; scopeId: string;
  } | undefined;
  if (!principal) return null;
  return {
    operationId: '', actorId: principal.actorUserId, module: principal.module,
    taskId: principal.taskId, scopeType: principal.scopeType, scopeId: principal.scopeId,
    configVersion: null, clientVersion: null, serverReleaseId: null,
    currentAttemptId: null, attemptId: null,
  };
}

export interface RecordTeamErrorInput {
  actorUserId: string;
  module: string;
  taskId?: string | null;
  operationId?: string | null;
  attemptId?: string | null;
  transferId?: string | null;
  phase?: string | null;
  scope?: { resourceType: string; resourceId: string } | null;
  stage: TeamErrorStage;
  code: string;
  statusCode?: number | null;
  safeMessage?: string;
  clientVersion?: string | null;
  serverReleaseId?: string | null;
  configVersion?: string | null;
  clientEventId?: string | null;
  eventKey?: string | null;
  origin?: TeamErrorOrigin;
  outcome?: TeamErrorOutcome;
}

export function recordTeamError(db: Database.Database, input: RecordTeamErrorInput): TeamErrorView {
  if (!TEAM_ERROR_STAGES.includes(input.stage)) {
    throw new TeamDiagnosticsError(400, 'invalid_error_stage', '错误阶段无效。');
  }
  const associated = input.attemptId ? associationForAttempt(db, input.attemptId) : null;
  const actorUserId = associated?.actorId ?? input.actorUserId;
  const clientEventId = optionalId(input.clientEventId);
  const eventKey = input.eventKey?.trim().slice(0, 240) || null;
  const outcome = input.outcome === 'recovered' ? 'recovered' : 'final';
  if (eventKey) {
    const existing = db.prepare('SELECT id FROM team_error_records WHERE eventKey = ?').pluck().get(eventKey) as string | undefined;
    if (existing) {
      if (outcome === 'recovered') db.prepare("UPDATE team_error_records SET outcome = 'recovered' WHERE id = ? AND outcome = 'final'").run(existing);
      // 接口事件按路由去重；再次请求失败时需要重新提醒，不能被过去的处理永久隐藏。
      if (input.stage === 'server_api' && outcome === 'final') {
        db.prepare("UPDATE team_error_records SET resolvedAt = NULL, resolvedByUserId = NULL, outcome = 'final' WHERE id = ?").run(existing);
      }
      return getError(db, existing)!;
    }
  }
  if (clientEventId) {
    const existing = db.prepare('SELECT id FROM team_error_records WHERE actorUserId = ? AND clientEventId = ?')
      .pluck().get(actorUserId, clientEventId) as string | undefined;
    if (existing) return getError(db, existing)!;
  }
  const id = randomUUID();
  const stage = input.stage;
  db.prepare(`
    INSERT INTO team_error_records (
      id, actorUserId, module, taskId, operationId, attemptId, scopeType, scopeId,
      stage, code, statusCode, safeMessage, clientVersion, serverReleaseId,
      configVersion, clientEventId, transferId, phase, eventKey, origin, outcome, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, actorUserId,
    associated?.module ?? requiredToken(input.module, 'unknown', 60),
    associated?.taskId ?? input.taskId ?? null,
    associated?.operationId ?? input.operationId ?? null,
    associated?.attemptId ?? input.attemptId ?? null,
    associated?.scopeType ?? input.scope?.resourceType ?? null,
    associated?.scopeId ?? input.scope?.resourceId ?? null,
    stage, requiredToken(input.code, 'unknown_error'), optionalStatus(input.statusCode),
    STAGE_MESSAGES[stage],
    optionalVersion(input.clientVersion) ?? optionalVersion(associated?.clientVersion),
    optionalVersion(input.serverReleaseId) ?? optionalVersion(associated?.serverReleaseId),
    optionalVersion(input.configVersion) ?? optionalVersion(associated?.configVersion),
    clientEventId, optionalId(input.transferId),
    requiredToken(input.phase, '', 80) || null,
    eventKey, input.origin ?? teamErrorOrigin(stage), outcome, new Date().toISOString(),
  );
  return getError(db, id)!;
}

export function recordTeamExecutionError(db: Database.Database, input: ExecutionErrorCapture & {
  serverReleaseId?: string;
  diagnosticOutcome?: TeamErrorOutcome;
}): TeamErrorView | null {
  const executionAssociation = input.attemptId ? associationForAttempt(db, input.attemptId) : null;
  const principal = !executionAssociation && input.module && input.taskId
    ? getTaskPrincipal(db, input.module, input.taskId) : null;
  if (principal && input.actorUserId && principal.actorUserId !== input.actorUserId) return null;
  const association = executionAssociation ?? (principal ? {
    operationId: '', actorId: principal.actorUserId, module: principal.module, taskId: principal.taskId,
    scopeType: principal.scope.resourceType, scopeId: principal.scope.resourceId,
    configVersion: null, clientVersion: null, serverReleaseId: null, currentAttemptId: null,
  } : null);
  if (!association) throw new TeamDiagnosticsError(404, 'attempt_not_found', '执行尝试不存在。');
  const code = requiredToken(input.errorCode, 'execution_failed');
  if (!isReportableTeamError(code)) return null;
  const existing = input.attemptId ? db.prepare(`
    SELECT id FROM team_error_records WHERE attemptId = ? AND stage = ? AND code = ?
  `).pluck().get(input.attemptId, input.stage, code) as string | undefined : undefined;
  if (existing) return getError(db, existing)!;
  const taskIdentity = `${association.actorId}:${association.module}:${association.taskId}:${input.stage}:${code}`;
  const eventKey = input.eventKey ?? (input.attemptId
    ? `attempt:${input.attemptId}:${input.stage}:${code}`
    : `task:${createHash('sha256').update(taskIdentity).digest('hex')}`);
  return recordTeamError(db, {
    actorUserId: association.actorId,
    module: association.module,
    attemptId: input.attemptId ?? null,
    operationId: executionAssociation?.operationId || null,
    taskId: association.taskId,
    scope: { resourceType: association.scopeType, resourceId: association.scopeId },
    stage: input.stage,
    code,
    serverReleaseId: input.serverReleaseId,
    eventKey,
    origin: 'worker',
    outcome: input.diagnosticOutcome,
  });
}

export function markTeamTaskErrorRecovered(
  db: Database.Database,
  input: { taskId: string; module: string; stage: 'download' | 'storage' },
): void {
  db.prepare("UPDATE team_error_records SET outcome = 'recovered' WHERE taskId = ? AND module = ? AND stage IN ('download', 'storage') AND outcome = 'final'")
    .run(input.taskId, input.module);
}

export function reportClientError(
  db: Database.Database,
  viewer: TeamViewer,
  input: {
    clientEventId?: string;
    taskId?: string;
    stage: TeamErrorStage;
    code: string;
    statusCode?: number;
    message?: string;
    actorUserId?: string;
    operationId?: string;
    attemptId?: string;
    resourceType?: string;
    resourceId?: string;
    transferId?: string;
    phase?: string;
  },
  versions: { clientVersion?: string; serverReleaseId?: string },
): TeamErrorView {
  const association = input.taskId?.trim()
    ? associationForTask(db, input.taskId.trim())
    : input.resourceType && input.resourceId
      ? associationForResource(db, requiredToken(input.resourceType, ''), input.resourceId)
      : null;
  const associationRequested = Boolean(input.taskId?.trim() || (input.resourceType && input.resourceId));
  if (associationRequested && (!association || (viewer.role !== 'admin' && association.actorId !== viewer.userId))) {
    throw new TeamDiagnosticsError(403, 'error_task_forbidden', '无法核验该任务的归属，错误上报已拒绝。');
  }
  const actorUserId = association?.actorId ?? viewer.userId;
  if (viewer.role !== 'admin' && actorUserId !== viewer.userId) {
    throw new TeamDiagnosticsError(403, 'error_actor_forbidden', '不能代其他成员上报错误。');
  }
  const clientEventId = optionalId(input.clientEventId);
  if (clientEventId) {
    const existing = db.prepare('SELECT id FROM team_error_records WHERE actorUserId = ? AND clientEventId = ?')
      .pluck().get(actorUserId, clientEventId) as string | undefined;
    if (existing) return getError(db, existing)!;
  }
  return recordTeamError(db, {
    actorUserId,
    module: association?.module ?? 'client',
    taskId: association?.taskId ?? input.taskId ?? null,
    operationId: association?.operationId || null,
    attemptId: association?.attemptId ?? null,
    scope: association ? { resourceType: association.scopeType, resourceId: association.scopeId } : null,
    stage: input.stage,
    code: input.code,
    statusCode: input.statusCode,
    clientEventId: input.clientEventId,
    transferId: input.transferId,
    phase: input.phase,
    origin: 'client',
    clientVersion: versions.clientVersion ?? association?.clientVersion,
    serverReleaseId: versions.serverReleaseId ?? association?.serverReleaseId,
    configVersion: association?.configVersion,
  });
}

export function getTeamErrorTask(
  db: Database.Database,
  viewer: TeamViewer,
  errorId: string,
) {
  const row = db.prepare('SELECT taskId FROM team_error_records WHERE id = ?').get(errorId) as { taskId: string | null } | undefined;
  if (!row?.taskId || !listTeamErrors(db, viewer, { errorId }).items.length) {
    throw new TeamDiagnosticsError(404, 'error_not_found', '错误记录不存在。');
  }
  return db.prepare(`SELECT o.id AS operationId, o.taskId, o.step, o.module,
    o.businessAttemptNo, o.inputRevision, o.createdAt, o.updatedAt,
    a.id AS attemptId, a.transportSeq, a.terminalState, a.errorCode,
    a.providerSnapshotJson
    FROM execution_operations o LEFT JOIN execution_attempts a ON a.operationId = o.id
    WHERE o.taskId = ? ORDER BY o.updatedAt DESC, a.transportSeq DESC LIMIT 100`).all(row.taskId)
    .map((value) => {
      const item = value as Record<string, unknown>;
      return {
        operationId: item.operationId, taskId: item.taskId, step: item.step, module: item.module,
        businessAttemptNo: item.businessAttemptNo, inputRevision: item.inputRevision,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
        attemptId: item.attemptId ?? null, transportSeq: item.transportSeq ?? null,
        terminalState: item.terminalState ?? null, errorCode: item.errorCode ?? null,
        model: safeProviderSnapshotModel(item.providerSnapshotJson as string | null),
      };
    });
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function resolveTeamError(db: Database.Database, viewer: TeamViewer, errorId: string): TeamErrorView {
  const row = getError(db, errorId);
  if (!row || (viewer.role !== 'admin' && row.actorUserId !== viewer.userId)) {
    throw new TeamDiagnosticsError(404, 'error_not_found', '错误记录不存在。');
  }
  db.prepare(`UPDATE team_error_records SET resolvedAt = ?, resolvedByUserId = ?
    WHERE id = ? AND resolvedAt IS NULL`).run(new Date().toISOString(), viewer.userId, errorId);
  return getError(db, errorId)!;
}

export function listTeamErrors(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { errorId?: string; actorUserId?: string; actionableOnly?: boolean } = {},
): { items: TeamErrorView[] } {
  if (viewer.role !== 'admin' && filters.actorUserId && filters.actorUserId !== viewer.userId) {
    throw new TeamDiagnosticsError(403, 'error_query_forbidden', '只能查询本人的错误。');
  }
  const clauses: string[] = [];
  const values: string[] = [];
  const recoveredRemotePoll = recoveredRemotePollSql(db);
  if (filters.actionableOnly) clauses.push(`e.outcome = 'final' AND e.resolvedAt IS NULL AND NOT ${recoveredRemotePoll}`);
  const actorUserId = viewer.role === 'admin' ? filters.actorUserId : viewer.userId;
  if (actorUserId) {
    clauses.push('e.actorUserId = ?');
    values.push(actorUserId);
  }
  if (filters.errorId) {
    clauses.push('e.id = ?');
    values.push(filters.errorId);
  }
  const rows = db.prepare(`
    SELECT e.*, u.employeeId, u.displayName, ${recoveredRemotePoll} AS remotePollRecovered,
      ${tableExists(db, 'execution_attempts')
        ? '(SELECT providerSnapshotJson FROM execution_attempts a WHERE a.id = e.attemptId)'
        : 'NULL'} AS providerSnapshotJson
    FROM team_error_records e
    JOIN team_users u ON u.id = e.actorUserId
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY e.createdAt DESC, e.id DESC LIMIT 500
  `).all(...values) as ErrorRow[];
  return { items: rows.map((row) => {
    const value = row as ErrorRow & { providerSnapshotJson?: string | null };
    let model: string | null = null;
    if (value.providerSnapshotJson) {
      try { model = safeTeamProviderModel(JSON.parse(value.providerSnapshotJson)); } catch { model = null; }
    }
    const scopeName = value.scopeType === 'project' && tableExists(db, 'projects')
      ? db.prepare('SELECT name FROM projects WHERE id = ?').pluck().get(value.scopeId) as string | undefined
      : value.scopeType === 'canvas' && tableExists(db, 'creative_canvases')
        ? db.prepare('SELECT name FROM creative_canvases WHERE id = ?').pluck().get(value.scopeId) as string | undefined
        : undefined;
    return mapError({ ...value, model, scopeName: scopeName ?? null });
  }) };
}

export function getTeamErrorDiagnostic(
  db: Database.Database,
  viewer: TeamViewer,
  errorId: string,
) {
  const row = db.prepare(`SELECT e.*, a.providerSnapshotJson,
    ${recoveredRemotePollSql(db)} AS remotePollRecovered FROM team_error_records e
    LEFT JOIN execution_attempts a ON a.id = e.attemptId WHERE e.id = ?`).get(errorId) as ErrorRow | undefined;
  if (!row || (viewer.role !== 'admin' && row.actorUserId !== viewer.userId)) {
    throw new TeamDiagnosticsError(404, 'error_not_found', '错误记录不存在。');
  }
  const error = mapError(row);
  return {
    schemaVersion: 1 as const,
    errorId: error.errorId,
    createdAt: error.createdAt,
    module: error.module,
    stage: error.stage,
    code: error.code,
    statusCode: error.statusCode,
    safeMessage: error.safeMessage,
    actionHint: error.actionHint,
    origin: error.origin,
    outcome: error.outcome,
    eventKey: error.eventKey,
    actorUserId: error.actorUserId,
    model: error.model,
    taskId: error.taskId,
    operationId: error.operationId,
    attemptId: error.attemptId,
    transferId: error.transferId,
    phase: error.phase,
    scope: error.scope,
    clientVersion: error.clientVersion,
    serverReleaseId: error.serverReleaseId,
    configVersion: error.configVersion,
  };
}
