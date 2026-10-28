import { seedLiveMixcutProjects, seedFormulaMaterialAnalysis } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-narration-stage-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
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
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { readFormulaSelectionHistory, reselectFormulaOutput } = await import('../lib/live-mixcut/formula/reselection.ts');
  const { listBatchTasks } = await import('../lib/live-mixcut/tasks.ts');
  const { retryTask } = await import('../lib/live-mixcut/scheduler.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { readFormulaPreview, resolveFormulaPreviewMedia } = await import('../lib/live-mixcut/formula/preview.ts');
  const { formulaSelectionSummaries } = await import('../lib/live-mixcut/formula/selection-summary.ts');
  const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/live-mixcut/output-arrangement.ts');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,productCode TEXT DEFAULT '',exportDirName TEXT DEFAULT '',createdAt TEXT DEFAULT '2026-10-23T00:00:00Z'); INSERT INTO projects (id,name) VALUES ('p','配音阶段');
    CREATE TABLE final_edit_tts_providers (id TEXT PRIMARY KEY,name TEXT,type TEXT,baseUrl TEXT,apiKey TEXT,keyEnv TEXT,model TEXT,enabled INTEGER);
    INSERT INTO final_edit_tts_providers VALUES ('vapi-qwen3-tts','测试音色','vapi-qwen-json-url','https://voice.example','fixture',NULL,'qwen3-tts-flash',1);`);
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  const batchId = createBatchProduction(db, 'p', '两份单独配音', undefined, { planningMode: 'formula' });
  const file = path.join(root, 'source.mp4'), audio = path.join(root, 'voice.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', audio]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'G1_静物.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', batchId);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [12, '抖音', 1, 16, 'G1', '坐得稳。'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'narration', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'tts', settingsId: settings.saved!.id, expectedInputRevision: 2 });
  assert.ok(request.input.ttsService, '制作请求必须冻结配音和对齐服务身份');
  const { readFormulaNarration, resolveFormulaNarrationMedia } = await import('../lib/live-mixcut/formula/narration-store.ts');
  const { readFormulaTimeline } = await import('../lib/live-mixcut/formula/timeline-store.ts');
  let syntheses = 0;
  let badWords = false;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/audio/speech')) {
      syntheses++;
      return Response.json({ output: { audio: { data: fs.readFileSync(audio).toString('base64') } } });
    }
    return Response.json({ words: [{ word: badWords ? '同字数' : '坐得稳', start: 0.1, end: 0.9 }] });
  };
  const executor = createFormulaStageExecutor();
  const executors = [executor, createBatchRenderExecutor()];
  await runPendingOnce({ db, workerId: 'tts-pipeline', concurrency: 2, executors, log: () => {} });
  assert(getBatchWorkspace(db, 'p', batchId).cards.every(card => card.approvable), '配音到排片、检查和封面均自动完成');
  const views = request.outputs.map(output => readFormulaNarration(db, 'p', batchId, output.planId));
  assert(views.every(view => view.result?.status === 'ready'), '每份自动推进到实际配音，不依赖浏览器续跑');
  assert.notEqual(views[0].stageId, views[1].stageId);
  assert.equal(syntheses, 1, '并发处理同文案同音色时只生成一次，逐份结果仍独立');
  const timelines = request.outputs.map(output => readFormulaTimeline(db, 'p', batchId, output.planId));
  assert(timelines.every(view => view.result?.status === 'planned'), '配音完成后应自动按实际声音排片');
  assert.notEqual(timelines[0].stageId, timelines[1].stageId);
  const editable = getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId);
  assert.ok(editable.outputVersionId, '排片完成后应自动建立现有编辑器使用的输出版本');
  assert.equal(editable.editable, true);
  assert.equal(editable.audioPlan?.bodyDurationUs, 2_000_000);
  assert.equal(editable.audioPlan?.clips[0].kind, 'narration');
  const move = applyBatchOutputClipEdit(db, 'p', batchId, request.outputs[0].planId, { type: 'move_audio_clip', track: 'narration',
    clipId: editable.audioPlan!.clips[0].id, timelineStartUs: 1_000_000, expectedEditRevision: editable.editRevision, expectedOutputVersionId: editable.outputVersionId! });
  const edited = getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId);
  assert.equal(edited.formulaPreview?.audioTimeline.clips[0].timelineStartUs, 1_000_000, '编辑器预览必须读取修改后的声音位置');
  assert.equal(edited.formulaPreview?.audioTimeline.clips[0].sourceInUs, 0);
  assert.equal(edited.editRevision, move.editRevision);
  const { materializeFormulaOutput } = await import('../lib/live-mixcut/formula/output-store.ts');
  assert.equal(materializeFormulaOutput(db, 'p', batchId, timelines[0].stageId!, request), editable.outputVersionId);
  assert.deepEqual(getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId), edited, '重复续接不能覆盖用户修改');
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
  assert.equal(getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId).editable, false, '关闭公式能力后保留数据但不能编辑');
  assert.match(getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId).formulaPreview!.message, /暂不可用/);
  assert.throws(() => applyBatchOutputClipEdit(db, 'p', batchId, request.outputs[0].planId, { type: 'delete', clipId: editable.clips[0].clipId,
    expectedEditRevision: edited.editRevision, expectedOutputVersionId: edited.outputVersionId! }), /暂不可用/);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  for (const timeline of timelines) {
    assert(timeline.result?.status === 'planned');
    assert.equal(timeline.result.duration.bodyFrames, 48, '只有两秒画面，参考16秒不允许循环凑长');
    assert.equal(timeline.result.duration.totalFrames, 68, '封面只加一次20帧');
    assert(timeline.result.issues.some(issue => issue.code === 'target_deviation'));
    assert.equal(timeline.result.audio[0].sourceOutUs, 1_000_000, '配音完整保留实际一秒长度');
  }
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, request.outputs[0].planId).current.timeline, timelines[0],
    '审片历史应返回当前选片对应的时间线');
  const preview = readFormulaPreview(db, 'p', batchId, request.outputs[0].planId);
  assert.equal(preview.status, 'ready');
  assert(preview.preview);
  assert.equal(preview.preview.audioTimeline.bodyDurationUs, 2_000_000);
  assert.equal(preview.preview.clips[0].sourceEndUs, 2_000_000);
  assert.equal(preview.preview.audioTimeline.clips[0].sourceDurationUs, 1_000_000);
  assert.equal(preview.preview.audioTimeline.clips[0].timelineStartUs, 1_000_000, '旧预览入口也不能回到未编辑的排片');
  const summary = formulaSelectionSummaries(db, request.batchVersionId).get(request.outputs[0].planId)!;
  assert.equal(summary.bodyDurationUs, 2_000_000, '成片列表应使用已排好的正文长度，不能继续显示待确定');
  assert.equal(summary.previewReady, true);
  assert(!JSON.stringify(preview).includes('storage/'), '预览响应不能把本地媒体路径交给浏览器');
  const voiceParams = new URL(preview.preview.audioTimeline.clips[0].url, 'http://localhost').searchParams;
  const previewMedia = await resolveFormulaPreviewMedia(db, 'p', batchId, request.outputs[0].planId,
    voiceParams.get('selectionStageId')!, voiceParams.get('timelineStageId')!, 'audio', voiceParams.get('mediaId')!, new AbortController().signal);
  assert.equal(fs.readFileSync(previewMedia.absolutePath).subarray(0, 4).toString(), 'RIFF');
  await assert.rejects(() => resolveFormulaPreviewMedia(db, 'p', batchId, request.outputs[1].planId,
    voiceParams.get('selectionStageId')!, voiceParams.get('timelineStageId')!, 'audio', voiceParams.get('mediaId')!, new AbortController().signal), /不存在|不属于/);
  for (const view of views) {
    assert.equal(view.result?.items[0].text, '坐得稳。');
    assert.equal(view.result?.items[0].audio.durationUs, 1_000_000);
  }
  const media = resolveFormulaNarrationMedia(db, 'p', batchId, request.outputs[0].planId, views[0].selectionStageId, views[0].result!.items[0].id);
  const { projectAssetMediaResponse } = await import('../lib/live-mixcut/project-asset-media-response.ts');
  const range = projectAssetMediaResponse(new Request('http://localhost/voice', { headers: { Range: 'bytes=0-3' } }), media.absolutePath,
    'audio/wav', {}, media.identity);
  assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), 'RIFF');
  assert.throws(() => resolveFormulaNarrationMedia(db, 'foreign', batchId, request.outputs[0].planId, views[0].selectionStageId, 'narration-1'), /不存在|不属于/);
  assert.throws(() => resolveFormulaNarrationMedia(db, 'p', batchId, request.outputs[1].planId, views[0].selectionStageId, 'narration-1'), /不存在/);
  await runPendingOnce({ db, workerId: 'edited-audio-check', executors, log: () => {} });
  assert(getBatchWorkspace(db, 'p', batchId).cards.every(card => card.approvable), '移动声音后完成新检查');
  assert.equal(await runPendingOnce({ db, workerId: 'idle', executors, log: () => {} }), 0);
  // 模拟尚无编辑版本的旧库：先移除本测试新建的输出，再构造旧阶段缺口。
  const removeOutputFixture = (stageId: string | null) => {
    const output = db.prepare('SELECT outputVersionId FROM live_mixcut_formula_output_versions WHERE timelineStageId=?').get(stageId) as { outputVersionId: string } | undefined;
    if (!output) return;
    db.prepare(`DELETE FROM live_mixcut_tasks WHERE targetId IN (SELECT id FROM live_mixcut_formula_execution_checks WHERE outputVersionId=?)
      OR targetId=?`).run(output.outputVersionId, output.outputVersionId);
    db.prepare('DELETE FROM live_mixcut_formula_execution_results WHERE stageId IN (SELECT id FROM live_mixcut_formula_execution_checks WHERE outputVersionId=?)').run(output.outputVersionId);
    db.prepare('DELETE FROM live_mixcut_formula_execution_checks WHERE outputVersionId=?').run(output.outputVersionId);
    db.prepare('DELETE FROM live_mixcut_formula_output_versions WHERE timelineStageId=?').run(stageId);
    db.prepare('UPDATE live_mixcut_output_plans SET currentVersionId=NULL WHERE currentVersionId=?').run(output.outputVersionId);
    db.prepare('DELETE FROM live_mixcut_output_versions WHERE id=?').run(output.outputVersionId);
  };
  removeOutputFixture(timelines[0].stageId);
  await runPendingOnce({ db, workerId: 'resume-output', executors, log: () => {} });
  assert.ok(getBatchOutputArrangementView(db, 'p', batchId, request.outputs[0].planId).outputVersionId, '旧排片升级后应补建编辑版本');
  // 恢复夹具：完整配音输入已冻结、映射已完成，但配音阶段尚未入队。
  db.prepare("DELETE FROM live_mixcut_tasks WHERE workType='formula_stage' AND targetId=?").run(timelines[0].stageId);
  removeOutputFixture(timelines[0].stageId);
  db.prepare('DELETE FROM live_mixcut_formula_timeline_results WHERE stageId=?').run(timelines[0].stageId);
  db.prepare('DELETE FROM live_mixcut_formula_timeline_stages WHERE id=?').run(timelines[0].stageId);
  db.prepare("DELETE FROM live_mixcut_tasks WHERE workType='formula_stage' AND targetId=?").run(views[0].stageId);
  db.prepare('DELETE FROM live_mixcut_formula_narration_results WHERE stageId=?').run(views[0].stageId);
  db.prepare('DELETE FROM live_mixcut_formula_narration_stages WHERE id=?').run(views[0].stageId);
  await runPendingOnce({ db, workerId: 'resume-mapping', executors, log: () => {} });
  assert.equal(readFormulaNarration(db, 'p', batchId, request.outputs[0].planId).status, 'ready', '后台应补齐旧映射之后的配音阶段');
  assert.deepEqual(readFormulaNarration(db, 'p', batchId, request.outputs[1].planId), views[1]);
  assert.equal(syntheses, 1);
  // 模拟旧版本已完成声音、尚未建立排片阶段，重启后只补后续工作。
  const toRepair = readFormulaTimeline(db, 'p', batchId, request.outputs[0].planId);
  db.prepare("DELETE FROM live_mixcut_tasks WHERE workType='formula_stage' AND targetId=?").run(toRepair.stageId);
  removeOutputFixture(toRepair.stageId);
  db.prepare('DELETE FROM live_mixcut_formula_timeline_results WHERE stageId=?').run(toRepair.stageId);
  db.prepare('DELETE FROM live_mixcut_formula_timeline_stages WHERE id=?').run(toRepair.stageId);
  await runPendingOnce({ db, workerId: 'resume-timeline', executors, log: () => {} });
  assert.equal(readFormulaTimeline(db, 'p', batchId, request.outputs[0].planId).result?.status, 'planned');
  assert.deepEqual(readFormulaTimeline(db, 'p', batchId, request.outputs[1].planId), timelines[1]);
  assert.equal(syntheses, 1, '恢复排片不能重新生成声音');
  const firstPlan = request.outputs[0].planId;
  const reselect = (key: string) => {
    const current = readFormulaSelectionHistory(db, 'p', batchId, firstPlan);
    const currentOutput = getBatchOutputArrangementView(db, 'p', batchId, firstPlan);
    return reselectFormulaOutput(db, 'p', batchId, firstPlan, { requestKey: key, expectedStageId: current.current.id,
      expectedOutputVersionId: currentOutput.outputVersionId, expectedEditRevision: currentOutput.editRevision });
  };
  reselect('before-late-tts');
  assert.equal(readFormulaPreview(db, 'p', batchId, firstPlan).status, 'pending', '重选期间不把旧预览当当前结果');
  assert.equal(readFormulaPreview(db, 'p', batchId, firstPlan).preview, null);
  let superseded: string | null = null;
  await runPendingOnce({ db, workerId: 'late-tts', concurrency: 1, log: () => {}, executors: [{ workTypes: ['formula_stage'], async execute(context) {
    const current = readFormulaNarration(db, 'p', batchId, firstPlan);
    const prepared = await executor.execute(context);
    if (!superseded && current.stageId === context.claim.task.targetId) {
      superseded = current.selectionStageId;
      reselect('changed-before-tts-commit');
    }
    return prepared;
  } }, createBatchRenderExecutor()] });
  assert(superseded);
  assert.equal(readFormulaNarration(db, 'p', batchId, firstPlan, superseded).result, null, '旧配音迟到不能写入新选片');
  assert.equal(readFormulaNarration(db, 'p', batchId, firstPlan).status, 'ready');
  reselect('before-late-timeline');
  let oldTimelineSelection: string | null = null;
  await runPendingOnce({ db, workerId: 'late-timeline', concurrency: 1, log: () => {}, executors: [{ workTypes: ['formula_stage'], async execute(context) {
    const current = readFormulaTimeline(db, 'p', batchId, firstPlan);
    const prepared = await executor.execute(context);
    if (!oldTimelineSelection && current.stageId === context.claim.task.targetId) {
      oldTimelineSelection = current.selectionStageId;
      reselect('changed-before-timeline-commit');
    }
    return prepared;
  } }, createBatchRenderExecutor()] });
  assert(oldTimelineSelection);
  assert.equal(readFormulaTimeline(db, 'p', batchId, firstPlan, oldTimelineSelection).result, null, '旧排片迟到不得写入已替换的选片');
  assert.equal(readFormulaTimeline(db, 'p', batchId, firstPlan).result?.status, 'planned');
  assert.deepEqual(readFormulaTimeline(db, 'p', batchId, request.outputs[1].planId), timelines[1]);
  const beforeAlignmentRetry = syntheses;
  const secondProduction = { ...production, audio: { ...production.audio,
    tts: { providerId: 'vapi-qwen3-tts', voice: 'Ethan', speed: 1 } } };
  const secondBatch = createBatchProduction(db, 'p', '对齐失败后重试', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', secondBatch, { assetId, sourcePath: 'G1_静物.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', secondBatch);
  const secondImported = await createFormulaImportSession(db, 'p', secondBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', secondBatch, secondImported.id, { expectedRevision: 1, excludedKeys: [] });
  const secondSettings = await saveFormulaSettings(db, 'p', secondBatch, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: secondImported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] }, production: secondProduction,
      timing: { mode: 'strict_max', scope: 'total', overrideDurationSec: 1.5, speechMarginMs: 120 } } });
  const secondRequest = await createFormulaGenerationRequest(db, 'p', secondBatch, { requestKey: 'tts-alignment-retry', settingsId: secondSettings.saved!.id, expectedInputRevision: 2 });
  badWords = true;
  await runPendingOnce({ db, workerId: 'bad-alignment', concurrency: 2, executors, log: () => {} });
  const failedAlignment = secondRequest.outputs.map(output => readFormulaNarration(db, 'p', secondBatch, output.planId));
  assert(failedAlignment.every(view => view.taskStatus === 'failed' && view.result === null), '对齐不可靠时任务可重试，不能进入声音就绪');
  assert.equal(readFormulaPreview(db, 'p', secondBatch, secondRequest.outputs[0].planId).status, 'needs_attention', '配音失败不能一直显示正在准备预览');
  assert.equal(syntheses, beforeAlignmentRetry + 1);
  badWords = false;
  const failedIds = new Set(failedAlignment.map(view => view.stageId));
  for (const task of listBatchTasks(db, secondBatch).filter(task => failedIds.has(task.targetId))) retryTask(db, 'p', task.id);
  await runPendingOnce({ db, workerId: 'retry-alignment', concurrency: 2, executors, log: () => {} });
  assert(secondRequest.outputs.every(output => readFormulaNarration(db, 'p', secondBatch, output.planId).status === 'ready'));
  assert.equal(syntheses, beforeAlignmentRetry + 1, '任务重试仅重试对齐，沿用已保存声音');
  for (const output of secondRequest.outputs) {
    const result = readFormulaTimeline(db, 'p', secondBatch, output.planId).result;
    assert.equal(result?.status, 'needs_attention', '一秒完整配音加20帧封面放不进1.5秒总片长');
    if (result?.status === 'needs_attention') assert.equal(result.conflicts[0].code, 'target_too_short');
  }
  assert.deepEqual(readFormulaNarration(db, 'p', batchId, request.outputs[1].planId), views[1]);
  reselect('file-changes-before-commit');
  let changed = false;
  await runPendingOnce({ db, workerId: 'changed-file', concurrency: 1, log: () => {}, executors: [{ workTypes: ['formula_stage'], async execute(context) {
    const current = readFormulaNarration(db, 'p', batchId, firstPlan);
    const prepared = await executor.execute(context);
    if (!changed && current.stageId === context.claim.task.targetId) {
      changed = true;
      fs.writeFileSync(path.join(root, 'storage', views[1].result!.items[0].audio.relativePath), Buffer.alloc(128));
    }
    return prepared;
  } }, createBatchRenderExecutor()] });
  assert(changed);
  const failed = readFormulaNarration(db, 'p', batchId, firstPlan);
  assert.equal(failed.taskStatus, 'failed', '配音文件提交前已变化，不能把就绪结果落盘');
  assert.equal(failed.result, null);
  for (const task of listBatchTasks(db, batchId).filter(task => task.status === 'failed')) retryTask(db, 'p', task.id);
  await runPendingOnce({ db, workerId: 'retry-file', executors, log: () => {} });
  assert.equal(readFormulaNarration(db, 'p', batchId, firstPlan).stageId, failed.stageId);
  assert.equal(readFormulaNarration(db, 'p', batchId, firstPlan).status, 'ready');
  assert.throws(() => readFormulaNarration(db, 'foreign', batchId, request.outputs[0].planId), /不存在|不属于/);
  console.log('formula narration stage tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('formula-narration-stage-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
