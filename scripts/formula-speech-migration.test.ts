import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-speech-migration-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const db = new Database(path.join(root, 'test.db'));
try {
  const { checkBatchProductionReadiness } = await import('../lib/batch-production/readiness.ts');
  const { checkFormulaReadiness } = await import('../lib/batch-production/formula/readiness.ts');
  const { FORMULA_SCHEMA_MIGRATIONS } = await import('../lib/batch-production/formula/schema.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction, createBatchProductionVersion } = await import('../lib/batch-production/versions.ts');
  const { createBatchExternalScript, snapshotScriptIntoBatch } = await import('../lib/batch-production/scripts.ts');
  const { createOutputPlan, createOutputVersion, getOutputVersion } = await import('../lib/batch-production/plans.ts');
  const { getFormulaCollection } = await import('../lib/batch-production/formula/collection-store.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
  const { readFormulaSpeech } = await import('../lib/batch-production/formula/speech-store.ts');
  const { createAsset } = await import('../lib/batch-production/assets.ts');
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','v13历史');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  db.exec('CREATE TABLE batch_formula_schema_migrations (version INTEGER PRIMARY KEY,appliedAt TEXT NOT NULL)');
  for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => item.version <= 13)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?,?)').run(migration.version, '2026-10-22T00:00:00Z');
  }
  const batchId = createBatchProduction(db, 'p', '旧选片记录', undefined, { planningMode: 'formula' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [12, '抖音', 1, 16, 'G1', '保留旧输入'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '历史.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 0 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 0, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 1, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 3 }], bgm: { mode: 'none', trackIds: [] } } });
  const batchVersion = createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const script = createBatchExternalScript(db, batchVersion, { sourceId: 'formula:old', title: '脚本 12', bodyText: '保留旧输入', sourceVersion: imported.id });
  const snapshot = snapshotScriptIntoBatch(db, batchVersion, { scriptId: script, copyCount: 3 });
  const plan = createOutputPlan(db, batchVersion, { scriptSnapshotId: snapshot, seq: 1 });
  // 直接植入已发布 v13 的存储形状，避免由新生成函数顺手创建 v14 声音任务。
  db.prepare(`INSERT INTO batch_formula_generation_requests
    (id,projectId,batchId,collectionId,batchVersionId,settingsId,inputRevision,requestKey,seed,inputJson,createdAt)
    VALUES ('r','p',?,?,?,?,1,'old','seed',?,'then')`).run(batchId, getFormulaCollection(db, 'p', batchId)!.id,
    batchVersion, settings.saved!.id, JSON.stringify({ settings: settings.saved }));
  db.prepare("INSERT INTO batch_formula_generation_outputs VALUES (?,'r','1:2','12',1,'[]')").run(plan);
  for (const revision of [1, 2]) {
    db.prepare("INSERT INTO batch_formula_stages VALUES (?,'r',?,'select',?,'then')").run(`s${revision}`, plan, revision);
    db.prepare('INSERT INTO batch_formula_selection_results VALUES (?,?,?)').run(`s${revision}`,
      JSON.stringify({ algorithmVersion: 'formula-selection/4', status: 'needs_attention', executionReady: false, slots: [] }), 'then');
  }
  db.prepare(`INSERT INTO batch_formula_reselections VALUES ('s2','s1',?,'old-reselect','seed-2','{"overrides":[]}',NULL,0)`).run(plan);
  db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,expectedState,attemptCount,createdAt,updatedAt)
    VALUES ('old-task','p',?,'formula_stage','formula_stage','s2','queued','running',0,'then','then')`).run(batchId);
  const tables = ['batch_formula_generation_requests', 'batch_formula_generation_outputs', 'batch_formula_stages',
    'batch_formula_selection_results', 'batch_formula_reselections', 'batch_tasks'];
  const snapshotTables = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshotTables();
  db.exec('CREATE TABLE batch_formula_speech_stages (id TEXT PRIMARY KEY)');
  assert.equal((await checkFormulaReadiness(options)).available, false, '追加失败时不留下半升级视图或触发器');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), before);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='batch_formula_execution_stages'").get(), undefined);
  db.exec('DROP TABLE batch_formula_speech_stages');
  // 固定已发布 v14 的原声记录，再验证 v15 的视图扩展不会丢弃这些任务和结果。
  const v14 = FORMULA_SCHEMA_MIGRATIONS.find(item => item.version === 14)!;
  db.exec(v14.sql);
  db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (14,?)').run('2026-10-22T01:00:00Z');
  const speechPlan = createOutputPlan(db, batchVersion, { scriptSnapshotId: snapshot, seq: 2 });
  const fingerprint = `sha256:${'0'.repeat(64)}`;
  const assetId = createAsset(db, { projectId: 'p', sourceKind: 'managed', locationJson: {}, contentFingerprint: fingerprint, mediaKind: 'video' });
  db.prepare("INSERT INTO batch_formula_generation_outputs VALUES (?,'r','1:2','12',2,'[]')").run(speechPlan);
  db.prepare("INSERT INTO batch_formula_stages VALUES ('spoken-selection','r',?,'select',1,'then')").run(speechPlan);
  db.prepare("INSERT INTO batch_formula_selection_results VALUES ('spoken-selection',?,'then')").run(JSON.stringify({ status: 'selected',
    slots: [{ slotId: 'slot', assetId, candidate: { contentFingerprint: fingerprint } }] }));
  db.prepare("INSERT INTO batch_formula_speech_stages VALUES ('old-speech','spoken-selection',?,?,1,?,'then')")
    .run(assetId, fingerprint, JSON.stringify({ formatVersion: 1, service: null }));
  db.prepare("INSERT INTO batch_formula_speech_results VALUES ('old-speech',?,'then')")
    .run(JSON.stringify({ status: 'no_audio_stream', assetId, contentFingerprint: fingerprint, sourceId: 'old-source', mediaDurationUs: 1_000_000 }));
  db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,expectedState,attemptCount,createdAt,updatedAt)
    VALUES ('old-speech-task','p',?,'formula_stage','formula_stage','old-speech','queued','running',0,'then','then')`).run(batchId);
  tables.push('batch_formula_speech_stages', 'batch_formula_speech_results');
  const v14Before = snapshotTables();
  const viewBefore = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get();
  db.exec('CREATE TABLE batch_formula_audio_mapping_stages (id TEXT PRIMARY KEY)');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), v14Before);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get(), viewBefore);
  db.exec('DROP TABLE batch_formula_audio_mapping_stages');
  const v15 = FORMULA_SCHEMA_MIGRATIONS.find(item => item.version === 15)!;
  db.exec(v15.sql);
  db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (15,?)').run('2026-10-22T02:00:00Z');
  db.prepare("INSERT INTO batch_formula_audio_mapping_stages VALUES ('old-mapping','spoken-selection',1,'{}','then')").run();
  db.prepare("INSERT INTO batch_formula_audio_mapping_results VALUES ('old-mapping',?,'then')")
    .run(JSON.stringify({ status: 'mapped', narrations: [{ id: 'narration-1', text: '保留旧输入', slotIds: ['slot'], blockIds: ['text-1'] }] }));
  tables.push('batch_formula_audio_mapping_stages', 'batch_formula_audio_mapping_results');
  const v15Before = snapshotTables();
  const v15View = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get();
  db.exec('CREATE TABLE batch_formula_narration_stages (id TEXT PRIMARY KEY)');
  assert.equal((await checkFormulaReadiness(options)).available, false);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), v15Before);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get(), v15View);
  db.exec('DROP TABLE batch_formula_narration_stages');
  const v16 = FORMULA_SCHEMA_MIGRATIONS.find(item => item.version === 16)!;
  db.exec(v16.sql);
  db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (16,?)').run('2026-10-22T03:00:00Z');
  db.prepare("INSERT INTO batch_formula_narration_stages VALUES ('old-narration','old-mapping','{}','then')").run();
  db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,expectedState,attemptCount,createdAt,updatedAt)
    VALUES ('old-narration-task','p',?,'formula_stage','formula_stage','old-narration','queued','running',0,'then','then')`).run(batchId);
  tables.push('batch_formula_narration_stages', 'batch_formula_narration_results');
  const v16Before = snapshotTables();
  const v16View = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get();
  db.exec('CREATE TABLE batch_formula_timeline_stages (id TEXT PRIMARY KEY)');
  assert.equal((await checkFormulaReadiness(options)).available, false, 'v17失败时保留v16及已有普通批量能力');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), v16Before);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get(), v16View);
  db.exec('DROP TABLE batch_formula_timeline_stages');
  const v17 = FORMULA_SCHEMA_MIGRATIONS.find(item => item.version === 17)!;
  db.exec(v17.sql);
  db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (17,?)').run('2026-10-22T04:00:00Z');
  assert.deepEqual(snapshotTables(), v16Before, '追加排片结构保留此前记录');
  const timelinePlan = createOutputPlan(db, batchVersion, { scriptSnapshotId: snapshot, seq: 3 });
  db.prepare("INSERT INTO batch_formula_generation_outputs VALUES (?,'r','1:2','12',3,'[]')").run(timelinePlan);
  db.prepare("INSERT INTO batch_formula_stages VALUES ('old-timeline-selection','r',?,'select',1,'then')").run(timelinePlan);
  db.prepare("INSERT INTO batch_formula_selection_results VALUES ('old-timeline-selection',?,'then')")
    .run(JSON.stringify({ status: 'selected', slots: [] }));
  db.prepare("INSERT INTO batch_formula_audio_mapping_stages VALUES ('old-source-mapping','old-timeline-selection',1,'{}','then')").run();
  db.prepare("INSERT INTO batch_formula_audio_mapping_results VALUES ('old-source-mapping',?,'then')")
    .run(JSON.stringify({ status: 'mapped', narrations: [] }));
  db.prepare("INSERT INTO batch_formula_timeline_stages VALUES ('old-timeline','old-source-mapping',NULL,'{}','then')").run();
  db.prepare("INSERT INTO batch_formula_timeline_results VALUES ('old-timeline',?,'then')")
    .run(JSON.stringify({ status: 'needs_attention', executionReady: false, issues: [{ code: 'duration_conflict', message: '保留旧时长冲突' }] }));
  tables.push('batch_formula_timeline_stages', 'batch_formula_timeline_results');
  const v17Before = snapshotTables();
  const v17View = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get();
  // 在 v18 事务中途制造名称冲突，验证新表/触发器一起回滚。
  db.exec('CREATE TRIGGER batch_formula_output_link_immutable AFTER INSERT ON batch_output_versions BEGIN SELECT 1; END');
  assert.equal((await checkFormulaReadiness(options)).available, false, 'v18失败只关闭公式能力');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), v17Before);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get(), v17View);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='batch_formula_output_versions'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='batch_formula_output_owner'").get(), undefined);
  db.exec('DROP TRIGGER batch_formula_output_link_immutable');
  const v18 = FORMULA_SCHEMA_MIGRATIONS.find(item => item.version === 18)!;
  db.exec(v18.sql);
  db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (18,?)').run('2026-10-22T05:00:00Z');
  // 已发布 v18 的可编辑公式输出，升级不能重排或清掉用户保存的安排。
  db.prepare("INSERT INTO batch_formula_audio_mapping_stages VALUES ('v18-mapping','old-timeline-selection',2,'{}','then')").run();
  db.prepare("INSERT INTO batch_formula_audio_mapping_results VALUES ('v18-mapping',?,'then')").run(JSON.stringify({ status: 'mapped', narrations: [] }));
  db.prepare("INSERT INTO batch_formula_timeline_stages VALUES ('v18-timeline','v18-mapping',NULL,'{}','then')").run();
  db.prepare("INSERT INTO batch_formula_timeline_results VALUES ('v18-timeline',?,'then')").run(JSON.stringify({ status: 'planned' }));
  const savedArrangement = { formula: { version: 1, timelineStageId: 'v18-timeline', selectionStageId: 'old-timeline-selection' },
    audioPlan: { version: 1 }, productionReady: false, editRevision: 7, blockers: ['保留用户待处理事项'] };
  const savedOutput = createOutputVersion(db, timelinePlan, { arrangementJson: savedArrangement });
  db.prepare("INSERT INTO batch_formula_output_versions VALUES ('v18-timeline',?,'then')").run(savedOutput);
  tables.push('batch_output_versions', 'batch_formula_output_versions');
  const v18Before = snapshotTables();
  db.exec('CREATE TRIGGER batch_formula_execution_result_immutable AFTER INSERT ON batch_output_versions BEGIN SELECT 1; END');
  assert.equal((await checkFormulaReadiness(options)).available, false, 'v19事务失败只关闭公式能力');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), v18Before);
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='batch_formula_execution_stages'").get(), v17View);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='batch_formula_execution_checks'").get(), undefined);
  db.exec('DROP TRIGGER batch_formula_execution_result_immutable');
  assert.equal((await checkFormulaReadiness(options)).available, true);
  assert.deepEqual(snapshotTables(), v18Before, 'v13选片至v18可编辑输出和任务逐行保留');
  assert.deepEqual(getOutputVersion(db, timelinePlan, savedOutput)?.arrangementJson, savedArrangement);
  assert.throws(() => db.prepare('INSERT INTO batch_formula_execution_checks VALUES (?,?,?,?,?,?)')
    .run('bad-check', savedOutput, 1, 'wrong', '{}', 'now'), /owner mismatch/);
  db.prepare('INSERT INTO batch_formula_execution_checks VALUES (?,?,?,?,?,?)')
    .run('execution-check', savedOutput, 1, 'same', JSON.stringify(savedArrangement), 'now');
  assert.throws(() => db.prepare("UPDATE batch_formula_execution_checks SET inputKey='changed' WHERE id='execution-check'").run(), /immutable/);
  assert.throws(() => db.prepare("INSERT INTO batch_formula_stages VALUES ('execution-check','r',?,'select',3,'now')").run(timelinePlan), /identity collision/);
  db.prepare("INSERT INTO batch_formula_execution_results VALUES ('execution-check','{}','now')").run();
  assert.throws(() => db.prepare("UPDATE batch_formula_execution_results SET resultJson='[]' WHERE stageId='execution-check'").run(), /immutable/);
  assert.equal((db.prepare("SELECT kind FROM batch_formula_execution_stages WHERE id='old-narration'").get() as { kind: string }).kind, 'narration');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(readFormulaSpeech(db, 'p', batchId, plan).status, 'needs_attention');
  assert.equal(readFormulaSpeech(db, 'p', batchId, plan, 's1').selectionStageId, 's1');
  assert.throws(() => db.prepare(`INSERT INTO batch_formula_speech_stages VALUES ('wrong','s2','foreign','fingerprint',1,'{}','now')`).run(), /owner mismatch/);
  assert.throws(() => db.prepare("INSERT INTO batch_formula_audio_mapping_stages VALUES ('wrong','s2',1,'{}','now')").run(), /owner mismatch/);
  assert.throws(() => db.prepare("INSERT INTO batch_formula_narration_stages VALUES ('wrong','missing','{}','now')").run(), /owner mismatch/);
  assert.throws(() => db.prepare("INSERT INTO batch_formula_timeline_stages VALUES ('wrong','old-mapping',NULL,'{}','now')").run(), /owner mismatch/);
  const { readFormulaNarration } = await import('../lib/batch-production/formula/narration-store.ts');
  assert.equal(readFormulaNarration(db, 'p', batchId, speechPlan).status, 'unconfigured', '旧请求未冻结完整声音配置，不得自动使用当前服务');
  console.log('formula speech migration: v13-v18历史保留、v14-v19故障回滚、执行检查归属/不可变约束、旧请求配音冻结与基础隔离通过');
} finally {
  db.close();
  const resolved = fs.realpathSync(root);
  assert(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('formula-speech-migration-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
