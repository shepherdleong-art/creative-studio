import { seedLiveMixcutProjects, seedFormulaMaterialAnalysis } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-speech-stage-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction, createBatchProductionVersion } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy, listAssetSources, resolveSourceFilePath } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { readFormulaSpeech } = await import('../lib/live-mixcut/formula/speech-store.ts');
  const { formulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { reselectFormulaOutput, readFormulaSelectionHistory } = await import('../lib/live-mixcut/formula/reselection.ts');
  const { claimNextTask, recoverInterruptedWork, retryTask } = await import('../lib/live-mixcut/scheduler.ts');
  const { listBatchTasks } = await import('../lib/live-mixcut/tasks.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','逐输出声音');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const batchId = createBatchProduction(db, 'p', '同脚本两份', undefined, { planningMode: 'formula' });
  const file = path.join(root, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'G1_展示.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', batchId);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'G1 G1', '同一原片的重复镜头'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://speech.example.test';
  process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'test-only-secret';
  process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'whisper-1';
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'speech-start', settingsId: settings.saved!.id, expectedInputRevision: 2 });
  process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'changed-after-generation';
  const firstPlan = request.outputs[0].planId, secondPlan = request.outputs[1].planId;
  assert.equal(readFormulaSpeech(db, 'p', batchId, firstPlan).status, 'waiting_selection');
  assert.equal(await runPendingOnce({ db, workerId: 'speech-test', concurrency: 1, executors: [formulaStageExecutor], log: () => {} }), 6,
    '每份选片、原声检查及文案映射自动衔接，不依赖页面再次发请求');
  const first = readFormulaSpeech(db, 'p', batchId, firstPlan), second = readFormulaSpeech(db, 'p', batchId, secondPlan);
  assert.equal(first.status, 'inspected');
  assert.equal(first.executionReady, false);
  assert.equal(first.sources.length, 1, '同一份中重复使用同一素材只检查一次');
  assert.equal(first.sources[0].result?.status, 'no_audio_stream');
  assert.equal(first.sources[0].slotIds.length, 2);
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, firstPlan).current.speech, first,
    '原审片记录接口返回当前选片对应的原声检查');
  assert.notEqual(first.selectionStageId, second.selectionStageId);
  assert.notEqual(first.sources[0].id, second.sources[0].id, '同脚本多份声音记录分别归属');
  assert.equal(await runPendingOnce({ db, workerId: 'idle', executors: [formulaStageExecutor], log: () => {} }), 0);
  assert.deepEqual(readFormulaSpeech(db, 'p', batchId, firstPlan), first);
  assert.throws(() => readFormulaSpeech(db, 'another-project', batchId, firstPlan), /不存在|不属于/);
  const reselect = (key: string) => {
    const current = readFormulaSelectionHistory(db, 'p', batchId, firstPlan);
    return reselectFormulaOutput(db, 'p', batchId, firstPlan, { requestKey: key, expectedStageId: current.current.id,
      expectedOutputVersionId: null, expectedEditRevision: 0 });
  };
  reselect('second-selection');
  assert.equal(readFormulaSpeech(db, 'p', batchId, firstPlan).status, 'waiting_selection', '新选片不能显示旧声音为当前结果');
  let replacedSelection: string | null = null;
  await runPendingOnce({ db, workerId: 'late-speech', concurrency: 1, log: () => {}, executors: [{
    workTypes: ['formula_stage'], async execute(context) {
      const view = readFormulaSpeech(db, 'p', batchId, firstPlan);
      const prepared = await formulaStageExecutor.execute(context);
      if (!replacedSelection && view.sources.some(source => source.id === context.claim.task.targetId)) {
        replacedSelection = view.selectionStageId;
        reselect('changed-while-inspecting');
      }
      return prepared;
    },
  }] });
  assert(replacedSelection);
  assert.equal(readFormulaSpeech(db, 'p', batchId, firstPlan, replacedSelection).sources[0].result, null, '迟到的原声检查不能提交已被替代的修订');
  assert.equal(readFormulaSpeech(db, 'p', batchId, firstPlan).status, 'inspected');
  assert.deepEqual(readFormulaSpeech(db, 'p', batchId, secondPlan), second, '重选一份不会更新同脚本另一份声音');
  assert.deepEqual(readFormulaSpeech(db, 'p', batchId, firstPlan, first.selectionStageId), first, '历史声音依据保持可读且未被覆盖');

  reselect('restart-before-speech');
  const shutdown = new AbortController();
  await runPendingOnce({ db, workerId: 'select-then-close', concurrency: 1, shutdownSignal: shutdown.signal, log: () => {}, executors: [{
    workTypes: ['formula_stage'], async execute(context) {
      const prepared = await formulaStageExecutor.execute(context);
      return { ...prepared, commit() { const value = prepared.commit!(); queueMicrotask(() => shutdown.abort()); return value; } };
    },
  }] });
  const pending = readFormulaSpeech(db, 'p', batchId, firstPlan);
  assert.equal(pending.status, 'pending');
  const abandoned = claimNextTask(db, { workerId: 'closed-process' })!;
  assert.equal(abandoned.task.targetId, pending.sources[0].id);
  recoverInterruptedWork(db);
  assert.equal(await runPendingOnce({ db, workerId: 'restarted', executors: [formulaStageExecutor], log: () => {} }), 2);
  const recovered = readFormulaSpeech(db, 'p', batchId, firstPlan);
  assert.equal(recovered.status, 'inspected');
  assert.equal(recovered.sources[0].id, pending.sources[0].id, '恢复沿用原声音修订，不重抽输入');
  assert.deepEqual(readFormulaSpeech(db, 'p', batchId, secondPlan), second);
  const voiceBatch = createBatchProduction(db, 'p', '真实音轨检查', undefined, { planningMode: 'formula' });
  const voiceFile = path.join(root, 'voice.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', voiceFile]);
  const voiceAsset = await registerManagedCopy(db, 'p', { sourcePath: voiceFile });
  registerFormulaAssetBinding(db, 'p', voiceBatch, { assetId: voiceAsset, sourcePath: 'G1_原声.mp4' });
  await seedFormulaMaterialAnalysis({ db }, 'p', voiceBatch);
  const voiceImport = await createFormulaImportSession(db, 'p', voiceBatch, { kind: 'scripts', filename: '原声.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', voiceBatch, voiceImport.id, { expectedRevision: 1, excludedKeys: [] });
  const voiceSettings = await saveFormulaSettings(db, 'p', voiceBatch, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: voiceImport.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'whisper-1';
  const voiceRequest = await createFormulaGenerationRequest(db, 'p', voiceBatch, { requestKey: 'voice', settingsId: voiceSettings.saved!.id, expectedInputRevision: 2 });
  assert.equal(JSON.stringify(voiceRequest).includes('test-only-secret'), false, '制作快照不保存密钥');
  let calls = 0;
  let emptyReply = true;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal((init!.body as FormData).has('prompt'), false);
    if (emptyReply) return Response.json({ text: '', words: [] });
    return Response.json({ text: '原片台词。', words: [{ word: '原片台词', start: 0.1, end: 0.8 }] });
  };
  process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'changed-after-generation';
  await runPendingOnce({ db, workerId: 'config-changed', executors: [formulaStageExecutor], log: () => {} });
  assert.equal(calls, 0, '模型身份改变，旧任务不提交给新模型');
  assert.equal(readFormulaSpeech(db, 'p', voiceBatch, voiceRequest.outputs[0].planId).status, 'needs_attention');
  process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'whisper-1';
  for (const task of listBatchTasks(db, voiceBatch).filter(task => task.status === 'failed')) retryTask(db, 'p', task.id);
  await runPendingOnce({ db, workerId: 'config-restored', executors: [formulaStageExecutor], log: () => {} });
  assert.equal(listBatchTasks(db, voiceBatch).filter(task => task.status === 'failed').length, 2, '未识别出台词可按原任务重试，不能落成不可重试的成功');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const blockedWorkspace = getBatchWorkspace(db, 'p', voiceBatch);
  const blockedCard = blockedWorkspace.cards.find(card => card.planId === voiceRequest.outputs[0].planId)!;
  assert.equal(blockedCard.status, 'retryable_failed', '声音失败不能在第三步显示为一直处理中');
  assert.match(blockedCard.formula!.message, /核对原声/);
  assert(blockedCard.formula?.retryTaskId, '第三步必须提供原失败任务的重试入口');
  assert(blockedCard.blockers.length > 0, '没有时间轴时仍须展示真实阻塞原因');

  const restoredPath = resolveSourceFilePath(listAssetSources(db, voiceAsset).find(source => source.sourceKind === 'managed')!.locationJson);
  const restoredStat = fs.statSync(restoredPath);
  fs.utimesSync(restoredPath, restoredStat.atime, new Date(restoredStat.mtimeMs + 1_000));
  emptyReply = false;
  for (const task of listBatchTasks(db, voiceBatch).filter(task => task.status === 'failed')) retryTask(db, 'p', task.id);
  await runPendingOnce({ db, workerId: 'speech-retried', executors: [formulaStageExecutor], log: () => {} });
  const spoken = voiceRequest.outputs.map(output => readFormulaSpeech(db, 'p', voiceBatch, output.planId));
  assert(spoken.every(view => view.status === 'inspected' && view.sources[0].result?.status === 'transcribed'));
  assert.equal(calls, 3, '两份失败各调用一次；成功重试后同一原片、同一识别配置只再调用一次');
  assert.notEqual(spoken[0].sources[0].id, spoken[1].sources[0].id);
  assert.equal(spoken.filter(view => view.sources[0].result?.reusedFromStageId).length, 1,
    '复用识别依据也要保存自己的声音记录及来源');
  assert.equal(spoken[0].sources[0].result?.status === 'transcribed' && spoken[0].sources[0].result.text, '原片台词。');
  assert.equal(await runPendingOnce({ db, workerId: 'already-done', executors: [formulaStageExecutor], log: () => {} }), 0);
  assert.equal(calls, 3, '已完成声音阶段恢复时不重新调用服务');
  const voicePlan = voiceRequest.outputs[0].planId;
  const voiceHistory = readFormulaSelectionHistory(db, 'p', voiceBatch, voicePlan);
  reselectFormulaOutput(db, 'p', voiceBatch, voicePlan, { requestKey: 'reuse-after-reselection',
    expectedStageId: voiceHistory.current.id, expectedOutputVersionId: null, expectedEditRevision: 0 });
  const afterSelection = new AbortController();
  await runPendingOnce({ db, workerId: 'select-for-reuse', concurrency: 1, shutdownSignal: afterSelection.signal,
    log: () => {}, executors: [{ workTypes: ['formula_stage'], async execute(context) {
      const prepared = await formulaStageExecutor.execute(context);
      return { ...prepared, commit() { const value = prepared.commit!(); queueMicrotask(() => afterSelection.abort()); return value; } };
    } }] });
  assert.equal(readFormulaSpeech(db, 'p', voiceBatch, voicePlan).status, 'pending');
  const temporarilyMoved = `${restoredPath}.test-moved`;
  assert.equal(fs.existsSync(temporarilyMoved), false);
  fs.renameSync(restoredPath, temporarilyMoved);
  try {
    await runPendingOnce({ db, workerId: 'missing-with-cache', executors: [formulaStageExecutor], log: () => {} });
    assert.equal(readFormulaSpeech(db, 'p', voiceBatch, voicePlan).status, 'needs_attention', '旧识别结果不能掩盖当前原片已丢失');
    assert.equal(readFormulaSpeech(db, 'p', voiceBatch, voicePlan).sources[0].result, null);
  } finally { fs.renameSync(temporarilyMoved, restoredPath); }
  for (const task of listBatchTasks(db, voiceBatch).filter(task => task.status === 'failed')) retryTask(db, 'p', task.id);
  await runPendingOnce({ db, workerId: 'restored-reuse', executors: [formulaStageExecutor], log: () => {} });
  const reused = readFormulaSpeech(db, 'p', voiceBatch, voicePlan);
  assert.equal(reused.status, 'inspected');
  assert(reused.sources[0].result?.reusedFromStageId);
  assert.equal(calls, 3, '恢复同一原片后重选仍可复用已保存识别，不再上传');
  assert.deepEqual(readFormulaSpeech(db, 'p', voiceBatch, voicePlan, spoken[0].selectionStageId), spoken[0]);
  assert.deepEqual(readFormulaSpeech(db, 'p', voiceBatch, voiceRequest.outputs[1].planId), spoken[1]);
  process.env.FINAL_EDIT_ALIGNMENT_MODEL = 'another-recognition-model';
  createBatchProductionVersion(db, voiceBatch, { copyCount: 2 });
  const changedService = await createFormulaGenerationRequest(db, 'p', voiceBatch, { requestKey: 'new-recognition',
    settingsId: voiceSettings.saved!.id, expectedInputRevision: 2 });
  await runPendingOnce({ db, workerId: 'different-service', executors: [formulaStageExecutor], log: () => {} });
  assert.equal(calls, 4, '新制作使用不同模型时重新识别；同一模型的两份仍只识别一次');
  for (const output of changedService.outputs) {
    const result = readFormulaSpeech(db, 'p', voiceBatch, output.planId).sources[0].result;
    assert(result?.status === 'transcribed');
    assert.ok(result.transcriptionIdentity, '自动识别不能冒充人工记录');
    assert.equal(result.transcriptionIdentity.model, 'another-recognition-model');
  }
  console.log('formula speech stage tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const resolved = fs.realpathSync(root);
  assert(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('formula-speech-stage-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
