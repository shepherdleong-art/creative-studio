import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  calculateUsageCostMicros,
  resolveCoreUsagePlan,
  type CoreUsageCategory,
  type CoreUsagePriceComponentV1,
  type CoreUsageQuantities,
  type CoreUsageSnapshotV1,
} from './usage-pricing.ts';
import { getUsageSchemaReadiness } from './usage-schema.ts';

/** One process-wide owner id used to distinguish interrupted call evidence. */
export const USAGE_INSTANCE_ID = `usage-${randomUUID()}`;

export type UsageCallStatus = 'started' | 'billable' | 'recorded' | 'uncertain';

export interface UsageMeasurement {
  /** The native quantity, or one quantity per price component. */
  quantity?: CoreUsageQuantities;
  /** Alias accepted for callers that prefer the plural spelling. */
  quantities?: CoreUsageQuantities;
  callCount?: number;
  category?: CoreUsageCategory;
  detail?: Record<string, unknown>;
  detailJson?: string | Record<string, unknown>;
}

export type UsageInput = UsageMeasurement | CoreUsageQuantities;

export interface UsageRecordInput {
  eventKey: string;
  snapshot: unknown;
  usage?: UsageInput;
  quantity?: CoreUsageQuantities;
  callCount?: number;
  category?: CoreUsageCategory;
  detail?: Record<string, unknown>;
  projectId?: string | null;
  refType?: string;
  refId?: string;
  createdAt?: string;
}

export interface UsageOperationResult {
  ok: boolean;
  inserted?: boolean;
  changed?: boolean;
  status?: UsageCallStatus | null;
  reason?: 'schema_unavailable' | 'invalid_snapshot' | 'invalid_usage' | 'not_found' | 'write_failed';
  error?: string;
}

export interface UsageDrainResult {
  ok: boolean;
  recorded: number;
  uncertain: number;
  failed: number;
  reason?: 'schema_unavailable' | 'write_failed';
}

export interface UsageRecoveryResult {
  ok: boolean;
  uncertain: number;
  reason?: 'schema_unavailable' | 'write_failed';
}

export interface UsageReconcileResult {
  ok: boolean;
  /** Number of started calls recovered from another process. */
  recovered: number;
  /** Number of billable call events drained in this pass. */
  drained: number;
  /** Total newly inserted ledger rows from draining, task replay and backfill. */
  recorded: number;
  /** Number of successful task rows whose snapshots could not be trusted. */
  invalidSnapshots: number;
  /** Number of call-event/task writes that failed and remain retryable. */
  failed: number;
  /** Number of legacy rows considered by the one-time image backfill. */
  backfillCandidates: number;
  /** Number of legacy rows inserted during this pass. */
  backfilled: number;
  /** Whether the legacy backfill marker was already present after this pass. */
  backfillMarkerPresent: boolean;
  /** Whether this pass inserted the legacy backfill marker. */
  backfillMarkerWritten: boolean;
  /** Uncertain call events after recovery and drain. */
  uncertain: number;
  reason?: 'schema_unavailable' | 'write_failed';
}

interface ParsedSnapshot {
  snapshot: CoreUsageSnapshotV1;
  category: CoreUsageCategory;
}

interface NormalizedMeasurement {
  quantity: CoreUsageQuantities;
  callCount: number;
  category?: CoreUsageCategory;
  detail: Record<string, unknown>;
}

interface UsageCallRow {
  eventKey: string;
  status: UsageCallStatus;
  snapshotJson: string;
  usageJson: string;
  projectId: string | null;
  refType: string;
  refId: string;
}

interface ReconcileImageJobRow {
  id: string;
  projectId: string | null;
  attempt: number | null;
  finishedAt: string | null;
  startedAt: string | null;
  usageSnapshotJson: string | null;
}

interface ReconcileVideoJobRow {
  id: string;
  projectId: string | null;
  durationSec: number | null;
  finishedAt: string | null;
  startedAt: string | null;
  usageSnapshotJson: string | null;
}

interface LegacyImageBackfillRow {
  id: string;
  projectId: string | null;
  attempt: number | null;
  estimatedCost: number;
  providerName: string;
  model: string;
  finishedAt: string | null;
  startedAt: string | null;
}

const CORE_CATEGORIES: Readonly<Record<string, CoreUsageCategory>> = {
  'company-image2-medium': 'image',
  'company-qiniuyun-gpt-image-2-medium': 'image',
  'company-kling-3-0': 'video',
  'company-seedance-fast': 'video',
  'company-gpt-5-6-luna': 'llm_text',
  'doubao-seed-tts-2': 'tts',
};

