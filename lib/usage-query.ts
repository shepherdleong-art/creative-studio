import type Database from 'better-sqlite3';

import type { CoreUsageCategory, CoreUsageModelKey } from './usage-pricing.ts';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CORE_USAGE_MODEL_KEYS: readonly CoreUsageModelKey[] = [
  'company-image2-medium',
  'company-qiniuyun-gpt-image-2-medium',
  'company-kling-3-0',
  'company-seedance-fast',
  'company-gpt-5-6-luna',
  'doubao-seed-tts-2',
] as const;

export const CORE_USAGE_CATEGORIES: readonly CoreUsageCategory[] = [
  'image',
  'video',
  'llm_text',
  'llm_vision',
  'tts',
] as const;

export interface UsageDateRange {
  from: string;
  to: string;
}

export interface UsageTrendDay extends UsageDateRange {
  date: string;
}

export interface ShanghaiUsagePeriods {
  today: UsageDateRange;
  week: UsageDateRange;
  month: UsageDateRange;
  trend: UsageTrendDay[];
}

export interface UsageQueryFilters {
  from?: string;
  to?: string;
  coreModelKey?: CoreUsageModelKey;
  category?: CoreUsageCategory;
}

export interface UsageDashboardQuery extends UsageQueryFilters {
  now?: Date;
}

export interface UsageAggregate {
  costMicros: number;
  callCount: number;
  quantity: number;
}

export interface UsageModelAggregate extends UsageAggregate {
  coreModelKey: CoreUsageModelKey;
  model: string;
  unit: string;
  categories: CoreUsageCategory[];
  percentage: number;
}

export interface UsageCategoryAggregate extends UsageAggregate {
  category: CoreUsageCategory;
  percentage: number;
}

export interface UsageTrendPoint {
  date: string;
  totalCostMicros: number;
  costByModel: Record<CoreUsageModelKey, number>;
}

export interface UsageDashboardResult {
  generatedAt: string;
  range: UsageDateRange;
  periodTotals: {
    todayCostMicros: number;
    weekCostMicros: number;
    monthCostMicros: number;
  };
  totals: UsageAggregate;
  models: UsageModelAggregate[];
  categories: UsageCategoryAggregate[];
  trend: UsageTrendPoint[];
  unresolvedCount: number;
}

export interface UsageRecordsQuery extends UsageQueryFilters {
  page?: number;
  pageSize?: number;
}

export interface UsageRecord {
  id: string;
  eventKey: string;
  coreModelKey: CoreUsageModelKey;
  category: CoreUsageCategory;
  providerId: string;
  providerName: string;
  model: string;
  pricingVersion: string;
  callCount: number;
  quantity: number;
  unit: string;
  priceScale: number;
  unitPriceMicros: number;
  costMicros: number;
  detail: Record<string, unknown>;
  projectId: string | null;
  refType: string;
  refId: string;
  createdAt: string;
}

