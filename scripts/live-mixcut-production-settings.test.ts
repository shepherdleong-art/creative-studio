import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-production-settings-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { dataRoot } = await import('../lib/data-root.ts');
assert.equal(dataRoot(), root);
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
const { readFormulaSettings, saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','声音和包装');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const batch = createBatchProduction(db, 'p', '生成设置', undefined, { planningMode: 'formula' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'G1 VO1', '原声优先的文案'],
  ]);
  const draft = await createFormulaImportSession(db, 'p', batch, { kind: 'scripts', filename: '声音包装.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 0 });
  confirmFormulaImportSession(db, 'p', batch, draft.id, { expectedRevision: 0, excludedKeys: [] });
  const settings = {
    selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] },
    production: {
      outputPreset: '9x16', audio: { mode: 'original', tts: null },
      packaging: { mode: 'random', templateIds: ['overlay-variety', 'overlay-journal'] },
      cover: { mode: 'default', presetIds: [] },
    },
  };
  const saved = await saveFormulaSettings(db, 'p', batch, {
    expectedInputRevision: 1, expectedSettingsRevision: 0, scriptsSessionId: draft.id, settings,
  });
  assert.equal(saved.saved!.settings.production.audio.mode, 'original');
  assert.equal(saved.saved!.settings.production.audio.tts, null, '没有 TTS 表和供应商也能保存纯原声设置');
  assert.deepEqual(saved.saved!.settings.production.packaging, { mode: 'random', templateIds: ['overlay-journal', 'overlay-variety'] });
  assert.deepEqual(readFormulaSettings(db, 'p', batch).saved, saved.saved);
  assert.equal(saved.saved!.totalCopies, 2);
  const update = (production: unknown, expectedSettingsRevision = 1) => saveFormulaSettings(db, 'p', batch, {
    expectedInputRevision: 1, expectedSettingsRevision, scriptsSessionId: draft.id, settings: { ...settings, production },
  });
  await assert.rejects(() => update({ ...settings.production, packaging: { mode: 'uniform', templateIds: ['invented-template'] } }), /包装模板.*不可用/);
  assert.equal(readFormulaSettings(db, 'p', batch).productionOptions.templates.length, 4);
  assert.deepEqual(readFormulaSettings(db, 'p', batch).productionOptions.voices, []);
  db.exec(`CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,model TEXT,enabled INTEGER,keyEnv TEXT,apiKey TEXT);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试配音','fixture-model',1,NULL,'do-not-expose-secret');
    CREATE TABLE final_edit_title_presets (id TEXT PRIMARY KEY,name TEXT,stylesByPresetJson TEXT);`);
  const { defaultTextStyle } = await import('../lib/media-core/cover-domain.ts');
  const { OUTPUT_PRESETS } = await import('../lib/media-core/cover-types.ts');
  const preset = { version: 2, stylesByPreset: Object.fromEntries(Object.entries(OUTPUT_PRESETS).map(([id, dimensions]) => [id, {
    primary: defaultTextStyle('coverPrimary', dimensions.width), secondary: defaultTextStyle('coverSecondary', dimensions.width),
    framing: { scale: 1.4, offsetX: 0.2, offsetY: 0 },
  }])) };
  for (const id of ['cover-one', 'cover-two']) db.prepare('INSERT INTO final_edit_title_presets VALUES (?,?,?)').run(id, id, JSON.stringify(preset));
  db.prepare('INSERT INTO final_edit_title_presets VALUES (?,?,?)').run('broken', '损坏预设', '{}');
  const available = readFormulaSettings(db, 'p', batch).productionOptions;
  assert.equal(available.voices[0].configured, true);
  assert(available.voices[0].voices.some(voice => voice.id === 'Cherry'));
  assert.equal(available.coverPresets.find(item => item.id === 'broken')!.available, false);
  assert(!JSON.stringify(readFormulaSettings(db, 'p', batch)).includes('do-not-expose-secret'));
  const production = { ...settings.production,
    outputPreset: '3x4', audio: { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.2 } },
    packaging: { mode: 'uniform', templateIds: ['overlay-minimal'] }, cover: { mode: 'random', presetIds: ['cover-two', 'cover-one'] },
  };
  const full = await update(production);
  assert.equal(full.saved!.revision, 2);
  assert.equal(full.saved!.settings.production.audio.tts!.speed, 1.2);
  assert.deepEqual(full.saved!.settings.production.cover, { mode: 'random', presetIds: ['cover-one', 'cover-two'] });
  assert.deepEqual(readFormulaSettings(db, 'p', batch).saved, full.saved);
  const oldClient = await saveFormulaSettings(db, 'p', batch, { expectedInputRevision: 1, expectedSettingsRevision: 2, scriptsSessionId: draft.id,
    settings: { selections: settings.selections, bgm: settings.bgm } });
  assert.equal(oldClient.saved!.id, full.saved!.id, '旧客户端只改脚本/音乐不能清除声音与包装');
  for (const bad of [
    { ...production, audio: { mode: 'mixed', tts: { providerId: 'missing', voice: 'Cherry', speed: 1 } } },
    { ...production, audio: { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'invented', speed: 1 } } },
    { ...production, audio: { mode: 'mixed', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.25 } } },
    { ...production, packaging: { mode: 'random', templateIds: [] } },
    { ...production, packaging: { mode: 'uniform', templateIds: ['overlay-poster', 'overlay-journal'] } },
    { ...production, cover: { mode: 'uniform', presetIds: ['missing'] } },
    { ...production, cover: { mode: 'random', presetIds: ['broken'] } },
    { ...production, outputPreset: 'cinema' },
    { ...production, runCommand: 'ignore this data' },
  ]) await assert.rejects(() => update(bad, 2));
  assert.equal(readFormulaSettings(db, 'p', batch).saved!.revision, 2, '无效资源或参数不能落下一半设置');
  const racing = update({ ...production, outputPreset: '16x9' }, 2);
  const changedPreset = structuredClone(preset);
  changedPreset.stylesByPreset['9x16'].framing.scale = 1.8;
  db.prepare('UPDATE final_edit_title_presets SET stylesByPresetJson=? WHERE id=?').run(JSON.stringify(changedPreset), 'cover-one');
  await assert.rejects(() => racing, /封面预设已变化/);
  assert.equal(readFormulaSettings(db, 'p', batch).saved!.revision, 2);
  db.prepare('UPDATE final_edit_tts_providers SET enabled=0').run();
  await assert.rejects(() => update(production, 2), /配音供应商不可用/);
  const original = await update({ ...settings.production, packaging: { mode: 'random', templateIds: ['overlay-poster'] } }, 2);
  assert.equal(original.saved!.settings.production.packaging.mode, 'uniform', '一个随机候选按统一处理');
  assert.equal(original.saved!.settings.production.audio.mode, 'original', '停用 TTS 不阻止纯原声');
  const pendingVoice = await update({ ...settings.production, audio: { mode: 'mixed', tts: null } }, 3);
  assert.equal(pendingVoice.saved!.settings.production.audio.tts, null, '可先保存草稿，制作时只对实际需要 TTS 的输出检查配置');
  // 已有 v7 记录只有脚本与音乐：用原持久化格式装入旧数据，再通过公开读取/保存接口验证兼容。
  const legacyBatch = createBatchProduction(db, 'p', '旧设置兼容', undefined, { planningMode: 'formula' });
  const legacyDraft = await createFormulaImportSession(db, 'p', legacyBatch, { kind: 'scripts', filename: '旧脚本.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 0 });
  confirmFormulaImportSession(db, 'p', legacyBatch, legacyDraft.id, { expectedRevision: 0, excludedKeys: [] });
  const { getFormulaCollection } = await import('../lib/live-mixcut/formula/collection-store.ts');
  const legacySettings = { selections: settings.selections, bgm: settings.bgm };
  db.prepare('INSERT INTO live_mixcut_formula_settings (id,collectionId,revision,scriptsSessionId,contentJson,createdAt) VALUES (?,?,?,?,?,?)')
    .run('legacy-settings', getFormulaCollection(db, 'p', legacyBatch)!.id, 1, legacyDraft.id, JSON.stringify(legacySettings), new Date().toISOString());
  const legacy = readFormulaSettings(db, 'p', legacyBatch);
  assert.deepEqual(legacy.saved!.settings.production, { outputPreset: '3x4', audio: { mode: 'mixed', tts: null },
    packaging: { mode: 'uniform', templateIds: ['overlay-poster'] }, cover: { mode: 'default', presetIds: [] } });
  assert.equal((await saveFormulaSettings(db, 'p', legacyBatch, { expectedInputRevision: 1, expectedSettingsRevision: 1,
    scriptsSessionId: legacyDraft.id, settings: legacySettings })).saved!.id, 'legacy-settings');
  console.log('formula-production-settings: 原声/配音、语速、包装/封面策略、资源验证、旧请求兼容、并发变更和密钥不回显通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