const COMPONENT_KEYS_BY_CORE_MODEL: Readonly<Record<string, readonly string[]>> = {
  'company-image2-medium': ['image'],
  'company-qiniuyun-gpt-image-2-medium': ['image'],
  'company-kling-3-0': ['second'],
  'company-seedance-fast': ['second'],
  'company-gpt-5-6-luna': ['input_token', 'output_token', 'cached_input_token'],
  'doubao-seed-tts-2': ['character'],
};

const COMPONENT_UNITS_BY_KEY: Readonly<Record<string, string>> = {
  image: 'image',
  second: 'second',
  input_token: 'token',
  output_token: 'token',
  cached_input_token: 'token',
  character: 'character',
};

const COMPONENT_QUANTITY_NAMES: Readonly<Record<string, readonly string[]>> = {
  image: ['image', 'images'],
  request: ['request', 'requests'],
  second: ['second', 'seconds', 'durationSec', 'durationSeconds'],
  input_token: ['input_token', 'inputTokens', 'uncachedInputTokens'],
  output_token: ['output_token', 'outputTokens', 'completionTokens'],
  cached_input_token: ['cached_input_token', 'cachedInputTokens', 'cachedReadTokens', 'cachedTokens'],
  character: ['character', 'characters', 'unicodeCharacters'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asSafeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function asCallCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

function safeJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : serialized;
  } catch {
    return null;
  }
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function schemaAvailable(db: Database.Database): boolean {
  try {
    const readiness = getUsageSchemaReadiness(db);
    if (!readiness.available) {
      console.error('[usage-ledger] unavailable; usage accounting skipped');
      return false;
    }
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('usage_ledger', 'usage_call_events')
    `).all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    if (!names.has('usage_ledger') || !names.has('usage_call_events')) {
      console.error('[usage-ledger] tables missing; usage accounting skipped');
      return false;
    }
    return true;
  } catch {
    console.error('[usage-ledger] unavailable; usage accounting skipped');
    return false;
  }
}

function snapshotProvider(value: unknown): CoreUsageSnapshotV1['provider'] | null {
  if (!isRecord(value)) return null;
  const providerTable = asNonEmptyString(value.providerTable);
  const providerId = asNonEmptyString(value.providerId);
  const providerName = typeof value.providerName === 'string' ? value.providerName.trim() : '';
  const providerType = asNonEmptyString(value.providerType);
  const configuredModel = asNonEmptyString(value.configuredModel);
  const requestModel = asNonEmptyString(value.requestModel);
  if (!providerTable || !providerId || !providerType || !configuredModel || !requestModel) return null;
  const provider: CoreUsageSnapshotV1['provider'] = {
    providerTable: providerTable as CoreUsageSnapshotV1['provider']['providerTable'],
    providerId,
    providerName,
    providerType,
    configuredModel,
    requestModel,
  };
  const executionScope = asNonEmptyString(value.executionScope);
  const apiStyle = asNonEmptyString(value.apiStyle);
  if (executionScope) provider.executionScope = executionScope as 'company' | 'external';
  if (apiStyle) provider.apiStyle = apiStyle;
  return provider;
}

/** Parse a versioned snapshot without consulting the current price registry. */
export function parseUsageSnapshot(value: unknown): { ok: true; parsed: ParsedSnapshot } | { ok: false; error: string } {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'usage snapshot is invalid JSON' };
    }
  }
  if (!isRecord(raw)) return { ok: false, error: 'usage snapshot must be an object' };
  if (raw.schemaVersion !== 1) {
    return { ok: false, error: 'usage snapshot schemaVersion is unsupported' };
  }
  const coreModelKey = asNonEmptyString(raw.coreModelKey);
  const pricingVersion = asNonEmptyString(raw.pricingVersion);
  const startedAt = asNonEmptyString(raw.startedAt);
  const refType = typeof raw.refType === 'string' ? raw.refType : '';
  const refId = typeof raw.refId === 'string' ? raw.refId : '';
  const provider = snapshotProvider(raw.provider);
  const components = raw.priceComponents;
  if (!coreModelKey || !pricingVersion || !startedAt || !provider || !Array.isArray(components)) {
    return { ok: false, error: 'usage snapshot is missing required fields' };
  }
  const category = CORE_CATEGORIES[coreModelKey];
  const expectedKeys = COMPONENT_KEYS_BY_CORE_MODEL[coreModelKey];
  if (!category || !expectedKeys || components.length !== expectedKeys.length) {
    return { ok: false, error: 'usage snapshot core model is unsupported' };
  }
  // Re-check the frozen provider identity as a scope gate. The current plan is
  // used only to validate identity/coreModelKey; its prices never replace the
  // prices stored in this historical snapshot.
  const currentPlan = resolveCoreUsagePlan(provider);
  if (!currentPlan || currentPlan.coreModelKey !== coreModelKey) {
    return { ok: false, error: 'usage snapshot provider identity is unsupported' };
  }
  const normalizedComponents: CoreUsagePriceComponentV1[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (!isRecord(component)) return { ok: false, error: 'usage snapshot price component is invalid' };
    const key = asNonEmptyString(component.key);
    const unit = asNonEmptyString(component.unit);
    const unitPriceMicros = component.unitPriceMicros;
    const priceScale = component.priceScale;
    if (
      !key || key !== expectedKeys[index] || !unit || COMPONENT_UNITS_BY_KEY[key] !== unit
      || typeof unitPriceMicros !== 'number' || !Number.isInteger(unitPriceMicros) || unitPriceMicros < 0
      || typeof priceScale !== 'number' || !Number.isInteger(priceScale) || priceScale <= 0
    ) {
      return { ok: false, error: 'usage snapshot price component is invalid' };
    }
    normalizedComponents.push({
      key: key as CoreUsagePriceComponentV1['key'],
      unit: unit as CoreUsagePriceComponentV1['unit'],
      unitPriceMicros,
      priceScale,
    });
  }
  return {
    ok: true,
    parsed: {
      category,
      snapshot: {
        schemaVersion: 1,
        provider,
        coreModelKey,
        pricingVersion,
        priceComponents: normalizedComponents,
        startedAt,
        ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
        refType,
        refId,
      },
    },
  };
}

function isMeasurement(value: unknown): value is UsageMeasurement {
  return isRecord(value)
    && ('quantity' in value || 'quantities' in value || 'callCount' in value || 'category' in value || 'detail' in value || 'detailJson' in value);
}

function normalizeMeasurement(input: UsageInput | undefined, fallback: Pick<UsageRecordInput, 'quantity' | 'callCount' | 'category' | 'detail'> = {}): NormalizedMeasurement {
  const measurement = isMeasurement(input) ? input : undefined;
  const quantity = measurement?.quantity ?? measurement?.quantities ?? (!measurement && input !== undefined ? input : undefined) ?? fallback.quantity ?? 0;
  let detail: Record<string, unknown> = fallback.detail ?? {};
  if (measurement?.detail) detail = measurement.detail;
  else if (measurement?.detailJson) detail = safeJsonObject(measurement.detailJson);
  return {
    quantity: quantity as CoreUsageQuantities,
    callCount: asCallCount(measurement?.callCount ?? fallback.callCount),
    category: measurement?.category ?? fallback.category,
    detail,
  };
}

function quantityForComponent(quantity: CoreUsageQuantities, component: CoreUsagePriceComponentV1, index: number): number {
  if (typeof quantity === 'number') return index === 0 ? asSafeNumber(quantity) : 0;
  if (Array.isArray(quantity)) return asSafeNumber(quantity[index]);
  if (!isRecord(quantity)) return 0;
  for (const name of COMPONENT_QUANTITY_NAMES[component.key] ?? []) {
    if (name in quantity) return asSafeNumber(quantity[name]);
  }
  return 0;
}

function usageLedgerFields(
  eventKey: string,
  parsed: ParsedSnapshot,
  measurement: NormalizedMeasurement,
  input: Pick<UsageRecordInput, 'projectId' | 'refType' | 'refId' | 'createdAt'>,
): {
  id: string;
  eventKey: string;
  coreModelKey: string;
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
  detailJson: string;
  projectId: string | null;
  refType: string;
  refId: string;
  createdAt: string;
} {
  const { snapshot: usageSnapshot, category: snapshotCategory } = parsed;
  const components = usageSnapshot.priceComponents;
  const componentDetails = components.map((component, index) => {
    const quantity = quantityForComponent(measurement.quantity, component, index);
    const componentCost = calculateUsageCostMicros([component], quantity);
    return {
      key: component.key,
      unit: component.unit,
      quantity,
      unitPriceMicros: component.unitPriceMicros,
      priceScale: component.priceScale,
      componentCostMicros: componentCost,
    };
  });
  const quantity = componentDetails.reduce((sum, component) => sum + component.quantity, 0);
  const costMicros = componentDetails.reduce((sum, component) => sum + component.componentCostMicros, 0);
  const isGpt = usageSnapshot.coreModelKey === 'company-gpt-5-6-luna';
  const detailJson = JSON.stringify({
    ...measurement.detail,
    priceComponents: componentDetails,
  });
  return {
    id: randomUUID(),
    eventKey,
    coreModelKey: usageSnapshot.coreModelKey,
    category: measurement.category ?? snapshotCategory,
    providerId: usageSnapshot.provider.providerId,
    providerName: usageSnapshot.provider.providerName,
    model: usageSnapshot.provider.requestModel,
    pricingVersion: usageSnapshot.pricingVersion,
    callCount: measurement.callCount,
    quantity,
    unit: components[0].unit,
    priceScale: isGpt ? 1 : components[0].priceScale,
    unitPriceMicros: isGpt ? 0 : components[0].unitPriceMicros,
    costMicros,
    detailJson,
    projectId: input.projectId ?? usageSnapshot.projectId ?? null,
    refType: input.refType ?? usageSnapshot.refType,
    refId: input.refId ?? usageSnapshot.refId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function insertLedgerRow(db: Database.Database, fields: ReturnType<typeof usageLedgerFields>): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO usage_ledger
      (id, eventKey, coreModelKey, category, providerId, providerName, model, pricingVersion,
       callCount, quantity, unit, priceScale, unitPriceMicros, costMicros, detailJson,
       projectId, refType, refId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.id,
    fields.eventKey,
    fields.coreModelKey,
    fields.category,
    fields.providerId,
    fields.providerName,
    fields.model,
    fields.pricingVersion,
    fields.callCount,
    fields.quantity,
    fields.unit,
    fields.priceScale,
    fields.unitPriceMicros,
    fields.costMicros,
    fields.detailJson,
    fields.projectId,
    fields.refType,
    fields.refId,
    fields.createdAt,
  );
  return result.changes === 1;
}

function snapshotFailureResult(error: string): UsageOperationResult {
  return { ok: false, reason: 'invalid_snapshot', error };
}

/** Write one immutable billable row. Repeating an eventKey is a no-op. */
export function recordUsage(db: Database.Database, input: UsageRecordInput): UsageOperationResult {
  if (!schemaAvailable(db)) return { ok: false, reason: 'schema_unavailable' };
  const parsed = parseUsageSnapshot(input.snapshot);
  if (!parsed.ok) return snapshotFailureResult(parsed.error);
  const measurement = normalizeMeasurement(input.usage, input);
  const fields = usageLedgerFields(input.eventKey, parsed.parsed, measurement, input);
  try {
    const inserted = insertLedgerRow(db, fields);
    return { ok: true, inserted };
  } catch {
    console.error('[usage-ledger] write failed; usage accounting skipped');
    return { ok: false, reason: 'write_failed' };
  }
}

function snapshotField(value: unknown, field: string): string {
  return isRecord(value) && typeof value[field] === 'string' ? value[field] as string : '';
}

export interface BeginUsageCallInput {
  eventKey: string;
  snapshot: unknown;
  projectId?: string | null;
  refType?: string;
  refId?: string;
  ownerInstanceId?: string;
}

/** Persist the price snapshot before a real upstream call starts. */
export function beginUsageCall(db: Database.Database, input: BeginUsageCallInput): UsageOperationResult {
  if (!schemaAvailable(db)) return { ok: false, reason: 'schema_unavailable' };
  const snapshotJson = safeJson(input.snapshot) ?? '';
  const projectId = input.projectId ?? (snapshotField(input.snapshot, 'projectId') || null);
  const refType = input.refType ?? snapshotField(input.snapshot, 'refType');
  const refId = input.refId ?? snapshotField(input.snapshot, 'refId');
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO usage_call_events
        (eventKey, status, ownerInstanceId, snapshotJson, usageJson, projectId, refType, refId, createdAt, updatedAt)
      VALUES (?, 'started', ?, ?, '{}', ?, ?, ?, ?, ?)
    `).run(
      input.eventKey,
      input.ownerInstanceId || USAGE_INSTANCE_ID,
      snapshotJson,
      projectId,
      refType,
      refId,
      now,
      now,
    );
    const existing = db.prepare(`SELECT status FROM usage_call_events WHERE eventKey = ?`).get(input.eventKey) as { status?: UsageCallStatus } | undefined;
    return {
      ok: true,
      inserted: result.changes === 1,
      status: existing?.status ?? null,
    };
  } catch {
    console.error('[usage-ledger] write failed; usage accounting skipped');
    return { ok: false, reason: 'write_failed' };
  }
}

