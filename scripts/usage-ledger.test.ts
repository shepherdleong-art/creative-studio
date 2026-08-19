import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import {
  createCoreUsageSnapshot,
  resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
  type CoreUsageSnapshotV1,
} from '../lib/usage-pricing.ts';
import { initUsageSchema } from '../lib/usage-schema.ts';
import {
  beginUsageCall,
  drainBillableUsageCalls,
  markUsageCallBillable,
  recordUsage,
  reconcileUsageLedger,
  recoverInterruptedUsageCalls,
} from '../lib/usage-ledger.ts';

function provider(overrides: Partial<CoreUsageProviderSnapshot> = {}): CoreUsageProviderSnapshot {
  return {
    providerTable: 'providers',
    providerId: 'company-gateway-image2-medium',
    providerName: '公司图片',
    providerType: 'gateway-task-image',
    configuredModel: 'image2-medium',
    requestModel: 'image2-medium',
    ...overrides,
  };
}

function snapshot(
  providerOverrides: Partial<CoreUsageProviderSnapshot> = {},
  options: { projectId?: string; refType?: string; refId?: string } = {},
): CoreUsageSnapshotV1 {
  const p = provider({ ...providerOverrides });
  const plan = resolveCoreUsagePlan(p);
  assert.ok(plan, `expected a usage plan for ${p.providerId}`);
  return createCoreUsageSnapshot(p, plan, {
    startedAt: '2026-08-18T00:00:00.000Z',
    projectId: options.projectId ?? 'project-1',
    refType: options.refType ?? 'job',
    refId: options.refId ?? 'ref-1',
  });
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  const readiness = initUsageSchema(db);
  assert.equal(readiness.available, true);
  return db;
}

function setupCoreTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      estimatedCost REAL,
      finishedAt TEXT,
      startedAt TEXT,
      createdAt TEXT,
      usageSnapshotJson TEXT
    );
    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      durationSec REAL NOT NULL DEFAULT 5,
      finishedAt TEXT,
      startedAt TEXT,
      createdAt TEXT,
      usageSnapshotJson TEXT
    );
  `);
}

function insertCoreProvider(db: Database.Database, overrides: Partial<{ id: string; name: string; type: string; model: string }> = {}): void {
  db.prepare(`INSERT INTO providers (id, name, type, model) VALUES (?, ?, ?, ?)`).run(
    overrides.id ?? 'company-gateway-image2-medium',
    overrides.name ?? '公司图片',
    overrides.type ?? 'gateway-task-image',
    overrides.model ?? 'image2-medium',
  );
}

function insertImageJob(db: Database.Database, input: {
  id: string;
  snapshot?: CoreUsageSnapshotV1 | unknown;
  attempt?: number;
  estimatedCost?: number | null;
  providerId?: string;
  model?: string;
  status?: string;
  finishedAt?: string | null;
  createdAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO jobs
      (id, projectId, providerId, model, status, attempt, estimatedCost, finishedAt, startedAt, createdAt, usageSnapshotJson)
    VALUES (?, 'project-1', ?, ?, ?, ?, ?, ?, '2026-08-18 00:01:00', ?, ?)
  `).run(
    input.id,
    input.providerId ?? 'company-gateway-image2-medium',
    input.model ?? 'image2-medium',
    input.status ?? 'succeeded',
    input.attempt ?? 1,
    input.estimatedCost ?? null,
    input.finishedAt ?? '2026-08-18 01:02:03',
    input.createdAt ?? '2026-08-18 00:00:00',
    input.snapshot === undefined ? null : typeof input.snapshot === 'string' ? input.snapshot : JSON.stringify(input.snapshot),
  );
}

