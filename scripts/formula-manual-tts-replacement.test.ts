import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: generate with real media + fixed external responses, edit, review and publish.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-tts-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const originalFetch = globalThis.fetch;
let db = new Database(path.join(root, 'test.db'));
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
  const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
  const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/batch-production/output-arrangement.ts');
  const { applyFormulaManualClipEdit } = await import('../lib/batch-production/formula/manual-clip-edit.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'PS866',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','原声替代配音');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','fixture',NULL,'qwen3-tts-flash',1);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.equal((await checkFormulaReadiness(options)).available, true);
  const silent = path.join(root, 'G1.mp4'), voice = path.join(root, '新口播.mp4'), audio = path.join(root, 'tts.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silent]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=yellow:s=64x64:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', voice]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', audio]);
  const batchId = createBatchProduction(db, 'p', '原声替代配音', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: silent });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'G1_展示.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 16, 'G1', '坐得稳。靠背舒服。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'narration', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] }, production } });
  globalThis.fetch = async url => String(url).endsWith('/audio/speech')
    ? Response.json({ output: { audio: { data: fs.readFileSync(audio).toString('base64') } } })
    : Response.json({ words: [{ word: '坐得稳。', start: 0.1, end: 0.4 }, { word: '靠背舒服。', start: 0.6, end: 0.9 }] });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'tts', settingsId: settings.saved!.id, expectedInputRevision: 2 });
  const work = () => runPendingOnce({ db, workerId: 'manual-tts', executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
  await work();
  const planId = request.outputs[0].planId;
  const view = () => getBatchOutputArrangementView(db, 'p', batchId, planId);
  const voiceId = await registerManagedCopy(db, 'p', { sourcePath: voice });
  const initial = view(), candidate = initial.poolAssets.find(item => item.assetId === voiceId)!;
  assert.equal(initial.audioPlan!.clips[0].kind, 'narration');
  const oldSound = initial.audioPlan!.clips[0];
  assert.equal(initial.clips[0].sourceEndUs - initial.clips[0].sourceStartUs, 2_000_000);
  const replacement = { type: 'replace' as const, clipId: initial.clips[0].clipId, assetId: voiceId, requestKey: 'replace-tts',
    expectedOutputVersionId: initial.outputVersionId!, expectedEditRevision: initial.editRevision,
    media: { contentFingerprint: candidate.contentFingerprint, inUs: 250_000, outUs: 2_250_000, protected: null,
      sound: 'source' as const, confirmed: true, speechConfirmed: true, replaceNarrationClipIds: [oldSound.id],
      segments: [{ text: '坐得稳。', startUs: 375_000, endUs: 1_125_000 }, { text: '靠背舒服。', startUs: 1_375_000, endUs: 2_125_000 }] } };
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
    { ...replacement, media: { ...replacement.media, replaceNarrationClipIds: [] } }), /重叠/);
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
    { ...replacement, media: { ...replacement.media, replaceNarrationClipIds: ['foreign-clip'] } }), /配音/);
  assert.equal(view().editRevision, initial.editRevision, '替换失败不得保存半份记录或推进修订');
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, replacement);
  const replaced = view();
  assert.equal(replaced.audioPlan!.clips.length, 1);
  assert.equal(replaced.audioPlan!.clips[0].kind, 'source');
  assert.deepEqual(replaced.audioPlan!.issues, []);
  assert.deepEqual(replaced.subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs, cue.timingSource]),
    [['坐得稳。', 125_000, 875_000, 'manual'], ['靠背舒服。', 1_125_000, 1_875_000, 'manual']]);
  assert.equal(getBatchOutputArrangementView(db, 'p', batchId, request.outputs[1].planId).audioPlan!.clips[0].kind, 'narration');
  const edit = (change: Parameters<typeof applyBatchOutputClipEdit>[4]) => applyBatchOutputClipEdit(db, 'p', batchId, planId,
    { ...change, expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision });
  const restore = (snapshot: typeof initial) => edit({ type: 'restore_arrangement', snapshot: { ...snapshot,
    musicTrackId: snapshot.music.trackId, musicGainDb: snapshot.music.gainDb, musicFadeInSec: snapshot.music.fadeInSec, musicFadeOutSec: snapshot.music.fadeOutSec } });
  restore(initial); assert.deepEqual(view().audioPlan!.clips, initial.audioPlan!.clips);
  restore(replaced); assert.deepEqual(view().audioPlan!.clips, replaced.audioPlan!.clips);
  const replayRevision = view().editRevision;
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, replacement);
  assert.equal(view().editRevision, replayRevision);
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
    { ...replacement, media: { ...replacement.media, replaceNarrationClipIds: [] } }), /同一次/);
  edit({ type: 'split', clipId: replaced.clips[0].clipId, offsetUs: 1_000_000 });
  assert.deepEqual(view().audioPlan!.issues, []);
  const split = view();
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement,
    requestKey: 'replace-first-half-again', expectedEditRevision: split.editRevision,
    media: { ...replacement.media, replaceNarrationClipIds: [], outUs: 1_250_000, segments: [replacement.media.segments[0]] } });
  assert.deepEqual(view().audioPlan!.issues, [], '分割后再次换片，剩余原声和新片共同保留原配音的覆盖依据');
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement, clipId: split.clips[1].clipId,
    requestKey: 'replace-second-half-again', expectedEditRevision: view().editRevision,
    media: { ...replacement.media, replaceNarrationClipIds: [], inUs: 1_250_000, segments: [replacement.media.segments[1]] } });
  assert.deepEqual(view().audioPlan!.issues, [], '两半都换成新片后，仍共同覆盖原来整段配音');
  edit({ type: 'delete', clipId: split.clips[1].clipId });
  assert(view().audioPlan!.issues.some(issue => issue.mediaId === oldSound.mediaId && issue.code === 'speech_incomplete'),
    '删掉另一半后，不得仅凭一小段新口播继续豁免整段原配音');
  restore(initial);
  edit({ type: 'split', clipId: initial.clips[0].clipId, offsetUs: 500_000 });
  edit({ type: 'split_audio_clip', track: 'narration', clipId: oldSound.id, atUs: 500_000 });
  const divided = view(), firstNarration = divided.audioPlan!.clips[0], secondNarration = divided.audioPlan!.clips[1];
  const partial = { ...replacement, requestKey: 'replace-one-tts-sentence', expectedEditRevision: divided.editRevision,
    media: { ...replacement.media, outUs: 750_000, replaceNarrationClipIds: [firstNarration.id],
      segments: [{ text: '坐得稳。', startUs: 375_000, endUs: 625_000 }] } };
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
    { ...partial, media: { ...partial.media, replaceNarrationClipIds: [secondNarration.id] } }), /完整覆盖/);
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, partial);
  assert.deepEqual(view().audioPlan!.clips.map(clip => clip.kind), ['source', 'narration']);
  assert.deepEqual(view().audioPlan!.clips[1], secondNarration, '没有选择替代的配音保留原来源、区间和位置');
  assert.deepEqual(view().audioPlan!.issues, []);
  restore(replaced);
  assert.throws(() => restore({ ...replaced, audioPlan: { ...replaced.audioPlan!, clips: [...replaced.audioPlan!.clips, ...initial.audioPlan!.clips] } }), /声音|配音|重叠/);
  await work();
  const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
  assert.equal(getBatchWorkspace(db, 'p', batchId).cards[0].productionReady, true, JSON.stringify(getBatchWorkspace(db, 'p', batchId).cards[0].blockers));
  const beforeRestart = view(); db.close(); db = new Database(path.join(root, 'test.db')); db.pragma('foreign_keys=ON');
  assert.deepEqual(view().audioPlan, beforeRestart.audioPlan);
  assert(view().reviewContext!.issues.some(issue => issue.details?.some(text => text.includes('替代配音：坐得稳。靠背舒服。'))), '审核必须展示被新原声替代的配音实际内容');
  const { setBatchPlanReviews } = await import('../lib/batch-production/review.ts');
  const { orchestrateBatchExport } = await import('../lib/batch-production/export-orchestrator.ts');
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'saved');
  await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} }); await work();
  assert.equal((await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} })).items[0].status, 'published');
  const formal = getBatchWorkspace(db, 'p', batchId).cards[0].currentFormalArtifact!;
  const pcm = path.join(root, 'published.f32');
  await runFfmpeg(['-i', path.join(root, 'storage', formal.video.relativePath), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-y', pcm]);
  const samples = fs.readFileSync(pcm), start = 20 / 24 + 0.2, end = start + 0.5;
  let crossings = 0;
  for (let i = Math.ceil(start * 48000) + 1; i < Math.floor(end * 48000); i++) {
    if (samples.readFloatLE((i - 1) * 4) <= 0 && samples.readFloatLE(i * 4) > 0) crossings++;
  }
  const frequency = crossings / (end - start);
  assert(frequency > 850 && frequency < 910, `正式视频须使用新原声 880Hz：${frequency}`);
  const amplitude = (hz: number) => {
    let real = 0, imaginary = 0, count = 0;
    for (let i = Math.ceil(start * 48000); i < Math.floor(end * 48000); i++) {
      const sample = samples.readFloatLE(i * 4), angle = 2 * Math.PI * hz * i / 48000;
      real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle); count++;
    }
    return 2 * Math.hypot(real, imaginary) / count;
  };
  const originalTtsRatio = amplitude(440) / amplitude(880);
  assert(originalTtsRatio < 0.01, `旧 440Hz 配音不能混入新原声：${originalTtsRatio}`);
  const { createFormulaExportPackage } = await import('../lib/batch-production/formula/export-package.ts');
  const saved = await createFormulaExportPackage(db, 'p', batchId, { requestKey: 'replaced-tts-package', items: [{ planId,
    videoArtifactId: formal.video.id, coverArtifactId: formal.cover!.id }] });
  assert(!saved.manifest.items[0].audio.sources.some(source => source.mediaId === oldSound.mediaId));
  assert.equal(saved.manifest.items[0].clips[0].manualMedia?.replaces?.[0].narration?.text, '坐得稳。靠背舒服。');
  fs.mkdirSync('outputs/formula-manual-tts-replacement', { recursive: true });
  fs.writeFileSync('outputs/formula-manual-tts-replacement/manifest.json', JSON.stringify(saved.manifest, null, 2));
  fs.writeFileSync('outputs/formula-manual-tts-replacement/summary.json', JSON.stringify({ status: 'passed', explicitCoverage: true,
    undoRedo: true, splitThenReplace: true, incompleteRejected: true, unselectedNarrationPreserved: true,
    restartRestored: true, realPublish: true, frequency, originalTtsRatio }, null, 2));
  console.log('manual TTS replacement: explicit coverage, linked subtitles, undo, split/replace, incomplete guard and real publish passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