/** Mark a started event billable after a successful upstream response. */
export function markUsageCallBillable(db: Database.Database, eventKey: string, usage: UsageInput): UsageOperationResult {
  if (!schemaAvailable(db)) return { ok: false, reason: 'schema_unavailable' };
  try {
    const row = db.prepare(`SELECT status FROM usage_call_events WHERE eventKey = ?`).get(eventKey) as { status?: UsageCallStatus } | undefined;
    if (!row) return { ok: false, reason: 'not_found', status: null };
    if (row.status !== 'started') return { ok: true, changed: false, status: row.status };
    const measurement = normalizeMeasurement(usage);
    const usageJson = safeJson({
      quantity: measurement.quantity,
      callCount: measurement.callCount,
      ...(measurement.category === undefined ? {} : { category: measurement.category }),
      detail: measurement.detail,
    });
    if (usageJson === null) {
      db.prepare(`UPDATE usage_call_events SET status='uncertain', errorMessage=?, updatedAt=? WHERE eventKey=? AND status='started'`)
        .run('usage quantity is not serializable', new Date().toISOString(), eventKey);
      return { ok: false, reason: 'invalid_usage', status: 'uncertain' };
    }
    const result = db.prepare(`
      UPDATE usage_call_events
      SET status = 'billable', usageJson = ?, errorMessage = NULL, updatedAt = ?
      WHERE eventKey = ? AND status = 'started'
    `).run(usageJson, new Date().toISOString(), eventKey);
    return { ok: true, changed: result.changes === 1, status: result.changes === 1 ? 'billable' : row.status };
  } catch {
    console.error('[usage-ledger] write failed; usage accounting skipped');
    return { ok: false, reason: 'write_failed' };
  }
}