export interface UsageRecordsResult {
  items: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface WhereClause {
  sql: string;
  values: Array<string | number>;
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function shanghaiMidnightMs(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS;
}

function shanghaiDateParts(now: Date): { year: number; month: number; day: number; weekday: number } {
  if (Number.isNaN(now.getTime())) throw new Error('invalid usage clock');
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function shanghaiDateLabel(timestampMs: number): string {
  return new Date(timestampMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Compute UTC query boundaries for UTC+8 natural days; weeks start Monday. */
export function getShanghaiUsagePeriods(now = new Date()): ShanghaiUsagePeriods {
  const parts = shanghaiDateParts(now);
  const todayStart = shanghaiMidnightMs(parts.year, parts.month, parts.day);
  const daysSinceMonday = (parts.weekday + 6) % 7;
  const weekStart = todayStart - daysSinceMonday * DAY_MS;
  const monthStart = shanghaiMidnightMs(parts.year, parts.month, 1);
  const nextMonthStart = shanghaiMidnightMs(parts.year, parts.month + 1, 1);
  const trendStart = todayStart - 29 * DAY_MS;

  return {
    today: { from: iso(todayStart), to: iso(todayStart + DAY_MS) },
    week: { from: iso(weekStart), to: iso(weekStart + 7 * DAY_MS) },
    month: { from: iso(monthStart), to: iso(nextMonthStart) },
    trend: Array.from({ length: 30 }, (_, index) => {
      const fromMs = trendStart + index * DAY_MS;
      return {
        date: shanghaiDateLabel(fromMs),
        from: iso(fromMs),
        to: iso(fromMs + DAY_MS),
      };
    }),
  };
}

export function isCoreUsageModelKey(value: string | null | undefined): value is CoreUsageModelKey {
  return !!value && (CORE_USAGE_MODEL_KEYS as readonly string[]).includes(value);
}

export function isCoreUsageCategory(value: string | null | undefined): value is CoreUsageCategory {
  return !!value && (CORE_USAGE_CATEGORIES as readonly string[]).includes(value);
}

/** A YYYY-MM-DD value denotes Shanghai midnight; timestamps must include an offset. */
export function parseUsageBoundary(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const timestamp = shanghaiMidnightMs(year, month, day);
    if (shanghaiDateLabel(timestamp) !== normalized) throw new Error('invalid usage date');
    return iso(timestamp);
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) throw new Error('usage timestamp must include a timezone');
  const timestampParts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(normalized);
  if (!timestampParts) throw new Error('invalid usage timestamp');
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = timestampParts.slice(1).map((part) => Number(part || 0));
  const calendarProbe = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarProbe.getUTCFullYear() !== year
    || calendarProbe.getUTCMonth() !== month - 1
    || calendarProbe.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    throw new Error('invalid usage timestamp');
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error('invalid usage timestamp');
  return iso(timestamp);
}

function validateFilters(filters: UsageQueryFilters): void {
  if (filters.coreModelKey && !isCoreUsageModelKey(filters.coreModelKey)) throw new Error('invalid coreModelKey');
  if (filters.category && !isCoreUsageCategory(filters.category)) throw new Error('invalid category');
  if (filters.from && filters.to && filters.from >= filters.to) throw new Error('from must be earlier than to');
}

function buildLedgerWhere(filters: UsageQueryFilters, alias = ''): WhereClause {
  validateFilters(filters);
  const prefix = alias ? `${alias}.` : '';
  const clauses: string[] = [];
  const values: string[] = [];
  if (filters.from) {
    clauses.push(`${prefix}createdAt >= ?`);
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${prefix}createdAt < ?`);
    values.push(filters.to);
  }
  if (filters.coreModelKey) {
    clauses.push(`${prefix}coreModelKey = ?`);
    values.push(filters.coreModelKey);
  }
  if (filters.category) {
    clauses.push(`${prefix}category = ?`);
    values.push(filters.category);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function aggregate(db: Database.Database, filters: UsageQueryFilters): UsageAggregate {
  const where = buildLedgerWhere(filters);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(costMicros), 0) AS costMicros,
      COALESCE(SUM(callCount), 0) AS callCount,
      COALESCE(SUM(quantity), 0) AS quantity
    FROM usage_ledger
    ${where.sql}
  `).get(...where.values) as UsageAggregate;
  return {
    costMicros: Number(row.costMicros || 0),
    callCount: Number(row.callCount || 0),
    quantity: Number(row.quantity || 0),
  };
}

function percentage(part: number, total: number): number {
  return total > 0 ? Math.round(part / total * 1_000_000) / 10_000 : 0;
}

function uncertainCount(db: Database.Database, filters: UsageQueryFilters): number {
  const clauses = [`status = 'uncertain'`];
  const values: string[] = [];
  if (filters.from) {
    clauses.push('createdAt >= ?');
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push('createdAt < ?');
    values.push(filters.to);
  }
  if (filters.coreModelKey) {
    clauses.push(`CASE WHEN json_valid(snapshotJson) THEN json_extract(snapshotJson, '$.coreModelKey') ELSE NULL END = ?`);
    values.push(filters.coreModelKey);
  }
  if (filters.category) {
    clauses.push(`
      COALESCE(
        CASE WHEN json_valid(usageJson) THEN json_extract(usageJson, '$.category') ELSE NULL END,
        CASE CASE WHEN json_valid(snapshotJson) THEN json_extract(snapshotJson, '$.coreModelKey') ELSE NULL END
          WHEN 'company-image2-medium' THEN 'image'
          WHEN 'company-qiniuyun-gpt-image-2-medium' THEN 'image'
          WHEN 'company-kling-3-0' THEN 'video'
          WHEN 'company-seedance-fast' THEN 'video'
          WHEN 'company-gpt-5-6-luna' THEN 'llm_text'
          WHEN 'doubao-seed-tts-2' THEN 'tts'
          ELSE NULL
        END
      ) = ?
    `);
    values.push(filters.category);
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM usage_call_events
    WHERE ${clauses.join(' AND ')}
  `).get(...values) as { count: number };
  return Number(row.count || 0);
}

function emptyModelCosts(): Record<CoreUsageModelKey, number> {
  return Object.fromEntries(CORE_USAGE_MODEL_KEYS.map((key) => [key, 0])) as Record<CoreUsageModelKey, number>;
}

export function queryUsageDashboard(
  db: Database.Database,
  input: UsageDashboardQuery = {},
): UsageDashboardResult {
  const now = input.now ?? new Date();
  const periods = getShanghaiUsagePeriods(now);
  const filters: UsageQueryFilters = {
    from: input.from ?? periods.month.from,
    to: input.to ?? periods.month.to,
    coreModelKey: input.coreModelKey,
    category: input.category,
  };
  validateFilters(filters);
  const dimensionFilters = { coreModelKey: filters.coreModelKey, category: filters.category };
  const totals = aggregate(db, filters);
  const modelWhere = buildLedgerWhere(filters);
  const modelRows = db.prepare(`
    SELECT coreModelKey, model, unit,
      GROUP_CONCAT(DISTINCT category) AS categories,
      SUM(costMicros) AS costMicros,
      SUM(callCount) AS callCount,
      SUM(quantity) AS quantity
    FROM usage_ledger
    ${modelWhere.sql}
    GROUP BY coreModelKey, model, unit
    ORDER BY costMicros DESC, coreModelKey ASC
  `).all(...modelWhere.values) as Array<{
    coreModelKey: CoreUsageModelKey;
    model: string;
    unit: string;
    categories: string;
    costMicros: number;
    callCount: number;
    quantity: number;
  }>;
  const models = modelRows.map((row): UsageModelAggregate => ({
    coreModelKey: row.coreModelKey,
    model: row.model,
    unit: row.unit,
    categories: row.categories.split(',').filter(isCoreUsageCategory),
    costMicros: Number(row.costMicros || 0),
    callCount: Number(row.callCount || 0),
    quantity: Number(row.quantity || 0),
    percentage: percentage(Number(row.costMicros || 0), totals.costMicros),
  }));

  const categoryWhere = buildLedgerWhere(filters);
  const categoryRows = db.prepare(`
    SELECT category, SUM(costMicros) AS costMicros,
      SUM(callCount) AS callCount, SUM(quantity) AS quantity
    FROM usage_ledger
    ${categoryWhere.sql}
    GROUP BY category
    ORDER BY costMicros DESC, category ASC
  `).all(...categoryWhere.values) as Array<UsageAggregate & { category: CoreUsageCategory }>;
  const categories = categoryRows.map((row): UsageCategoryAggregate => ({
    category: row.category,
    costMicros: Number(row.costMicros || 0),
    callCount: Number(row.callCount || 0),
    quantity: Number(row.quantity || 0),
    percentage: percentage(Number(row.costMicros || 0), totals.costMicros),
  }));

  const trendFilters: UsageQueryFilters = {
    from: periods.trend[0].from,
    to: periods.trend.at(-1)?.to,
    ...dimensionFilters,
  };
  const trendWhere = buildLedgerWhere(trendFilters);
  const trendRows = db.prepare(`
    SELECT substr(datetime(createdAt, '+8 hours'), 1, 10) AS date,
      coreModelKey, SUM(costMicros) AS costMicros
    FROM usage_ledger
    ${trendWhere.sql}
    GROUP BY date, coreModelKey
    ORDER BY date ASC, coreModelKey ASC
  `).all(...trendWhere.values) as Array<{ date: string; coreModelKey: CoreUsageModelKey; costMicros: number }>;
  const trendMap = new Map(periods.trend.map((day) => [day.date, emptyModelCosts()]));
  for (const row of trendRows) {
    const costs = trendMap.get(row.date);
    if (costs && isCoreUsageModelKey(row.coreModelKey)) costs[row.coreModelKey] = Number(row.costMicros || 0);
  }
  const trend = periods.trend.map((day): UsageTrendPoint => {
    const costByModel = trendMap.get(day.date) ?? emptyModelCosts();
    return {
      date: day.date,
      costByModel,
      totalCostMicros: Object.values(costByModel).reduce((sum, value) => sum + value, 0),
    };
  });

  return {
    generatedAt: now.toISOString(),
    range: { from: filters.from!, to: filters.to! },
    periodTotals: {
      todayCostMicros: aggregate(db, { ...dimensionFilters, ...periods.today }).costMicros,
      weekCostMicros: aggregate(db, { ...dimensionFilters, ...periods.week }).costMicros,
      monthCostMicros: aggregate(db, { ...dimensionFilters, ...periods.month }).costMicros,
    },
    totals,
    models,
    categories,
    trend,
    unresolvedCount: uncertainCount(db, filters),
  };
}

function safeDetail(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function listUsageRecords(
  db: Database.Database,
  input: UsageRecordsQuery = {},
): UsageRecordsResult {
  const page = Number.isFinite(input.page) ? Math.max(1, Math.floor(input.page!)) : 1;
  const pageSize = Number.isFinite(input.pageSize) ? Math.min(100, Math.max(1, Math.floor(input.pageSize!))) : 25;
  const filters: UsageQueryFilters = {
    from: input.from,
    to: input.to,
    coreModelKey: input.coreModelKey,
    category: input.category,
  };
  const where = buildLedgerWhere(filters);
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger ${where.sql}`)
    .get(...where.values) as { count: number };
  const total = Number(countRow.count || 0);
  const rows = db.prepare(`
    SELECT * FROM usage_ledger
    ${where.sql}
    ORDER BY createdAt DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...where.values, pageSize, (page - 1) * pageSize) as Array<Omit<UsageRecord, 'detail'> & { detailJson: string }>;
  return {
    items: rows.map(({ detailJson, ...row }) => ({ ...row, detail: safeDetail(detailJson) })),
    total,
    page,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

/**
 * Sum committed ledger cost per project for the project list. Callers must
 * gate on usage schema availability before querying.
 */
export function sumUsageCostByProject(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`
    SELECT projectId, SUM(costMicros) AS costMicros
    FROM usage_ledger
    WHERE projectId IS NOT NULL
    GROUP BY projectId
  `).all() as Array<{ projectId: string; costMicros: number }>;
  return new Map(rows.map((row) => [row.projectId, Number(row.costMicros || 0)]));
}
