import type Database from 'better-sqlite3';
import {
  chargedCostExpression,
  monthlyCostUsage,
  personalConcurrencyPoolKey,
  readActorPolicy,
  shanghaiAccountingPeriod,
  updateActorPolicy,
  type ActorPolicy,
} from '../media-core/execution/pools.ts';
import { getShanghaiUsagePeriods } from '../usage-query.ts';
import { addUsageDays, usageDateLabel } from '../usage-date-range.ts';
import type { TeamViewer } from './diagnostics.ts';
import {
  UNIFIED_KLING3_MODEL_KEY,
  unifiedMediaDisplayName,
} from '../media-core/unified-media/catalog.ts';
import { parseTeamPage, resolveTeamPage, type TeamPageParamInput, type TeamPagination } from './pagination.ts';
import {
  countTeamUnifiedUsageTasks,
  countUnifiedUsageTasksByModel,
  listTeamUnifiedUsageTasks,
  type TeamUnifiedTaskView,
} from './unified-usage.ts';
import {
  isAdminOnlyUsageSection,
  type TeamUsageAttemptSection,
} from './usage-sections.ts';
import {
  attemptSqlSources,
  reportingModelName,
  type UsageAttemptSqlSources,
} from './usage-sql.ts';

export class TeamUsageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TeamUsageError';
    this.status = status;
    this.code = code;
  }
}

export interface TeamUsageFilters {
  from?: string;
  to?: string;
  actorUserId?: string;
  module?: string;
  model?: string;
  outcome?: 'succeeded' | 'failed';
}

export type TeamCostStatus = 'estimated' | 'settled' | 'released' | 'unpriced' | 'uncertain';

export interface TeamUsageAttempt {
  attemptId: string;
  operationId: string;
  mediaTaskId: string | null;
  taskId: string;
  businessAttemptId: string;
  businessAttemptNo: number;
  submitRound: number;
  transportSeq: number;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  scope: { resourceType: string; resourceId: string };
  module: string;
  step: string;
  model: string;
  reportingModel: string;
  unifiedModel: string | null;
  submissionState: string;
  outcome: string | null;
  remoteId: string | null;
  reservedMinor: number;
  actualMinor: number | null;
  costStatus: TeamCostStatus;
  policyVersion: number;
  accountingPeriod: string;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  errorId: string | null;
  usageMirrorStatus: 'recorded' | 'missing';
  createdAt: string;
}

export interface TeamModelUsage {
  model: string;
  modules: string[];
  taskCount: number;
  callCount: number;
  chargedMinor: number;
  settledMinor: number;
  estimatedMinor: number;
  unpricedCount: number;
  uncertainCount: number;
  percentage: number;
}

export interface TeamUsageTrendPoint {
  date: string;
  chargedMinor: number;
  byModel: Record<string, number>;
}

export interface TeamQuotaSummary {
  accountingPeriod: string;
  chargedMinor: number;
  settledMinor: number;
  heldMinor: number;
  limitedCount: number;
  limitedTotalMinor: number;
  limitedRemainingMinor: number;
  unlimitedCount: number;
}

export interface TeamUsageMember extends TeamMemberSummary {
  taskCount: number;
  callCount: number;
  rangeChargedMinor: number;
}

/** 完整筛选范围的金额分类合计（人民币分）。 */
export interface TeamUsageTotals {
  settledMinor: number;
  estimatedMinor: number;
  unpricedCount: number;
  uncertainCount: number;
}

/**
 * 完整筛选范围的三类真实尝试计数。`channels` / `legacy` / `unmapped` 互斥，
 * 并集等于该筛选下全部真实尝试；`generationTasks` 是制作任务数（分页单位）。
 */
export interface TeamUsageCounts {
  generationTasks: number;
  channelCalls: number;
  legacyAttempts: number;
  unmappedAttempts: number;
}

/**
 * `section=summary` 的完整摘要：额度、金额、计数、模型排行、趋势、成员统计与
 * 模型选项。**不携带**任何全量任务/尝试数组；`totals`/`counts`/排行/趋势/成员/
 * 模型选项都对完整筛选范围求值，不随页码或 section 变化。
 */
export interface TeamUsageSummary {
  totals: TeamUsageTotals;
  counts: TeamUsageCounts;
  models: TeamModelUsage[];
  trend: TeamUsageTrendPoint[];
  members: TeamUsageMember[];
  teamQuota: TeamQuotaSummary | null;
  modelOptions: string[];
  taskCount: number;
  attemptCount: number;
  localAgentIncluded: false;
  costNotice: string;
}

export const TEAM_USAGE_COST_NOTICE = '金额为工作台预估与结算口径，不等于供应商最终账单；本地 Agent 不计入。';