function markUncertain(db: Database.Database, eventKey: string, error: string): void {
  db.prepare(`
    UPDATE usage_call_events
    SET status = 'uncertain', errorMessage = ?, updatedAt = ?
    WHERE eventKey = ? AND status = 'billable'
  `).run(error.slice(0, 240), new Date().toISOString(), eventKey);
}

function parseUsageJson(value: string): UsageMeasurement | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    return parsed as UsageMeasurement;
  } catch {
    return null;
  }
}

/** Move billable evidence into the immutable ledger, one event at a time. */
export function drainBillableUsageCalls(db: Database.Database): UsageDrainResult {
  if (!schemaAvailable(db)) return { ok: false, recorded: 0, uncertain: 0, failed: 0, reason: 'schema_unavailable' };
  let rows: UsageCallRow[];
  try {
    rows = db.prepare(`
      SELECT eventKey, status, snapshotJson, usageJson, projectId, refType, refId
      FROM usage_call_events
      WHERE status = 'billable'
      ORDER BY updatedAt, eventKey
    `).all() as UsageCallRow[];
  } catch {
    console.error('[usage-ledger] read failed; usage accounting skipped');
    return { ok: false, recorded: 0, uncertain: 0, failed: 1, reason: 'write_failed' };
  }
  let recorded = 0;
  let uncertain = 0;
  let failed = 0;
  for (const row of rows) {
    const parsed = parseUsageSnapshot(row.snapshotJson);
    const usage = parseUsageJson(row.usageJson);
    if (!parsed.ok || !usage) {
      try {
        markUncertain(db, row.eventKey, parsed.ok ? 'usage evidence is invalid' : parsed.error);
        uncertain += 1;
      } catch {
        failed += 1;
      }
      continue;
    }
    try {
      const measurement = normalizeMeasurement(usage);
      const fields = usageLedgerFields(row.eventKey, parsed.parsed, measurement, {
        projectId: row.projectId,
        refType: row.refType,
        refId: row.refId,
      });
      db.transaction(() => {
        insertLedgerRow(db, fields);
        db.prepare(`
          UPDATE usage_call_events
          SET status = 'recorded', errorMessage = NULL, updatedAt = ?
          WHERE eventKey = ? AND status = 'billable'
        `).run(new Date().toISOString(), row.eventKey);
      })();
      recorded += 1;
    } catch {
      // Keep the evidence billable so a later reconciliation can retry a transient DB failure.
      failed += 1;
      console.error('[usage-ledger] write failed; usage accounting skipped');
    }
  }
  return { ok: failed === 0, recorded, uncertain, failed, ...(failed > 0 ? { reason: 'write_failed' as const } : {}) };
}

