import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FORMULA_SCHEMA_MIGRATIONS } from '../lib/batch-production/formula/schema.ts';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkFormulaReadiness } from '../lib/batch-production/formula/readiness.ts';
import { createBatchProduction, getBatchProduction } from '../lib/batch-production/versions.ts';
import { readFormulaInputs } from '../lib/batch-production/formula/import-store.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-media-migration-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root; process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES ('p','历史批次');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  db.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)');
  for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 24)) {
    db.exec(migration.sql); db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, 'then');
  }
  const batchId = createBatchProduction(db, 'p', '旧公式批次', undefined, { planningMode: 'formula' });
  const before = getBatchProduction(db, 'p', batchId), inputs = readFormulaInputs(db, 'p', batchId);
  db.exec('CREATE TRIGGER batch_formula_manual_media_owner AFTER INSERT ON batch_productions BEGIN SELECT 1; END');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_formula_manual_media'").get(), undefined, '失败回滚，不保留半建的新表');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(getBatchProduction(db, 'p', batchId), before);
  assert.deepEqual(readFormulaInputs(db, 'p', batchId), inputs);
  assert.ok(createBatchProduction(db, 'p', '普通仍可创建'));
  db.exec('DROP TRIGGER batch_formula_manual_media_owner');
  assert.equal((await checkFormulaReadiness(options)).available, true);
  assert.deepEqual(getBatchProduction(db, 'p', batchId), before);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.exec('DROP TRIGGER batch_formula_manual_media_immutable');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  console.log('人工素材迁移：v24 数据保留、v25 故障回滚重试、约束丢失和普通批量隔离通过');
} finally {
  db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