interface AttemptRow {
  attemptId: string;
  operationId: string;
  mediaTaskId: string | null;
  taskId: string;
  businessAttemptId: string;
  businessAttemptNo: number;
  submitRound: number;
  transportSeq: number;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  scopeType: string;
  scopeId: string;
  module: string;
  step: string;
  model: string | null;
  quoteKind: string;
  submissionState: string;
  outcome: string | null;
  remoteId: string | null;
  reservedMinor: number;
  actualMinor: number | null;
  costState: string;
  policyVersion: number;
  accountingPeriod: string;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  errorId: string | null;
  usageMirrorCount: number;
  unifiedModel: string | null;
  createdAt: string;
}

function scopedActor(viewer: TeamViewer, requested?: string): string | undefined {
  if (viewer.role === 'admin') return requested;
  if (requested && requested !== viewer.userId) {
    throw new TeamUsageError(403, 'usage_query_forbidden', '只能查询本人的用量。');
  }
  return viewer.userId;
}

function mapAttempt(row: AttemptRow): TeamUsageAttempt {
  const costStatus: TeamCostStatus = row.costState === 'released'
    ? 'released'
    : row.actualMinor !== null && row.costState === 'settled'
      ? 'settled'
      : row.costState === 'unknown' && row.outcome !== null
        ? 'uncertain'
        : row.quoteKind === 'unpriced'
          ? 'unpriced'
          : row.costState === 'unknown'
            ? 'uncertain'
            : 'estimated';
  const model = row.model || '未定价模型';
  return {
    attemptId: row.attemptId,
    operationId: row.operationId,
    mediaTaskId: row.mediaTaskId,
    taskId: row.taskId,
    businessAttemptId: row.businessAttemptId,
    businessAttemptNo: row.businessAttemptNo,
    submitRound: row.submitRound,
    transportSeq: row.transportSeq,
    actorUserId: row.actorUserId,
    employeeId: row.employeeId,
    actorDisplayName: row.actorDisplayName,
    scope: { resourceType: row.scopeType, resourceId: row.scopeId },
    module: row.module,
    step: row.step,
    model,
    reportingModel: reportingModelName(row.unifiedModel, model),
    submissionState: row.submissionState,
    outcome: row.outcome,
    remoteId: row.remoteId,
    reservedMinor: row.reservedMinor,
    actualMinor: row.actualMinor,
    costStatus,
    policyVersion: row.policyVersion,
    accountingPeriod: row.accountingPeriod,
    configVersion: row.configVersion,
    clientVersion: row.clientVersion,
    serverReleaseId: row.serverReleaseId,
    errorId: row.errorId,
    usageMirrorStatus: row.usageMirrorCount > 0 ? 'recorded' : 'missing',
    unifiedModel: row.unifiedModel,
    createdAt: row.createdAt,
  };
}

/** 员工投影把统一模型的真实通道模型收敛为统一模型名；管理员保留真实身份。 */
function projectAttempt(viewer: TeamViewer, item: TeamUsageAttempt): TeamUsageAttempt {
  return viewer.role === 'admin' || item.unifiedModel === null
    ? item
    : { ...item, model: item.reportingModel };
}

const ATTEMPT_SELECT = (sources: UsageAttemptSqlSources) => `a.id AS attemptId, o.id AS operationId,
  o.mediaTaskId, o.taskId, o.businessAttemptId,
  a.businessAttemptNo, a.submitRound, a.transportSeq, a.actorId AS actorUserId,
  u.employeeId, u.displayName AS actorDisplayName, o.scopeType, o.scopeId,
  o.module, o.step, ${sources.model} AS model,
  ${sources.unifiedModel} AS unifiedModel,
  ${sources.quoteKind} AS quoteKind,
  a.submissionState, a.terminalState AS outcome, a.remoteId, a.reservedMinor, a.actualMinor,
  a.costState, a.policyVersion, a.accountingPeriod, o.configVersion, o.clientVersion,
  o.serverReleaseId,
  (SELECT e.id FROM team_error_records e WHERE e.attemptId = a.id ORDER BY e.createdAt DESC LIMIT 1) AS errorId,
  (SELECT COUNT(*) FROM usage_ledger l WHERE l.executionAttemptId = a.id) AS usageMirrorCount,
  a.createdAt`;

interface AttemptQuery {
  sources: UsageAttemptSqlSources;
  clauses: string[];
  values: Array<string | number>;
}

