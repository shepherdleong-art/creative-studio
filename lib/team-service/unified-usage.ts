import type Database from 'better-sqlite3';
import {
  UNIFIED_KLING3_MODEL_KEY,
  unifiedMediaDisplayName,
} from '../media-core/unified-media/catalog.ts';
import type { TeamViewer } from './diagnostics.ts';
import {
  parseTeamPage,
  resolveTeamPage,
  type TeamPageParamInput,
  type TeamPagination,
} from './pagination.ts';
import type { TeamUsageFilters } from './usage.ts';
import {
  attemptCostStatus,
  summarizeUnifiedAttemptCosts,
  type UnifiedTaskCostStatus,
} from './unified-usage-contract.ts';

class UnifiedUsageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UnifiedUsageError';
    this.status = status;
    this.code = code;
  }
}

export interface TeamUnifiedAttemptView {
  attemptId: string;
  operationId: string;
  operationKey: string;
  inputRevision: string;
  submissionState: string;
  terminalState: string | null;
  remoteId: string | null;
  providerId: string | null;
  providerModel: string;
  reservedMinor: number;
  actualMinor: number | null;
  costStatus: 'settled' | 'estimated' | 'uncertain' | 'unpriced' | 'released';
  pricing: {
    coreModelKey: string | null;
    pricingVersion: string | null;
    priceComponents: unknown[] | null;
  } | null;
  errorCode: string | null;
  createdAt: string;
}

export interface TeamUnifiedChannelView {
  channelKey: string;
  providerId: string;
  providerModel: string;
  priority: number;
  state: string;
  executionRevision: number;
  operationId: string | null;
  operationStatus: string | null;
  operationWaitReason: string | null;
  remoteId: string | null;
  attempts: TeamUnifiedAttemptView[];
}

export interface TeamUnifiedTaskView {
  mediaTaskId: string;
  taskId: string;
  module: string;
  unifiedModel: string;
  model: string;
  ruleVersion: string;
  status: string;
  cancelRequestedAt: string | null;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  scope: { resourceType: string; resourceId: string };
  scopeName: string;
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  generationTaskCount: 1;
  channelCallCount: number;
  submissionCount: number;
  usedChannelCount: number;
  chargedMinor: number;
  settledMinor: number;
  estimatedMinor: number;
  uncertainMinor: number;
  unpricedCount: number;
  uncertainCount: number;
  releasedCount: number;
  costStatus: UnifiedTaskCostStatus;
  channels?: TeamUnifiedChannelView[];
}

interface TaskRow {
  id: string;
  actorId: string;
  scopeType: string;
  scopeId: string;
  module: string;
  taskId: string;
  unifiedModel: string;
  ruleVersion: string;
  status: string;
  cancelRequestedAt: string | null;
  sourceType: string;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  employeeId: string;
  actorDisplayName: string;
}

interface ChannelRow {
  mediaTaskId: string;
  channelKey: string;
  providerId: string;
  providerModel: string;
  priority: number;
  state: string;
  executionRevision: number;
  operationId: string | null;
  remoteId: string | null;
}

interface AttemptRow {
  mediaTaskId: string;
  channelKey: string;
  attemptId: string;
  operationId: string;
  operationKey: string;
  inputRevision: string;
  submissionState: string;
  terminalState: string | null;
  remoteId: string | null;
  providerSnapshotJson: string;
  pricingSnapshotJson: string | null;
  quoteJson: string | null;
  reservedMinor: number;
  actualMinor: number | null;
  costState: string;
  errorCode: string | null;
  intentJournalSeq: number | null;
  createdAt: string;
  operationStatus: string;
  operationWaitReason: string | null;
}