function insertVideoJob(db: Database.Database, input: {
  id: string;
  snapshot?: CoreUsageSnapshotV1 | unknown;
  durationSec?: number;
  providerId?: string;
  model?: string;
  status?: string;
  finishedAt?: string | null;
  createdAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO video_jobs
      (id, projectId, providerId, model, status, durationSec, finishedAt, startedAt, createdAt, usageSnapshotJson)
    VALUES (?, 'project-1', ?, ?, ?, ?, ?, '2026-08-18 00:01:00', ?, ?)
  `).run(
    input.id,
    input.providerId ?? 'company-kling-3-0',
    input.model ?? 'kling-3.0',
    input.status ?? 'succeeded',
    input.durationSec ?? 5,
    input.finishedAt ?? '2026-08-18 01:02:03',
    input.createdAt ?? '2026-08-18 00:00:00',
    input.snapshot === undefined ? null : typeof input.snapshot === 'string' ? input.snapshot : JSON.stringify(input.snapshot),
  );
}

// Idempotent task recording keeps one row and retains per-component billing evidence.
{
  const db = setupDb();
  const imageSnapshot = snapshot({}, { refId: 'job-idempotent' });
  const first = recordUsage(db, {
    eventKey: 'image-job:job-idempotent:succeeded',
    snapshot: imageSnapshot,
    usage: { quantity: 2, callCount: 2 },
  });
  const second = recordUsage(db, {
    eventKey: 'image-job:job-idempotent:succeeded',
    snapshot: imageSnapshot,
    usage: { quantity: 99, callCount: 99 },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get(), { count: 1 });
  const row = db.prepare('SELECT * FROM usage_ledger').get() as {
    quantity: number;
    callCount: number;
    costMicros: number;
    detailJson: string;
  };
  assert.equal(row.quantity, 2);
  assert.equal(row.callCount, 2);
  assert.equal(row.costMicros, 2_100_000);
  assert.deepEqual(JSON.parse(row.detailJson).priceComponents, [{
    key: 'image',
    unit: 'image',
    quantity: 2,
    unitPriceMicros: 1_050_000,
    priceScale: 1,
    componentCostMicros: 2_100_000,
  }]);
  db.close();
}

// A legal core key cannot be forged onto a non-core provider identity.
{
  const db = setupDb();
  const forgedSnapshot = {
    ...snapshot({}, { refId: 'forged-provider' }),
    provider: {
      ...snapshot({}, { refId: 'forged-provider' }).provider,
      providerId: 'packy-image',
      providerType: 'openai-compatible',
    },
  };
  beginUsageCall(db, { eventKey: 'llm-call:forged-provider', snapshot: forgedSnapshot, ownerInstanceId: 'owner-a' });
  markUsageCallBillable(db, 'llm-call:forged-provider', { quantity: 1, callCount: 1 });
  const drained = drainBillableUsageCalls(db);
  assert.equal(drained.uncertain, 1);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get(), { count: 0 });
  assert.deepEqual(db.prepare('SELECT status FROM usage_call_events WHERE eventKey=?').get('llm-call:forged-provider'), { status: 'uncertain' });
  db.close();
}

// A component key and unit must agree before any amount is recorded.
{
  const db = setupDb();
  const invalidUnitSnapshot = {
    ...snapshot({}, { refId: 'invalid-unit' }),
    priceComponents: [{ ...snapshot({}, { refId: 'invalid-unit' }).priceComponents[0], unit: 'token' }],
  };
  beginUsageCall(db, { eventKey: 'llm-call:invalid-unit', snapshot: invalidUnitSnapshot, ownerInstanceId: 'owner-a' });
  markUsageCallBillable(db, 'llm-call:invalid-unit', { quantity: 1, callCount: 1 });
  const drained = drainBillableUsageCalls(db);
  assert.equal(drained.uncertain, 1);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get(), { count: 0 });
  db.close();
}

// GPT events retain a composite component breakdown while their top-level price is 0/1.
{
  const db = setupDb();
  const gptSnapshot = snapshot({
    providerTable: 'script_providers',
    providerId: 'gpt',
    providerName: '公司 GPT',
    providerType: 'openai-compatible',
    executionScope: 'company',
    apiStyle: 'openai-compatible',
    configuredModel: 'GPT-5-6-Luna-Standard',
    requestModel: 'GPT-5-6-Luna-Standard',
  }, { refType: 'script', refId: 'call-gpt' });
  recordUsage(db, {
    eventKey: 'llm-call:call-gpt',
    snapshot: gptSnapshot,
    usage: {
      quantity: { uncachedInputTokens: 1_000_000, cachedReadTokens: 3, outputTokens: 3 },
      callCount: 1,
      detail: { estimated: false },
    },
  });
  const row = db.prepare('SELECT unitPriceMicros, priceScale, costMicros, detailJson FROM usage_ledger').get() as {
    unitPriceMicros: number;
    priceScale: number;
    costMicros: number;
    detailJson: string;
  };
  assert.equal(row.unitPriceMicros, 0);
  assert.equal(row.priceScale, 1);
  assert.equal(row.costMicros, 2_887_840);
  assert.deepEqual(JSON.parse(row.detailJson).priceComponents.map((component: Record<string, unknown>) => component.key), [
    'input_token', 'output_token', 'cached_input_token',
  ]);
  db.close();
}

// A billable call drains exactly once into the ledger and becomes recorded.
{
  const db = setupDb();
  beginUsageCall(db, {
    eventKey: 'video-call:billable',
    snapshot: snapshot({
      providerTable: 'video_providers',
      providerId: 'company-kling-3-0',
      providerName: '公司可灵',
      providerType: 'openai-video',
      configuredModel: 'kling-3.0',
      requestModel: 'kling-3.0',
    }, { refType: 'video-job', refId: 'video-1' }),
    ownerInstanceId: 'owner-a',
  });
  markUsageCallBillable(db, 'video-call:billable', { quantity: 5, callCount: 1 });
  const firstDrain = drainBillableUsageCalls(db);
  const secondDrain = drainBillableUsageCalls(db);
  assert.equal(firstDrain.recorded, 1);
  assert.equal(secondDrain.recorded, 0);
  assert.deepEqual(db.prepare('SELECT status FROM usage_call_events WHERE eventKey=?').get('video-call:billable'), { status: 'recorded' });
  assert.deepEqual(db.prepare('SELECT costMicros, quantity FROM usage_ledger WHERE eventKey=?').get('video-call:billable'), {
    costMicros: 2_990_000,
    quantity: 5,
  });
  db.close();
}

// A started event owned by another process is uncertain, never billable, and never drained.
{
  const db = setupDb();
  beginUsageCall(db, {
    eventKey: 'llm-call:interrupted',
    snapshot: snapshot({
      providerTable: 'script_providers',
      providerId: 'gpt',
      providerName: '公司 GPT',
      providerType: 'openai-compatible',
      executionScope: 'company',
      apiStyle: 'openai-compatible',
      configuredModel: 'GPT-5-6-Luna-Standard',
      requestModel: 'GPT-5-6-Luna-Standard',
    }),
    ownerInstanceId: 'old-owner',
  });
  const recovered = recoverInterruptedUsageCalls(db, 'new-owner');
  assert.equal(recovered.uncertain, 1);
  assert.deepEqual(db.prepare('SELECT status FROM usage_call_events WHERE eventKey=?').get('llm-call:interrupted'), { status: 'uncertain' });
  assert.equal(drainBillableUsageCalls(db).recorded, 0);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get(), { count: 0 });
  db.close();
}

// Unknown snapshot versions are rejected without falling back to current prices.
{
  const db = setupDb();
  const unknownSnapshot = { ...snapshot({}, { refId: 'unknown-version' }), schemaVersion: 99 };
  beginUsageCall(db, { eventKey: 'llm-call:unknown-version', snapshot: unknownSnapshot, ownerInstanceId: 'owner-a' });
  markUsageCallBillable(db, 'llm-call:unknown-version', { quantity: 1, callCount: 1 });
  const drained = drainBillableUsageCalls(db);
  assert.equal(drained.uncertain, 1);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get(), { count: 0 });
  const event = db.prepare('SELECT status, errorMessage FROM usage_call_events WHERE eventKey=?').get('llm-call:unknown-version') as { status: string; errorMessage: string };
  assert.equal(event.status, 'uncertain');
  assert.match(event.errorMessage, /schemaVersion|snapshot/i);
  db.close();
}

// Schema-unavailable calls are explicit no-ops and never escape into core business code.
{
  const db = new Database(':memory:');
  const result = recordUsage(db, {
    eventKey: 'image-job:no-schema:succeeded',
    snapshot: snapshot(),
    usage: { quantity: 1, callCount: 1 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_unavailable');
  assert.doesNotThrow(() => beginUsageCall(db, {
    eventKey: 'llm-call:no-schema',
    snapshot: snapshot(),
  }));
  assert.doesNotThrow(() => drainBillableUsageCalls(db));
  db.close();
}

// Reconciliation recovers old calls first, drains billable evidence, then fills
// successful image/video tasks from their frozen snapshots.
{
  const db = setupDb();
  setupCoreTables(db);
  insertCoreProvider(db);
  const imageSnapshot = snapshot({}, { projectId: 'project-1', refType: 'job', refId: 'image-reconcile' });
  const klingSnapshot = snapshot({
    providerTable: 'video_providers',
    providerId: 'company-kling-3-0',
    providerName: '公司可灵',
    providerType: 'openai-video',
    configuredModel: 'kling-3.0',
    requestModel: 'kling-3.0',
  }, { projectId: 'project-1', refType: 'video-job', refId: 'video-kling-reconcile' });
  const seedanceSnapshot = snapshot({
    providerTable: 'video_providers',
    providerId: 'company-seedance-2-0-fast',
    providerName: '公司 Seedance',
    providerType: 'openai-video',
    configuredModel: 'doubao-seedance-2-0-fast-260128',
    requestModel: 'doubao-seedance-2-0-fast-260128',
  }, { projectId: 'project-1', refType: 'video-job', refId: 'video-seedance-reconcile' });
  insertImageJob(db, { id: 'image-reconcile', snapshot: imageSnapshot, attempt: 3 });
  insertVideoJob(db, { id: 'video-kling-reconcile', snapshot: klingSnapshot, durationSec: 5 });
  insertVideoJob(db, { id: 'video-seedance-reconcile', snapshot: seedanceSnapshot, durationSec: 5, providerId: 'company-seedance-2-0-fast', model: 'doubao-seedance-2-0-fast-260128' });

  beginUsageCall(db, { eventKey: 'llm-call:reconcile-started', snapshot: snapshot({
    providerTable: 'script_providers',
    providerId: 'gpt',
    providerName: '公司 GPT',
    providerType: 'openai-compatible',
    executionScope: 'company',
    apiStyle: 'openai-compatible',
    configuredModel: 'GPT-5-6-Luna-Standard',
    requestModel: 'GPT-5-6-Luna-Standard',
  }), ownerInstanceId: 'old-owner' });
  beginUsageCall(db, { eventKey: 'image-call:reconcile-billable', snapshot: imageSnapshot, ownerInstanceId: 'old-owner' });
  markUsageCallBillable(db, 'image-call:reconcile-billable', { quantity: 1, callCount: 1 });

  const result = reconcileUsageLedger(db, 'new-owner');
  assert.equal(result.ok, true);
  assert.equal(result.recovered, 1);
  assert.equal(result.drained, 1);
  assert.equal(result.recorded, 4);
  assert.equal(result.invalidSnapshots, 0);
  assert.deepEqual(db.prepare(`SELECT status FROM usage_call_events WHERE eventKey='llm-call:reconcile-started'`).get(), { status: 'uncertain' });
  assert.deepEqual(db.prepare(`SELECT status FROM usage_call_events WHERE eventKey='image-call:reconcile-billable'`).get(), { status: 'recorded' });
  assert.deepEqual(db.prepare(`SELECT quantity, callCount, costMicros, createdAt FROM usage_ledger WHERE eventKey='image-job:image-reconcile:succeeded'`).get(), {
    quantity: 3,
    callCount: 3,
    costMicros: 3_150_000,
    createdAt: '2026-08-18T01:02:03.000Z',
  });
  assert.deepEqual(db.prepare(`SELECT costMicros, quantity, callCount FROM usage_ledger WHERE eventKey='video-job:video-kling-reconcile:succeeded'`).get(), {
    costMicros: 2_990_000,
    quantity: 5,
    callCount: 1,
  });
  assert.deepEqual(db.prepare(`SELECT costMicros, quantity, callCount FROM usage_ledger WHERE eventKey='video-job:video-seedance-reconcile:succeeded'`).get(), {
    costMicros: 11_730_000,
    quantity: 5,
    callCount: 1,
  });
  db.close();
}

// Invalid or unknown task snapshots are reported and never charged with the current price.
{
  const db = setupDb();
  setupCoreTables(db);
  insertCoreProvider(db);
  insertImageJob(db, { id: 'image-bad-snapshot', snapshot: JSON.stringify({ schemaVersion: 999 }), estimatedCost: null });
  const result = reconcileUsageLedger(db);
  assert.equal(result.ok, true);
  assert.equal(result.invalidSnapshots, 1);
  assert.equal(result.recorded, 0);
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  db.close();
}

// Reconciliation is safe to repeat: stable event keys keep exactly one row.
{
  const db = setupDb();
  setupCoreTables(db);
  insertCoreProvider(db);
  insertImageJob(db, { id: 'image-idempotent-reconcile', snapshot: snapshot({}, { refId: 'image-idempotent-reconcile' }), attempt: 2 });
  const first = reconcileUsageLedger(db);
  const second = reconcileUsageLedger(db);
  assert.equal(first.recorded, 1);
  assert.equal(second.recorded, 0);
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger WHERE eventKey='image-job:image-idempotent-reconcile:succeeded'`).get(), { count: 1 });
  db.close();
}

