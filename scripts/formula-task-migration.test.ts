import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkFormulaReadiness } from '../lib/batch-production/formula/readiness.ts';
import { FORMULA_SCHEMA_MIGRATIONS } from '../lib/batch-production/formula/schema.ts';
import { formulaExecutionAvailable } from '../lib/batch-production/formula/execution-gate.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createAsset } from '../lib/batch-production/assets.ts';
import { createBatchTask, startTaskAttempt } from '../lib/batch-production/tasks.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-task-migration-'));
const db = new Database(path.join(root, 'workbench.db'));
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','旧任务');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  const batchId = createBatchProduction(db, 'p', '迁移前的普通批次');
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const assetId = createAsset(db, { projectId: 'p', sourceKind: 'managed', locationJson: { kind: 'managed', relativePath: 'storage/batch-media/fixture.mp4' },
    contentFingerprint: fingerprint, mediaKind: 'video' });
  const taskId = createBatchTask(db, 'p', { batchId, workType: 'asset_prepare', targetKind: 'asset', targetId: assetId, requestKey: 'preserved-analysis' });
  startTaskAttempt(db, taskId);
  db.prepare(`INSERT INTO batch_asset_analysis_requests
    (taskId,projectId,batchId,assetId,contentFingerprint,providerId,model,analysisMode,createdAt,executionScope)
    VALUES (?,?,?,?,?,?,?,'content',?,'company')`).run(taskId, 'p', batchId, assetId, fingerprint, 'fixture-provider', 'fixture-model', '2026-10-22T00:00:00Z');
  db.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)');
  for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 8)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
  }
  const preserved = () => ({ tasks: db.prepare('SELECT * FROM batch_tasks').all(), attempts: db.prepare('SELECT * FROM batch_task_attempts').all(),
    analysis: db.prepare('SELECT * FROM batch_asset_analysis_requests').all() });
  const before = preserved();
  // 在共享任务表已重建之后才遇到失败，仍须整体撤销，而不能级联丢掉引用子表。
  db.exec('CREATE TABLE batch_formula_stages (id TEXT PRIMARY KEY)');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.deepEqual(preserved(), before);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.equal(formulaExecutionAvailable(db), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_formula_v9'").all().length, 0);
  db.exec('DROP TABLE batch_formula_stages');
  db.exec('CREATE TABLE future_reference (taskId TEXT REFERENCES batch_tasks(id) ON DELETE CASCADE)');
  db.prepare('INSERT INTO future_reference VALUES (?)').run(taskId);
  assert.equal((await checkFormulaReadiness(options)).available, false, '未知引用阻止重建而非丢掉未来模块的数据');
  assert.deepEqual(preserved(), before);
  assert.equal((db.prepare('SELECT count(*) AS n FROM future_reference').get() as { n: number }).n, 1);
  db.exec('DROP TABLE future_reference');
  const upgraded = await checkFormulaReadiness(options);
  assert.equal(upgraded.available, true, JSON.stringify(upgraded));
  assert.deepEqual(preserved(), before, '普通任务、每次尝试和分析请求的每一列都保留');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.equal(formulaExecutionAvailable(db), true);
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='batch_formula_task_owner'").get() as { sql: string };
  db.exec('DROP TRIGGER batch_formula_task_owner');
  assert.equal(formulaExecutionAvailable(db), false, '不能缓存损坏前的能力结果');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  db.exec(trigger.sql);
  assert.equal(formulaExecutionAvailable(db), true);
  console.log('公式任务升级：旧任务/尝试/分析请求完整保留、失败回滚、未知引用保护与普通能力隔离通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
