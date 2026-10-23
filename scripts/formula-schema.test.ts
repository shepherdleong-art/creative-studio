import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkFormulaReadiness } from '../lib/batch-production/formula/readiness.ts';
import { FORMULA_SCHEMA_MIGRATIONS, validateFormulaExecutionSchema } from '../lib/batch-production/formula/schema.ts';
import { readFormulaInputs, createFormulaImportSession, confirmFormulaImportSession } from '../lib/batch-production/formula/import-store.ts';
import { readFormulaSettings, saveFormulaSettings } from '../lib/batch-production/formula/settings-store.ts';
import { readFormulaSelectionRules } from '../lib/batch-production/formula/selection-rules.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { createBatchProduction, getBatchProduction, createBatchProductionVersion, getBatchVersion } from '../lib/batch-production/versions.ts';
import { startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { listSchemaUpgradeRecoveryCandidates } from '../lib/schema-upgrade/recovery.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-schema-'));
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','测试'),('p2','其他项目');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  const legacy = createBatchProduction(db, 'p1', '普通旧批次');
  assert.equal(getBatchProduction(db, 'p1', legacy)?.planningMode, 'semantic');

  // 公式备份失败不能关闭已验证安全的基础批量；也不能写入半升级身份。
  const failed = await checkFormulaReadiness({ ...options, diskSpaceProbe: async () => 0 });
  assert.equal(failed.available, false);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  const ordinary = createBatchProduction(db, 'p1', '失败后的普通批次');
  assert.equal(getBatchProduction(db, 'p1', ordinary)?.planningMode, 'semantic');

  const ready = await checkFormulaReadiness(options);
  assert.equal(ready.available, true, JSON.stringify(ready));
  const formula = createBatchProduction(db, 'p1', '按公式制作', undefined, { planningMode: 'formula' });
  assert.equal(getBatchProduction(db, 'p1', formula)?.planningMode, 'formula');
  assert.equal(getBatchProduction(db, 'p2', formula), undefined);
  assert.equal(getBatchProduction(db, 'p1', legacy)?.planningMode, 'semantic');
  const version = createBatchProductionVersion(db, formula, { copyCount: 1 });
  assert.equal(getBatchVersion(db, formula, version)?.planningMode, 'formula');
  assert.equal((await checkFormulaReadiness(options)).schemaState, 'current');
  assert.throws(() => startBatchProduction(db, 'p1', formula), /公式.*普通/);
  assert.throws(() => db.prepare("UPDATE batch_productions SET planningMode='semantic' WHERE id=?").run(formula), /immutable/);
  assert.throws(() => db.prepare("UPDATE batch_production_versions SET planningMode='semantic' WHERE id=?").run(version), /immutable/);
  assert.equal((await listSchemaUpgradeRecoveryCandidates({ backupRoot: options.backupRoot, scope: 'batch-formula' }))[0]?.verification, 'verified');
  const audit = fs.readFileSync(options.auditFilePath, 'utf8');
  assert(audit.includes('batch-formula'));

  // 独立迁移故障回滚，保留旧批次；不以错误迁移结果伪称基础能力可用。
  const brokenRoot = path.join(root, 'broken');
  fs.mkdirSync(brokenRoot);
  const broken = new Database(path.join(brokenRoot, 'workbench.db'));
  try {
    broken.pragma('foreign_keys = ON');
    broken.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','测试');");
    const brokenOptions = { db: broken, ...schemaUpgradeRuntimePaths(brokenRoot) };
    assert.equal((await checkBatchProductionReadiness(brokenOptions)).available, true);
    broken.exec("CREATE TRIGGER batch_formula_mode_immutable BEFORE UPDATE ON batch_productions BEGIN SELECT 1; END;");
    const migrationFailure = await checkFormulaReadiness(brokenOptions);
    assert.equal(migrationFailure.available, false);
    assert.equal((await checkBatchProductionReadiness(brokenOptions)).available, true);
    const afterFailure = createBatchProduction(broken, 'p1', '仍能创建');
    assert.equal(getBatchProduction(broken, 'p1', afterFailure)?.planningMode, 'semantic');
    assert.throws(() => createBatchProduction(broken, 'p1', '不应成功', undefined, { planningMode: 'formula' }), /安全升级/);
    broken.exec('DROP TABLE batch_asset_pool_items');
    assert.equal((await checkFormulaReadiness(brokenOptions)).available, false);
    assert.equal((await checkBatchProductionReadiness(brokenOptions)).available, false);
  } finally { broken.close(); }
  const priorRoot = path.join(root, 'prior-formula');
  fs.mkdirSync(priorRoot);
  const prior = new Database(path.join(priorRoot, 'workbench.db'));
  try {
    prior.pragma('foreign_keys=ON');
    prior.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','旧公式资料');");
    const priorOptions = { db: prior, ...schemaUpgradeRuntimePaths(priorRoot) };
    assert.equal((await checkBatchProductionReadiness(priorOptions)).available, true);
    prior.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
    for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 3)) {
      prior.exec(migration.sql);
      prior.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
    }
    const priorBatch = createBatchProduction(prior, 'p1', '已确认资料', undefined, { planningMode: 'formula' });
    prior.prepare("INSERT INTO batch_formula_collections (id,projectId,batchId,revision,createdAt,updatedAt) VALUES ('old-collection','p1',?,1,'then','then')").run(priorBatch);
    const oldPreview = { kind: 'scripts', fingerprint: 'old-fingerprint', extraction: 'local_headers', rowCount: 1, issues: [], rows: [
      { key: '1:2', scriptNumber: '9', platform: '抖音', targetDurationSec: 16, bodyText: '历史原文', originalFormula: 'G1', codes: ['G1'], source: { sheet: '脚本', row: 2, cells: { '脚本文案': 'F2' } } },
    ] };
    prior.prepare(`INSERT INTO batch_formula_import_sessions (id,collectionId,kind,fingerprint,filename,baseRevision,previewJson,state,confirmedRevision,createdAt)
      VALUES ('old-import','old-collection','scripts','old-fingerprint','旧表.xlsx',0,?,'confirmed',1,'then')`).run(JSON.stringify(oldPreview));
    prior.exec("UPDATE batch_formula_collections SET scriptsSessionId='old-import' WHERE id='old-collection'");
    assert.equal((await checkFormulaReadiness(priorOptions)).available, true);
    const kept = readFormulaInputs(prior, 'p1', priorBatch);
    assert.equal(kept.scripts?.rows.length, 1);
    assert.equal(kept.scripts?.sessionId, 'old-import');
    assert.equal(kept.scripts?.rows[0].source.cells['脚本文案'], 'F2');
    assert.equal(kept.revision, 1);
  } finally { prior.close(); }
  // v7 设置迁移失败时，不关闭已验证安全的普通批量，也不改 v6 的公式身份。
  const settingsRoot = path.join(root, 'v6-settings-upgrade');
  fs.mkdirSync(settingsRoot);
  const settingsDb = new Database(path.join(settingsRoot, 'workbench.db'));
  try {
    settingsDb.pragma('foreign_keys=ON');
    settingsDb.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','v6 资料');");
    const settingsOptions = { db: settingsDb, ...schemaUpgradeRuntimePaths(settingsRoot) };
    assert.equal((await checkBatchProductionReadiness(settingsOptions)).available, true);
    settingsDb.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
    for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 6)) {
      settingsDb.exec(migration.sql);
      settingsDb.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
    }
    const existingFormula = createBatchProduction(settingsDb, 'p1', 'v6 公式批次', undefined, { planningMode: 'formula' });
    settingsDb.exec('CREATE TABLE batch_formula_settings (id INTEGER PRIMARY KEY)');
    assert.equal((await checkFormulaReadiness(settingsOptions)).available, false);
    assert.equal((await checkBatchProductionReadiness(settingsOptions)).available, true);
    const existingOrdinary = createBatchProduction(settingsDb, 'p1', '公式升级失败后仍可创建普通批次');
    assert.equal(getBatchProduction(settingsDb, 'p1', existingOrdinary)?.planningMode, 'semantic');
    assert.equal(getBatchProduction(settingsDb, 'p1', existingFormula)?.planningMode, 'formula');
    settingsDb.exec('DROP TABLE batch_formula_settings');
    assert.equal((await checkFormulaReadiness(settingsOptions)).available, true);
    assert.equal(getBatchProduction(settingsDb, 'p1', existingFormula)?.planningMode, 'formula');
  } finally { settingsDb.close(); }
  const generationRoot = path.join(root, 'v7-generation-upgrade');
  fs.mkdirSync(generationRoot);
  const generationDb = new Database(path.join(generationRoot, 'workbench.db'));
  try {
    generationDb.pragma('foreign_keys=ON');
    generationDb.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','v7 已保存设置');");
    const generationOptions = { db: generationDb, ...schemaUpgradeRuntimePaths(generationRoot) };
    assert.equal((await checkBatchProductionReadiness(generationOptions)).available, true);
    generationDb.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
    for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 7)) {
      generationDb.exec(migration.sql);
      generationDb.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
    }
    const batchId = createBatchProduction(generationDb, 'p1', '升级前的公式资料', undefined, { planningMode: 'formula' });
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('脚本').addRows([
      ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
      [12, '抖音', 2, 16, 'G1 VO1', '旧资料必须保留'],
    ]);
    const draft = await createFormulaImportSession(generationDb, 'p1', batchId, { kind: 'scripts', filename: '旧资料.xlsx',
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0 });
    confirmFormulaImportSession(generationDb, 'p1', batchId, draft.id, { expectedRevision: 0, excludedKeys: [] });
    const settings = await saveFormulaSettings(generationDb, 'p1', batchId, { expectedInputRevision: 1, expectedSettingsRevision: 0,
      scriptsSessionId: draft.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
    const inputs = readFormulaInputs(generationDb, 'p1', batchId);
    generationDb.exec('CREATE TABLE batch_formula_generation_requests (id INTEGER PRIMARY KEY)');
    assert.equal((await checkFormulaReadiness(generationOptions)).available, false);
    assert.equal((await checkBatchProductionReadiness(generationOptions)).available, true);
    assert.deepEqual(readFormulaSettings(generationDb, 'p1', batchId), settings);
    generationDb.exec('DROP TABLE batch_formula_generation_requests');
    assert.equal((await checkFormulaReadiness(generationOptions)).available, true);
    assert.deepEqual(readFormulaInputs(generationDb, 'p1', batchId), inputs);
    assert.deepEqual(readFormulaSettings(generationDb, 'p1', batchId), settings);
    generationDb.exec('DROP TRIGGER batch_formula_generation_output_owner');
    assert.equal((await checkFormulaReadiness(generationOptions)).available, false, '缺少生成归属约束时不能假报就绪');
    assert.equal((await checkBatchProductionReadiness(generationOptions)).available, true);
  } finally { generationDb.close(); }
  const rulesRoot = path.join(root, 'v9-rules-upgrade');
  fs.mkdirSync(rulesRoot);
  const rulesDb = new Database(path.join(rulesRoot, 'workbench.db'));
  try {
    rulesDb.pragma('foreign_keys=ON');
    rulesDb.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','v9 公式资料');");
    const rulesOptions = { db: rulesDb, ...schemaUpgradeRuntimePaths(rulesRoot) };
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
    rulesDb.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)');
    for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 9)) {
      rulesDb.exec(migration.sql);
      rulesDb.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
    }
    const batchId = createBatchProduction(rulesDb, 'p1', '已有公式批次', undefined, { planningMode: 'formula' });
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('脚本').addRows([
      ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
      [12, '抖音', 2, 16, 'G1 G1', '升级保留重复镜头'],
    ]);
    const session = await createFormulaImportSession(rulesDb, 'p1', batchId, { kind: 'scripts', filename: '原表.xlsx',
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0 });
    confirmFormulaImportSession(rulesDb, 'p1', batchId, session.id, { expectedRevision: 0, excludedKeys: [] });
    const before = readFormulaInputs(rulesDb, 'p1', batchId);
    rulesDb.exec('CREATE TABLE batch_formula_selection_rules (id INTEGER PRIMARY KEY)');
    rulesDb.exec('CREATE TABLE batch_formula_asset_ranges (id INTEGER PRIMARY KEY)');
    rulesDb.exec('CREATE TABLE batch_formula_reselections (id INTEGER PRIMARY KEY)');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, false);
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
    assert.deepEqual(readFormulaInputs(rulesDb, 'p1', batchId), before);
    rulesDb.exec('DROP TABLE batch_formula_selection_rules');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, false, 'v10 成功后 v11 区间升级失败不能假报就绪');
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
    assert.deepEqual(readFormulaInputs(rulesDb, 'p1', batchId), before);
    rulesDb.exec('DROP TABLE batch_formula_asset_ranges');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, false, 'v11 成功后 v12 重选升级失败不能假报就绪');
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
    assert.deepEqual(readFormulaInputs(rulesDb, 'p1', batchId), before, '重选升级失败不能改写已有导入资料');
    assert.equal(getBatchProduction(rulesDb, 'p1', batchId)?.planningMode, 'formula');
    const ordinary = createBatchProduction(rulesDb, 'p1', '重选升级失败后仍可用的普通批次');
    assert.equal(getBatchProduction(rulesDb, 'p1', ordinary)?.planningMode, 'semantic');
    rulesDb.exec('DROP TABLE batch_formula_reselections');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, true);
    assert.deepEqual(readFormulaInputs(rulesDb, 'p1', batchId), before);
    assert.equal(readFormulaSelectionRules(rulesDb, 'p1', batchId).saved, null, '旧批次升级不凭空指定主片');
    const rangeOwner = rulesDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='batch_formula_range_owner'").get() as { sql: string };
    rulesDb.exec('DROP TRIGGER batch_formula_range_owner');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, false, '缺少区间归属约束时公式能力不可用');
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
    rulesDb.exec(rangeOwner.sql);
    const reselectionOwner = rulesDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='batch_formula_reselection_owner'").get() as { sql: string };
    rulesDb.exec('DROP TRIGGER batch_formula_reselection_owner');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, false, '缺少逐条重选归属约束时公式能力不可用');
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
    rulesDb.exec(reselectionOwner.sql);
    rulesDb.exec('DROP TRIGGER batch_formula_rules_owner');
    assert.equal((await checkFormulaReadiness(rulesOptions)).available, false);
    assert.equal((await checkBatchProductionReadiness(rulesOptions)).available, true);
  } finally { rulesDb.close(); }
  const mappingRoot = path.join(root, 'v12-mapping-upgrade');
  fs.mkdirSync(mappingRoot);
  const mappingDb = new Database(path.join(mappingRoot, 'workbench.db'));
  try {
    mappingDb.pragma('foreign_keys=ON');
    mappingDb.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p1','旧选片规则');");
    const mappingOptions = { db: mappingDb, ...schemaUpgradeRuntimePaths(mappingRoot) };
    assert.equal((await checkBatchProductionReadiness(mappingOptions)).available, true);
    mappingDb.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)');
    for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 12)) {
      mappingDb.exec(migration.sql);
      mappingDb.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
    }
    const existingBatch = createBatchProduction(mappingDb, 'p1', '已有人工选片', undefined, { planningMode: 'formula' });
    mappingDb.prepare("INSERT INTO batch_formula_collections (id,projectId,batchId,revision,createdAt,updatedAt) VALUES ('old-rules-collection','p1',?,1,'then','then')").run(existingBatch);
    const oldRules = { primary: [], overrides: [] };
    mappingDb.prepare(`INSERT INTO batch_formula_selection_rules (id,collectionId,revision,scriptsSessionId,contentJson,createdAt)
      VALUES ('old-rules','old-rules-collection',1,NULL,?,'then')`).run(JSON.stringify(oldRules));
    assert.throws(() => validateFormulaExecutionSchema(mappingDb), /尚未就绪/, '统一替换需要新的规则格式，不能在升级前启动公式任务');
    mappingDb.exec('ALTER TABLE batch_formula_selection_rules ADD COLUMN formatVersion TEXT');
    assert.equal((await checkFormulaReadiness(mappingOptions)).available, false);
    assert.equal((await checkBatchProductionReadiness(mappingOptions)).available, true);
    assert.equal(getBatchProduction(mappingDb, 'p1', existingBatch)?.planningMode, 'formula');
    mappingDb.exec('ALTER TABLE batch_formula_selection_rules DROP COLUMN formatVersion');
    assert.equal((await checkFormulaReadiness(mappingOptions)).available, true);
    const kept = readFormulaSelectionRules(mappingDb, 'p1', existingBatch);
    assert.equal(kept.saved?.id, 'old-rules');
    assert.equal(kept.saved?.formatVersion, 1);
    assert.deepEqual(kept.saved?.rules, oldRules);
  } finally { mappingDb.close(); }
  console.log('formula-schema: 备份失败隔离、批次身份、v7–v13 资料升级保留、生成/人工选片/区间/重选/统一替换格式检查通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