// The one-time legacy image backfill only accepts the exact company provider and
// stores the old estimated amount without consulting the current price registry.
{
  const db = setupDb();
  setupCoreTables(db);
  insertCoreProvider(db);
  insertCoreProvider(db, { id: 'public-image', name: '公网图片', type: 'openai-compatible', model: 'image2-medium' });
  insertImageJob(db, { id: 'image-legacy', estimatedCost: 1.2345675, attempt: 2 });
  insertImageJob(db, { id: 'image-public', providerId: 'public-image', estimatedCost: 9.99 });
  insertImageJob(db, { id: 'image-mismatched-model', model: 'gpt-image-1', estimatedCost: 8.88 });
  insertImageJob(db, { id: 'image-failed', status: 'failed', estimatedCost: 7.77 });
  insertImageJob(db, { id: 'image-live', snapshot: snapshot({}, { refId: 'image-live' }), estimatedCost: 2.1 });

  const first = reconcileUsageLedger(db);
  assert.equal(first.backfilled, 1);
  assert.equal(first.backfillMarkerWritten, true);
  assert.deepEqual(db.prepare(`SELECT costMicros, pricingVersion, quantity, callCount, unitPriceMicros, createdAt FROM usage_ledger WHERE eventKey='image-job:image-legacy:succeeded'`).get(), {
    costMicros: 1_234_568,
    pricingVersion: 'legacy-image-estimated-cost-v1',
    quantity: 2,
    callCount: 2,
    unitPriceMicros: 0,
    createdAt: '2026-08-18T01:02:03.000Z',
  });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 2 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger WHERE eventKey LIKE 'image-job:image-public:%'`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger WHERE eventKey LIKE 'image-job:image-mismatched-model:%'`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger WHERE eventKey LIKE 'image-job:image-failed:%'`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT marker FROM usage_backfill_state`).all(), [{ marker: 'image-backfill-v1' }]);
  const second = reconcileUsageLedger(db);
  assert.equal(second.backfilled, 0);
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 2 });
  db.close();
}

