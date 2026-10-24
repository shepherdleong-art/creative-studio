import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: manually verified source speech → frozen generation → actual media check and subtitles.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-speech-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
delete process.env.FINAL_EDIT_ALIGNMENT_BASE_URL;
delete process.env.FINAL_EDIT_ALIGNMENT_API_KEY;
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { readFormulaManualSpeech, saveFormulaManualSpeech } = await import('../lib/live-mixcut/formula/manual-speech.ts');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { readFormulaSpeech } = await import('../lib/live-mixcut/formula/speech-store.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { getBatchOutputArrangementView } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'MANUAL',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','人工原声');`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const source = path.join(root, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'p', '人工台词离线制作', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'VO1_原声.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 2, 'VO1', '好擦洗。坐得稳。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const inputView = readFormulaManualSpeech(db, 'p', batchId);
  const input = { assetId, contentFingerprint: inputView.items[0].contentFingerprint,
    expectedInputRevision: 2, expectedSpeechRevision: 0, confirmed: true, mode: 'speech' as const,
    segments: [{ text: '好擦洗。', startUs: 250_000, endUs: 900_000 }, { text: '坐得稳。', startUs: 1_100_000, endUs: 1_750_000 }] };
  const saved = await saveFormulaManualSpeech(db, 'p', batchId, input);
  assert.equal(saved.inputRevision, 3);
  assert.deepEqual(saved.items[0].saved?.segments, input.segments);
  assert.equal(saved.items[0].saved?.origin, 'manual');
  assert.deepEqual(await saveFormulaManualSpeech(db, 'p', batchId, input), saved, '回复丢失后同次保存幂等');
  const correction = { ...input, expectedInputRevision: 3, expectedSpeechRevision: 1 };
  await assert.rejects(saveFormulaManualSpeech(db, 'p', batchId, { ...correction, confirmed: false }), /试听/);
  await assert.rejects(saveFormulaManualSpeech(db, 'p', batchId, { ...correction,
    segments: [{ text: '超出原片', startUs: 0, endUs: 3_000_000 }] }), /原片/);
  await assert.rejects(saveFormulaManualSpeech(db, 'p', batchId, { ...correction,
    segments: [{ text: '第一句', startUs: 0, endUs: 900_000 }, { text: '重叠', startUs: 800_000, endUs: 1_000_000 }] }), /重叠/);
  await assert.rejects(saveFormulaManualSpeech(db, 'other', batchId, correction), /不存在|不属于/);
  assert.equal(readFormulaManualSpeech(db, 'p', batchId).inputRevision, 3, '失败不产生新资料修订');
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'original', tts: null }; production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'manual', settingsId: settings.saved!.id, expectedInputRevision: 3 });
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw new Error('本场景不应调用任何声音服务'); };
  await runPendingOnce({ db, workerId: 'manual', executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
  assert.equal(externalCalls, 0);
  const speech = readFormulaSpeech(db, 'p', batchId, request.outputs[0].planId).sources[0].result;
  assert.equal(speech?.status, 'transcribed');
  if (speech?.status !== 'transcribed') assert.fail('人工台词没有进入真实声音编排');
  assert.equal(speech.manualVerification?.revisionId, saved.items[0].saved?.id);
  assert.equal(speech.transcriptionIdentity, null, '人工核对不冒充自动识别');
  assert.deepEqual(speech.words, input.segments);
  assert.equal(getBatchWorkspace(db, 'p', batchId).formulaGeneration?.ready, 1);
  const output = getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId);
  assert.equal(output.subtitleCues.map(cue => cue.text).join(''), '好擦洗。坐得稳。');
  const { setBatchPlanReviews } = await import('../lib/live-mixcut/review.ts');
  const { orchestrateBatchExport } = await import('../lib/live-mixcut/export-orchestrator.ts');
  const planId = request.outputs[0].planId;
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...output.reviewContext! }] }).results[0].status, 'saved');
  await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} });
  await runPendingOnce({ db, workerId: 'manual-export', executors: [createBatchRenderExecutor()], log: () => {} });
  assert.equal((await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} })).items[0].status, 'published');
  await assert.rejects(saveFormulaManualSpeech(db, 'p', batchId, correction), /冻结/);
  const { beginFormulaInputRevision } = await import('../lib/live-mixcut/formula/input-revision.ts');
  beginFormulaInputRevision(db, 'p', batchId, { expectedBatchVersionId: request.batchVersionId, expectedInputRevision: 3 });
  const corrected = await saveFormulaManualSpeech(db, 'p', batchId, { ...correction, expectedInputRevision: 4,
    segments: [{ text: '人工纠正后的台词。', startUs: 250_000, endUs: 1_750_000 }] });
  const second = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'corrected', settingsId: settings.saved!.id, expectedInputRevision: 5 });
  await runPendingOnce({ db, workerId: 'corrected', executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
  const revisedSpeech = readFormulaSpeech(db, 'p', batchId, second.outputs[0].planId).sources[0].result;
  assert.equal(revisedSpeech?.status === 'transcribed' && revisedSpeech.text, '人工纠正后的台词。');
  assert.equal(revisedSpeech?.manualVerification?.revisionId, corrected.items[0].saved?.id);
  assert.deepEqual(readFormulaSpeech(db, 'p', batchId, request.outputs[0].planId).sources[0].result, speech, '人工修订不改历史依据');
  beginFormulaInputRevision(db, 'p', batchId, { expectedBatchVersionId: second.batchVersionId, expectedInputRevision: 5 });
  await saveFormulaManualSpeech(db, 'p', batchId, { ...input, expectedInputRevision: 6, expectedSpeechRevision: 2,
    mode: 'automatic', segments: [], confirmed: false });
  const automatic = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'automatic', settingsId: settings.saved!.id, expectedInputRevision: 7 });
  await runPendingOnce({ db, workerId: 'automatic', executors: [createFormulaStageExecutor()], log: () => {} });
  assert.equal(readFormulaSpeech(db, 'p', batchId, automatic.outputs[0].planId).sources[0].result?.status, 'needs_attention',
    '撤回人工核对后不能继续复用旧人工台词，无服务时明确需处理');
  assert.equal(externalCalls, 0);
  const { analyzeFormulaSourceSpeech } = await import('../lib/live-mixcut/formula/source-speech.ts');
  const { listAssetSources } = await import('../lib/live-mixcut/media-catalog.ts');
  const roleBatch = createBatchProduction(db, 'p', '人工确认无声', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', roleBatch, { assetId, sourcePath: 'G1_环境音.mp4' });
  const roleSaved = await saveFormulaManualSpeech(db, 'p', roleBatch, { ...input,
    expectedInputRevision: 1, mode: 'no_speech', segments: [] });
  const noSpeech = await analyzeFormulaSourceSpeech(db, 'p', { assetId, contentFingerprint: input.contentFingerprint,
    sources: listAssetSources(db, assetId).map(item => ({ id: item.id, location: item.locationJson })), manualSpeech: roleSaved.items[0].saved },
  () => { throw new Error('人工确认不应读取识别服务'); }, new AbortController().signal);
  assert.equal(noSpeech.status, 'no_speech', '有音轨且人工确认无话语，不能谎称文件没有音轨');
  const silentFile = path.join(root, 'silent.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silentFile]);
  const silentAsset = await registerManagedCopy(db, 'p', { sourcePath: silentFile });
  registerFormulaAssetBinding(db, 'p', roleBatch, { assetId: silentAsset, sourcePath: 'G2_静音.mp4' });
  const silentView = readFormulaManualSpeech(db, 'p', roleBatch);
  await assert.rejects(saveFormulaManualSpeech(db, 'p', roleBatch, { ...input, assetId: silentAsset,
    contentFingerprint: silentView.items.find(item => item.assetId === silentAsset)!.contentFingerprint,
    expectedInputRevision: silentView.inputRevision, segments: [{ text: '不能伪造的原声', startUs: 0, endUs: 500_000 }] }), /没有可用音轨/);
  console.log('formula manual speech: 人工台词离线制作、字幕、时间校验、幂等保存、修订隔离与撤回通过');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