/** Mark calls left by another process uncertain; uncertain evidence is never charged. */
export function recoverInterruptedUsageCalls(db: Database.Database, currentOwner = USAGE_INSTANCE_ID): UsageRecoveryResult {
  if (!schemaAvailable(db)) return { ok: false, uncertain: 0, reason: 'schema_unavailable' };
  try {
    const result = db.prepare(`
      UPDATE usage_call_events
      SET status = 'uncertain', errorMessage = ?, updatedAt = ?
      WHERE status = 'started' AND ownerInstanceId <> ?
    `).run('usage call interrupted by another instance', new Date().toISOString(), currentOwner);
    return { ok: true, uncertain: result.changes };
  } catch {
    console.error('[usage-ledger] write failed; usage accounting skipped');
    return { ok: false, uncertain: 0, reason: 'write_failed' };
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
  } catch {
    return false;
  }
}

function requiredColumnsExist(db: Database.Database, table: string, columns: readonly string[]): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    const names = new Set(rows.map((row) => row.name));
    return columns.every((column) => names.has(column));
  } catch {
    return false;
  }
}

/** Convert SQLite's UTC datetime text to the ISO form used by new ledger rows. */
function normalizeLedgerTimestamp(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const sqliteUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(raw);
  const candidate = sqliteUtc
    ? new Date(`${sqliteUtc[1]}T${sqliteUtc[2]}Z`)
    : new Date(raw);
  return Number.isNaN(candidate.valueOf()) ? null : candidate.toISOString();
}

