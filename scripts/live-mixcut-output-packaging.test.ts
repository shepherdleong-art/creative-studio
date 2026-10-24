import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
/** A23/A35: saved generation settings must reach each editable output, using its actual audio timings. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-output-packaging-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { defaultTextStyle } = await import('../lib/media-core/cover-domain.ts');
  const { OUTPUT_PRESETS } = await import('../lib/media-core/cover-types.ts');
  const { runFfmpeg, resolveFfprobePath } = await import('../lib/ffmpeg.ts');
  const { readFormulaTimeline } = await import('../lib/live-mixcut/formula/timeline-store.ts');
  const { materializeFormulaOutput } = await import('../lib/live-mixcut/formula/output-store.ts');
  const { initialFormulaPresentation } = await import('../lib/live-mixcut/formula/output-presentation.ts');
  const { PACKAGING_TEMPLATE_IDS } = await import('../lib/media-core/packaging-vars.ts');
  const { setBatchPlanReviews, readBatchPlanReview } = await import('../lib/live-mixcut/review.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,productName TEXT,sellingPointsJson TEXT,productCode TEXT);
    INSERT INTO projects VALUES ('p','包装验收','实拍椅','[{"title":"轻松擦洗"}]','TEST');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','fixture',NULL,'qwen3-tts-flash',1);
    CREATE TABLE final_edit_title_presets (id TEXT PRIMARY KEY,name TEXT,stylesByPresetJson TEXT);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  db.prepare('UPDATE live_mixcut_projects SET productName=? WHERE id=?').run('实拍椅', 'p');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  const preset = { version: 2, stylesByPreset: Object.fromEntries(Object.entries(OUTPUT_PRESETS).map(([id, dimensions]) => [id, {
    primary: { ...defaultTextStyle('coverPrimary', dimensions.width), color: '#123456' },
    secondary: defaultTextStyle('coverSecondary', dimensions.width), framing: { scale: 1.4, offsetX: 0.2, offsetY: -0.1 },
  }])) };
  db.prepare('INSERT INTO final_edit_title_presets VALUES (?,?,?)').run('cover-one', '偏右构图', JSON.stringify(preset));
  const file = path.join(root, 'source.mp4'), voice = path.join(root, 'voice.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', voice]);
  globalThis.fetch = async url => String(url).endsWith('/audio/speech')
    ? Response.json({ output: { audio: { data: fs.readFileSync(voice).toString('base64') } } })
    : Response.json({ words: [{ word: '轻松擦洗', start: 0.1, end: 0.9 }] });
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
  const batchId = createBatchProduction(db, 'p', '统一包装和封面', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'G1_静物.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [12, '抖音', 1, 16, 'G1', '轻松擦洗。'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'narration', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  production.packaging = { mode: 'uniform', templateIds: ['overlay-minimal'] };
  production.cover = { mode: 'uniform', presetIds: ['cover-one'] };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'packaging', settingsId: settings.saved!.id, expectedInputRevision: 2 });
  // A queued request must not pick up a later edit to the project or preset library.
  db.prepare('DELETE FROM final_edit_title_presets WHERE id=?').run('cover-one');
  db.prepare('UPDATE live_mixcut_projects SET productName=? WHERE id=?').run('后来改名', 'p');
  await runPendingOnce({ db, workerId: 'packaging', concurrency: 2, executors: [createFormulaStageExecutor()], log: () => {} });
  const views = request.outputs.map(output => getBatchOutputArrangementView(db, 'p', batchId, output.planId));
  assert(views.every(view => view.outputVersionId), '排片完成后应有可编辑成片');
  for (const view of views) {
    assert.equal(view.packaging?.enabled, true, '生成成片必须采用第二步已选中的包装');
    assert.equal(view.packaging.template, 'overlay-minimal');
    assert.equal(view.packaging.varsOverrides?.title, '实拍椅');
    assert.deepEqual(view.coverFraming, { scale: 1.4, offsetX: 0.2, offsetY: -0.1 }, '采用生成时冻结的预设构图');
    assert.equal(view.coverTitle?.styles.primary.color, '#123456', '保存预设完整样式供关闭包装时使用');
  }
  applyBatchOutputClipEdit(db, 'p', batchId, views[0].planId, { type: 'move_audio_clip', track: 'narration',
    clipId: views[0].audioPlan!.clips[0].id, timelineStartUs: 1_000_000,
    expectedEditRevision: views[0].editRevision, expectedOutputVersionId: views[0].outputVersionId! });
  const moved = getBatchOutputArrangementView(db, 'p', batchId, views[0].planId);
  assert.deepEqual(getBatchOutputArrangementView(db, 'p', batchId, views[1].planId), views[1], '修改一份不能影响同脚本其他份');
  const timeline = readFormulaTimeline(db, 'p', batchId, views[0].planId);
  assert.equal(materializeFormulaOutput(db, 'p', batchId, timeline.stageId!, request), moved.outputVersionId);
  assert.deepEqual(getBatchOutputArrangementView(db, 'p', batchId, views[0].planId), moved, '恢复或重试不能重抽样式、花字标识或覆盖编辑');

  // A23's allocation seam uses fixed identities/seed, independent of UUIDs, worker order and database storage.
  assert(timeline.result?.status === 'planned');
  const plannedTimeline = timeline.result;
  const randomRequest = structuredClone(request);
  randomRequest.seed = 'fixed-presentation-acceptance';
  randomRequest.outputs = Array.from({ length: 16 }, (_, index) => ({ ...request.outputs[0], planId: `output-${index}`, copyIndex: index + 1 }));
  randomRequest.input.settings.settings.production.packaging = { mode: 'random', templateIds: [...PACKAGING_TEMPLATE_IDS] };
  randomRequest.input.settings.settings.production.cover = { mode: 'random', presetIds: ['cover-one', 'cover-two'] };
  const secondPreset = structuredClone(randomRequest.input.productionResources.covers[0]);
  secondPreset.id = 'cover-two'; secondPreset.name = '偏左构图';
  secondPreset.preset.stylesByPreset['9x16'].framing = { scale: 1.8, offsetX: -0.3, offsetY: 0.1 };
  randomRequest.input.productionResources.covers.push(secondPreset);
  const allocation = randomRequest.outputs.map(output => initialFormulaPresentation(randomRequest, output.planId, 'timeline-fixture', plannedTimeline));
  assert.equal(new Set(allocation.map(item => item.packaging.template)).size, 4, '同脚本多份可独立采用四种已选包装');
  assert.equal(new Set(allocation.map(item => item.formulaPresentation.presetId)).size, 2, '同脚本多份可独立采用不同封面');
  for (const [index, output] of [...randomRequest.outputs.entries()].reverse()) {
    assert.deepEqual(initialFormulaPresentation(randomRequest, output.planId, 'timeline-fixture', timeline.result), allocation[index], '领取顺序和重试不能改变结果');
  }
  randomRequest.input.settings.settings.production.packaging = { mode: 'none', templateIds: [] };
  const noPackaging = initialFormulaPresentation(randomRequest, 'output-0', 'timeline-fixture', timeline.result);
  assert.equal(noPackaging.packaging.enabled, false);
  assert.deepEqual(noPackaging.cover, allocation[0].cover, '关闭包装仍应用封面，包装和封面分别分配');
  randomRequest.input.settings.settings.production.cover = { mode: 'default', presetIds: [] };
  assert.equal(initialFormulaPresentation(randomRequest, 'output-0', 'timeline-fixture', timeline.result).formulaPresentation.presetId, null);
  console.log('formula packaging: uniform/random/off, independent frozen covers, retry/edit isolation and actual audio cue timing passed');

  const currentPresentation = () => getBatchOutputArrangementView(db, 'p', batchId, views[0].planId);
  const beforeLock = currentPresentation();
  assert(beforeLock.reviewContext?.issues.some(issue => issue.kind === 'range'), '待审自动区间进入实际显示和确认的问题集合');
  assert.throws(() => setBatchPlanReviews(db, 'p', batchId, { planIds: [beforeLock.planId], decision: 'approved' }), /所见版本|提醒信息/,
    '公式批次不接受缺少所见版本的旧确认调用');
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [{ planId: beforeLock.planId, ...beforeLock.reviewContext! }], decision: 'approved' }).results[0].status,
    'not_ready', '选片和声音已有草稿也不能绕过完整制作检查');
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [{ planId: beforeLock.planId, ...beforeLock.reviewContext! }], decision: 'rework' }).results[0].status, 'saved');
  const locked = applyBatchOutputClipEdit(db, 'p', batchId, beforeLock.planId, {
    type: 'set_presentation_lock', target: 'packaging', locked: true,
    expectedEditRevision: beforeLock.editRevision, expectedOutputVersionId: beforeLock.outputVersionId!,
  });
  assert.equal(locked.visualChanged, false, '锁定只保护后续分配，不改变画面或声音');
  assert.equal(locked.reviewCleared, false);
  assert.equal(readBatchPlanReview(db, 'p', batchId, beforeLock.planId).decision, 'rework');
  assert.equal(locked.editRevision, beforeLock.editRevision + 1, '旧窗口不能覆盖新的锁定');
  assert.deepEqual(currentPresentation().presentationLocks, { packaging: true, cover: false });
  assert.deepEqual(currentPresentation().packaging, beforeLock.packaging);
  assert.deepEqual(currentPresentation().audioPlan, beforeLock.audioPlan);
  const undoLock = applyBatchOutputClipEdit(db, 'p', batchId, beforeLock.planId, { type: 'restore_arrangement',
    expectedEditRevision: currentPresentation().editRevision, expectedOutputVersionId: beforeLock.outputVersionId!,
    snapshot: { ...beforeLock, musicTrackId: beforeLock.music.trackId, musicGainDb: beforeLock.music.gainDb,
      musicFadeInSec: beforeLock.music.fadeInSec, musicFadeOutSec: beforeLock.music.fadeOutSec,
      musicDucking: beforeLock.music.ducking, narrationGainDb: beforeLock.narration.gainDb } });
  for (const key of ['clips', 'audioPlan', 'music', 'packaging', 'coverTitle', 'coverFraming'] as const) {
    assert.deepEqual(currentPresentation()[key], beforeLock[key], `只撤销锁定不改 ${key}`);
  }
  assert.equal(undoLock.visualChanged, false, '只撤销锁定同样不改变成片内容');
  assert.equal(undoLock.reviewCleared, false);
  assert.deepEqual(currentPresentation().presentationLocks, { packaging: false, cover: false });
  assert.equal(readBatchPlanReview(db, 'p', batchId, beforeLock.planId).decision, 'rework');
  assert.throws(() => applyBatchOutputClipEdit(db, 'p', batchId, beforeLock.planId, {
    type: 'set_presentation_lock', target: 'packaging', locked: false,
    expectedEditRevision: beforeLock.editRevision, expectedOutputVersionId: beforeLock.outputVersionId!,
  }), /修改|修订/, '过期窗口不能取消锁定');
  const presentationEdit = (command: Parameters<typeof applyBatchOutputClipEdit>[4]) => {
    const current = currentPresentation();
    return applyBatchOutputClipEdit(db, 'p', batchId, current.planId, {
      expectedEditRevision: current.editRevision, expectedOutputVersionId: current.outputVersionId!, ...command,
    });
  };
  presentationEdit({ type: 'set_packaging', config: { ...currentPresentation().packaging!, template: 'overlay-journal',
    varsOverrides: { ...currentPresentation().packaging!.varsOverrides, title: '手动标题' } },
    expectedEditRevision: currentPresentation().editRevision, expectedOutputVersionId: currentPresentation().outputVersionId! });
  presentationEdit({ type: 'set_cover', assetId, timeUs: 500_000, framing: { scale: 1.8, offsetX: 0, offsetY: 0 },
    title: { ...currentPresentation().coverTitle!, primary: '手动封面标题' } });
  const manual = currentPresentation();
  assert.deepEqual(manual.presentationLocks, { packaging: true, cover: true }, '手动修改自动保护对应部分');
  assert.equal(presentationEdit({ type: 'reassign_presentation' }).changed, false, '已锁定两部分的成片全部跳过');
  assert.deepEqual(currentPresentation(), manual);
  presentationEdit({ type: 'set_presentation_lock', target: 'cover', locked: false });
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [{ planId: beforeLock.planId, ...currentPresentation().reviewContext! }], decision: 'rework' }).results[0].status, 'saved');
  const redistributed = presentationEdit({ type: 'reassign_presentation' });
  assert.equal(redistributed.visualChanged, true);
  assert.equal(redistributed.reviewCleared, true);
  assert.equal(readBatchPlanReview(db, 'p', batchId, beforeLock.planId).decision, null);
  assert.deepEqual(currentPresentation().packaging, manual.packaging, '重新分配封面不能改锁定的包装');
  assert.deepEqual(currentPresentation().coverFraming, { scale: 1.4, offsetX: 0.2, offsetY: -0.1 });
  assert.equal(currentPresentation().coverTitle?.primary, '手动封面标题', '重新分配样式不改手写文字');
  assert.equal(currentPresentation().coverTimeUs, 500_000, '重新分配预设不改选好的封面帧');
  presentationEdit({ type: 'set_presentation_lock', target: 'packaging', locked: false });
  presentationEdit({ type: 'reassign_presentation' });
  const reassigned = currentPresentation();
  assert.equal(reassigned.packaging?.template, 'overlay-minimal', '只从原冻结候选重新分配');
  assert.equal(reassigned.packaging.varsOverrides?.title, '手动标题');
  assert.deepEqual(reassigned.packaging.pointCues, manual.packaging?.pointCues, '重分配样式不重新提取或改花字时序');
  assert.deepEqual(reassigned.clips, manual.clips);
  assert.deepEqual(reassigned.audioPlan, manual.audioPlan);
  assert.deepEqual(getBatchOutputArrangementView(db, 'p', batchId, views[1].planId), views[1]);
  presentationEdit({ type: 'restore_arrangement', snapshot: { ...manual,
    musicTrackId: manual.music.trackId, musicGainDb: manual.music.gainDb, musicFadeInSec: manual.music.fadeInSec,
    musicFadeOutSec: manual.music.fadeOutSec, musicDucking: manual.music.ducking, narrationGainDb: manual.narration.gainDb } });
  assert.deepEqual(currentPresentation().packaging, manual.packaging, '撤销恢复手改包装');
  assert.deepEqual(currentPresentation().coverTitle, manual.coverTitle);
  assert.deepEqual(currentPresentation().coverFraming, manual.coverFraming);
  assert.deepEqual(currentPresentation().presentationLocks, manual.presentationLocks, '整包撤销同时恢复锁定状态');

  // Exercise explicit random reassignment through saved requests and the public output edit/read boundary.
  db.prepare('INSERT INTO final_edit_title_presets VALUES (?,?,?)').run('cover-one', '偏右构图', JSON.stringify(preset));
  db.prepare('INSERT INTO final_edit_title_presets VALUES (?,?,?)').run(secondPreset.id, secondPreset.name, JSON.stringify(secondPreset.preset));
  const randomBatch = createBatchProduction(db, 'p', '随机重分配', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', randomBatch, { assetId, sourcePath: 'G1_静物.mp4' });
  const randomImport = await createFormulaImportSession(db, 'p', randomBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', randomBatch, randomImport.id, { expectedRevision: 1, excludedKeys: [] });
  const randomSettings = await saveFormulaSettings(db, 'p', randomBatch, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: randomImport.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] },
      production: { ...production, packaging: { mode: 'random', templateIds: [...PACKAGING_TEMPLATE_IDS] },
        cover: { mode: 'random', presetIds: ['cover-one', 'cover-two'] } } } });
  const randomSaved = await createFormulaGenerationRequest(db, 'p', randomBatch, { requestKey: 'random-presentation',
    settingsId: randomSettings.saved!.id, expectedInputRevision: 2 });
  db.prepare('DELETE FROM final_edit_title_presets').run();
  await runPendingOnce({ db, workerId: 'random-presentation', concurrency: 2, executors: [createFormulaStageExecutor()], log: () => {} });
  for (const output of randomSaved.outputs) {
    const original = getBatchOutputArrangementView(db, 'p', randomBatch, output.planId);
    db.prepare("UPDATE live_mixcut_output_versions SET arrangementJson=json_remove(arrangementJson,'$.presentationLocks') WHERE id=?")
      .run(original.outputVersionId); // legacy, never edited: still eligible for explicit allocation
    const before = getBatchOutputArrangementView(db, 'p', randomBatch, output.planId);
    const command = { type: 'reassign_presentation' as const, expectedEditRevision: before.editRevision,
      expectedOutputVersionId: before.outputVersionId! };
    applyBatchOutputClipEdit(db, 'p', randomBatch, output.planId, command);
    const after = getBatchOutputArrangementView(db, 'p', randomBatch, output.planId);
    assert.deepEqual(after.presentationLocks, { packaging: false, cover: false }, '旧未编辑成片重新分配后仍保持未锁定');
    assert.notEqual(after.packaging?.template, before.packaging?.template, '多个候选时显式重分配换一种模板');
    assert.notDeepEqual(after.coverFraming, before.coverFraming, '只有两个预设时换到另一种已冻结构图');
    assert.deepEqual(after.packaging?.pointCues, before.packaging?.pointCues);
    assert.deepEqual(after.audioPlan, before.audioPlan);
    assert.throws(() => applyBatchOutputClipEdit(db, 'p', randomBatch, output.planId, command), /修改|修订/, '重复旧请求不能再抽一次');
    assert.deepEqual(getBatchOutputArrangementView(db, 'p', randomBatch, output.planId), after, '重复读取不重新分配');
    assert.throws(() => applyBatchOutputClipEdit(db, 'another-project', randomBatch, output.planId, {
      ...command, expectedEditRevision: after.editRevision }), /不存在/);
    process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
    assert.equal(setBatchPlanReviews(db, 'p', randomBatch, { items: [{ planId: output.planId, ...after.reviewContext! }], decision: 'rework' }).results[0].status,
      'unavailable', '能力关闭后返工确认也应返回逐条不可用原因');
    assert.throws(() => applyBatchOutputClipEdit(db, 'p', randomBatch, output.planId, {
      ...command, expectedEditRevision: after.editRevision }), /不可用/);
    process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
    applyBatchOutputClipEdit(db, 'p', randomBatch, output.planId, { type: 'restore_arrangement',
      expectedEditRevision: after.editRevision, expectedOutputVersionId: after.outputVersionId!,
      snapshot: { ...before, musicTrackId: before.music.trackId, musicGainDb: before.music.gainDb,
        musicFadeInSec: before.music.fadeInSec, musicFadeOutSec: before.music.fadeOutSec,
        musicDucking: before.music.ducking, narrationGainDb: before.narration.gainDb } });
    const undone = getBatchOutputArrangementView(db, 'p', randomBatch, output.planId);
    applyBatchOutputClipEdit(db, 'p', randomBatch, output.planId, { ...command, expectedEditRevision: undone.editRevision });
    assert.notDeepEqual(getBatchOutputArrangementView(db, 'p', randomBatch, output.planId).coverFraming, undone.coverFraming,
      '撤销后再重分配应按当前实际封面选择另一预设，不能按旧分配标记判断');
  }
  console.log('formula presentation: locks, manual protection, independent reassignment, undo, frozen pools and stale/off/scope rejection passed');
  // A legacy edited output has no lock fields. Treat it conservatively until the user explicitly unlocks it.
  const legacyPlan = randomSaved.outputs[0].planId;
  const legacyBefore = getBatchOutputArrangementView(db, 'p', randomBatch, legacyPlan);
  db.prepare("UPDATE live_mixcut_output_versions SET arrangementJson=json_remove(arrangementJson,'$.presentationLocks') WHERE id=?")
    .run(legacyBefore.outputVersionId);
  const legacy = getBatchOutputArrangementView(db, 'p', randomBatch, legacyPlan);
  assert.deepEqual(legacy.presentationLocks, { packaging: true, cover: true }, '旧成片已有编辑时默认保护，不推断用户是否只改过声音');
  assert.equal(applyBatchOutputClipEdit(db, 'p', randomBatch, legacyPlan, { type: 'reassign_presentation',
    expectedEditRevision: legacy.editRevision, expectedOutputVersionId: legacy.outputVersionId! }).changed, false);

  if (process.argv.includes('--render')) {
    const { renderBatchOutputVersion } = await import('../lib/live-mixcut/batch-renderer.ts');
    const evidence = path.resolve('outputs/formula-output-packaging');
    fs.mkdirSync(evidence, { recursive: true });
    const renderView = () => getBatchOutputArrangementView(db, 'p', batchId, views[1].planId);
    const reports = [];
    for (const template of PACKAGING_TEMPLATE_IDS) {
      const before = renderView();
      applyBatchOutputClipEdit(db, 'p', batchId, before.planId, { type: 'set_packaging',
        config: { ...before.packaging!, template }, expectedEditRevision: before.editRevision, expectedOutputVersionId: before.outputVersionId! });
      const current = renderView();
      const result = await renderBatchOutputVersion({ db, projectId: 'p', batchId, batchVersionId: request.batchVersionId,
        planId: current.planId, outputVersionId: current.outputVersionId! });
      assert.equal(result.width, 1080); assert.equal(result.height, 1920); assert.equal(result.fps, 24);
      assert.equal(result.productionReady, false, '修改包装后尚未重新检查的渲染不能正式发布');
      const countFile = path.join(root, 'frames.json'), errorFile = path.join(root, 'frames.stderr');
      const stdout = fs.openSync(countFile, 'w'), stderr = fs.openSync(errorFile, 'w');
      try {
        const counted = spawnSync(resolveFfprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
          '-show_entries', 'stream=nb_read_frames', '-of', 'json', result.videoAbsolutePath],
        { stdio: ['ignore', stdout, stderr], windowsHide: true, timeout: 60_000 });
        assert.equal(counted.status, 0, fs.readFileSync(errorFile, 'utf8'));
      } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
      const frames = Number(JSON.parse(fs.readFileSync(countFile, 'utf8')).streams[0].nb_read_frames);
      assert.equal(frames, 68, '两秒正文与20帧封面，包装不延长底片');
      const coverStats = await sharp(result.coverAbsolutePath).stats();
      assert(coverStats.channels.some(channel => channel.stdev > 10), '纯蓝底片上必须实际合成包装内容');
      fs.copyFileSync(result.videoAbsolutePath, path.join(evidence, `${template}.mp4`));
      fs.copyFileSync(result.coverAbsolutePath, path.join(evidence, `${template}.jpg`));
      await runFfmpeg(['-y', '-ss', '1.4', '-i', result.videoAbsolutePath, '-frames:v', '1', path.join(evidence, `${template}-body.png`)]);
      reports.push({ template, width: result.width, height: result.height, fps: result.fps, frames, durationUs: result.durationUs,
        videoChecksum: result.videoChecksum, coverChecksum: result.coverChecksum, packaging: current.packaging, framing: current.coverFraming });
      console.log(`${template}: generated formula output rendered with packaging and cover at 1080x1920 / 24fps / 68 frames`);
    }
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(reports, null, 2));
  }
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const { closeDb } = await import('../lib/db.ts');
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
