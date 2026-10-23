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
import { readFormulaManualSpeech } from '../lib/batch-production/formula/manual-speech.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-migration-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES ('p','历史批次');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  db.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)');
  for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 21)) {
    db.exec(migration.sql); db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, 'then');
  }
  const batchId = createBatchProduction(db, 'p', '旧公式批次', undefined, { planningMode: 'formula' });
  const before = getBatchProduction(db, 'p', batchId), inputs = readFormulaInputs(db, 'p', batchId);
  db.exec('CREATE TRIGGER batch_formula_manual_speech_immutable AFTER INSERT ON batch_productions BEGIN SELECT 1; END');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(getBatchProduction(db, 'p', batchId), before);
  assert.deepEqual(readFormulaInputs(db, 'p', batchId), inputs);
  assert.ok(createBatchProduction(db, 'p', '仍能创建普通批次'));
  db.exec('DROP TRIGGER batch_formula_manual_speech_immutable');
  assert.equal((await checkFormulaReadiness(options)).available, true);
  assert.deepEqual(readFormulaManualSpeech(db, 'p', batchId).items, []);
  db.exec('DROP TRIGGER batch_formula_manual_speech_owner');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  console.log('formula manual speech migration: v21 保留、v22 失败回滚/重试、归属约束及普通批量隔离通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
