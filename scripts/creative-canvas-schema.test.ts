import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CREATIVE_CANVAS_MIGRATIONS,
  canvasTablesPresent,
  ensureCreativeCanvasSchemaReady,
  readCanvasAppliedVersions,
} from '../lib/creative-canvas/schema.ts';
import {
  SCOPE_SLUGS,
  cleanupInterruptedSchemaUpgradeBackups,
} from '../lib/schema-upgrade/backup.ts';
import { readSchemaUpgradeAudit } from '../lib/schema-upgrade/audit.ts';
import { listSchemaUpgradeRecoveryCandidates } from '../lib/schema-upgrade/recovery.ts';
import { checkCanvasReadiness } from '../lib/creative-canvas/readiness.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-schema-'));
const backupRoot = path.join(root, 'data', 'backups', 'schema-upgrades');
const lockDatabasePath = path.join(root, 'data', 'schema-upgrade.lock.db');
const auditFilePath = path.join(root, 'storage', 'logs', 'schema-upgrades.jsonl');

function createDatabase(name = 'workbench.db'): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const tablesAfterMigration = [
  'creative_canvas_logs',
  'creative_canvases',
  'creative_canvas_assets',
  'creative_canvas_node_states',
  'creative_canvas_runs',
  'creative_canvas_tasks',
  'creative_canvas_task_inputs',
  'creative_canvas_exports',
  'creative_canvas_copy_operations',
];

// --- 首次迁移：建表 + 备份 + 审计 + readiness ---------------------------------

{
  const db = createDatabase();
  const first = await ensureCreativeCanvasSchemaReady({ db, backupRoot });
  assert.equal(first.state, 'ready');
  // v2（并发多变体）：全新库一次性应用 v1+v2
  assert.deepEqual(first.appliedVersions, [1, 2, 3, 4]);
  assert.equal(first.targetVersion, 4);
  assert.equal(typeof first.backupDirectory, 'string');
  assert.equal(first.backupManifest?.scope, 'creative-canvas');
  assert.equal(first.backupManifest?.integrityCheck, 'ok');

  for (const table of tablesAfterMigration) {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
    assert.ok(row, `缺少表 ${table}`);
  }
  assert.equal(canvasTablesPresent(db), true);
  assert.deepEqual(readCanvasAppliedVersions(db), [1, 2, 3, 4]);

  // v2 结构断言：variantIndex 列存在；单任务唯一索引已放开
  const variantColumn = db.prepare(
    `SELECT 1 FROM pragma_table_info('creative_canvas_tasks') WHERE name = 'variantIndex'`,
  ).get();
  assert.ok(variantColumn, 'creative_canvas_tasks 缺少 variantIndex 列');
  const activeIndex = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_cct_node_active'`,
  ).get();
  assert.equal(activeIndex, undefined, 'v2 应已删除 idx_cct_node_active 唯一索引');

  // 备份目录名带 canvas slug，能被恢复候选读回并验证通过
  const candidates = await listSchemaUpgradeRecoveryCandidates({ backupRoot, scope: 'creative-canvas' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].verification, 'verified');
  assert.equal(candidates[0].targetVersion, 4);
  assert.match(candidates[0].backupId, /^pre-canvas-v4-/);
  assert.equal(path.basename(String(first.backupDirectory)).startsWith('pre-canvas-v4-'), true);

  // 审计由共享 gate 写入：走 readiness 的升级要留下完整记录
  const gatedDb = createDatabase('gated.db');
  const readiness = await checkCanvasReadiness({ db: gatedDb, backupRoot, lockDatabasePath, auditFilePath });
  assert.equal(readiness.available, true);
  assert.equal(readiness.available === true && readiness.schemaState, 'ready');
  assert.deepEqual(readiness.appliedVersions, [1, 2, 3, 4]);

  const audit = await readSchemaUpgradeAudit(auditFilePath);
  const canvasRecords = audit.filter((record) => record.scope === 'creative-canvas');
  assert.deepEqual(
    canvasRecords.map((record) => record.event),
    ['started', 'backup_completed', 'migration_completed', 'validation_completed', 'finished'],
  );
  assert.equal(canvasRecords.at(-1)?.result?.available, true);
  const gatedReadiness = await checkCanvasReadiness({ db: gatedDb, backupRoot, lockDatabasePath, auditFilePath });
  assert.equal(gatedReadiness.available, true);
  assert.equal(gatedReadiness.available === true && gatedReadiness.schemaState, 'current');
  gatedDb.close();

  // 重复运行：current，不再新增升级记录，也不再产生备份
  const second = await ensureCreativeCanvasSchemaReady({ db, backupRoot });
  assert.equal(second.state, 'current');
  assert.deepEqual(second.appliedVersions, [1, 2, 3, 4]);
  const backupsAfterSecondRun = fs.readdirSync(backupRoot).filter((name) => !name.startsWith('.'));
  assert.equal(backupsAfterSecondRun.length, 2);

  db.close();
}

// --- v1 → v2 增量升级：已发布 v1 的库安全补上 v2 --------------------------------

