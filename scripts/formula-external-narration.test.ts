import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-external-narration-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
let db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { checkBatchProductionReadiness } = await import('../lib/batch-production/readiness.ts');
  const { checkFormulaReadiness } = await import('../lib/batch-production/formula/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/batch-production/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/batch-production/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/batch-production/batch-render-executor.ts');
  const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
  const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
  const { getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { readFormulaExternalNarrations, saveFormulaExternalNarration } = await import('../lib/batch-production/formula/external-narration.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'PS866',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','外部配音'),('foreign','其他项目');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.equal((await checkFormulaReadiness(options)).available, true);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  const batchId = createBatchProduction(db, 'p', '外部声音两份', undefined, { planningMode: 'formula' });
  const video = path.join(root, 'source.mp4'), voice = path.join(root, 'voice.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', voice]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: video });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'G1_静物.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 16, 'G1', '坐得稳。靠背舒服。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const input = { scriptKey: '1:2', scriptsSessionId: imported.id, expectedInputRevision: 2, expectedNarrationRevision: 0,
    confirmed: true, filename: '我的配音.wav', bytes: fs.readFileSync(voice),
    srt: '1\n00:00:00,125 --> 00:00:00,875\n坐得稳。\n\n2\n00:00:01,125 --> 00:00:01,875\n靠背舒服。\n' };
  await assert.rejects(() => saveFormulaExternalNarration(db, 'p', batchId, { ...input, confirmed: false }), /试听|确认/);
  await assert.rejects(() => saveFormulaExternalNarration(db, 'p', batchId, { ...input, srt: input.srt.replace('坐得稳', '好擦洗') }), /文案|文字/);
  await assert.rejects(() => saveFormulaExternalNarration(db, 'p', batchId, { ...input, srt: input.srt.replace('01,875', '02,875') }), /时间|音频/);
  await assert.rejects(() => saveFormulaExternalNarration(db, 'foreign', batchId, input), /不存在|不属于/);
  const saved = await saveFormulaExternalNarration(db, 'p', batchId, input);
  assert.equal(saved.inputRevision, 3);
  assert.equal(saved.items[0].saved?.audio?.channels, 2, '外部立体声保留左右声道');
  assert.equal(saved.items[0].saved?.audio?.timingSource, 'manual', 'SRT 是人工确认时间，不能冒充服务对齐');
  assert.deepEqual(await saveFormulaExternalNarration(db, 'p', batchId, input), saved, '丢回复重试不重复保存或推进修订');
  assert.equal(readFormulaExternalNarrations(db, 'p', batchId).items[0].saved?.text, '坐得稳。靠背舒服。');
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'narration', tts: null };
  production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'external', settingsId: settings.saved!.id, expectedInputRevision: 3 });
  assert.equal(request.input.ttsService, null);
  assert.equal(request.input.externalNarrations?.length, 1);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('外部配音无需语音供应商'); };
  await runPendingOnce({ db, workerId: 'external-narration', concurrency: 2,
    executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
  assert(getBatchWorkspace(db, 'p', batchId).cards.every(card => card.approvable), '没有 TTS 服务也能用实际外部声音完成两份成片');
  assert.equal(calls, 0);
  for (const output of request.outputs) {
    const view = getBatchOutputArrangementView(db, 'p', batchId, output.planId);
    assert.equal(view.audioPlan?.clips.length, 1);
    assert.equal(view.audioPlan?.clips[0].kind, 'narration');
    assert.equal(view.audioPlan?.clips[0].sourceOutUs, 2_000_000);
    assert.deepEqual(view.subtitleCues.map(cue => ({ text: cue.text, startUs: cue.startUs, endUs: cue.endUs, timingSource: cue.timingSource })), [
      { text: '坐得稳。', startUs: 125_000, endUs: 875_000, timingSource: 'manual' },
      { text: '靠背舒服。', startUs: 1_125_000, endUs: 1_875_000, timingSource: 'manual' },
    ]);
  }
  db.close(); db = new Database(path.join(root, 'test.db')); db.pragma('foreign_keys=ON');
  assert.equal((await checkFormulaReadiness({ ...options, db })).available, true);
  const { setBatchPlanReviews } = await import('../lib/batch-production/review.ts');
  const { orchestrateBatchExport } = await import('../lib/batch-production/export-orchestrator.ts');
  const { createFormulaExportPackage } = await import('../lib/batch-production/formula/export-package.ts');
  const { resolveFormulaNarrationMedia, readFormulaNarration } = await import('../lib/batch-production/formula/narration-store.ts');
  const planId = request.outputs[0].planId, current = getBatchOutputArrangementView(db, 'p', batchId, planId);
  assert(current.reviewContext?.issues.some(issue => issue.message.includes('外部配音')));
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...current.reviewContext! }] }).results[0].status, 'saved');
  await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} });
  await runPendingOnce({ db, workerId: 'external-publish', executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
  assert.equal((await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} })).items[0].status, 'published');
  const formal = getBatchWorkspace(db, 'p', batchId).cards[0].currentFormalArtifact!;
  const exported = await createFormulaExportPackage(db, 'p', batchId, { requestKey: 'external-package', items: [{ planId,
    videoArtifactId: formal.video.id, coverArtifactId: formal.cover!.id }] });
  assert.equal(exported.manifest.items[0].subtitles[0].timingSource, 'manual');
  assert.equal(exported.manifest.items[0].externalNarrations[0].channels, 2);
  assert.equal(exported.manifest.items[0].externalNarrations[0].timing, 'manually_confirmed_srt');
  assert(JSON.stringify(exported.manifest).includes(saved.items[0].saved!.id), '正式包保留实际导入声音的核验身份');
  const narration = readFormulaNarration(db, 'p', batchId, planId), sound = narration.result!.items[0];
  const media = resolveFormulaNarrationMedia(db, 'p', batchId, planId, narration.selectionStageId, sound.id);
  const original = fs.readFileSync(media.absolutePath), corrupt = Buffer.from(original); corrupt[corrupt.length - 2] ^= 1;
  fs.writeFileSync(media.absolutePath, corrupt);
  assert.throws(() => resolveFormulaNarrationMedia(db, 'p', batchId, planId, narration.selectionStageId, sound.id), /已变化|缺失/);
  fs.writeFileSync(media.absolutePath, original);
  const { beginFormulaInputRevision } = await import('../lib/batch-production/formula/input-revision.ts');
  beginFormulaInputRevision(db, 'p', batchId, { expectedBatchVersionId: request.batchVersionId, expectedInputRevision: 3 });
  const removal = { scriptKey: input.scriptKey, scriptsSessionId: imported.id, expectedInputRevision: 4,
    expectedNarrationRevision: 1, confirmed: true, remove: true };
  const removed = await saveFormulaExternalNarration(db, 'p', batchId, removal);
  assert.equal(removed.inputRevision, 5); assert.equal(removed.items[0].saved?.audio, null);
  assert.deepEqual(await saveFormulaExternalNarration(db, 'p', batchId, removal), removed);
  assert.deepEqual(fs.readFileSync(resolveFormulaNarrationMedia(db, 'p', batchId, planId, narration.selectionStageId, sound.id).absolutePath), original,
    '修改输入后移除外部配音不删除旧生成使用的声音');
  const evidence = path.resolve('outputs/formula-external-narration'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'manifest.json'), JSON.stringify(exported.manifest, null, 2));
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ status: 'passed', externalVoiceId: saved.items[0].saved!.id,
    channels: 2, durationUs: 2_000_000, providerCalls: calls, outputs: 2, formalExport: true, restart: true, corruptionRejected: true }, null, 2));
  console.log('formula external narration: paired import, validation, stereo, replay, provider-free production, restart and formal export passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  (await import('../lib/db.ts')).closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