interface OperationRow {
  id: string;
  mediaTaskId: string;
  channelKey: string;
  operationKey: string;
  inputRevision: string;
  status: string;
  waitReason: string | null;
  quoteJson: string | null;
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parse(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function attemptModel(snapshot: Record<string, unknown> | null): {
  providerId: string | null;
  model: string;
} {
  const usageProvider = object(snapshot?.provider);
  return {
    providerId: text(snapshot?.providerId) ?? text(snapshot?.providerIdentity)
      ?? text(snapshot?.id) ?? text(usageProvider?.providerId),
    model: text(snapshot?.requestModel) ?? text(snapshot?.modelAlias)
      ?? text(snapshot?.model) ?? text(usageProvider?.requestModel)
      ?? '未定价模型',
  };
}

function safePricing(snapshot: Record<string, unknown> | null): TeamUnifiedAttemptView['pricing'] {
  if (!snapshot) return null;
  return {
    coreModelKey: text(snapshot.coreModelKey),
    pricingVersion: text(snapshot.pricingVersion),
    priceComponents: Array.isArray(snapshot.priceComponents) ? snapshot.priceComponents : null,
  };
}

function scopedActor(viewer: TeamViewer, requested?: string): string | undefined {
  if (viewer.role === 'admin') return requested;
  if (requested && requested !== viewer.userId) {
    throw new UnifiedUsageError(403, 'usage_query_forbidden', '只能查询本人的用量。');
  }
  return viewer.userId;
}

function taskModelFilterValues(value: string): { unified: string | null; raw: string } {
  const unified = ['image2', UNIFIED_KLING3_MODEL_KEY]
    .find((key) => value === key || value === unifiedMediaDisplayName(key)) ?? null;
  return {
    unified,
    raw: value,
  };
}

function scopeNames(
  db: Database.Database,
  rows: readonly TaskRow[],
): Map<string, string> {
  const names = new Map<string, string>();
  const projectIds = [...new Set(rows.filter((row) => row.scopeType === 'project').map((row) => row.scopeId))];
  const canvasIds = [...new Set(rows.filter((row) => row.scopeType === 'canvas').map((row) => row.scopeId))];
  const hasTable = (name: string) => Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
  if (projectIds.length > 0 && hasTable('projects')) {
    for (const row of db.prepare(`SELECT id, name FROM projects
      WHERE id IN (${projectIds.map(() => '?').join(',')})`).all(...projectIds) as Array<{ id: string; name: string }>) {
      names.set(`project:${row.id}`, row.name);
    }
  }
  if (canvasIds.length > 0 && hasTable('creative_canvases')) {
    for (const row of db.prepare(`SELECT id, name FROM creative_canvases
      WHERE id IN (${canvasIds.map(() => '?').join(',')})`).all(...canvasIds) as Array<{ id: string; name: string }>) {
      names.set(`canvas:${row.id}`, row.name);
    }
  }
  return names;
}

const TASK_SELECT_COLUMNS = `t.id, t.actorId, t.scopeType, t.scopeId, t.module, t.taskId,
  t.unifiedModel, t.ruleVersion, t.status, t.cancelRequestedAt,
  t.sourceType, t.sourceId, t.createdAt, t.updatedAt,
  u.employeeId, u.displayName AS actorDisplayName`;

/**
 * 制作任务级筛选：权限、日期归属（任务创建在范围内，或范围内有真实尝试）、
 * 模型、结果、模块。列表分页、计数与按模型统计共用同一份条件，避免口径漂移。
 */
function taskFilter(
  viewer: TeamViewer,
  filters: TeamUsageFilters,
): { clauses: string[]; values: unknown[] } {
  const actorUserId = scopedActor(viewer, filters.actorUserId);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (actorUserId) { clauses.push('t.actorId = ?'); values.push(actorUserId); }
  if (filters.module) { clauses.push('t.module = ?'); values.push(filters.module); }
  const attemptExists: string[] = ['o.mediaTaskId = t.id'];
  const attemptValues: unknown[] = [];
  if (filters.from) { attemptExists.push('a.createdAt >= ?'); attemptValues.push(filters.from); }
  if (filters.to) { attemptExists.push('a.createdAt < ?'); attemptValues.push(filters.to); }
  if (filters.outcome) { attemptExists.push('a.terminalState = ?'); attemptValues.push(filters.outcome); }
  if (filters.outcome) {
    clauses.push(`EXISTS (
      SELECT 1 FROM execution_operations o
      JOIN execution_attempts a ON a.operationId = o.id
      WHERE ${attemptExists.join(' AND ')}
    )`);
    values.push(...attemptValues);
  } else if (filters.from || filters.to) {
    clauses.push(`(
      (${filters.from ? 't.createdAt >= ?' : '1 = 1'})
      ${filters.to ? 'AND t.createdAt < ?' : ''}
      OR EXISTS (
        SELECT 1 FROM execution_operations o
        JOIN execution_attempts a ON a.operationId = o.id
        WHERE ${attemptExists.join(' AND ')}
      )
    )`);
    if (filters.from) values.push(filters.from);
    if (filters.to) values.push(filters.to);
    values.push(...attemptValues);
  }
  if (filters.model) {
    const modelFilter = taskModelFilterValues(filters.model);
    if (modelFilter.unified) {
      clauses.push(`(t.unifiedModel = ? OR EXISTS (
        SELECT 1 FROM execution_operations o
        JOIN execution_attempts a ON a.operationId = o.id
        WHERE o.mediaTaskId = t.id AND (
          json_extract(a.providerSnapshotJson, '$.model') = ?
          OR json_extract(a.providerSnapshotJson, '$.requestModel') = ?
          OR json_extract(a.providerSnapshotJson, '$.modelAlias') = ?
        )
      ))`);
      values.push(modelFilter.unified, modelFilter.raw, modelFilter.raw, modelFilter.raw);
    } else {
      clauses.push(`EXISTS (
        SELECT 1 FROM execution_operations o
        JOIN execution_attempts a ON a.operationId = o.id
        WHERE o.mediaTaskId = t.id AND (
          json_extract(a.providerSnapshotJson, '$.model') = ?
          OR json_extract(a.providerSnapshotJson, '$.requestModel') = ?
          OR json_extract(a.providerSnapshotJson, '$.modelAlias') = ?
          OR json_extract(a.pricingSnapshotJson, '$.coreModelKey') = ?
        )
      )`);
      values.push(modelFilter.raw, modelFilter.raw, modelFilter.raw, modelFilter.raw);
    }
  }
  return { clauses, values };
}

function taskWhere(clauses: readonly string[]): string {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function taskRows(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters,
): TaskRow[] {
  const { clauses, values } = taskFilter(viewer, filters);
  return db.prepare(`
    SELECT ${TASK_SELECT_COLUMNS}
    FROM execution_media_tasks t
    JOIN team_users u ON u.id = t.actorId
    ${taskWhere(clauses)}
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(...values) as TaskRow[];
}

/** 全范围制作任务计数（授权与筛选在计数之前）。 */
export function countTeamUnifiedUsageTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): number {
  const { clauses, values } = taskFilter(viewer, filters);
  return Number(db.prepare(`
    SELECT COUNT(*) FROM execution_media_tasks t
    JOIN team_users u ON u.id = t.actorId
    ${taskWhere(clauses)}
  `).pluck().get(...values) ?? 0);
}

/** 按统一模型统计制作任务数（摘要模型排行用；任务数不是通道调用数）。 */
export function countUnifiedUsageTasksByModel(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): Array<{ unifiedModel: string; taskCount: number }> {
  const { clauses, values } = taskFilter(viewer, filters);
  return db.prepare(`
    SELECT t.unifiedModel AS unifiedModel, COUNT(*) AS taskCount
    FROM execution_media_tasks t
    JOIN team_users u ON u.id = t.actorId
    ${taskWhere(clauses)}
    GROUP BY t.unifiedModel
  `).all(...values) as Array<{ unifiedModel: string; taskCount: number }>;
}

function channelRows(db: Database.Database, taskIds: readonly string[]): ChannelRow[] {
  if (taskIds.length === 0) return [];
  return db.prepare(`SELECT mediaTaskId, channelKey, providerId, providerModel, priority,
    state, executionRevision, operationId, remoteId
    FROM execution_media_channels
    WHERE mediaTaskId IN (${taskIds.map(() => '?').join(',')})
    ORDER BY mediaTaskId, priority, channelKey`).all(...taskIds) as ChannelRow[];
}

function attemptRows(
  db: Database.Database,
  taskIds: readonly string[],
  filters: TeamUsageFilters,
): AttemptRow[] {
  if (taskIds.length === 0) return [];
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.from) { clauses.push('a.createdAt >= ?'); values.push(filters.from); }
  if (filters.to) { clauses.push('a.createdAt < ?'); values.push(filters.to); }
  if (filters.outcome) { clauses.push('a.terminalState = ?'); values.push(filters.outcome); }
  return db.prepare(`
    SELECT o.mediaTaskId, o.channelKey, a.id AS attemptId, a.operationId,
      o.operationKey, o.inputRevision, a.submissionState, a.terminalState, a.remoteId,
      a.providerSnapshotJson, a.pricingSnapshotJson, o.quoteJson,
      a.reservedMinor, a.actualMinor, a.costState, a.errorCode,
      a.intentJournalSeq, a.createdAt, o.status AS operationStatus,
      o.waitReason AS operationWaitReason
    FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId IN (${taskIds.map(() => '?').join(',')})
      ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
    ORDER BY a.createdAt, a.transportSeq, a.id
  `).all(...taskIds, ...values) as AttemptRow[];
}

function operationRows(db: Database.Database, taskIds: readonly string[]): OperationRow[] {
  if (taskIds.length === 0) return [];
  return db.prepare(`SELECT id, mediaTaskId, channelKey, operationKey, inputRevision,
    status, waitReason, quoteJson
    FROM execution_operations
    WHERE mediaTaskId IN (${taskIds.map(() => '?').join(',')})
    ORDER BY createdAt, id`).all(...taskIds) as OperationRow[];
}

function mapAttempt(row: AttemptRow): TeamUnifiedAttemptView {
  const provider = parse(row.providerSnapshotJson);
  const pricing = parse(row.pricingSnapshotJson);
  const quote = parse(row.quoteJson);
  const fact = attemptModel(provider);
  return {
    attemptId: row.attemptId,
    operationId: row.operationId,
    operationKey: row.operationKey,
    inputRevision: row.inputRevision,
    submissionState: row.submissionState,
    terminalState: row.terminalState,
    remoteId: row.remoteId,
    providerId: fact.providerId,
    providerModel: fact.model,
    reservedMinor: row.reservedMinor,
    actualMinor: row.actualMinor,
    costStatus: attemptCostStatus({
      quoteKind: text(quote?.kind) ?? 'unpriced',
      costState: row.costState,
      terminalState: row.terminalState,
      actualMinor: row.actualMinor,
    }),
    pricing: safePricing(pricing),
    errorCode: row.errorCode,
    createdAt: row.createdAt,
  };
}

function taskRowsByMediaTaskIds(
  db: Database.Database,
  viewer: TeamViewer,
  mediaTaskIds: readonly string[],
): TaskRow[] {
  if (mediaTaskIds.length === 0) return [];
  // 员工只能读到本人的统一任务；越权 ID 直接不返回（调用方本身已按授权范围取过 ID）。
  const actorClause = viewer.role === 'admin' ? '' : 'AND t.actorId = ?';
  const values: unknown[] = [...mediaTaskIds];
  if (viewer.role !== 'admin') values.push(viewer.userId);
  return db.prepare(`
    SELECT t.id, t.actorId, t.scopeType, t.scopeId, t.module, t.taskId,
      t.unifiedModel, t.ruleVersion, t.status, t.cancelRequestedAt,
      t.sourceType, t.sourceId, t.createdAt, t.updatedAt,
      u.employeeId, u.displayName AS actorDisplayName
    FROM execution_media_tasks t
    JOIN team_users u ON u.id = t.actorId
    WHERE t.id IN (${mediaTaskIds.map(() => '?').join(',')}) ${actorClause}
    ORDER BY t.createdAt DESC, t.id DESC
  `).all(...values) as TaskRow[];
}

function buildTaskViews(
  db: Database.Database,
  viewer: TeamViewer,
  rows: readonly TaskRow[],
  filters: TeamUsageFilters,
): TeamUnifiedTaskView[] {
  const names = scopeNames(db, rows);
  const taskIds = rows.map((row) => row.id);
  const channels = channelRows(db, taskIds);
  const operations = operationRows(db, taskIds);
  const attempts = attemptRows(db, taskIds, filters);
  const operationsByTaskChannel = new Map<string, OperationRow>();
  for (const operation of operations) {
    operationsByTaskChannel.set(
      `${operation.mediaTaskId}\u0000${operation.channelKey}`,
      operation,
    );
  }
  const attemptsByTaskChannel = new Map<string, TeamUnifiedAttemptView[]>();
  const rawAttemptsByTaskChannel = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const key = `${attempt.mediaTaskId}\u0000${attempt.channelKey}`;
    const group = attemptsByTaskChannel.get(key) ?? [];
    group.push(mapAttempt(attempt));
    attemptsByTaskChannel.set(key, group);
    const rawGroup = rawAttemptsByTaskChannel.get(key) ?? [];
    rawGroup.push(attempt);
    rawAttemptsByTaskChannel.set(key, rawGroup);
  }
  const channelsByTask = new Map<string, TeamUnifiedChannelView[]>();
  for (const channel of channels) {
    const group = channelsByTask.get(channel.mediaTaskId) ?? [];
    const attemptsForChannel = attemptsByTaskChannel.get(
      `${channel.mediaTaskId}\u0000${channel.channelKey}`,
    ) ?? [];
    const rawAttemptsForChannel = rawAttemptsByTaskChannel.get(
      `${channel.mediaTaskId}\u0000${channel.channelKey}`,
    ) ?? [];
    const operation = operationsByTaskChannel.get(
      `${channel.mediaTaskId}\u0000${channel.channelKey}`,
    );
    group.push({
      channelKey: channel.channelKey,
      providerId: channel.providerId,
      providerModel: channel.providerModel,
      priority: channel.priority,
      state: channel.state,
      executionRevision: channel.executionRevision,
      operationId: channel.operationId ?? operation?.id ?? null,
      operationStatus: operation?.status ?? rawAttemptsForChannel[0]?.operationStatus ?? null,
      operationWaitReason: operation?.waitReason ?? rawAttemptsForChannel[0]?.operationWaitReason ?? null,
      remoteId: channel.remoteId
        ?? attemptsForChannel.at(-1)?.remoteId
        ?? null,
      attempts: attemptsForChannel,
    });
    channelsByTask.set(channel.mediaTaskId, group);
  }

  return rows.map((row): TeamUnifiedTaskView => {
    const taskChannels = channelsByTask.get(row.id) ?? [];
    const taskAttempts = taskChannels.flatMap((channel) => channel.attempts);
    const rawTaskAttempts = taskChannels.flatMap((channel) =>
      rawAttemptsByTaskChannel.get(`${row.id}\u0000${channel.channelKey}`) ?? [],
    );
    const cost = summarizeUnifiedAttemptCosts(taskAttempts);
    const model = unifiedMediaDisplayName(row.unifiedModel)
      ?? row.unifiedModel;
    const base: TeamUnifiedTaskView = {
      mediaTaskId: row.id,
      taskId: row.taskId,
      module: row.module,
      unifiedModel: row.unifiedModel,
      model,
      ruleVersion: row.ruleVersion,
      status: row.status,
      cancelRequestedAt: row.cancelRequestedAt,
      actorUserId: row.actorId,
      employeeId: row.employeeId,
      actorDisplayName: row.actorDisplayName,
      scope: { resourceType: row.scopeType, resourceId: row.scopeId },
      scopeName: names.get(`${row.scopeType}:${row.scopeId}`)
        ?? (row.scopeType === 'project' ? '项目已删除或不可用'
          : row.scopeType === 'canvas' ? '画布已删除或不可用' : ''),
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      generationTaskCount: 1,
      channelCallCount: taskAttempts.length,
      submissionCount: rawTaskAttempts.filter((attempt) => attempt.intentJournalSeq !== null).length,
      usedChannelCount: taskChannels.filter((channel) =>
        (rawAttemptsByTaskChannel.get(`${row.id}\u0000${channel.channelKey}`) ?? [])
          .some((attempt) => attempt.intentJournalSeq !== null),
      ).length,
      ...cost,
    };
    return viewer.role === 'admin'
      ? { ...base, channels: taskChannels }
      : base;
  });
}

/**
 * 全范围统一制作任务投影（**无 500 条截断**）。
 *
 * 供诊断/回归测试与「不关心分页」的调用方使用；接口列表必须走
 * `listTeamUnifiedUsageTasks`，先计数再按 LIMIT/OFFSET 只加载选中页的任务，
 * 不把完整历史加载到 Node 再 slice。
 */
export function queryUnifiedTaskUsage(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): { tasks: TeamUnifiedTaskView[] } {
  const rows = taskRows(db, viewer, filters);
  return { tasks: buildTaskViews(db, viewer, rows, filters) };
}

/**
 * 分页读取统一制作任务（04 号票 `section=tasks`）。
 *
 * 分页单位是「统一制作任务」（自动兜底仍是一条任务），排序
 * `createdAt DESC, mediaTaskId DESC`；先按完整筛选范围计数，再只投影当前页任务，
 * 页内通道尝试仍按同一日期/结果筛选展开。员工投影不含 `channels`。
 */
export function listTeamUnifiedUsageTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
  page: TeamPageParamInput = {},
): { items: TeamUnifiedTaskView[]; pagination: TeamPagination } {
  const request = parseTeamPage(page);
  // 计数与选页在同一读事务里（一致读视图）；页内通道/尝试只加载选中页的任务。
  const run = db.transaction((): { items: TeamUnifiedTaskView[]; pagination: TeamPagination } => {
    const total = countTeamUnifiedUsageTasks(db, viewer, filters);
    const { pagination, offset } = resolveTeamPage(request, total);
    if (total === 0) return { items: [], pagination };
    const { clauses, values } = taskFilter(viewer, filters);
    const rows = db.prepare(`
      SELECT ${TASK_SELECT_COLUMNS}
      FROM execution_media_tasks t
      JOIN team_users u ON u.id = t.actorId
      ${taskWhere(clauses)}
      ORDER BY t.createdAt DESC, t.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, pagination.pageSize, offset) as TaskRow[];
    return { items: buildTaskViews(db, viewer, rows, filters), pagination };
  });
  return run.deferred();
}

/**
 * 按 mediaTaskId 定向加载统一任务费用/通道计数（03 号票：任务页当前页）。
 *
 * 任务页只补当前页实际出现的统一制作任务，因此这里**按 ID 直查**，不再取
 * 「最近 500 个统一任务」做 Map，也不靠可能重名的业务 taskId 关联；返回 Map 的键是
 * `mediaTaskId`。员工脱敏（不含 `channels`）与本人范围与 `queryUnifiedTaskUsage` 一致。
 * 04 号票在用量侧做全范围统计时可以直接复用/扩展这个入口。
 */
export function queryUnifiedTaskUsageByMediaTaskIds(
  db: Database.Database,
  viewer: TeamViewer,
  mediaTaskIds: readonly string[],
): Map<string, TeamUnifiedTaskView> {
  const unique = [...new Set(mediaTaskIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
  const rows = taskRowsByMediaTaskIds(db, viewer, unique);
  const views = buildTaskViews(db, viewer, rows, {});
  return new Map(views.map((view) => [view.mediaTaskId, view]));
}