function preferredLedgerTimestamp(finishedAt: unknown, createdAt: unknown): string {
  return normalizeLedgerTimestamp(finishedAt)
    ?? normalizeLedgerTimestamp(createdAt)
    ?? new Date().toISOString();
}

function positiveAttempt(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : 1;
}

function queryReconcileImageJobs(db: Database.Database): { rows: ReconcileImageJobRow[]; failed: boolean } {
  if (!tableExists(db, 'jobs') || !requiredColumnsExist(db, 'jobs', [
    'id', 'projectId', 'attempt', 'finishedAt', 'startedAt', 'usageSnapshotJson',
  ])) {
    return { rows: [], failed: false };
  }
  try {
    const rows = db.prepare(`
      SELECT j.id, j.projectId, j.attempt, j.finishedAt, j.startedAt, j.usageSnapshotJson
      FROM jobs j
      LEFT JOIN usage_ledger l
        ON l.eventKey = 'image-job:' || j.id || ':succeeded'
      WHERE j.status = 'succeeded'
        AND j.usageSnapshotJson IS NOT NULL
        AND TRIM(j.usageSnapshotJson) <> ''
        AND l.eventKey IS NULL
      ORDER BY j.id
    `).all() as ReconcileImageJobRow[];
    return { rows, failed: false };
  } catch {
    console.error('[usage-ledger] image reconciliation scan failed; usage accounting skipped');
    return { rows: [], failed: true };
  }
}

function queryReconcileVideoJobs(db: Database.Database): { rows: ReconcileVideoJobRow[]; failed: boolean } {
  if (!tableExists(db, 'video_jobs') || !requiredColumnsExist(db, 'video_jobs', [
    'id', 'projectId', 'durationSec', 'finishedAt', 'startedAt', 'usageSnapshotJson',
  ])) {
    return { rows: [], failed: false };
  }
  try {
    const rows = db.prepare(`
      SELECT j.id, j.projectId, j.durationSec, j.finishedAt, j.startedAt, j.usageSnapshotJson
      FROM video_jobs j
      LEFT JOIN usage_ledger l
        ON l.eventKey = 'video-job:' || j.id || ':succeeded'
      WHERE j.status = 'succeeded'
        AND j.usageSnapshotJson IS NOT NULL
        AND TRIM(j.usageSnapshotJson) <> ''
        AND l.eventKey IS NULL
      ORDER BY j.id
    `).all() as ReconcileVideoJobRow[];
    return { rows, failed: false };
  } catch {
    console.error('[usage-ledger] video reconciliation scan failed; usage accounting skipped');
    return { rows: [], failed: true };
  }
}

function replayImageJob(db: Database.Database, row: ReconcileImageJobRow):
  { inserted: boolean; invalidSnapshot: boolean; failed: boolean } {
  const eventKey = `image-job:${row.id}:succeeded`;
  const parsed = parseUsageSnapshot(row.usageSnapshotJson ?? '');
  if (!parsed.ok) {
    console.warn(`[usage-ledger] image job ${row.id} usage snapshot ignored: ${parsed.error}`);
    return { inserted: false, invalidSnapshot: true, failed: false };
  }
  const quantity = positiveAttempt(row.attempt);
  const result = recordUsage(db, {
    eventKey,
    snapshot: parsed.parsed.snapshot,
    usage: { quantity, callCount: quantity, detail: { source: 'reconcile', taskType: 'image-job' } },
    projectId: row.projectId,
    refType: 'job',
    refId: row.id,
    createdAt: preferredLedgerTimestamp(row.finishedAt, row.startedAt),
  });
  if (!result.ok && result.reason === 'invalid_snapshot') {
    console.warn(`[usage-ledger] image job ${row.id} usage snapshot ignored: ${result.error ?? 'invalid snapshot'}`);
    return { inserted: false, invalidSnapshot: true, failed: false };
  }
  return { inserted: result.ok && result.inserted === true, invalidSnapshot: false, failed: !result.ok };
}