function attemptWhere(clauses: readonly string[]): string {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/** 权限 + 业务筛选的唯一拼装处：授权总是在计数/选页之前生效。 */
function attemptQuery(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters,
): AttemptQuery {
  const actorUserId = scopedActor(viewer, filters.actorUserId);
  const sources = attemptSqlSources(db, { parentScopedToAttemptActor: viewer.role !== 'admin' });
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (actorUserId) { clauses.push('a.actorId = ?'); values.push(actorUserId); }
  if (filters.from) { clauses.push('a.createdAt >= ?'); values.push(filters.from); }
  if (filters.to) { clauses.push('a.createdAt < ?'); values.push(filters.to); }
  if (filters.module) { clauses.push('o.module = ?'); values.push(filters.module); }
  if (filters.outcome) { clauses.push('a.terminalState = ?'); values.push(filters.outcome); }
  if (filters.model) {
    const unifiedFilter = ['image2', UNIFIED_KLING3_MODEL_KEY]
      .find((key) => filters.model === key || filters.model === unifiedMediaDisplayName(key));
    const displayModel = unifiedFilter ?? filters.model;
    clauses.push(`(${sources.model} = ? OR ${sources.unifiedModel} = ?)`);
    values.push(filters.model, displayModel);
  }
  return { sources, clauses, values };
}

/**
 * 全范围真实尝试投影（不分页）。接口列表必须走 `listTeamUsageAttempts`；
 * 本函数供 CSV 导出与回归测试使用，不做隐式截断。
 */
export function queryTeamUsage(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): {
  items: TeamUsageAttempt[];
  totals: TeamUsageTotals;
  localAgentIncluded: false;
  costNotice: string;
} {
  const { sources, clauses, values } = attemptQuery(db, viewer, filters);
  const rows = db.prepare(`
    SELECT ${ATTEMPT_SELECT(sources)}
    ${sources.from}
    ${attemptWhere(clauses)}
    ORDER BY a.createdAt DESC, a.id DESC
  `).all(...values) as AttemptRow[];
  const items = rows.map((row) => projectAttempt(viewer, mapAttempt(row)));
  return {
    items,
    totals: {
      settledMinor: items.reduce((sum, item) => sum + (item.costStatus === 'settled' ? item.actualMinor ?? 0 : 0), 0),
      estimatedMinor: items.reduce((sum, item) => sum + (item.costStatus === 'estimated' ? item.reservedMinor : 0), 0),
      unpricedCount: items.filter((item) => item.costStatus === 'unpriced').length,
      uncertainCount: items.filter((item) => item.costStatus === 'uncertain').length,
    },
    localAgentIncluded: false,
    costNotice: TEAM_USAGE_COST_NOTICE,
  };
}

/** 完整筛选范围的金额分类合计（SQL 聚合，不加载尝试对象）。 */
export function queryTeamUsageTotals(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): TeamUsageTotals {
  const { sources, clauses, values } = attemptQuery(db, viewer, filters);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(${sources.settledMinor}), 0) AS settledMinor,
      COALESCE(SUM(${sources.estimatedMinor}), 0) AS estimatedMinor,
      COALESCE(SUM(${sources.unpricedCount}), 0) AS unpricedCount,
      COALESCE(SUM(${sources.uncertainCount}), 0) AS uncertainCount
    ${sources.from}
    ${attemptWhere(clauses)}
  `).get(...values) as TeamUsageTotals | undefined;
  return {
    settledMinor: Number(row?.settledMinor ?? 0),
    estimatedMinor: Number(row?.estimatedMinor ?? 0),
    unpricedCount: Number(row?.unpricedCount ?? 0),
    uncertainCount: Number(row?.uncertainCount ?? 0),
  };
}

/**
 * 完整筛选范围的互斥分类计数（SQL 聚合）。
 * `channelCalls` / `legacyAttempts` / `unmappedAttempts` 与三个明细 section 的
 * `pagination.total` 同口径；`generationTasks` 与 `section=tasks` 的总数同口径。
 */
export function queryTeamUsageCounts(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): TeamUsageCounts {
  const generationTasks = countTeamUnifiedUsageTasks(db, viewer, filters);
  const { sources, clauses, values } = attemptQuery(db, viewer, filters);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN ${sources.channels} THEN 1 ELSE 0 END), 0) AS channelCalls,
      COALESCE(SUM(CASE WHEN ${sources.legacy} THEN 1 ELSE 0 END), 0) AS legacyAttempts,
      COALESCE(SUM(CASE WHEN ${sources.unmapped} THEN 1 ELSE 0 END), 0) AS unmappedAttempts
    ${sources.from}
    ${attemptWhere(clauses)}
  `).get(...values) as { channelCalls: number; legacyAttempts: number; unmappedAttempts: number } | undefined;
  return {
    generationTasks,
    channelCalls: Number(row?.channelCalls ?? 0),
    legacyAttempts: Number(row?.legacyAttempts ?? 0),
    unmappedAttempts: Number(row?.unmappedAttempts ?? 0),
  };
}

interface ModelGroupRow {
  unifiedModel: string | null;
  model: string | null;
  module: string;
  callCount: number;
  chargedMinor: number;
  settledMinor: number;
  estimatedMinor: number;
  unpricedCount: number;
  uncertainCount: number;
}

