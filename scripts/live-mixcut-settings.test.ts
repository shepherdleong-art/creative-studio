import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-settings-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { dataRoot } = await import('../lib/data-root.ts');
assert.equal(dataRoot(), root);
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } = await import('../lib/live-mixcut/versions.ts');
const { createFormulaImportSession, confirmFormulaImportSession, reviseFormulaScriptImport } = await import('../lib/live-mixcut/formula/import-store.ts');
const { readFormulaSettings, saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');

const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试'),('other','另一个项目');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  const base = await checkBatchProductionReadiness(options);
  seedLiveMixcutProjects(options, ['p','other']);
  assert.equal(base.available, true, JSON.stringify(base));
  const ready = await checkBatchProductionReadiness(options);
  seedLiveMixcutProjects(options, ['p','other']);
  assert.equal(ready.available, true, JSON.stringify(ready));
  const batch = createBatchProduction(db, 'p', '选择脚本和份数', undefined, { planningMode: 'formula' });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('脚本');
  sheet.addRow(['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案']);
  for (let i = 1; i <= 300; i++) sheet.addRow([i, '抖音', 2, 16, 'G1 VO1', `文案 ${i}`]);
  const draft = await createFormulaImportSession(db, 'p', batch, { kind: 'scripts', filename: '300条.xlsx',
    bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0 });
  confirmFormulaImportSession(db, 'p', batch, draft.id, { expectedRevision: 0, excludedKeys: [] });
  const initial = readFormulaSettings(db, 'p', batch);
  assert.equal(initial.saved, null);
  assert.equal(initial.scripts.length, 300);
  const input = { expectedInputRevision: 1, expectedSettingsRevision: 0, scriptsSessionId: draft.id, settings: {
    selections: [{ key: '1:142', copies: 1 }, { key: '1:13', copies: 2 }], bgm: { mode: 'none', trackIds: [] },
  } };
  const saved = await saveFormulaSettings(db, 'p', batch, input);
  assert.equal(saved.saved!.totalCopies, 3);
  assert.deepEqual(saved.saved!.settings.selections, [{ key: '1:13', copies: 2 }, { key: '1:142', copies: 1 }]);
  assert.deepEqual(saved.saved!.settings.bgm, { mode: 'none', trackIds: [] });
  assert.deepEqual(readFormulaSettings(db, 'p', batch).saved, saved.saved, '重新读取保留脚本选择、份数与明确的无音乐');
  assert.equal((await saveFormulaSettings(db, 'p', batch, input)).saved!.id, saved.saved!.id, '同一保存重试不创建另一份修订');
  assert.equal((await saveFormulaSettings(db, 'p', batch, { ...input, expectedSettingsRevision: 1 })).saved!.revision, 1, '内容未变化不增加修订');
  const musicInput = (mode: string, trackIds: string[], expectedSettingsRevision = 1) => ({ ...input, expectedSettingsRevision,
    settings: { ...input.settings, bgm: { mode, trackIds } } });
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, musicInput('auto', [])), /曲库.*空|没有可用音乐/);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, musicInput('manual', [])), /至少选择一首/);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, musicInput('manual', ['missing'])), /曲目.*不可用|曲目.*不存在/);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  const musicDir = path.join(root, 'storage', 'bgm');
  fs.mkdirSync(musicDir, { recursive: true });
  // 一秒有效 PCM WAV，无需依赖外部模型或启动 FFmpeg。
  const wav = Buffer.alloc(44 + 8_000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let n = 0; n < 8_000; n++) wav.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 440 / 8_000) * 2_000), 44 + n * 2);
  const musicPath = path.join(musicDir, 'one.wav');
  fs.writeFileSync(musicPath, wav);
  const { computeFingerprintFromBuffer } = await import('../lib/live-mixcut/fingerprint.ts');
  db.prepare('INSERT INTO final_edit_bgm_tracks VALUES (?,?,?,?,?)').run('one', 'bgm/one.wav', computeFingerprintFromBuffer(wav), 1_000_000, 'ready');
  const music = await saveFormulaSettings(db, 'p', batch, musicInput('manual', ['one']));
  assert.equal(music.saved!.revision, 2);
  assert.deepEqual(music.saved!.settings.bgm, { mode: 'manual', trackIds: ['one'] });
  fs.unlinkSync(musicPath);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, musicInput('manual', ['one'], 2)), /音乐文件.*缺失/);
  assert.equal(readFormulaSettings(db, 'p', batch).saved!.settings.bgm.mode, 'manual', '文件丢失不得自动改成不加音乐或全库自动');
  const noMusic = await saveFormulaSettings(db, 'p', batch, musicInput('none', [], 2));
  assert.equal(noMusic.saved!.revision, 3, '明确改成不加音乐后，不受旧曲目缺失影响');
  fs.writeFileSync(musicPath, Buffer.from('被换成另一份文件'));
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, musicInput('auto', [], 3)), /音乐文件.*变化/);
  fs.writeFileSync(musicPath, wav);
  const automatic = await saveFormulaSettings(db, 'p', batch, musicInput('auto', [], 3));
  assert.equal(automatic.saved!.revision, 4);
  assert.deepEqual(automatic.saved!.settings.bgm, { mode: 'auto', trackIds: [] });
  const currentInput = { ...musicInput('none', [], 4) };
  for (const copies of [0, -1, 1.5, 1_001, Number.NaN]) {
    await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput,
      settings: { ...currentInput.settings, selections: [{ key: '1:13', copies }] } }), /份数|1,000/);
  }
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput,
    settings: { ...currentInput.settings, selections: [{ key: '1:13', copies: 500 }, { key: '1:142', copies: 501 }] } }), /1,000/);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput,
    settings: { ...currentInput.settings, selections: [{ key: '1:13', copies: 1 }, { key: '1:13', copies: 2 }] } }), /重复选择/);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput,
    settings: { ...currentInput.settings, selections: [{ key: 'other:2', copies: 1 }] } }), /不属于/);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput,
    settings: { ...currentInput.settings, selections: [] } }), /至少选择/);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput, expectedSettingsRevision: 2 }), /其他页面/);
  await assert.rejects(() => saveFormulaSettings(db, 'other', batch, currentInput), /不存在/);
  const otherBatch = createBatchProduction(db, 'p', '另一批次', undefined, { planningMode: 'formula' });
  await assert.rejects(() => saveFormulaSettings(db, 'p', otherBatch, currentInput), /更新/);

  // 音乐核验等待时曲库发生变化，不能把核验前的选择当成已保存。
  const saving = saveFormulaSettings(db, 'p', batch, musicInput('manual', ['one'], 4));
  db.prepare("UPDATE final_edit_bgm_tracks SET durationUs=2000000 WHERE id='one'").run();
  await assert.rejects(() => saving, /曲库已变化/);
  assert.equal(readFormulaSettings(db, 'p', batch).saved!.revision, 4);
  db.prepare("UPDATE final_edit_bgm_tracks SET relativePath='../outside.wav' WHERE id='one'").run();
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, musicInput('manual', ['one'], 4)), /路径不可用/);
  db.prepare("UPDATE final_edit_bgm_tracks SET relativePath='bgm/one.wav',durationUs=1000000 WHERE id='one'").run();

  const revised = await reviseFormulaScriptImport(db, 'p', batch, draft.id, { expectedRevision: 1 });
  assert.equal(readFormulaSettings(db, 'p', batch).hasPendingScripts, true);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, currentInput), /待确认/);
  confirmFormulaImportSession(db, 'p', batch, revised.id, { expectedRevision: 1, excludedKeys: [] });
  const stale = readFormulaSettings(db, 'p', batch);
  assert.equal(stale.stale, true);
  assert.equal(stale.saved!.scriptsSessionId, draft.id, '原设置保留原脚本版本，不能悄悄套用新表');
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, currentInput), /更新/);
  const updated = await saveFormulaSettings(db, 'p', batch, { ...currentInput, expectedInputRevision: 2, scriptsSessionId: revised.id });
  assert.equal(updated.stale, false);
  assert.equal(updated.saved!.revision, 5);
  assert.equal(updated.saved!.scriptsSessionId, revised.id);
  const timing = { mode: 'strict_max', scope: 'body', overrideDurationSec: 18.5, speechMarginMs: 200 };
  const timed = await saveFormulaSettings(db, 'p', batch, { expectedInputRevision: 2, expectedSettingsRevision: 5,
    scriptsSessionId: revised.id, settings: { ...updated.saved!.settings, timing } });
  assert.deepEqual(readFormulaSettings(db, 'p', batch).saved!.settings.timing, timing);
  const { timing: omittedTiming, ...legacySettings } = timed.saved!.settings;
  assert.deepEqual(omittedTiming, timing);
  const legacy = await saveFormulaSettings(db, 'p', batch, { expectedInputRevision: 2, expectedSettingsRevision: timed.saved!.revision,
    scriptsSessionId: revised.id, settings: legacySettings });
  assert.deepEqual(legacy.saved!.settings.timing, timing, '旧客户端不传时长字段时保留已保存选择');
  createBatchProductionVersion(db, batch, { copyCount: 3 });
  updateBatchProductionStatus(db, 'p', batch, 'running');
  assert.equal(readFormulaSettings(db, 'p', batch).editable, false);
  await assert.rejects(() => saveFormulaSettings(db, 'p', batch, { ...currentInput, expectedInputRevision: 2, scriptsSessionId: revised.id, expectedSettingsRevision: 5 }), /冻结/);
  assert.throws(() => db.prepare("UPDATE live_mixcut_formula_settings SET contentJson='{}' WHERE id=?").run(updated.saved!.id), /immutable/);
  assert.throws(() => db.prepare(`INSERT INTO live_mixcut_formula_settings (id,collectionId,revision,scriptsSessionId,contentJson,createdAt)
    VALUES ('bad','foreign-collection',1,?,'{}','then')`).run(revised.id), /owner/);
  console.log('formula-settings: 指定脚本与份数、无曲库无 TTS 保存、持久化及幂等通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
