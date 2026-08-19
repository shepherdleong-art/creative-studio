import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getUsageSchemaError,
  getUsageSchemaReadiness,
  initUsageSchema,
  isUsageSchemaReady,
  USAGE_SCHEMA_MIGRATIONS,
} from '../lib/usage-schema.ts';

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

const db = new Database(':memory:');
assert.deepEqual(USAGE_SCHEMA_MIGRATIONS.map((migration) => migration.version), [1, 2]);

const firstReadiness = initUsageSchema(db);
assert.equal(firstReadiness.available, true, 'fresh usage schema must be ready');
assert.equal(firstReadiness.version, 2, 'fresh usage schema must apply migration v2');
assert.equal(firstReadiness.error, null, 'ready usage schema must not expose an error');
assert.equal(isUsageSchemaReady(db), true);
assert.deepEqual(getUsageSchemaReadiness(db), firstReadiness);
assert.equal(getUsageSchemaError(db), null);

assert.deepEqual(
  tableNames(db).filter((name) => name.startsWith('usage_')),
  ['usage_backfill_state', 'usage_call_events', 'usage_ledger', 'usage_schema_migrations'],
  'usage schema must be isolated behind its own tables',
);
assert.deepEqual(
  db.prepare(`SELECT version FROM usage_schema_migrations ORDER BY version`).all(),
  [{ version: 1 }, { version: 2 }],
  'usage migrations must be recorded in the independent migration table',
);

assert.deepEqual(
  (db.prepare(`PRAGMA table_info(usage_ledger)`).all() as Array<{ name: string }>).map((column) => column.name),
  [
    'id', 'eventKey', 'coreModelKey', 'category', 'providerId', 'providerName', 'model',
    'pricingVersion', 'callCount', 'quantity', 'unit', 'priceScale', 'unitPriceMicros',
    'costMicros', 'detailJson', 'projectId', 'refType', 'refId', 'createdAt',
  ],
  'usage_ledger must keep the complete v1 column contract',
);
assert.deepEqual(
  (db.prepare(`PRAGMA table_info(usage_call_events)`).all() as Array<{ name: string }>).map((column) => column.name),
  [
    'eventKey', 'status', 'ownerInstanceId', 'snapshotJson', 'usageJson', 'projectId',
    'refType', 'refId', 'errorMessage', 'createdAt', 'updatedAt',
  ],
  'usage_call_events must keep the complete v1 column contract',
);

const ledgerIndexes = indexNames(db, 'usage_ledger');
for (const expected of [
  'idx_usage_ledger_createdAt',
  'idx_usage_ledger_model_createdAt',
  'idx_usage_ledger_category_createdAt',
]) {
  assert.ok(ledgerIndexes.includes(expected), `usage_ledger must expose ${expected}`);
}
assert.ok(indexNames(db, 'usage_call_events').includes('idx_usage_call_events_status'));

const ledgerInsert = db.prepare(`
  INSERT INTO usage_ledger
    (id, eventKey, coreModelKey, category, providerId, model, pricingVersion, unit, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
ledgerInsert.run('ledger-1', 'event-1', 'model-1', 'image', 'provider-1', 'model-1', 'pricing-v1', 'image', '2026-08-18T00:00:00.000Z');
assert.throws(
  () => ledgerInsert.run('ledger-2', 'event-1', 'model-1', 'image', 'provider-1', 'model-1', 'pricing-v1', 'image', '2026-08-18T00:00:01.000Z'),
  /UNIQUE constraint failed/,
  'usage_ledger.eventKey must be unique for idempotent recording',
);

const secondReadiness = initUsageSchema(db);
assert.deepEqual(secondReadiness, firstReadiness, 're-running usage migrations must be idempotent');
assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_schema_migrations`).get(), { count: 2 });
assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get(), { count: 1 });

const failedDb = new Database(':memory:');
failedDb.exec(`
  CREATE TABLE usage_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
  INSERT INTO usage_schema_migrations (version, appliedAt) VALUES (99, 'future');
  CREATE TABLE usage_ledger (id TEXT PRIMARY KEY, eventKey TEXT NOT NULL UNIQUE);
`);
const failedReadiness = initUsageSchema(failedDb);
assert.equal(failedReadiness.available, false, 'a failed migration must report unavailable readiness');
assert.equal(isUsageSchemaReady(failedDb), false);
assert.equal(getUsageSchemaError(failedDb), failedReadiness.error);
assert.ok(failedReadiness.error, 'failed readiness must expose a safe diagnostic');
assert.equal(
  (failedDb.prepare(`SELECT COUNT(*) AS count FROM usage_schema_migrations WHERE version = 1`).get() as { count: number }).count,
  0,
  'a failed migration transaction must not record its version',
);

failedDb.exec(`DROP TABLE usage_ledger`);
const recoveredReadiness = initUsageSchema(failedDb);
assert.equal(recoveredReadiness.available, true, 'a rolled-back migration must be retryable');
assert.equal(isUsageSchemaReady(failedDb), true);
assert.equal(getUsageSchemaError(failedDb), null);

db.close();
failedDb.close();
console.log('usage-schema tests passed');