interface RangeMemberRow {
  userId: string;
  taskCount: number;
  callCount: number;
  rangeChargedMinor: number;
}

interface TrendGroupRow {
  day: string;
  unifiedModel: string | null;
  model: string | null;
  chargedMinor: number;
}

function usageTrend(
  from: string,
  to: string,
  rows: readonly TrendGroupRow[],
): TeamUsageTrendPoint[] {
  const firstDay = usageDateLabel(new Date(from));
  const endDay = usageDateLabel(new Date(to));
  const points: TeamUsageTrendPoint[] = [];
  for (let date = firstDay; date < endDay; date = addUsageDays(date, 1)) {
    points.push({ date, chargedMinor: 0, byModel: {} });
  }
  const byDate = new Map(points.map((point) => [point.date, point]));
  for (const row of rows) {
    const point = byDate.get(row.day);
    if (!point) continue;
    const model = reportingModelName(row.unifiedModel, row.model ?? '未定价模型');
    point.chargedMinor += Number(row.chargedMinor);
    point.byModel[model] = (point.byModel[model] ?? 0) + Number(row.chargedMinor);
  }
  return points;
}

function buildModelUsage(
  rows: readonly ModelGroupRow[],
  unifiedTaskCounts: ReadonlyMap<string, number>,
  legacyTaskCounts: ReadonlyMap<string, number>,
): TeamModelUsage[] {
  const modelMap = new Map<string, TeamModelUsage>();
  for (const row of rows) {
    const model = reportingModelName(row.unifiedModel, row.model ?? '未定价模型');
    const current = modelMap.get(model) ?? {
      model, modules: [], taskCount: 0, callCount: 0, chargedMinor: 0,
      settledMinor: 0, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0, percentage: 0,
    };
    current.callCount += Number(row.callCount);
    current.chargedMinor += Number(row.chargedMinor);
    current.settledMinor += Number(row.settledMinor);
    current.estimatedMinor += Number(row.estimatedMinor);
    current.unpricedCount += Number(row.unpricedCount);
    current.uncertainCount += Number(row.uncertainCount);
    if (!current.modules.includes(row.module)) current.modules.push(row.module);
    modelMap.set(model, current);
  }
  for (const [model, taskCount] of unifiedTaskCounts) {
    const current = modelMap.get(model) ?? {
      model, modules: [], taskCount: 0, callCount: 0, chargedMinor: 0,
      settledMinor: 0, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0, percentage: 0,
    };
    current.taskCount += taskCount;
    modelMap.set(model, current);
  }
  for (const [model, taskCount] of legacyTaskCounts) {
    const current = modelMap.get(model) ?? {
      model, modules: [], taskCount: 0, callCount: 0, chargedMinor: 0,
      settledMinor: 0, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0, percentage: 0,
    };
    current.taskCount += taskCount;
    modelMap.set(model, current);
  }
  const chargedTotal = [...modelMap.values()].reduce((sum, model) => sum + model.chargedMinor, 0);
  return [...modelMap.values()].map((model) => ({
    ...model,
    modules: model.modules.sort((left, right) => left.localeCompare(right)),
    percentage: chargedTotal > 0 ? model.chargedMinor / chargedTotal * 100 : 0,
  })).sort((left, right) => right.chargedMinor - left.chargedMinor
    || right.callCount - left.callCount
    || left.model.localeCompare(right.model));
}

/**
 * 授权范围内**完整候选**模型选项（不受日期/结果/模型筛选与分页影响）。
 * 管理员看全团队，员工只看本人；选中一个模型后仍能换选其它模型。
 */
function queryModelOptions(db: Database.Database, viewer: TeamViewer): string[] {
  const actorUserId = scopedActor(viewer);
  const sources = attemptSqlSources(db, { parentScopedToAttemptActor: viewer.role !== 'admin' });
  const attemptRows = db.prepare(`
    SELECT DISTINCT ${sources.unifiedModel} AS unifiedModel, ${sources.model} AS model
    ${sources.from}
    ${actorUserId ? 'WHERE a.actorId = ?' : ''}
  `).all(...(actorUserId ? [actorUserId] : [])) as Array<{ unifiedModel: string | null; model: string | null }>;
  const taskRows = db.prepare(`
    SELECT DISTINCT t.unifiedModel AS unifiedModel
    FROM execution_media_tasks t
    ${actorUserId ? 'WHERE t.actorId = ?' : ''}
  `).all(...(actorUserId ? [actorUserId] : [])) as Array<{ unifiedModel: string }>;
  const names = new Set<string>();
  for (const row of attemptRows) names.add(reportingModelName(row.unifiedModel, row.model ?? '未定价模型'));
  for (const row of taskRows) names.add(reportingModelName(row.unifiedModel, row.unifiedModel));
  return [...names].sort();
}

