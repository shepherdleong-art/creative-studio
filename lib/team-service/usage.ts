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
  callCount: number;
  rangeChargedMinor: number;
}

interface AttemptRow {
  attemptId: string;
  operationId: string;
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

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((item) => item.name === column);
  } catch {
    return false;
  }
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
  return {
    attemptId: row.attemptId,
    operationId: row.operationId,
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
    model: row.model || '未定价模型',
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

export function queryTeamUsage(
  db: Database.Database,
  viewer: TeamViewer,
  filters: TeamUsageFilters = {},
): {
  items: TeamUsageAttempt[];
  totals: { settledMinor: number; estimatedMinor: number; unpricedCount: number; uncertainCount: number };
  localAgentIncluded: false;
  costNotice: string;
} {
  const actorUserId = scopedActor(viewer, filters.actorUserId);
  const clauses: string[] = [];
  const values: string[] = [];
  if (actorUserId) { clauses.push('a.actorId = ?'); values.push(actorUserId); }
  if (filters.from) { clauses.push('a.createdAt >= ?'); values.push(filters.from); }
  if (filters.to) { clauses.push('a.createdAt < ?'); values.push(filters.to); }
  if (filters.module) { clauses.push('o.module = ?'); values.push(filters.module); }
  if (filters.outcome) { clauses.push('a.terminalState = ?'); values.push(filters.outcome); }
  const modelExpression = `COALESCE(
    CASE WHEN json_valid(a.pricingSnapshotJson) THEN json_extract(a.pricingSnapshotJson, '$.coreModelKey') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.coreModelKey') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.requestModel') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.model') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.modelAlias') END
  )`;
  const hasUnifiedModel = tableHasColumn(db, 'jobs', 'unifiedModel');
  if (filters.model) { clauses.push(`${modelExpression} = ?`); values.push(filters.model); }
  const rows = db.prepare(`
    SELECT a.id AS attemptId, o.id AS operationId, o.taskId, o.businessAttemptId,
      a.businessAttemptNo, a.submitRound, a.transportSeq, a.actorId AS actorUserId,
      u.employeeId, u.displayName AS actorDisplayName, o.scopeType, o.scopeId,
      o.module, o.step, ${modelExpression} AS model,
      ${hasUnifiedModel ? 'j.unifiedModel' : 'NULL'} AS unifiedModel,
      CASE WHEN json_valid(o.quoteJson) THEN json_extract(o.quoteJson, '$.kind') ELSE 'unpriced' END AS quoteKind,
      a.submissionState, a.terminalState AS outcome, a.remoteId, a.reservedMinor, a.actualMinor,
      a.costState, a.policyVersion, a.accountingPeriod, o.configVersion, o.clientVersion,
      o.serverReleaseId,
      (SELECT e.id FROM team_error_records e WHERE e.attemptId = a.id ORDER BY e.createdAt DESC LIMIT 1) AS errorId,
      (SELECT COUNT(*) FROM usage_ledger l WHERE l.executionAttemptId = a.id) AS usageMirrorCount,
      a.createdAt
    FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    JOIN team_users u ON u.id = a.actorId
    ${hasUnifiedModel ? "LEFT JOIN jobs j ON o.module = 'image' AND j.id = o.taskId" : ''}
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY a.createdAt DESC, a.id DESC
  `).all(...values) as AttemptRow[];
  const items = rows.map(mapAttempt);
  return {
    items,
    totals: {
      settledMinor: items.reduce((sum, item) => sum + (item.costStatus === 'settled' ? item.actualMinor ?? 0 : 0), 0),
      estimatedMinor: items.reduce((sum, item) => sum + (item.costStatus === 'estimated' ? item.reservedMinor : 0), 0),
      unpricedCount: items.filter((item) => item.costStatus === 'unpriced').length,
      uncertainCount: items.filter((item) => item.costStatus === 'uncertain').length,
    },
    localAgentIncluded: false,
    costNotice: '金额为工作台预估与结算口径，不等于供应商最终账单；本地 Agent 不计入。',
  };
}

function attemptChargedMinor(item: TeamUsageAttempt): number {
  if (item.costStatus === 'settled') return item.actualMinor ?? 0;
  if (item.costStatus === 'estimated' || item.costStatus === 'uncertain') return item.reservedMinor;
  return 0;
}

function usageTrend(from: string, to: string, items: TeamUsageAttempt[]): TeamUsageTrendPoint[] {
  const firstDay = usageDateLabel(new Date(from));
  const endDay = usageDateLabel(new Date(to));
  const points: TeamUsageTrendPoint[] = [];
  for (let date = firstDay; date < endDay; date = addUsageDays(date, 1)) {
    points.push({ date, chargedMinor: 0, byModel: {} });
  }
  const byDate = new Map(points.map((point) => [point.date, point]));
  for (const item of items) {
    const point = byDate.get(usageDateLabel(new Date(item.createdAt)));
    if (!point) continue;
    const chargedMinor = attemptChargedMinor(item);
    point.chargedMinor += chargedMinor;
    point.byModel[item.model] = (point.byModel[item.model] ?? 0) + chargedMinor;
  }
  return points;
}

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
} {
  const items = queryTeamUsage(db, viewer, filters).items;
  const modelMap = new Map<string, TeamModelUsage>();
  for (const item of items) {
    const current = modelMap.get(item.model) ?? {
      model: item.model, modules: [], callCount: 0, chargedMinor: 0,
      settledMinor: 0, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0, percentage: 0,
    };
    current.callCount += 1;
    current.chargedMinor += attemptChargedMinor(item);
    if (!current.modules.includes(item.module)) current.modules.push(item.module);
    if (item.costStatus === 'settled') current.settledMinor += item.actualMinor ?? 0;
    if (item.costStatus === 'estimated') current.estimatedMinor += item.reservedMinor;
    if (item.costStatus === 'unpriced') current.unpricedCount += 1;
    if (item.costStatus === 'uncertain') current.uncertainCount += 1;
    modelMap.set(item.model, current);
  }
  const chargedTotal = items.reduce((sum, item) => sum + attemptChargedMinor(item), 0);
  const models = [...modelMap.values()].map((model) => ({
    ...model,
    modules: model.modules.sort((left, right) => left.localeCompare(right)),
    percentage: chargedTotal > 0 ? model.chargedMinor / chargedTotal * 100 : 0,
  })).sort((left, right) => right.chargedMinor - left.chargedMinor || right.callCount - left.callCount || left.model.localeCompare(right.model));

  const defaults = getShanghaiUsagePeriods(now).month;
  const trend = usageTrend(filters.from ?? defaults.from, filters.to ?? defaults.to, items);
  if (viewer.role !== 'admin') {
    const modelOptions = queryTeamUsage(db, viewer, { actorUserId: viewer.userId }).items.map((item) => item.model);
    return { models, trend, members: [], teamQuota: null, modelOptions: [...new Set(modelOptions)].sort() };
  }

  const memberRows = listTeamMembers(db, viewer, { now }).items;
  const members = memberRows.map((member) => ({
    ...member,
    callCount: items.filter((item) => item.actorUserId === member.userId).length,
    rangeChargedMinor: items.filter((item) => item.actorUserId === member.userId)
      .reduce((sum, item) => sum + attemptChargedMinor(item), 0),
  })).sort((left, right) => right.rangeChargedMinor - left.rangeChargedMinor || left.employeeId.localeCompare(right.employeeId));
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
  const modelOptions = queryTeamUsage(db, viewer).items.map((item) => item.model);
  return { models, trend, members, teamQuota, modelOptions: [...new Set(modelOptions)].sort() };
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