// A backfill transaction failure rolls back both its rows and its completion marker.
{
  const db = setupDb();
  setupCoreTables(db);
  insertCoreProvider(db);
  insertImageJob(db, { id: 'image-backfill-transaction', estimatedCost: 1.25 });
  db.exec(`
    CREATE TRIGGER fail_usage_backfill_marker
    BEFORE INSERT ON usage_backfill_state
    BEGIN SELECT RAISE(ABORT, 'marker failure'); END;
  `);
  const failed = reconcileUsageLedger(db);
  assert.equal(failed.ok, false);
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 0 });
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_backfill_state`).get(), { count: 0 });
  db.exec(`DROP TRIGGER fail_usage_backfill_marker`);
  const recovered = reconcileUsageLedger(db);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.backfilled, 1);
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_backfill_state`).get(), { count: 1 });
  db.close();
}

// Node startup must attempt reconciliation without making batch recovery depend on it.
{
  const instrumentation = fs.readFileSync(new URL('../instrumentation.ts', import.meta.url), 'utf8');
  assert.match(instrumentation, /NEXT_RUNTIME/);
  assert.match(instrumentation, /getDb/);
  assert.match(instrumentation, /reconcileUsageLedger/);
  assert.match(instrumentation, /startBatchSchedulerAfterReadiness/);
  assert.match(instrumentation, /catch/);
  assert.doesNotMatch(instrumentation, /error\.message|String\(error\)/, '启动告警不得拼接异常上下文');
}

console.log('usage-ledger tests passed');
