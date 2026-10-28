import { seedLiveMixcutProjects, seedFormulaMaterialAnalysis } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-generation-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction, getBatchVersion, getBatchProduction, createBatchProductionVersion } = await import('../lib/live-mixcut/versions.ts');
const { listOutputPlans } = await import('../lib/live-mixcut/plans.ts');
const { listScriptSnapshots } = await import('../lib/live-mixcut/scripts.ts');
const { createFormulaImportSession, confirmFormulaImportSession, editFormulaScriptRow } = await import('../lib/live-mixcut/formula/import-store.ts');
const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
const { createFormulaGenerationRequest, readFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');

const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试'),('other','其他项目');");
  const readiness = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  const batch = createBatchProduction(db, 'p', '三条输出', undefined, { planningMode: 'formula' });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('脚本');
  sheet.addRow(['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案']);
  sheet.addRow([12, '抖音', 3, 16, 'G1 VO1 G1', '第一条文案']);
  sheet.addRow([141, '小红书', 2, 32, 'S76 P100', '第二条文案']);
  const imported = await createFormulaImportSession(db, 'p', batch, { kind: 'scripts', filename: '选择两条.xlsx',
    bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0 });
  confirmFormulaImportSession(db, 'p', batch, imported.id, { expectedRevision: 0, excludedKeys: [] });
  const settingsInput = { expectedInputRevision: 1, expectedSettingsRevision: 0, scriptsSessionId: imported.id,
    settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } };
  const saved = await saveFormulaSettings(db, 'p', batch, settingsInput);
  const input = { requestKey: 'first-click', expectedInputRevision: 1, settingsId: saved.saved!.id };
  const first = await createFormulaGenerationRequest(db, 'p', batch, input);
  assert.deepEqual(first.outputs.map(item => [item.scriptNumber, item.copyIndex]), [['12', 1], ['12', 2], ['141', 1]]);
  assert.deepEqual(first.outputs[0].slots.map(item => item.logicalCode), ['G1', 'VO1', 'G1'], '公式重复槽位不能去重');
  assert.deepEqual(first.outputs[0].slots.map(item => item.clipId), [0, 1, 2]);
  assert.equal(new Set(first.outputs.flatMap(item => item.slots.map(slot => slot.slotId))).size, 8);
  assert.equal(first.input.settings.id, saved.saved!.id);
  assert.deepEqual(first.input.musicPool, []);
  assert.equal(first.input.scripts[0].bodyText, '第一条文案');
  assert.deepEqual(await createFormulaGenerationRequest(db, 'p', batch, input), first, '重试复用原请求、输出身份和随机种子');
  assert.deepEqual(readFormulaGenerationRequest(db, 'p', batch, first.id), first, '重新读取只用落盘快照');
  assert.equal(getBatchVersion(db, batch, first.batchVersionId)?.inputState, 'frozen');
  assert.equal(listScriptSnapshots(db, first.batchVersionId).length, 2);
  assert.deepEqual(listScriptSnapshots(db, first.batchVersionId).map(script => script.targetDurationSec), [16, 32],
    '进入共享审片的脚本快照必须保留表格的目标时长，不能退回旧的 15 秒默认值');
  assert.equal(listOutputPlans(db, first.batchVersionId).length, 3);
  assert.ok(listOutputPlans(db, first.batchVersionId).every(plan => plan.currentVersionId === null), '有输入记录不等于已有可审成片');
  assert.throws(() => readFormulaGenerationRequest(db, 'other', batch, first.id), /不存在/);
  await assert.rejects(() => createFormulaGenerationRequest(db, 'p', batch, { ...input, settingsId: 'changed' }), /同一生成请求/);
  await assert.rejects(() => createFormulaGenerationRequest(db, 'p', batch, { ...input, requestKey: 'another-click' }), /冻结/);
  const reopened = new Database(path.join(root, 'workbench.db'));
  try { assert.deepEqual(readFormulaGenerationRequest(reopened, 'p', batch, first.id), first, '新数据库连接可恢复完整请求'); }
  finally { reopened.close(); }

  async function prepare(name: string) {
    const batchId = createBatchProduction(db, 'p', name, undefined, { planningMode: 'formula' });
    const draft = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '两条.xlsx',
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0 });
    confirmFormulaImportSession(db, 'p', batchId, draft.id, { expectedRevision: 0, excludedKeys: [] });
    const configured = await saveFormulaSettings(db, 'p', batchId, { ...settingsInput, scriptsSessionId: draft.id });
    return { batchId, settingsId: configured.saved!.id, scriptsSessionId: draft.id, expectedInputRevision: 1, requestKey: 'generate' };
  }
  const concurrent = await prepare('同时点击');
  const pair = await Promise.all([createFormulaGenerationRequest(db, 'p', concurrent.batchId, concurrent),
    createFormulaGenerationRequest(db, 'p', concurrent.batchId, concurrent)]);
  assert.deepEqual(pair[0], pair[1], '同时请求只能生成一套输出和种子');
  assert.equal(listOutputPlans(db, pair[0].batchVersionId).length, 3);
  const rollback = await prepare('事务失败');
  const beforeRollback = getBatchProduction(db, 'p', rollback.batchId);
  db.exec(`CREATE TRIGGER test_fail_second_plan BEFORE INSERT ON live_mixcut_output_plans WHEN NEW.seq=2
    BEGIN SELECT RAISE(ABORT, 'injected plan failure'); END`);
  await assert.rejects(() => createFormulaGenerationRequest(db, 'p', rollback.batchId, rollback), /injected plan failure/);
  assert.deepEqual(getBatchProduction(db, 'p', rollback.batchId), beforeRollback, '失败不能留下半套版本或冻结原草稿');
  db.exec('DROP TRIGGER test_fail_second_plan');
  const recovered = await createFormulaGenerationRequest(db, 'p', rollback.batchId, rollback);
  assert.equal(getBatchVersion(db, rollback.batchId, recovered.batchVersionId)?.versionNumber, 1);
  assert.equal(recovered.outputs.length, 3);

  const changed = await prepare('核验期间改设置');
  const saving = saveFormulaSettings(db, 'p', changed.batchId, { ...settingsInput, scriptsSessionId: changed.scriptsSessionId,
    expectedSettingsRevision: 1, settings: { ...settingsInput.settings, selections: [{ key: '1:3', copies: 1 }] } });
  const pending = createFormulaGenerationRequest(db, 'p', changed.batchId, changed);
  await saving;
  await assert.rejects(() => pending, /变化/);
  assert.equal(getBatchProduction(db, 'p', changed.batchId)?.currentVersionId, null);

  const editedBatch = createBatchProduction(db, 'p', '改过公式', undefined, { planningMode: 'formula' });
  const editDraft = await createFormulaImportSession(db, 'p', editedBatch, { kind: 'scripts', filename: '修正.xlsx',
    bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0 });
  await editFormulaScriptRow(db, 'p', editedBatch, editDraft.id, { expectedRevision: 0, expectedDraftRevision: 0,
    key: '1:2', values: { ...editDraft.preview.scriptInputs![0].values, '画面分镜(逻辑镜号组合)': 'G10 VO1 G10' } });
  confirmFormulaImportSession(db, 'p', editedBatch, editDraft.id, { expectedRevision: 0, expectedDraftRevision: 1, excludedKeys: [] });
  const editedSettings = await saveFormulaSettings(db, 'p', editedBatch, { ...settingsInput, scriptsSessionId: editDraft.id });
  const edited = await createFormulaGenerationRequest(db, 'p', editedBatch, { ...input, settingsId: editedSettings.saved!.id });
  assert.deepEqual(edited.outputs[0].slots.map(slot => slot.logicalCode), ['G10', 'VO1', 'G10'], '执行使用人工修正后公式');
  assert.equal(edited.input.scripts[0].originalFormula, 'G1 VO1 G1', '原公式保留追溯');
  assert.equal(edited.input.sessions[0].preview.scriptInputs?.[0].edits.length, 1, '人工修改记录随输入固定');
  createBatchProductionVersion(db, editedBatch, { copyCount: 1 });
  assert.deepEqual(await createFormulaGenerationRequest(db, 'p', editedBatch, { ...input, settingsId: editedSettings.saved!.id }), edited,
    '打开新草稿后，旧请求重试仍返回旧版本');

  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { saveFormulaMaterialNote } = await import('../lib/live-mixcut/formula/material-notes.ts');
  const { defaultTextStyle } = await import('../lib/media-core/cover-domain.ts');
  const { OUTPUT_PRESETS } = await import('../lib/media-core/cover-types.ts');
  const material = await prepare('冻结来源和预设');
  const source = path.join(root, 'fixture.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  const binding = registerFormulaAssetBinding(db, 'p', material.batchId, { assetId, sourcePath: '实拍/G1_正面.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', material.batchId);
  material.expectedInputRevision = 2;
  const content = { description: '产品正面', category: '外观', sellingPoints: [], actions: [], speech: 'unknown' as const, evidence: [] };
  const note = saveFormulaMaterialNote(db, 'p', material.batchId, binding.id, { expectedRevision: 2, expectedProfileId: null, content });
  const awaitingNotes = createFormulaGenerationRequest(db, 'p', material.batchId, material);
  const changedNote = saveFormulaMaterialNote(db, 'p', material.batchId, binding.id, { expectedRevision: 2, expectedProfileId: note.id,
    content: { ...content, description: '产品背面' } });
  await assert.rejects(() => awaitingNotes, /核验期间.*变化/, '说明修改不推进集合版本，也必须被输入比较发现');
  assert.equal(getBatchProduction(db, 'p', material.batchId)?.currentVersionId, null);
  db.exec(`CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,model TEXT,enabled INTEGER,keyEnv TEXT,apiKey TEXT,type TEXT,baseUrl TEXT);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试配音','frozen-model',1,NULL,'secret-not-in-snapshot','vapi-qwen-json-url','https://voice.example');
    CREATE TABLE final_edit_title_presets (id TEXT PRIMARY KEY,name TEXT,stylesByPresetJson TEXT);`);
  const preset = { version: 2, stylesByPreset: Object.fromEntries(Object.entries(OUTPUT_PRESETS).map(([key, dimensions]) => [key, {
    primary: defaultTextStyle('coverPrimary', dimensions.width), secondary: defaultTextStyle('coverSecondary', dimensions.width),
    framing: { scale: 1.4, offsetX: 0.2, offsetY: 0 },
  }])) };
  db.prepare('INSERT INTO final_edit_title_presets VALUES (?,?,?)').run('cover', '保留旧预设', JSON.stringify(preset));
  const fullSettings = await saveFormulaSettings(db, 'p', material.batchId, { ...settingsInput, expectedInputRevision: 2,
    expectedSettingsRevision: 1, scriptsSessionId: material.scriptsSessionId, settings: { ...settingsInput.settings, production: {
      outputPreset: '3x4', audio: { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.2 } },
      packaging: { mode: 'random', templateIds: ['overlay-poster', 'overlay-variety'] }, cover: { mode: 'uniform', presetIds: ['cover'] },
    } } });
  material.settingsId = fullSettings.saved!.id;
  const frozen = await createFormulaGenerationRequest(db, 'p', material.batchId, material);
  assert.equal(frozen.input.materialNotes[0].profile?.id, changedNote.id);
  assert.equal(frozen.input.materialNotes[0].profile?.content.description, '产品背面');
  assert.equal(frozen.input.materialIndex.bindings[0].contentFingerprint, binding.contentFingerprint);
  assert.equal(frozen.input.mediaSources[0].assetId, assetId);
  assert.equal(frozen.input.mediaSources[0].sources[0].location.kind, 'managed');
  assert.equal(frozen.input.productionResources.voice?.model, 'frozen-model');
  assert.equal(frozen.input.productionResources.covers[0].preset.stylesByPreset['3x4'].framing.scale, 1.4);
  assert(!JSON.stringify(frozen).includes('secret-not-in-snapshot'));
  db.exec("DELETE FROM final_edit_title_presets; UPDATE final_edit_tts_providers SET model='new-model',enabled=0;");
  createBatchProductionVersion(db, material.batchId, { copyCount: 1 });
  saveFormulaMaterialNote(db, 'p', material.batchId, binding.id, { expectedRevision: 2, expectedProfileId: changedNote.id,
    content: { ...content, description: '新草稿说明' } });
  assert.deepEqual(await createFormulaGenerationRequest(db, 'p', material.batchId, material), frozen,
    '旧请求不依赖仍在目录里的预设和当前说明；后续执行另外核验实际文件与供应商能力');
  console.log('公式请求：脚本份数、重复槽位、共享计划、输入冻结与幂等回读通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