/**
 * 完整筛选范围的模型排行、趋势、成员统计、额度卡与模型选项。
 * 全部通过 SQL 聚合/定向查询求值，不依赖当前页或 section。
 */
export function queryTeamUsageAnalytics(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
  now = new Date(),
): {
  models: TeamModelUsage[];
  trend: TeamUsageTrendPoint[];
  members: TeamUsageMember[];
  teamQuota: TeamQuotaSummary | null;
  modelOptions: string[];
  taskCount: number;
  attemptCount: number;
} {
  const { sources, clauses, values } = attemptQuery(db, viewer, filters);
  const from = attemptWhere(clauses);
  const modelRows = db.prepare(`
    SELECT ${sources.unifiedModel} AS unifiedModel, ${sources.model} AS model, o.module AS module,
      COUNT(*) AS callCount,
      COALESCE(SUM(${sources.chargedMinor}), 0) AS chargedMinor,
      COALESCE(SUM(${sources.settledMinor}), 0) AS settledMinor,
      COALESCE(SUM(${sources.estimatedMinor}), 0) AS estimatedMinor,
      COALESCE(SUM(${sources.unpricedCount}), 0) AS unpricedCount,
      COALESCE(SUM(${sources.uncertainCount}), 0) AS uncertainCount
    ${sources.from}
    ${from}
    GROUP BY ${sources.unifiedModel}, ${sources.model}, o.module
  `).all(...values) as ModelGroupRow[];
  const trendRows = db.prepare(`
    SELECT date(a.createdAt, '+8 hours') AS day,
      ${sources.unifiedModel} AS unifiedModel, ${sources.model} AS model,
      COALESCE(SUM(${sources.chargedMinor}), 0) AS chargedMinor
    ${sources.from}
    ${from}
    GROUP BY date(a.createdAt, '+8 hours'), ${sources.unifiedModel}, ${sources.model}
  `).all(...values) as TrendGroupRow[];
  const attemptCount = Number(db.prepare(`
    SELECT COUNT(*) FROM (
      SELECT 1 ${sources.from} ${from}
    )
  `).pluck().get(...values) ?? 0);
  const legacyTaskRows = db.prepare(`
    SELECT ${sources.model} AS model, COUNT(DISTINCT o.taskId) AS taskCount
    ${sources.from}
    ${from ? `${from} AND` : 'WHERE'} (${sources.legacy})
    GROUP BY ${sources.model}
  `).all(...values) as Array<{ model: string | null; taskCount: number }>;
  const unifiedTaskCounts = new Map<string, number>();
  for (const row of countUnifiedUsageTasksByModel(db, viewer, filters)) {
    const model = reportingModelName(row.unifiedModel, row.unifiedModel);
    unifiedTaskCounts.set(model, (unifiedTaskCounts.get(model) ?? 0) + Number(row.taskCount));
  }
  const legacyTaskCounts = new Map<string, number>();
  for (const row of legacyTaskRows) {
    const model = reportingModelName(null, row.model ?? '未定价模型');
    legacyTaskCounts.set(model, (legacyTaskCounts.get(model) ?? 0) + Number(row.taskCount));
  }
  const models = buildModelUsage(modelRows, unifiedTaskCounts, legacyTaskCounts);
  const generationTasks = countTeamUnifiedUsageTasks(db, viewer, filters);
  const taskCount = generationTasks
    + [...legacyTaskCounts.values()].reduce((sum, count) => sum + count, 0);
  const defaults = getShanghaiUsagePeriods(now).month;
  const trend = usageTrend(filters.from ?? defaults.from, filters.to ?? defaults.to, trendRows);
  const modelOptions = queryModelOptions(db, viewer);
  if (viewer.role !== 'admin') {
    return { models, trend, members: [], teamQuota: null, modelOptions, taskCount, attemptCount };
  }

  const memberRows = listTeamMembers(db, viewer, { now }).items;
  const rangeRows = db.prepare(`
    SELECT a.actorId AS userId, COUNT(DISTINCT o.taskId) AS taskCount, COUNT(*) AS callCount,
      COALESCE(SUM(${sources.chargedMinor}), 0) AS rangeChargedMinor
    ${sources.from}
    ${from}
    GROUP BY a.actorId
  `).all(...values) as RangeMemberRow[];
  const byActor = new Map(rangeRows.map((row) => [row.userId, row]));
  const members = memberRows.map((member) => {
    const row = byActor.get(member.userId);
    return {
      ...member,
      taskCount: Number(row?.taskCount ?? 0),
      callCount: Number(row?.callCount ?? 0),
      rangeChargedMinor: Number(row?.rangeChargedMinor ?? 0),
    };
  }).sort((left, right) => right.rangeChargedMinor - left.rangeChargedMinor
    || left.employeeId.localeCompare(right.employeeId));
  const limited = memberRows.filter((member) => member.monthlyLimitMinor !== null);
  const teamQuota: TeamQuotaSummary = {
    accountingPeriod: shanghaiAccountingPeriod(now),
    chargedMinor: memberRows.reduce((sum, member) => sum + member.monthChargedMinor, 0),
    settledMinor: memberRows.reduce((sum, member) => sum + member.monthSettledMinor, 0),
    heldMinor: memberRows.reduce((sum, member) => sum + member.heldMinor, 0),
    limitedCount: limited.length,
    limitedTotalMinor: limited.reduce((sum, member) => sum + (member.monthlyLimitMinor ?? 0), 0),
    limitedRemainingMinor: limited.reduce((sum, member) => sum + (member.remainingMinor ?? 0), 0),
    unlimitedCount: memberRows.length - limited.length,
  };
  return { models, trend, members, teamQuota, modelOptions, taskCount, attemptCount };
}

