import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  BATCH_SCHEMA_MIGRATIONS,
  ensureBatchSchemaReady,
} from '../lib/batch-production/schema.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
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
  return { db, databasePath };
}

function listPublishedBackups(backupRoot: string): string[] {
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot).filter((name) => !name.startsWith('.'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-schema-'));

try {
  const healthyRoot = path.join(root, 'healthy');
  fs.mkdirSync(healthyRoot, { recursive: true });
  const healthy = createLegacyDatabase(healthyRoot, 'workbench.db');
  const healthyBackupRoot = path.join(healthyRoot, 'backups');

  const migrated = await ensureBatchSchemaReady({
    db: healthy.db,
    backupRoot: healthyBackupRoot,
    now: () => new Date('2026-08-01T08:00:00.000Z'),
  });

  assert.equal(migrated.state, 'ready');
  assert.deepEqual(migrated.appliedVersions, BATCH_SCHEMA_MIGRATIONS.map(({ version }) => version));
  assert.ok(healthy.db.prepare(`SELECT 1 FROM batch_productions LIMIT 1`).get() === undefined);
  assert.deepEqual(
    healthy.db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all(),
    BATCH_SCHEMA_MIGRATIONS.map(({ version }) => ({ version })),
  );
  assert.deepEqual(
    healthy.db.prepare(`SELECT value FROM legacy_marker WHERE id = 'marker-1'`).get(),
    { value: '必须保留' },
  );

  const backups = listPublishedBackups(healthyBackupRoot);
  assert.equal(backups.length, 1, '首次批量迁移只发布一份已验证备份');
  const backupDir = path.join(healthyBackupRoot, backups[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as {
    applicationVersion: string;
    dataRootIdentity: string;
    targetVersion: number;
    databaseBytes: number;
    sha256: string;
    integrityCheck: string;
    foreignKeyViolations: number;
  };
  const packageVersion = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
  assert.equal(manifest.applicationVersion, packageVersion);
  assert.match(manifest.dataRootIdentity, /^[a-f0-9]{64}$/);
  assert.equal(manifest.targetVersion, BATCH_SCHEMA_MIGRATIONS.at(-1)?.version);
  assert.ok(manifest.databaseBytes > 0);
  assert.equal(
    manifest.sha256,
    createHash('sha256').update(fs.readFileSync(path.join(backupDir, 'workbench.db'))).digest('hex'),
  );
  assert.equal(manifest.integrityCheck, 'ok');
  assert.equal(manifest.foreignKeyViolations, 0);

  const backupDb = new Database(path.join(backupDir, 'workbench.db'), { readonly: true, fileMustExist: true });
  assert.deepEqual(backupDb.prepare(`SELECT value FROM legacy_marker WHERE id = 'marker-1'`).get(), { value: '必须保留' });
  assert.equal(
    backupDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'batch_productions'`).get(),
    undefined,
    '备份必须发生在第一张批量业务表建立之前',
  );
  backupDb.close();

  const current = await ensureBatchSchemaReady({
    db: healthy.db,
    backupRoot: healthyBackupRoot,
    now: () => new Date('2026-08-01T09:00:00.000Z'),
  });
  assert.equal(current.state, 'current');
  assert.deepEqual(current.appliedVersions, []);
  assert.equal(listPublishedBackups(healthyBackupRoot).length, 1, '没有待执行迁移时不得重复备份');
  healthy.db.close();

  const invalidBackupRoot = path.join(root, 'invalid-backup');
  fs.mkdirSync(invalidBackupRoot, { recursive: true });
  const invalidBackup = createLegacyDatabase(invalidBackupRoot, 'workbench.db');
  invalidBackup.db.pragma('foreign_keys = OFF');
  invalidBackup.db.exec(`
    CREATE TABLE parent_rows (id TEXT PRIMARY KEY);
    CREATE TABLE child_rows (
      id TEXT PRIMARY KEY,
      parentId TEXT NOT NULL REFERENCES parent_rows(id)
    );
    INSERT INTO child_rows (id, parentId) VALUES ('child-1', 'missing-parent');
  `);
  invalidBackup.db.pragma('foreign_keys = ON');

  const rejectedBackup = await ensureBatchSchemaReady({
    db: invalidBackup.db,
    backupRoot: path.join(invalidBackupRoot, 'backups'),
    now: () => new Date('2026-08-01T10:00:00.000Z'),
  });
  assert.equal(rejectedBackup.state, 'compatibility_only');
  if (rejectedBackup.state === 'compatibility_only') {
    assert.equal(rejectedBackup.code, 'backup_validation_failed');
  }
  assert.equal(
    invalidBackup.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'batch_productions'`).get(),
    undefined,
    '备份未通过外键检查时不得执行批量迁移',
  );
  assert.equal(listPublishedBackups(path.join(invalidBackupRoot, 'backups')).length, 0);
  invalidBackup.db.close();

  const invalidHistoryRoot = path.join(root, 'invalid-history');
  fs.mkdirSync(invalidHistoryRoot, { recursive: true });
  const invalidHistory = createLegacyDatabase(invalidHistoryRoot, 'workbench.db');
  invalidHistory.db.exec(`
    CREATE TABLE batch_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );
    INSERT INTO batch_schema_migrations (version, appliedAt)
    VALUES (0, '2026-08-01T00:00:00.000Z');
  `);
  const rejectedHistory = await ensureBatchSchemaReady({
    db: invalidHistory.db,
    backupRoot: path.join(invalidHistoryRoot, 'backups'),
  });
  assert.equal(rejectedHistory.state, 'compatibility_only');
  if (rejectedHistory.state === 'compatibility_only') {
    assert.equal(rejectedHistory.code, 'schema_history_invalid');
  }
  assert.equal(listPublishedBackups(path.join(invalidHistoryRoot, 'backups')).length, 0);
  invalidHistory.db.close();

  const invalidStructureRoot = path.join(root, 'invalid-structure');
  fs.mkdirSync(invalidStructureRoot, { recursive: true });
  const invalidStructure = createLegacyDatabase(invalidStructureRoot, 'workbench.db');
  invalidStructure.db.exec(`
    CREATE TABLE batch_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );
    INSERT INTO batch_schema_migrations (version, appliedAt)
    VALUES (1, '2026-08-01T00:00:00.000Z');
    CREATE TABLE batch_productions (id TEXT PRIMARY KEY);
  `);
  const rejectedStructure = await ensureBatchSchemaReady({
    db: invalidStructure.db,
    backupRoot: path.join(invalidStructureRoot, 'backups'),
  });
  assert.equal(rejectedStructure.state, 'compatibility_only');
  if (rejectedStructure.state === 'compatibility_only') {
    assert.equal(rejectedStructure.code, 'schema_history_invalid');
  }
  assert.equal(listPublishedBackups(path.join(invalidStructureRoot, 'backups')).length, 0);
  invalidStructure.db.close();

  const failedMigrationRoot = path.join(root, 'failed-migration');
  fs.mkdirSync(failedMigrationRoot, { recursive: true });
  const failedMigration = createLegacyDatabase(failedMigrationRoot, 'workbench.db');
  failedMigration.db.exec(`CREATE TABLE batch_productions (id TEXT PRIMARY KEY)`);

  const rejectedMigration = await ensureBatchSchemaReady({
    db: failedMigration.db,
    backupRoot: path.join(failedMigrationRoot, 'backups'),
    now: () => new Date('2026-08-01T11:00:00.000Z'),
  });
  assert.equal(rejectedMigration.state, 'compatibility_only');
  if (rejectedMigration.state === 'compatibility_only') {
    assert.equal(rejectedMigration.code, 'migration_failed');
  }
  assert.deepEqual(
    failedMigration.db.prepare(`PRAGMA table_info(batch_productions)`).all(),
    [{ cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 }],
    '失败事务不得把目标字段半加到冲突旧表',
  );
  assert.equal(
    failedMigration.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'batch_schema_migrations'`).get(),
    undefined,
    '首个 migration 失败时版本表也必须一起回滚',
  );
  assert.equal(listPublishedBackups(path.join(failedMigrationRoot, 'backups')).length, 1);
  failedMigration.db.close();

  console.log('batch schema upgrade tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
