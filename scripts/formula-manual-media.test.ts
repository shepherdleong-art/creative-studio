import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Public seam: import/generate → real workers/review/publish → formal download paths.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-media-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const originalFetch = globalThis.fetch;
const manualSpeechMedia = process.argv.includes('--speech');
let db = new Database(path.join(root, 'test.db'));
try {
  const { checkBatchProductionReadiness } = await import('../lib/batch-production/readiness.ts');
  const { checkFormulaReadiness } = await import('../lib/batch-production/formula/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding, getFormulaMaterialIndex } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/batch-production/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/batch-production/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/batch-production/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
  const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
  const { getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
  const { setBatchPlanReviews } = await import('../lib/batch-production/review.ts');
  const { orchestrateBatchExport } = await import('../lib/batch-production/export-orchestrator.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT 'PS866',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z',storeCode TEXT DEFAULT '',productSubmodel TEXT DEFAULT '',productionType TEXT DEFAULT '',editorName TEXT DEFAULT '',namingDate TEXT DEFAULT '20261023');
    INSERT INTO projects (id,name) VALUES ('p','原脚本号验收');`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  const formulaReady = await checkFormulaReadiness(options);
  assert.equal(formulaReady.available, true, JSON.stringify(formulaReady));
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'p', '乱序导出', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'VO1_口播.mp4' });
  const addedAssets: string[] = [];
  for (const [index, color] of ['red', 'blue'].entries()) {
    const file = path.join(root, `G${index + 1}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
    const id = await registerManagedCopy(db, 'p', { sourcePath: file }); addedAssets.push(id);
    registerFormulaAssetBinding(db, 'p', batchId, { assetId: id, sourcePath: `G${index + 1}_展示.mp4` });
  }
  let voiceReplacementId = '';
  if (manualSpeechMedia) {
    const voice = path.join(root, 'VO2.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=yellow:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', voice]);
    voiceReplacementId = await registerManagedCopy(db, 'p', { sourcePath: voice });
    registerFormulaAssetBinding(db, 'p', batchId, { assetId: voiceReplacementId, sourcePath: 'VO2_口播.mp4' });
  }
  const baseRevision = manualSpeechMedia ? 4 : 3;
  const originalFormula = 'VO1 G1 G2';
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 3, 5, originalFormula, '好擦洗。'],
    [141, '抖音', 3, 5, originalFormula, '好擦洗。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '两条.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: baseRevision });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: baseRevision, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'original', tts: null }; production.packaging = { mode: 'none', templateIds: [] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: baseRevision + 1, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }],
      bgm: { mode: 'none', trackIds: [] }, production } });
  const generation = { requestKey: 'identity', settingsId: settings.saved!.id, expectedInputRevision: baseRevision + 1 };
  const request = await createFormulaGenerationRequest(db, 'p', batchId, generation);
  globalThis.fetch = async () => Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 0.125, end: 0.875 }] });
  const { createFormulaExportPackage } = await import('../lib/batch-production/formula/export-package.ts');
  const renderer = createBatchRenderExecutor();
  const work = () => runPendingOnce({ db, workerId: 'package', executors: [createFormulaStageExecutor(), renderer] });
  await work();
  const { applyFormulaManualClipEdit } = await import('../lib/batch-production/formula/manual-clip-edit.ts');
  const planId = request.outputs[0].planId;
  const view = () => getBatchOutputArrangementView(db, 'p', batchId, planId);
  if (manualSpeechMedia) {
    const initial = view();
    const voiceAsset = getFormulaMaterialIndex(db, 'p', batchId).bindings.find(asset => asset.assetId === voiceReplacementId)!;
    const insertion = { type: 'insert' as const, afterClipId: initial.clips.at(-1)!.clipId, assetId: voiceAsset.assetId,
      requestKey: 'insert-spoken', expectedOutputVersionId: initial.outputVersionId!, expectedEditRevision: initial.editRevision,
      media: { contentFingerprint: voiceAsset.contentFingerprint, inUs: 250_000, outUs: 1_250_000, protected: null,
        sound: 'source' as const, confirmed: true, speechConfirmed: true,
        segments: [{ text: '坐得稳。', startUs: 375_000, endUs: 1_125_000 }] } };
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
      { ...insertion, media: { ...insertion.media, speechConfirmed: false } }), /试听|确认/);
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
      { ...insertion, media: { ...insertion.media, segments: [] } }), /台词/);
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
      { ...insertion, media: { ...insertion.media, segments: [{ text: '越界。', startUs: 125_000, endUs: 1_125_000 }] } }), /完整包含/);
    const silent = initial.poolAssets.find(asset => asset.assetId === addedAssets[0])!;
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId,
      { ...insertion, assetId: silent.assetId, media: { ...insertion.media, contentFingerprint: silent.contentFingerprint } }), /没有音轨/);
    assert.equal(view().editRevision, initial.editRevision);
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...insertion, afterClipId: 'missing-clip' }), /片段|插入/);
    assert.equal(view().editRevision, initial.editRevision, '保存片段失败时，原声核验记录与修订一并回滚');
    await applyFormulaManualClipEdit(db, 'p', batchId, planId, insertion);
    const inserted = view();
    const insertedClip = inserted.clips.at(-1)!;
    assert.equal(inserted.audioPlan!.clips.length, 2);
    const insertedSound = inserted.audioPlan!.clips.find(clip => clip.linkedVideoClipId === insertedClip.clipId)!;
    assert.equal(insertedSound.sourceInUs, 250_000);
    assert.equal(insertedSound.timelineStartUs, insertedClip.timelineStartUs);
    assert.equal(inserted.subtitleCues.at(-1)!.text, '坐得稳。');
    assert.equal(inserted.subtitleCues.at(-1)!.timingSource, 'manual', '人工核对的台词时间不能标成自动对齐');
    assert.equal(inserted.subtitleCues.at(-1)!.startUs, insertedClip.timelineStartUs + 125_000);
    await work();
    assert.equal(view().audioPlan!.issues.length, 0);
    const target = inserted.clips[0];
    const replacement = { ...insertion, type: 'replace' as const, clipId: target.clipId, requestKey: 'replace-spoken',
      expectedEditRevision: inserted.editRevision, media: { ...insertion.media, segments: [{ text: '好擦洗。', startUs: 375_000, endUs: 1_125_000 }] } };
    await applyFormulaManualClipEdit(db, 'p', batchId, planId, replacement);
    const replaced = view();
    assert(replaced.reviewContext!.issues.some(issue => issue.message.includes('人工核对原声') && issue.details?.some(detail => detail.includes('好擦洗'))));
    assert.equal(replaced.clips[0].assetId, voiceAsset.assetId);
    assert.equal(replaced.audioPlan!.clips[0].sourceInUs, 250_000);
    assert.notEqual(replaced.audioPlan!.clips[0].mediaId, initial.audioPlan!.clips[0].mediaId);
    assert.deepEqual(replaced.subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]).slice(0, 1), [['好擦洗。', 125_000, 875_000]]);
    const { applyBatchOutputClipEdit } = await import('../lib/batch-production/output-arrangement.ts');
    const restore = (snapshot: typeof initial) => applyBatchOutputClipEdit(db, 'p', batchId, planId, {
      type: 'restore_arrangement', expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision,
      snapshot: { ...snapshot, musicTrackId: snapshot.music.trackId, musicGainDb: snapshot.music.gainDb,
        musicFadeInSec: snapshot.music.fadeInSec, musicFadeOutSec: snapshot.music.fadeOutSec } });
    restore(inserted);
    assert.equal(view().audioPlan!.clips[0].mediaId, initial.audioPlan!.clips[0].mediaId);
    restore(replaced);
    assert.equal(view().audioPlan!.clips[0].mediaId, replaced.audioPlan!.clips[0].mediaId);
    const revisionBeforeReplay = view().editRevision;
    await applyFormulaManualClipEdit(db, 'p', batchId, planId, replacement);
    assert.equal(view().editRevision, revisionBeforeReplay);
    const edit = (command: Parameters<typeof applyBatchOutputClipEdit>[4]) => applyBatchOutputClipEdit(db, 'p', batchId, planId,
      { ...command, expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision });
    edit({ type: 'split', clipId: replaced.clips[0].clipId, offsetUs: 500_000 });
    assert.equal(view().audioPlan!.issues.length, 0, '连续分割原声仍是一句完整话语');
    assert.equal(view().subtitleCues[0].text, '好擦洗。');
    const splitView = view();
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement,
      requestKey: 'half-sentence', expectedEditRevision: splitView.editRevision,
      media: { ...replacement.media, outUs: 750_000, segments: [{ text: '半句', startUs: 375_000, endUs: 625_000 }] } }), /半句话/);
    edit({ type: 'delete', clipId: splitView.clips[1].clipId });
    assert(view().audioPlan!.issues.some(issue => issue.code === 'speech_incomplete'));
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'not_ready');
    restore(replaced);
    edit({ type: 'set_subtitle_cue_text', cueId: view().subtitleCues[0].id, text: '旧字幕待替换' });
    edit({ type: 'set_subtitle_cue_text', cueId: view().subtitleCues.at(-1)!.id, text: '坐得稳！' });
    await applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement,
      requestKey: 'replace-again', expectedEditRevision: view().editRevision,
      media: { ...replacement.media, inUs: 500_000, outUs: 1_500_000,
        segments: [{ text: '方便清洁。', startUs: 625_000, endUs: 1_375_000 }] } });
    assert.deepEqual(view().subtitleCues.map(cue => cue.text), ['方便清洁。', '坐得稳！'], '新原声换掉旧字幕，并保留无关人工字幕');
    assert.equal(view().audioPlan!.issues.length, 0, '再次换片仍保留对原始必需话语的人工覆盖依据');
    assert.throws(() => restore({ ...view(), audioPlan: { ...view().audioPlan!, clips: initial.audioPlan!.clips } }), /声音|原声|撤销/);
    restore(replaced);
    await work();
    const card = getBatchWorkspace(db, 'p', batchId).cards.find(item => item.planId === planId)!;
    assert.equal(card.productionReady, true, JSON.stringify(card.blockers));
    const { resolveFormulaPreviewMedia } = await import('../lib/batch-production/formula/preview.ts');
    const soundUrl = new URL(view().formulaPreview!.audioTimeline.clips[0].url, 'http://localhost');
    const q = soundUrl.searchParams;
    assert(fs.existsSync((await resolveFormulaPreviewMedia(db, 'p', batchId, planId, q.get('selectionStageId')!, q.get('timelineStageId')!,
      'audio', q.get('mediaId')!, new AbortController().signal, { outputVersionId: q.get('outputVersionId')!, sourceFingerprint: '' })).absolutePath));
    const beforeRestart = view(); db.close(); db = new Database(path.join(root, 'test.db')); db.pragma('foreign_keys=ON');
    assert.deepEqual(view().audioPlan, beforeRestart.audioPlan);
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'saved');
    await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} }); await work();
    assert.equal((await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} })).items[0].status, 'published');
    const formal = getBatchWorkspace(db, 'p', batchId).cards.find(item => item.planId === planId)!.currentFormalArtifact!;
    const pcm = path.join(root, 'new-voice.f32');
    await runFfmpeg(['-i', path.join(root, 'storage', formal.video.relativePath), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-y', pcm]);
    const samples = fs.readFileSync(pcm);
    const frequency = (start: number, end: number) => {
      let crossings = 0;
      for (let i = Math.ceil(start * 48000) + 1; i < Math.floor(end * 48000); i++) {
        if (samples.readFloatLE((i - 1) * 4) <= 0 && samples.readFloatLE(i * 4) > 0) crossings++;
      }
      return crossings / (end - start);
    };
    const intro = 20 / 24;
    const replacementHz = frequency(intro + 0.2, intro + 0.7);
    const insertionStart = view().clips.at(-1)!.timelineStartUs / 1e6 + intro;
    const insertionHz = frequency(insertionStart + 0.2, insertionStart + 0.7);
    assert(replacementHz > 850 && replacementHz < 910, `换片必须听到新素材 880Hz，不能沿用旧素材 660Hz：${replacementHz}`);
    assert(insertionHz > 850 && insertionHz < 910, `插入原声必须进入正式音轨：${insertionHz}`);
    const saved = await createFormulaExportPackage(db, 'p', batchId, { requestKey: 'spoken-package', items: [{ planId,
      videoArtifactId: formal.video.id, coverArtifactId: formal.cover!.id }] });
    assert.equal(saved.manifest.items[0].clips[0].manualMedia?.sound, 'source');
    assert(saved.manifest.items[0].audio.sources.some(source => source.mediaId === replaced.audioPlan!.clips[0].mediaId));
    assert(!saved.manifest.items[0].audio.sources.some(source => source.mediaId === initial.audioPlan!.clips[0].mediaId), '正式声音来源列表不能混入已换掉的旧原声');
    fs.mkdirSync('outputs/formula-manual-media-speech', { recursive: true });
    fs.writeFileSync('outputs/formula-manual-media-speech/manifest.json', JSON.stringify(saved.manifest, null, 2));
    fs.writeFileSync('outputs/formula-manual-media-speech/summary.json', JSON.stringify({ status: 'passed', replaceVoice: true, insertVoice: true,
      subtitles: true, undoRedo: true, restartRestored: true, realPublish: true, replacementHz, insertionHz }, null, 2));
    console.log('manual speech media: insertion, replacement, linked sound/subtitles, undo, restart and real publish passed');
  } else {
  const before = view();
  const target = before.clips.find(clip => clip.assetId === addedAssets[0])!;
  const replacement = { type: 'replace' as const, clipId: target.clipId, assetId: addedAssets[1],
    expectedOutputVersionId: before.outputVersionId!, expectedEditRevision: before.editRevision,
    requestKey: 'replace-verified', media: { contentFingerprint: before.clips.find(clip => clip.assetId === addedAssets[1])!.contentFingerprint,
      inUs: 250_000, outUs: 250_000 + target.sourceEndUs - target.sourceStartUs, protected: { inUs: 750_000, outUs: 1_000_000 },
      sound: 'mute' as const, segments: [], confirmed: true } };
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, replacement);
  assert.equal(view().clips.find(clip => clip.clipId === target.clipId)!.assetId, addedAssets[1]);
  assert.equal(view().clips.find(clip => clip.clipId === target.clipId)!.sourceStartUs, 250_000, '不能默默从新片开头取用');
  assert(view().reviewContext!.issues.some(issue => issue.message.includes('人工选定区间') && issue.message.includes('新素材原声静音')));
  assert(!view().reviewContext!.issues.some(issue => issue.message.includes('镜头 2（G1）使用系统安排')));
  await work();
  const checkedCard = getBatchWorkspace(db, 'p', batchId).cards.find(card => card.planId === planId)!;
  assert.equal(checkedCard.productionReady, true, `核验后的人工换片应能通过实际制作检查：${JSON.stringify(checkedCard.blockers)}`);
  assert.equal(checkedCard.approvable, true);
  const after = view();
  const repeated = await applyFormulaManualClipEdit(db, 'p', batchId, planId, replacement);
  assert('replayed' in repeated && repeated.replayed === true, '返回已保存标记，界面才能在回复丢失后恢复同一次撤销记录');
  assert.equal(view().editRevision, after.editRevision, '回复丢失后重试不能再次换片或推进修订');
  const { applyBatchOutputClipEdit } = await import('../lib/batch-production/output-arrangement.ts');
  const restore = (snapshot: ReturnType<typeof view>) => applyBatchOutputClipEdit(db, 'p', batchId, planId, {
    type: 'restore_arrangement', expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision,
    snapshot: { ...snapshot, musicTrackId: snapshot.music.trackId, musicGainDb: snapshot.music.gainDb,
      musicFadeInSec: snapshot.music.fadeInSec, musicFadeOutSec: snapshot.music.fadeOutSec } });
  restore(before);
  assert.equal(view().clips.find(clip => clip.clipId === target.clipId)!.formulaSourceId, undefined);
  restore(after);
  assert.ok(view().clips.find(clip => clip.clipId === target.clipId)!.formulaSourceId);
  const { resolveFormulaPreviewMedia } = await import('../lib/batch-production/formula/preview.ts');
  const previewUrl = new URL(view().formulaPreview!.assetsById[addedAssets[1]].originalUrl, 'http://localhost');
  const q = previewUrl.searchParams;
  const preview = () => resolveFormulaPreviewMedia(db, 'p', batchId, planId, q.get('selectionStageId')!, q.get('timelineStageId')!,
    'video', q.get('mediaId')!, new AbortController().signal, { outputVersionId: q.get('outputVersionId')!, sourceFingerprint: '' });
  assert.ok(fs.existsSync((await preview()).absolutePath));
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement, media: { ...replacement.media, confirmed: false } }), /确认|检查/);
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement, media: { ...replacement.media, inUs: 0 } }), /同一次/);
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement, requestKey: 'stale' }), /已被修改/);
  const voice = view().clips.find(clip => clip.assetId === assetId)!;
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement, requestKey: 'mute-voice',
    clipId: voice.clipId, expectedEditRevision: view().editRevision }), /原声|台词/);
  const afterDenied = view();
  assert.throws(() => applyBatchOutputClipEdit(db, 'p', batchId, planId, { type: 'trim', clipId: target.clipId, sourceStartUs: 0,
    sourceEndUs: target.sourceEndUs - target.sourceStartUs, expectedEditRevision: view().editRevision, expectedOutputVersionId: view().outputVersionId! }), /核验/);
  assert.equal(view().editRevision, afterDenied.editRevision, '非法取用区间不能部分保存');
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement, requestKey: 'not-on-frame',
    expectedEditRevision: view().editRevision, media: { ...replacement.media, inUs: 250_001, outUs: replacement.media.outUs + 1 } }), /帧边界/);
  const protectedSnapshot = view();
  applyBatchOutputClipEdit(db, 'p', batchId, planId, { type: 'split', clipId: target.clipId, offsetUs: 666_667,
    expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision });
  await work();
  assert.equal(getBatchWorkspace(db, 'p', batchId).cards.find(card => card.planId === planId)!.productionReady, true,
    '完整连续分割可以跨过保护动作，不能误报截断');
  restore(protectedSnapshot);
  applyBatchOutputClipEdit(db, 'p', batchId, planId, { type: 'trim_variable', clipId: target.clipId,
    sourceStartUs: 1_041_667, sourceEndUs: replacement.media.outUs, expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision });
  await work();
  const protectedFailure = getBatchWorkspace(db, 'p', batchId).cards.find(card => card.planId === planId)!;
  assert.equal(protectedFailure.productionReady, false);
  assert.match(protectedFailure.executionTask?.errorMessage ?? '', /保护动作/);
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] }).results[0].status, 'not_ready');
  restore(protectedSnapshot);
  const siblingId = request.outputs[1].planId;
  const sibling = getBatchOutputArrangementView(db, 'p', batchId, siblingId);
  assert.throws(() => applyBatchOutputClipEdit(db, 'p', batchId, siblingId, { type: 'restore_arrangement',
    expectedOutputVersionId: sibling.outputVersionId!, expectedEditRevision: sibling.editRevision,
    snapshot: { ...sibling, clips: view().clips } }), /不属于这份成片/);
  const proofId = view().clips.find(clip => clip.clipId === target.clipId)!.formulaSourceId!;
  assert.throws(() => db.prepare('UPDATE batch_formula_manual_media SET proofJson=? WHERE id=?').run('{}', proofId), /immutable/);
  const audioBeforeInsert = view().audioPlan;
  const insert = { type: 'insert' as const, assetId, afterClipId: view().clips.at(-1)!.clipId,
    expectedOutputVersionId: view().outputVersionId!, expectedEditRevision: view().editRevision, requestKey: 'insert-with-muted-audio',
    media: { contentFingerprint: voice.contentFingerprint, inUs: 250_000, outUs: 750_000, protected: null,
      sound: 'mute' as const, segments: [], confirmed: true } };
  await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...insert, afterClipId: 'missing' }), /不存在/);
  assert.equal(view().editRevision, insert.expectedEditRevision);
  await applyFormulaManualClipEdit(db, 'p', batchId, planId, insert);
  assert.equal(view().clips.at(-1)!.sourceStartUs, 250_000);
  assert.equal(view().clips.at(-1)!.sourceEndUs, 750_000);
  assert.deepEqual(view().audioPlan!.clips, audioBeforeInsert!.clips, '插入明确静音的有声视频不能多播原声或挪动已有声音');
  const savedBeforeRestart = view();
  db.close(); db = new Database(path.join(root, 'test.db')); db.pragma('foreign_keys=ON');
  assert.equal((await checkFormulaReadiness({ ...options, db })).available, true);
  assert.deepEqual(view().clips, savedBeforeRestart.clips);
  await work();
  const approved = setBatchPlanReviews(db, 'p', batchId, { decision: 'approved', items: [{ planId, ...view().reviewContext! }] });
  assert.equal(approved.results[0].status, 'saved');
  await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} });
  await work();
  assert.equal((await orchestrateBatchExport(db, 'p', batchId, [planId], { wakeScheduler: () => {} })).items[0].status, 'published');
  const formal = getBatchWorkspace(db, 'p', batchId).cards.find(card => card.planId === planId)!.currentFormalArtifact!;
  const pcm = path.join(root, 'formal-audio.f32');
  await runFfmpeg(['-i', path.join(root, 'storage', formal.video.relativePath), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-y', pcm]);
  const samples = fs.readFileSync(pcm);
  const rms = (startSec: number, endSec: number) => {
    let energy = 0, count = 0;
    for (let i = Math.ceil(startSec * 48000); i < Math.floor(endSec * 48000) && i * 4 + 4 <= samples.length; i++) {
      energy += samples.readFloatLE(i * 4) ** 2; count++;
    }
    assert(count > 0); return Math.sqrt(energy / count);
  };
  const introSec = 20 / 24;
  const originalRms = rms(introSec + 0.2, introSec + 0.7);
  const insertedStartSec = view().clips.at(-1)!.timelineStartUs / 1_000_000 + introSec;
  const mutedRms = rms(insertedStartSec + 0.125, insertedStartSec + 0.375);
  assert(originalRms > 0.01, '正式视频仍保留原来的实际原声');
  assert(mutedRms < 0.001, '明确静音的插入素材不能在正式视频里漏出原声');
  const saved = await createFormulaExportPackage(db, 'p', batchId, { requestKey: 'manual-media', items: [{ planId,
    videoArtifactId: formal.video.id, coverArtifactId: formal.cover!.id }] });
  const recorded = saved.manifest.items[0].clips.find(clip => clip.clipId === target.clipId)!;
  assert.equal(recorded.manualMedia?.sound, 'mute');
  assert.equal(recorded.manualMedia?.inUs, 250_000);
  assert.deepEqual(recorded.manualMedia?.protected, { inUs: 750_000, outUs: 1_000_000 });
  assert.equal(saved.manifest.items[0].clips.at(-1)!.manualMedia?.outUs, 750_000);
  assert(!JSON.stringify(saved.manifest).includes(root), '清单不能暴露本机目录');
  fs.mkdirSync(path.resolve('outputs/formula-manual-media'), { recursive: true });
  fs.writeFileSync(path.resolve('outputs/formula-manual-media/manifest.json'), JSON.stringify(saved.manifest, null, 2));
  const file = (await preview()).absolutePath;
  const originalBytes = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, 'broken');
    await assert.rejects(preview, /变化|核验/);
    const revisionBefore = view().editRevision;
    await assert.rejects(() => applyFormulaManualClipEdit(db, 'p', batchId, planId, { ...replacement,
      requestKey: 'changed-file', expectedEditRevision: revisionBefore }), /变化|读取/);
    assert.equal(view().editRevision, revisionBefore);
  } finally { fs.writeFileSync(file, originalBytes); }
  fs.writeFileSync(path.resolve('outputs/formula-manual-media/summary.json'), JSON.stringify({ status: 'passed',
    nonzeroSourceOffset: true, insertMuted: true, undoRedo: true, restartRestored: true,
    protectedActionBlocked: true, changedMediaBlocked: true, originalRms, mutedRms }, null, 2));
  console.log('formula manual media: verified replacement → production check → review → real render/publish passed');
  }
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  (await import('../lib/db.ts')).closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