function replayVideoJob(db: Database.Database, row: ReconcileVideoJobRow):
  { inserted: boolean; invalidSnapshot: boolean; failed: boolean } {
  const eventKey = `video-job:${row.id}:succeeded`;
  const parsed = parseUsageSnapshot(row.usageSnapshotJson ?? '');
  if (!parsed.ok) {
    console.warn(`[usage-ledger] video job ${row.id} usage snapshot ignored: ${parsed.error}`);
    return { inserted: false, invalidSnapshot: true, failed: false };
  }
  const durationSec = typeof row.durationSec === 'number' && Number.isFinite(row.durationSec) ? row.durationSec : 0;
  const result = recordUsage(db, {
    eventKey,
    snapshot: parsed.parsed.snapshot,
    usage: { quantity: durationSec, callCount: 1, detail: { source: 'reconcile', taskType: 'video-job' } },
    projectId: row.projectId,
    refType: 'video-job',
    refId: row.id,
    createdAt: preferredLedgerTimestamp(row.finishedAt, row.startedAt),
  });
  if (!result.ok && result.reason === 'invalid_snapshot') {
    console.warn(`[usage-ledger] video job ${row.id} usage snapshot ignored: ${result.error ?? 'invalid snapshot'}`);
    return { inserted: false, invalidSnapshot: true, failed: false };
  }
  return { inserted: result.ok && result.inserted === true, invalidSnapshot: false, failed: !result.ok };
}

function queryLegacyImageBackfill(db: Database.Database): { rows: LegacyImageBackfillRow[]; failed: boolean } {
  if (
    !tableExists(db, 'providers')
    || !tableExists(db, 'jobs')
    || !requiredColumnsExist(db, 'providers', ['id', 'name', 'type', 'model'])
    || !requiredColumnsExist(db, 'jobs', ['id', 'projectId', 'providerId', 'model', 'status', 'attempt', 'estimatedCost', 'finishedAt', 'startedAt', 'usageSnapshotJson'])
  ) {
    return { rows: [], failed: false };
  }
  try {
    const rows = db.prepare(`
      SELECT j.id, j.projectId, j.attempt, j.estimatedCost, p.name AS providerName,
             j.model, j.finishedAt, j.startedAt
      FROM jobs j
      JOIN providers p ON p.id = j.providerId
      LEFT JOIN usage_ledger l
        ON l.eventKey = 'image-job:' || j.id || ':succeeded'
      WHERE p.id = 'company-gateway-image2-medium'
        AND p.type = 'gateway-task-image'
        AND p.model = 'image2-medium'
        AND j.model = 'image2-medium'
        AND j.status = 'succeeded'
        AND j.estimatedCost IS NOT NULL
        AND (j.usageSnapshotJson IS NULL OR TRIM(j.usageSnapshotJson) = '')
        AND l.eventKey IS NULL
      ORDER BY j.id
    `).all() as LegacyImageBackfillRow[];
    return { rows, failed: false };
  } catch {
    console.error('[usage-ledger] legacy image backfill scan failed; usage accounting skipped');
    return { rows: [], failed: true };
  }
}

function legacyImageLedgerFields(row: LegacyImageBackfillRow): ReturnType<typeof usageLedgerFields> {
  const callCount = positiveAttempt(row.attempt);
  return {
    id: randomUUID(),
    eventKey: `image-job:${row.id}:succeeded`,
    coreModelKey: 'company-image2-medium',
    category: 'image',
    providerId: 'company-gateway-image2-medium',
    providerName: row.providerName,
    model: row.model,
    pricingVersion: 'legacy-image-estimated-cost-v1',
    callCount,
    quantity: callCount,
    unit: 'image',
    priceScale: 1,
    unitPriceMicros: 0,
    costMicros: Math.round(row.estimatedCost * 1_000_000),
    detailJson: JSON.stringify({
      source: 'image-backfill-v1',
      estimatedCost: row.estimatedCost,
      attempt: callCount,
    }),
    projectId: row.projectId,
    refType: 'job',
    refId: row.id,
    createdAt: preferredLedgerTimestamp(row.finishedAt, row.startedAt),
  };
}

