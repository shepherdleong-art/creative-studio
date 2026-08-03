import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BATCH_SCHEMA_MIGRATIONS, ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-phase-e-schema-'));
const dbPath = path.join(root, 'workbench.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);

try {
  const result = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(root, 'backups'),
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.targetVersion, 16);
  assert.equal(BATCH_SCHEMA_MIGRATIONS.at(-1)?.version, 16);

  for (const table of ['batch_allocation_runs', 'batch_asset_exclusions']) {
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
  }
  const allocationColumns = db.prepare(`PRAGMA table_info(batch_output_versions)`).all() as Array<{ name: string; notnull: number }>;
  assert.equal(allocationColumns.find((column) => column.name === 'allocationRunId')?.notnull, 0);
  const outputForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_versions)`).all() as Array<{ table: string; from: string; on_delete: string }>;
  assert.ok(outputForeignKeys.some((foreignKey) => foreignKey.table === 'batch_allocation_runs' && foreignKey.from === 'allocationRunId' && foreignKey.on_delete.toUpperCase() === 'RESTRICT'));
  const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{ name: string; notnull: number }>;
  assert.equal(versionColumns.find((column) => column.name === 'currentAllocationRunId')?.notnull, 0);
  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_production_versions)`).all() as Array<{ table: string; from: string; on_delete: string }>;
  assert.ok(versionForeignKeys.some((foreignKey) => foreignKey.table === 'batch_allocation_runs' && foreignKey.from === 'currentAllocationRunId' && foreignKey.on_delete.toUpperCase() === 'SET NULL'));
  const runIndexes = db.prepare(`PRAGMA index_list(batch_allocation_runs)`).all() as Array<{ name: string }>;
  assert.ok(runIndexes.some(({ name }) => name === 'idx_batch_allocation_runs_version'));
  const exclusionIndexes = db.prepare(`PRAGMA index_list(batch_asset_exclusions)`).all() as Array<{ name: string }>;
  assert.ok(exclusionIndexes.some(({ name }) => name === 'idx_batch_asset_exclusions_version'));

  const now = '2026-08-03T00:00:00.000Z';
  db.prepare(`
    INSERT INTO batch_productions
      (id, projectId, name, status, progressJson, controlState, createdAt, updatedAt, deletedAt)
    VALUES ('deleted-batch', 'project-1', '已删除批次', 'completed', '{}', 'stopped', ?, ?, ?)
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO batch_production_versions
      (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
    VALUES ('deleted-version', 'deleted-batch', 1, 1, '{}', 'frozen', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO batch_allocation_runs
      (id, batchVersionId, ruleVersion, seed, inputFingerprint, status, resultJson, createdAt)
    VALUES ('deleted-run', 'deleted-version', 'v1', 'seed', 'sha256:fixture', 'completed', '{}', ?)
  `).run(now);

  const current = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.equal(current.state, 'current');
  assert.deepEqual(current.appliedVersions, []);
  assert.equal(fs.readdirSync(path.join(root, 'backups')).filter((name) => !name.startsWith('.')).length, 1, 'schema 已当前时不得重复备份');

  console.log('batch phase E schema tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
