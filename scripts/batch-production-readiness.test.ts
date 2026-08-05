import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appendSchemaUpgradeAudit, readSchemaUpgradeAudit } from '../lib/schema-upgrade/audit.ts';
import { acquireSchemaUpgradeLock } from '../lib/schema-upgrade/lock.ts';
import { batchReadinessUnavailable, checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { BATCH_SCHEMA_MIGRATIONS } from '../lib/batch-production/schema.ts';

function createLegacyDatabase(root: string): Database.Database {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE legacy_marker (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '旧项目');
    INSERT INTO legacy_marker (id, value) VALUES ('marker-1', '必须保留');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-readiness-'));

try {
  const healthyRoot = path.join(root, 'healthy');
  fs.mkdirSync(healthyRoot, { recursive: true });
  const healthyDb = createLegacyDatabase(healthyRoot);
  const healthyOptions = {
    db: healthyDb,
    backupRoot: path.join(healthyRoot, 'backups'),
    lockDatabasePath: path.join(healthyRoot, 'schema-upgrade.lock.db'),
    auditFilePath: path.join(healthyRoot, 'schema-upgrades.jsonl'),
    now: () => new Date('2026-08-01T12:00:00.000Z'),
  };

  const ready = await checkBatchProductionReadiness(healthyOptions);
  assert.equal(ready.available, true);
  assert.equal(ready.mode, 'ready');
  assert.equal(ready.schemaState, 'ready');
  assert.ok(healthyDb.prepare(`SELECT 1 FROM batch_productions LIMIT 1`).get() === undefined);
  assert.deepEqual(
    healthyDb.prepare(`SELECT value FROM legacy_marker WHERE id = 'marker-1'`).get(),
    { value: '必须保留' },
  );

  const firstAudit = await readSchemaUpgradeAudit(healthyOptions.auditFilePath);
  assert.deepEqual(firstAudit.map(({ event }) => event), [
    'started',
    'backup_completed',
    'migration_completed',
    'validation_completed',
    'finished',
  ]);
  assert.equal(firstAudit.at(-1)?.result?.available, true);
  assert.equal(firstAudit.at(-1)?.result?.schemaState, 'ready');
  const targetVersion = BATCH_SCHEMA_MIGRATIONS.at(-1)?.version;
  assert.match(firstAudit[1]?.details?.backup?.backupId ?? '', new RegExp(`^pre-batch-v${targetVersion}-`));
  assert.equal(firstAudit[1]?.details?.backup?.validated, true);
  assert.deepEqual(
    firstAudit[2]?.details?.migration?.appliedVersions,
    BATCH_SCHEMA_MIGRATIONS.map(({ version }) => version),
  );

  const current = await checkBatchProductionReadiness({
    ...healthyOptions,
    now: () => new Date('2026-08-01T12:01:00.000Z'),
  });
  assert.equal(current.available, true);
  assert.equal(current.schemaState, 'current');
  assert.equal(fs.readdirSync(healthyOptions.backupRoot).length, 1, '已就绪时不重复生成备份');
  healthyDb.close();

  const concurrentRoot = path.join(root, 'concurrent');
  fs.mkdirSync(concurrentRoot, { recursive: true });
  const firstConcurrentDb = createLegacyDatabase(concurrentRoot);
  const secondConcurrentDb = new Database(path.join(concurrentRoot, 'workbench.db'));
  secondConcurrentDb.pragma('foreign_keys = ON');
  const concurrentOptions = {
    backupRoot: path.join(concurrentRoot, 'backups'),
    lockDatabasePath: path.join(concurrentRoot, 'schema-upgrade.lock.db'),
    auditFilePath: path.join(concurrentRoot, 'schema-upgrades.jsonl'),
    lockTimeoutMs: 2_000,
    lockPollIntervalMs: 10,
    now: () => new Date('2026-08-01T12:01:30.000Z'),
  };
  const concurrentResults = await Promise.all([
    checkBatchProductionReadiness({ ...concurrentOptions, db: firstConcurrentDb }),
    checkBatchProductionReadiness({ ...concurrentOptions, db: secondConcurrentDb }),
  ]);
  assert.deepEqual(
    concurrentResults.map(({ schemaState }) => schemaState).sort(),
    ['current', 'ready'],
    '两个实例同时自检时只能有一个执行迁移，另一个读取已完成状态',
  );
  assert.equal(
    fs.readdirSync(concurrentOptions.backupRoot).filter((name) => !name.startsWith('.')).length,
    1,
  );
  firstConcurrentDb.close();
  secondConcurrentDb.close();

  const busyRoot = path.join(root, 'busy');
  fs.mkdirSync(busyRoot, { recursive: true });
  const busyDb = createLegacyDatabase(busyRoot);
  const busyLockPath = path.join(busyRoot, 'schema-upgrade.lock.db');
  const held = await acquireSchemaUpgradeLock({ lockDatabasePath: busyLockPath });
  try {
    const busy = await checkBatchProductionReadiness({
      db: busyDb,
      backupRoot: path.join(busyRoot, 'backups'),
      lockDatabasePath: busyLockPath,
      auditFilePath: path.join(busyRoot, 'schema-upgrades.jsonl'),
      lockTimeoutMs: 30,
      lockPollIntervalMs: 10,
      now: () => new Date('2026-08-01T12:02:00.000Z'),
    });
    assert.equal(busy.available, false);
    assert.equal(busy.mode, 'compatibility_only');
    if (!busy.available) assert.equal(busy.code, 'upgrade_in_progress');
    assert.equal(
      busyDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_productions'`).get(),
      undefined,
    );
    const busyAudit = await readSchemaUpgradeAudit(path.join(busyRoot, 'schema-upgrades.jsonl'));
    assert.equal(busyAudit.at(-1)?.event, 'lock_timeout');
  } finally {
    held.release();
    busyDb.close();
  }

  const noDiskRoot = path.join(root, 'no-disk');
  fs.mkdirSync(noDiskRoot, { recursive: true });
  const noDiskDb = createLegacyDatabase(noDiskRoot);
  const noDiskAuditPath = path.join(noDiskRoot, 'schema-upgrades.jsonl');
  const noDisk = await checkBatchProductionReadiness({
    db: noDiskDb,
    backupRoot: path.join(noDiskRoot, 'backups'),
    lockDatabasePath: path.join(noDiskRoot, 'schema-upgrade.lock.db'),
    auditFilePath: noDiskAuditPath,
    diskSpaceProbe: async () => 0,
    now: () => new Date('2026-08-01T12:02:30.000Z'),
  });
  assert.equal(noDisk.available, false);
  if (!noDisk.available) assert.equal(noDisk.code, 'insufficient_disk_space');
  assert.equal(
    noDiskDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_productions'`).get(),
    undefined,
    '磁盘空间不足时不得开始迁移',
  );
  assert.equal(fs.readdirSync(path.join(noDiskRoot, 'backups')).length, 0);
  const noDiskAudit = await readSchemaUpgradeAudit(noDiskAuditPath);
  assert.equal(noDiskAudit.at(-1)?.result?.code, 'insufficient_disk_space');
  noDiskDb.close();

  const interruptedRoot = path.join(root, 'interrupted');
  fs.mkdirSync(interruptedRoot, { recursive: true });
  const interruptedDb = createLegacyDatabase(interruptedRoot);
  const interruptedAuditPath = path.join(interruptedRoot, 'schema-upgrades.jsonl');
  await appendSchemaUpgradeAudit(interruptedAuditPath, {
    version: 1,
    event: 'started',
    attemptId: 'interrupted-attempt',
    scope: 'batch-production',
    at: '2026-08-01T11:59:00.000Z',
  });
  fs.appendFileSync(interruptedAuditPath, '{"version":1', 'utf8');
  const recovered = await checkBatchProductionReadiness({
    db: interruptedDb,
    backupRoot: path.join(interruptedRoot, 'backups'),
    lockDatabasePath: path.join(interruptedRoot, 'schema-upgrade.lock.db'),
    auditFilePath: interruptedAuditPath,
    now: () => new Date('2026-08-01T12:03:00.000Z'),
  });
  assert.equal(recovered.available, true);
  const recoveredAudit = await readSchemaUpgradeAudit(interruptedAuditPath);
  assert.ok(recoveredAudit.some((record) => (
    record.event === 'interrupted_recovered'
    && record.attemptId === 'interrupted-attempt'
  )));
  assert.ok(recoveredAudit.some((record) => record.event === 'corrupt_records_recovered'));
  interruptedDb.close();

  // --- API 门禁判定:兼容模式必须判为不可用,current/ready 必须放行 ---
  assert.deepEqual(
    batchReadinessUnavailable({
      available: false,
      mode: 'compatibility_only',
      code: 'migration_failed',
      message: '升级未完成',
      appliedVersions: [],
      targetVersion: 12,
      checkedAt: '2026-08-02T00:00:00.000Z',
      auditId: 'audit-1',
    }),
    { code: 'migration_failed', message: '升级未完成' },
    '兼容模式必须判为批量 API 不可用',
  );
  assert.equal(
    batchReadinessUnavailable({
      available: true,
      mode: 'ready',
      schemaState: 'current',
      message: '批量功能已就绪。',
      appliedVersions: [],
      targetVersion: 12,
      checkedAt: '2026-08-02T00:00:00.000Z',
      auditId: 'audit-2',
    }),
    null,
    'current 状态必须放行',
  );
  assert.equal(
    batchReadinessUnavailable({
      available: true,
      mode: 'ready',
      schemaState: 'ready',
      message: '批量功能已完成安全升级。',
      appliedVersions: [1, 2],
      targetVersion: 12,
      checkedAt: '2026-08-02T00:00:00.000Z',
      auditId: 'audit-3',
    }),
    null,
    'ready 状态必须放行',
  );

  console.log('batch production readiness tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