interface LegacyBackfillResult {
  ok: boolean;
  candidates: number;
  inserted: number;
  markerPresent: boolean;
  markerWritten: boolean;
}

function runLegacyImageBackfill(db: Database.Database): LegacyBackfillResult {
  const empty: LegacyBackfillResult = {
    ok: true, candidates: 0, inserted: 0, markerPresent: false, markerWritten: false,
  };
  if (!tableExists(db, 'usage_backfill_state')) return { ...empty, ok: false };
  try {
    const marker = db.prepare(`SELECT 1 AS present FROM usage_backfill_state WHERE marker = ?`).get('image-backfill-v1') as { present?: number } | undefined;
    if (marker?.present === 1) return { ...empty, markerPresent: true };
  } catch {
    console.error('[usage-ledger] legacy image backfill marker read failed; usage accounting skipped');
    return { ...empty, ok: false };
  }

  const query = queryLegacyImageBackfill(db);
  if (query.failed) return { ...empty, ok: false };
  const candidates = query.rows.length;
  try {
    let inserted = 0;
    db.transaction(() => {
      for (const row of query.rows) {
        if (!Number.isFinite(row.estimatedCost)) {
          throw new Error(`legacy image job ${row.id} has an invalid estimated cost`);
        }
        if (insertLedgerRow(db, legacyImageLedgerFields(row))) inserted += 1;
      }
      db.prepare(`
        INSERT OR IGNORE INTO usage_backfill_state (marker, completedAt)
        VALUES (?, ?)
      `).run('image-backfill-v1', new Date().toISOString());
    })();
    return { ok: true, candidates, inserted, markerPresent: true, markerWritten: true };
  } catch {
    console.error('[usage-ledger] legacy image backfill failed; usage accounting skipped');
    return { ok: false, candidates, inserted: 0, markerPresent: false, markerWritten: false };
  }
}

/**
 * Recover abandoned call evidence, drain billable calls, replay successful
 * async jobs from their frozen snapshots, and perform the one-time legacy
 * image migration. Every step is best-effort and never throws into startup.
 */
export function reconcileUsageLedger(db: Database.Database, currentOwner = USAGE_INSTANCE_ID): UsageReconcileResult {
  const empty: UsageReconcileResult = {
    ok: false,
    recovered: 0,
    drained: 0,
    recorded: 0,
    invalidSnapshots: 0,
    failed: 0,
    backfillCandidates: 0,
    backfilled: 0,
    backfillMarkerPresent: false,
    backfillMarkerWritten: false,
    uncertain: 0,
  };
  if (!schemaAvailable(db)) return { ...empty, reason: 'schema_unavailable' };

  let failed = 0;
  const recoveredResult = recoverInterruptedUsageCalls(db, currentOwner);
  if (!recoveredResult.ok) failed += 1;

  const drainedResult = drainBillableUsageCalls(db);
  if (!drainedResult.ok) failed += 1;

  let recorded = drainedResult.recorded;
  let invalidSnapshots = 0;
  const imageScan = queryReconcileImageJobs(db);
  if (imageScan.failed) failed += 1;
  for (const row of imageScan.rows) {
    const replay = replayImageJob(db, row);
    if (replay.inserted) recorded += 1;
    if (replay.invalidSnapshot) invalidSnapshots += 1;
    if (replay.failed) failed += 1;
  }

  const videoScan = queryReconcileVideoJobs(db);
  if (videoScan.failed) failed += 1;
  for (const row of videoScan.rows) {
    const replay = replayVideoJob(db, row);
    if (replay.inserted) recorded += 1;
    if (replay.invalidSnapshot) invalidSnapshots += 1;
    if (replay.failed) failed += 1;
  }

  const backfill = runLegacyImageBackfill(db);
  if (!backfill.ok) failed += 1;
  recorded += backfill.inserted;
  const uncertain = recoveredResult.uncertain + drainedResult.uncertain;
  return {
    ok: failed === 0,
    recovered: recoveredResult.uncertain,
    drained: drainedResult.recorded,
    recorded,
    invalidSnapshots,
    failed,
    backfillCandidates: backfill.candidates,
    backfilled: backfill.inserted,
    backfillMarkerPresent: backfill.markerPresent,
    backfillMarkerWritten: backfill.markerWritten,
    uncertain,
    ...(failed > 0 ? { reason: 'write_failed' as const } : {}),
  };
}
