import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const TEAM_ERROR_STAGES = [
  'upload', 'remote_submit', 'remote_poll', 'download', 'local_media',
  'client_update', 'client_ui', 'server_release', 'server_config',
] as const;
export type TeamErrorStage = typeof TEAM_ERROR_STAGES[number];

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
  clientVersion: string | null;
  serverReleaseId: string | null;
  configVersion: string | null;
  createdAt: string;
}

interface ErrorRow {
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
  clientVersion: string | null;
  serverReleaseId: string | null;
  configVersion: string | null;
  createdAt: string;
}

function associationForResource(db: Database.Database, resourceType: string, resourceId: string): ExecutionAssociation | null {
  const operation = db.prepare(`
    SELECT id AS operationId, actorId, module, taskId, scopeType, scopeId,
      configVersion, clientVersion, serverReleaseId, currentAttemptId
    FROM execution_operations WHERE scopeType = ? AND scopeId = ? ORDER BY updatedAt DESC, id DESC LIMIT 1
  `).get(resourceType, resourceId) as ExecutionAssociation | undefined;
  if (operation) return operation;
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
    currentAttemptId: null,
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
};

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

function mapError(row: ErrorRow): TeamErrorView {
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
    safeMessage: row.safeMessage,
    clientVersion: optionalVersion(row.clientVersion),
    serverReleaseId: optionalVersion(row.serverReleaseId),
    configVersion: optionalVersion(row.configVersion),
    createdAt: row.createdAt,
  };
}

function getError(db: Database.Database, errorId: string): TeamErrorView | null {
  const row = db.prepare('SELECT * FROM team_error_records WHERE id = ?').get(errorId) as ErrorRow | undefined;
  return row ? mapError(row) : null;
}

function associationForAttempt(db: Database.Database, attemptId: string): (ExecutionAssociation & { attemptId: string }) | null {
  const row = db.prepare(`
    SELECT o.id AS operationId, o.actorId, o.module, o.taskId, o.scopeType, o.scopeId,
      o.configVersion, o.clientVersion, o.serverReleaseId, o.currentAttemptId, a.id AS attemptId
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
}

export function recordTeamError(db: Database.Database, input: RecordTeamErrorInput): TeamErrorView {
  if (!TEAM_ERROR_STAGES.includes(input.stage)) {
    throw new TeamDiagnosticsError(400, 'invalid_error_stage', '错误阶段无效。');
  }
  const associated = input.attemptId ? associationForAttempt(db, input.attemptId) : null;
  const actorUserId = associated?.actorId ?? input.actorUserId;
  const clientEventId = optionalId(input.clientEventId);
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
      configVersion, clientEventId, transferId, phase, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    requiredToken(input.phase, '', 80) || null, new Date().toISOString(),
  );
  return getError(db, id)!;
}

export function recordTeamExecutionError(db: Database.Database, input: {
  attemptId: string;
  outcome: 'failed';
  errorCode?: string;
  stage: 'remote_submit' | 'remote_poll';
  serverReleaseId?: string;
}): TeamErrorView {
  const association = associationForAttempt(db, input.attemptId);
  if (!association) throw new TeamDiagnosticsError(404, 'attempt_not_found', '执行尝试不存在。');
  const code = requiredToken(input.errorCode, 'execution_failed');
  const existing = db.prepare(`
    SELECT id FROM team_error_records WHERE attemptId = ? AND stage = ? AND code = ?
  `).pluck().get(input.attemptId, input.stage, code) as string | undefined;
  if (existing) return getError(db, existing)!;
  return recordTeamError(db, {
    actorUserId: association.actorId,
    module: association.module,
    attemptId: input.attemptId,
    stage: input.stage,
    code,
    serverReleaseId: input.serverReleaseId,
  });
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
    clientVersion: versions.clientVersion ?? association?.clientVersion,
    serverReleaseId: versions.serverReleaseId ?? association?.serverReleaseId,
    configVersion: association?.configVersion,
  });
}

export function listTeamErrors(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { errorId?: string; actorUserId?: string } = {},
): { items: TeamErrorView[] } {
  if (viewer.role !== 'admin' && filters.actorUserId && filters.actorUserId !== viewer.userId) {
    throw new TeamDiagnosticsError(403, 'error_query_forbidden', '只能查询本人的错误。');
  }
  const clauses: string[] = [];
  const values: string[] = [];
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
    SELECT e.*, u.employeeId, u.displayName FROM team_error_records e
    JOIN team_users u ON u.id = e.actorUserId
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY e.createdAt DESC, e.id DESC LIMIT 500
  `).all(...values) as ErrorRow[];
  return { items: rows.map(mapError) };
}

export function getTeamErrorDiagnostic(
  db: Database.Database,
  viewer: TeamViewer,
  errorId: string,
) {
  const row = db.prepare('SELECT * FROM team_error_records WHERE id = ?').get(errorId) as ErrorRow | undefined;
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