/**
 * `section=summary`：把完整范围的金额合计、分类计数与分析摘要合在一起。
 * 不加载全量任务/尝试数组，翻页与切 section 不会改变这里的任何金额或排名。
 */
export function queryTeamUsageSummary(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
  now = new Date(),
): TeamUsageSummary {
  // 摘要包含多个聚合查询：放进同一个延迟读事务，保证响应内金额/计数/排行的读视图一致。
  const run = db.transaction((): TeamUsageSummary => ({
    totals: queryTeamUsageTotals(db, viewer, filters),
    counts: queryTeamUsageCounts(db, viewer, filters),
    ...queryTeamUsageAnalytics(db, viewer, filters, now),
    localAgentIncluded: false,
    costNotice: TEAM_USAGE_COST_NOTICE,
  }));
  return run.deferred();
}

/**
 * 读取 `channels` / `legacy` / `unmapped` 明细分区（每 attempt 一条）。
 *
 * 分类用数据库真实父任务身份判断（不依赖本页 ID 集合或父任务账期）；员工请求
 * `channels`/`unmapped` 直接 403，不能只在 UI 隐藏。分页单位是真实尝试。
 */
export function listTeamUsageAttempts(
  db: Database.Database,
  viewer: TeamViewer,
  section: TeamUsageAttemptSection,
  filters: TeamUsageFilters = {},
  page: TeamPageParamInput = {},
): { items: TeamUsageAttempt[]; pagination: TeamPagination } {
  if (isAdminOnlyUsageSection(section) && viewer.role !== 'admin') {
    throw new TeamUsageError(403, 'usage_section_forbidden', '只有管理员可以查看该用量明细分类。');
  }
  const { sources, clauses, values } = attemptQuery(db, viewer, filters);
  const classification = section === 'channels'
    ? sources.channels
    : section === 'legacy'
      ? sources.legacy
      : sources.unmapped;
  const allClauses = [...clauses, classification];
  const request = parseTeamPage(page);
  // 计数与选页在同一读事务里（一致读视图），避免并发写入让 total 与当前页错位。
  const run = db.transaction(() => {
    const total = Number(db.prepare(`
      SELECT COUNT(*) FROM (
        SELECT 1 ${sources.from} ${attemptWhere(allClauses)}
      )
    `).pluck().get(...values) ?? 0);
    const { pagination, offset } = resolveTeamPage(request, total);
    if (total === 0) return { items: [], pagination };
    const rows = db.prepare(`
      SELECT ${ATTEMPT_SELECT(sources)}
      ${sources.from}
      ${attemptWhere(allClauses)}
      ORDER BY a.createdAt DESC, a.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, pagination.pageSize, offset) as AttemptRow[];
    return {
      items: rows.map((row) => projectAttempt(viewer, mapAttempt(row))),
      pagination,
    };
  });
  return run.deferred();
}

/**
 * `section=tasks`：统一制作任务分页（单位 = 每个统一制作任务，自动兜底仍是一条）。
 * 委托 `unified-usage.ts` 的页选择，页内通道尝试按同一日期/结果筛选展开。
 */
export function listTeamUsageTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
  page: TeamPageParamInput = {},
): { items: TeamUnifiedTaskView[]; pagination: TeamPagination } {
  return listTeamUnifiedUsageTasks(db, viewer, filters, page);
}

interface MemberRow {
  userId: string;
  employeeId: string;
  displayName: string;
  role: 'employee' | 'admin';
  accountStatus: 'active' | 'disabled';
  mustChangePassword: number;
}

export interface TeamMemberSummary {
  userId: string;
  employeeId: string;
  displayName: string;
  role: 'employee' | 'admin';
  accountStatus: 'active' | 'disabled';
  mustChangePassword: boolean;
  todayChargedMinor: number;
  monthChargedMinor: number;
  monthSettledMinor: number;
  heldMinor: number;
  monthlyLimitMinor: number | null;
  remainingMinor: number | null;
  currentConcurrency: number;
  concurrencyLimit: number | null;
  concurrencyMode: ActorPolicy['concurrencyMode'];
  concurrencySource: ActorPolicy['concurrencySource'];
  paused: boolean;
  allowedModels: string[] | null;
  policyVersion: number;
  waitingReason: string | null;
  attention: boolean;
  modules: Array<{ module: string; chargedMinor: number }>;
}

function memberSummary(db: Database.Database, row: MemberRow, now: Date): TeamMemberSummary {
  const policy = readActorPolicy(db, row.userId);
  const period = shanghaiAccountingPeriod(now);
  const periods = getShanghaiUsagePeriods(now);
  const monthChargedMinor = monthlyCostUsage(db, row.userId, period);
  const todayChargedMinor = Number(db.prepare(`
    SELECT COALESCE(SUM(${chargedCostExpression()}), 0) AS amount
    FROM execution_reservations r JOIN execution_attempts a ON a.id = r.attemptId
    WHERE r.kind = 'cost' AND r.actorId = ? AND a.createdAt >= ? AND a.createdAt < ?
  `).pluck().get(row.userId, periods.today.from, periods.today.to) ?? 0);
  const monthSettledMinor = Number(db.prepare(`
    SELECT COALESCE(SUM(actualMinor), 0) FROM execution_reservations
    WHERE kind = 'cost' AND actorId = ? AND accountingPeriod = ? AND state = 'settled' AND costState = 'settled'
  `).pluck().get(row.userId, period) ?? 0);
  const heldMinor = Number(db.prepare(`
    SELECT COALESCE(SUM(reservedMinor), 0) FROM execution_reservations
    WHERE kind = 'cost' AND actorId = ? AND accountingPeriod = ? AND state = 'held'
  `).pluck().get(row.userId, period) ?? 0);
  const currentConcurrency = Number(db.prepare(`
    SELECT COUNT(*) FROM execution_reservations
    WHERE kind = 'concurrency' AND poolKey = ? AND state = 'held'
  `).pluck().get(personalConcurrencyPoolKey(row.userId)) ?? 0);
  const waitingReason = db.prepare(`
    SELECT waitReason FROM execution_operations
    WHERE actorId = ? AND status IN ('pending', 'deferred') AND waitReason IS NOT NULL
    ORDER BY updatedAt DESC LIMIT 1
  `).pluck().get(row.userId) as string | undefined;
  const hasUnknown = Boolean(db.prepare(`
    SELECT 1 FROM execution_reservations
    WHERE kind = 'cost' AND actorId = ? AND state IN ('held', 'settled') AND costState = 'unknown' LIMIT 1
  `).get(row.userId));
  const modules = db.prepare(`
    SELECT o.module, COALESCE(SUM(${chargedCostExpression()}), 0) AS chargedMinor
    FROM execution_reservations r
    JOIN execution_attempts a ON a.id = r.attemptId
    JOIN execution_operations o ON o.id = a.operationId
    WHERE r.kind = 'cost' AND r.actorId = ? AND r.accountingPeriod = ?
    GROUP BY o.module ORDER BY chargedMinor DESC, o.module
  `).all(row.userId, period) as Array<{ module: string; chargedMinor: number }>;
  const nearLimit = policy.monthlyLimitMinor !== null
    && (monthChargedMinor >= policy.monthlyLimitMinor || (policy.monthlyLimitMinor > 0 && monthChargedMinor / policy.monthlyLimitMinor >= 0.8));
  return {
    ...row,
    mustChangePassword: Boolean(row.mustChangePassword),
    todayChargedMinor,
    monthChargedMinor,
    monthSettledMinor,
    heldMinor,
    monthlyLimitMinor: policy.monthlyLimitMinor,
    remainingMinor: policy.monthlyLimitMinor === null ? null : Math.max(0, policy.monthlyLimitMinor - monthChargedMinor),
    currentConcurrency,
    concurrencyLimit: policy.effectiveConcurrency,
    concurrencyMode: policy.concurrencyMode,
    concurrencySource: policy.concurrencySource,
    paused: policy.paused,
    allowedModels: policy.allowedModels,
    policyVersion: policy.version,
    waitingReason: waitingReason ?? null,
    attention: row.accountStatus === 'disabled' || policy.paused || Boolean(waitingReason) || hasUnknown || nearLimit
      || (policy.effectiveConcurrency !== null && currentConcurrency > policy.effectiveConcurrency),
    modules: modules.map((module) => ({ module: module.module, chargedMinor: Number(module.chargedMinor) })),
  };
}

export function listTeamMembers(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { now?: Date; search?: string; attentionOnly?: boolean } = {},
): { items: TeamMemberSummary[] } {
  if (viewer.role !== 'admin') throw new TeamUsageError(403, 'members_forbidden', '只有管理员可以查看成员汇总。');
  const now = filters.now ?? new Date();
  const search = filters.search?.trim();
  const rows = db.prepare(`
    SELECT id AS userId, employeeId, displayName, role, status AS accountStatus, mustChangePassword FROM team_users
    WHERE deletedAt IS NULL ${search ? 'AND (employeeId LIKE ? OR displayName LIKE ?)' : ''}
    ORDER BY employeeId
  `).all(...(search ? [`%${search}%`, `%${search}%`] : [])) as MemberRow[];
  const items = rows.map((row) => memberSummary(db, row, now));
  return { items: filters.attentionOnly ? items.filter((item) => item.attention) : items };
}

export function readTeamMemberSummary(
  db: Database.Database,
  viewer: TeamViewer,
  targetUserId: string,
  now = new Date(),
): TeamMemberSummary {
  if (viewer.role !== 'admin' && viewer.userId !== targetUserId) {
    throw new TeamUsageError(403, 'member_forbidden', '只能查看本人的用量汇总。');
  }
  const row = db.prepare(`
    SELECT id AS userId, employeeId, displayName, role, status AS accountStatus, mustChangePassword FROM team_users WHERE id = ?
  `).get(targetUserId) as MemberRow | undefined;
  if (!row) throw new TeamUsageError(404, 'user_not_found', '成员不存在。');
  return memberSummary(db, row, now);
}

export function readTeamMemberPolicy(
  db: Database.Database,
  viewer: TeamViewer,
  targetUserId: string,
): ActorPolicy & { accountStatus: string; waitingReason: string | null } {
  if (viewer.role !== 'admin' && viewer.userId !== targetUserId) {
    throw new TeamUsageError(403, 'policy_forbidden', '只能查看本人的费用与并发策略。');
  }
  const user = db.prepare('SELECT status FROM team_users WHERE id = ?').pluck().get(targetUserId) as string | undefined;
  if (!user) throw new TeamUsageError(404, 'user_not_found', '成员不存在。');
  const waitingReason = db.prepare(`
    SELECT waitReason FROM execution_operations
    WHERE actorId = ? AND status IN ('pending', 'deferred') AND waitReason IS NOT NULL
    ORDER BY updatedAt DESC LIMIT 1
  `).pluck().get(targetUserId) as string | undefined;
  return { ...readActorPolicy(db, targetUserId), accountStatus: user, waitingReason: waitingReason ?? null };
}

export function updateTeamMemberPolicy(
  db: Database.Database,
  viewer: TeamViewer,
  input: {
    targetUserId: string;
    monthlyLimitMinor: number | null;
    personalConcurrency: number;
    concurrencyMode?: 'inherit' | 'fixed';
    paused: boolean;
    expectedVersion: number;
    allowedModels?: string[] | null;
  },
): ActorPolicy {
  if (viewer.role !== 'admin') {
    throw new TeamUsageError(403, 'policy_forbidden', '员工策略为只读，只有管理员可以修改。');
  }
  if (!db.prepare('SELECT 1 FROM team_users WHERE id = ?').get(input.targetUserId)) {
    throw new TeamUsageError(404, 'user_not_found', '成员不存在。');
  }
  return updateActorPolicy(db, {
    actorId: input.targetUserId,
    monthlyLimitMinor: input.monthlyLimitMinor,
    personalConcurrency: input.personalConcurrency,
    concurrencyMode: input.concurrencyMode,
    paused: input.paused,
    expectedVersion: input.expectedVersion,
    allowedModels: input.allowedModels,
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function teamUsageCsv(items: TeamUsageAttempt[]): string {
  const columns = [
    'attemptId', 'operationId', 'taskId', 'actorUserId', 'employeeId', 'actorDisplayName',
    'module', 'step', 'model', 'businessAttemptNo', 'submitRound', 'transportSeq',
    'submissionState', 'outcome', 'remoteId', 'accountingPeriod', 'policyVersion',
    'configVersion', 'clientVersion', 'serverReleaseId', 'errorId', 'costStatus',
    'reservedMinor', 'actualMinor', 'usageMirrorStatus', 'createdAt',
    'unifiedModel', 'reportingModel',
  ] as const;
  const lines = [columns.join(',')];
  for (const item of items) {
    lines.push(columns.map((column) => {
      if ((column === 'reservedMinor' || column === 'actualMinor')
        && item.costStatus !== 'estimated' && item.costStatus !== 'settled') return '';
      return csvCell(item[column]);
    }).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function exportTeamUsageCsv(db: Database.Database, viewer: TeamViewer, filters: TeamUsageFilters = {}): string {
  if (viewer.role !== 'admin') throw new TeamUsageError(403, 'usage_export_forbidden', '只有管理员可以导出团队 CSV。');
  return teamUsageCsv(queryTeamUsage(db, viewer, filters).items);
}