{
  const db = createDatabase('upgrade-from-v1.db');
  // 先手工应用 v1（模拟 v1 时代的库），再走 readiness 升到 v2
  db.exec(CREATIVE_CANVAS_MIGRATIONS[0].sql);
  db.exec(`CREATE TABLE IF NOT EXISTS creative_canvas_schema_migrations (
    version INTEGER PRIMARY KEY,
    appliedAt TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO creative_canvas_schema_migrations (version, appliedAt) VALUES (1, ?)`).run('now');
  const upgraded = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'data', 'backups', 'schema-upgrades-v1to2') });
  assert.equal(upgraded.state, 'ready');
  assert.deepEqual(upgraded.appliedVersions, [2, 3, 4]);
  assert.deepEqual(readCanvasAppliedVersions(db), [1, 2, 3, 4]);
  const variantColumn = db.prepare(
    `SELECT 1 FROM pragma_table_info('creative_canvas_tasks') WHERE name = 'variantIndex'`,
  ).get();
  assert.ok(variantColumn, '增量升级后应存在 variantIndex 列');
  db.close();
}

// --- 迁移失败 → compatibility_only，旧功能不受影响 ---------------------------

{
  const db = createDatabase('failing.db');
  db.exec(`CREATE TABLE creative_canvas_schema_migrations (
    version INTEGER PRIMARY KEY,
    appliedAt TEXT NOT NULL,
    note TEXT NOT NULL
  )`);
  const result = await ensureCreativeCanvasSchemaReady({ db, backupRoot });
  assert.equal(result.state, 'compatibility_only');
  assert.equal(result.state === 'compatibility_only' && result.code, 'migration_failed');
  assert.equal(canvasTablesPresent(db), false);
  db.close();
}

// --- 升级历史异常 -------------------------------------------------------------

{
  const db = createDatabase('history.db');
  db.exec(`CREATE TABLE creative_canvas_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
  db.prepare(`INSERT INTO creative_canvas_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(99, 'now');
  const tooNew = await ensureCreativeCanvasSchemaReady({ db, backupRoot });
  assert.equal(tooNew.state === 'compatibility_only' && tooNew.code, 'schema_too_new');
  db.close();
}

{
  const db = createDatabase('gap.db');
  db.exec(`CREATE TABLE creative_canvas_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
  // 记录存在但缺表 → 结构不一致
  db.prepare(`INSERT INTO creative_canvas_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(1, 'now');
  const inconsistent = await ensureCreativeCanvasSchemaReady({ db, backupRoot });
  assert.equal(inconsistent.state === 'compatibility_only' && inconsistent.code, 'schema_history_invalid');
  db.close();
}

// --- 中断备份清理识别 canvas 前缀 --------------------------------------------

{
  const stagingRoot = path.join(root, 'staging-backups');
  fs.mkdirSync(path.join(stagingRoot, '.pre-canvas-v1-2026-09-11T00-00-00-000Z-abcdef12'), { recursive: true });
  fs.mkdirSync(path.join(stagingRoot, 'pre-canvas-v1-2026-09-11T00-00-00-000Z-abcdef12'), { recursive: true });
  fs.mkdirSync(path.join(stagingRoot, '.pre-script-studio-v7-x'), { recursive: true });
  const cleaned = await cleanupInterruptedSchemaUpgradeBackups(stagingRoot);
  assert.equal(cleaned, 2);
  assert.deepEqual(fs.readdirSync(stagingRoot), ['pre-canvas-v1-2026-09-11T00-00-00-000Z-abcdef12']);
}

// --- 旧 scope 回归：slug 与既有迁移不受影响 -----------------------------------

{
  assert.deepEqual(SCOPE_SLUGS, {
    'batch-production': 'batch',
    'video-provider-gateway': 'video-gateway',
    'script-studio': 'script-studio',
    'creative-canvas': 'canvas',
  });
  assert.equal(CREATIVE_CANVAS_MIGRATIONS.length, 4);
  assert.deepEqual(CREATIVE_CANVAS_MIGRATIONS.map((migration) => migration.version), [1, 2, 3, 4]);

  // 旧 scope 在同库上仍能独立升级，且画布表不影响它
  const db = createDatabase('legacy-scope.db');
  await ensureCreativeCanvasSchemaReady({ db, backupRoot });
  const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
  const scriptStudio = await ensureScriptStudioSchemaReady({ db, backupRoot });
  assert.equal(scriptStudio.state, 'ready');
  assert.equal(scriptStudio.targetVersion >= 1, true);
  const scriptCandidates = await listSchemaUpgradeRecoveryCandidates({ backupRoot, scope: 'script-studio' });
  assert.equal(scriptCandidates.length, 1);
  assert.match(scriptCandidates[0].backupId, /^pre-script-studio-v\d+-/);
  db.close();
}

// --- 功能开关关闭：不执行迁移、不创建画布表 ------------------------------------

{
  const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-disabled-'));
  process.env.CREATIVE_STUDIO_DATA_ROOT = disabledRoot;
  delete process.env.CREATIVE_STUDIO_CANVAS_ENABLE;
  const { startCanvasAfterReadiness, getCanvasBootstrapState } = await import('../lib/creative-canvas/bootstrap.ts');
  const state = await startCanvasAfterReadiness();
  assert.equal(state, null);
  assert.equal(getCanvasBootstrapState(), null);
  // 连核心数据库都没有被创建——开关关闭时画布启动路径完全不触碰数据根
  assert.equal(fs.existsSync(path.join(disabledRoot, 'data', 'workbench.db')), false);
  assert.equal(fs.existsSync(path.join(disabledRoot, 'data', 'backups', 'schema-upgrades')), false);

  const { getDb, closeDb } = await import('../lib/db.ts');
  const db = getDb();
  assert.equal(canvasTablesPresent(db), false);
  const migrationRow = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_canvas_schema_migrations'`,
  ).get();
  assert.equal(migrationRow, undefined);
  closeDb();
  fs.rmSync(disabledRoot, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-schema.test.ts 通过');
