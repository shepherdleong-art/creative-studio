import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-audio-stage-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://speech.example.test';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
const db = new Database(path.join(root, 'test.db'));
const originalFetch = globalThis.fetch;
try {
  const { readFormulaAudioMapping } = await import('../lib/live-mixcut/formula/audio-mapping-store.ts');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { readFormulaSelectionHistory, reselectFormulaOutput } = await import('../lib/live-mixcut/formula/reselection.ts');
  const { listBatchTasks, createBatchTask } = await import('../lib/live-mixcut/tasks.ts');
  const { retryTask } = await import('../lib/live-mixcut/scheduler.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','原声加配音');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const batchId = createBatchProduction(db, 'p', '两份分别编排', undefined, { planningMode: 'formula' });
  for (const index of [1, 2]) {
    const file = path.join(root, `source-${index}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${index === 1 ? 'red' : 'blue'}:s=64x64:r=24:d=2`,
      ...(index === 1 ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-shortest'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
    const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
    registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: `G${index}_测试.mp4` });
  }
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'G1 G2', '好擦洗。坐得稳。'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 2, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'mapping', settingsId: settings.saved!.id, expectedInputRevision: 3 });
  globalThis.fetch = async () => Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 0.2, end: 1.2 }] });
  let modelCalls = 0;
  let brokenMapping = false;
  const executor = createFormulaStageExecutor(async () => ({ id: 'fixture', name: '测试模型', model: 'fixture', async complete(input) {
    modelCalls++;
    if (brokenMapping) return { blocks: [] };
    const prompt = JSON.parse(input.userPrompt);
    return { blocks: [{ text: '好擦洗。', kind: 'source', slotId: prompt.sources[0].slotId },
      { text: '坐得稳。', kind: 'tts', slotIds: prompt.narrationWindows[0] }] };
  } }));
  assert.equal(readFormulaAudioMapping(db, 'p', batchId, request.outputs[0].planId).result, null);
  await runPendingOnce({ db, workerId: 'audio-pipeline', executors: [executor], log: () => {} });
  const views = request.outputs.map(output => readFormulaAudioMapping(db, 'p', batchId, output.planId));
  assert(views.every(view => view.result?.status === 'mapped'), '后台在每份原声结果齐备后自动映射文案，不依赖页面续跑');
  assert.notEqual(views[0].stageId, views[1].stageId);
  for (const view of views) {
    assert(view.result?.status === 'mapped');
    assert.equal(view.result.narrations[0].text, '坐得稳。');
    assert.equal(view.result.executionReady, false, '映射完成不等于真实配音就绪');
  }
  assert.equal(modelCalls, 2, '每份的覆盖关系分别保存，不按脚本广播更新');
  assert.equal(await runPendingOnce({ db, workerId: 'idle', executors: [executor], log: () => {} }), 0);
  assert.equal(modelCalls, 2);
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, request.outputs[0].planId).current.audioMapping, views[0]);
  // 迁移夹具：v14 只保存选片和原声，尚无 v15 映射阶段；通过公开 worker 恢复续接。
  db.prepare("DELETE FROM live_mixcut_tasks WHERE workType='formula_stage' AND targetId=?").run(views[0].stageId);
  db.prepare('DELETE FROM live_mixcut_formula_audio_mapping_results WHERE stageId=?').run(views[0].stageId);
  db.prepare('DELETE FROM live_mixcut_formula_audio_mapping_stages WHERE id=?').run(views[0].stageId);
  assert.equal(readFormulaAudioMapping(db, 'p', batchId, request.outputs[0].planId).stageId, null);
  db.exec("CREATE TRIGGER fail_audio_recovery BEFORE INSERT ON live_mixcut_formula_audio_mapping_stages BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END;");
  const ordinary = createBatchProduction(db, 'p', '普通任务不受恢复失败影响');
  const preparedMapping = views[0].result;
  assert(preparedMapping?.status === 'mapped');
  createBatchTask(db, 'p', { batchId: ordinary, workType: 'asset_prepare', targetKind: 'asset',
    targetId: preparedMapping.sources[0].assetId });
  const recoveryLogs: string[] = [];
  assert.equal(await runPendingOnce({ db, workerId: 'recovery-failure', executors: [executor,
    { workTypes: ['asset_prepare'], execute: async () => ({ resultJson: { ordinary: true } }) }],
    log: event => recoveryLogs.push(event.message) }), 1, '公式续接故障不能挡住普通批量任务');
  assert(recoveryLogs.some(message => message.includes('续接')));
  db.exec('DROP TRIGGER fail_audio_recovery');
  await runPendingOnce({ db, workerId: 'resume-old-release', executors: [executor], log: () => {} });
  views[0] = readFormulaAudioMapping(db, 'p', batchId, request.outputs[0].planId);
  assert.equal(views[0].result?.status, 'mapped', '升级后的后台补齐未建立的新阶段，无需页面再次点击生成');
  assert.equal(modelCalls, 3);
  assert.deepEqual(readFormulaAudioMapping(db, 'p', batchId, request.outputs[1].planId), views[1]);
  const firstPlan = request.outputs[0].planId;
  const reselect = (key: string) => {
    const current = readFormulaSelectionHistory(db, 'p', batchId, firstPlan);
    return reselectFormulaOutput(db, 'p', batchId, firstPlan, { requestKey: key, expectedStageId: current.current.id,
      expectedOutputVersionId: null, expectedEditRevision: 0 });
  };
  reselect('mapping-then-reselect');
  let superseded: string | null = null;
  await runPendingOnce({ db, workerId: 'late-mapping', concurrency: 1, log: () => {}, executors: [{ workTypes: ['formula_stage'], async execute(context) {
    const current = readFormulaAudioMapping(db, 'p', batchId, firstPlan);
    const prepared = await executor.execute(context);
    if (!superseded && current.stageId === context.claim.task.targetId) {
      superseded = current.selectionStageId;
      reselect('changed-before-mapping-commit');
    }
    return prepared;
  } }] });
  assert(superseded);
  assert.equal(readFormulaAudioMapping(db, 'p', batchId, firstPlan, superseded).result, null, '迟到的声音映射不能提交旧选片修订');
  assert.equal(readFormulaAudioMapping(db, 'p', batchId, firstPlan).result?.status, 'mapped');
  assert.deepEqual(readFormulaAudioMapping(db, 'p', batchId, firstPlan, views[0].selectionStageId), views[0]);
  assert.deepEqual(readFormulaAudioMapping(db, 'p', batchId, request.outputs[1].planId), views[1]);
  reselect('retry-mapping');
  brokenMapping = true;
  await runPendingOnce({ db, workerId: 'invalid-response', executors: [executor], log: () => {} });
  const failed = readFormulaAudioMapping(db, 'p', batchId, firstPlan);
  assert.equal(failed.taskStatus, 'failed');
  assert.equal(failed.result, null);
  brokenMapping = false;
  for (const task of listBatchTasks(db, batchId).filter(task => task.status === 'failed')) retryTask(db, 'p', task.id);
  await runPendingOnce({ db, workerId: 'retry-response', executors: [executor], log: () => {} });
  assert.equal(readFormulaAudioMapping(db, 'p', batchId, firstPlan).stageId, failed.stageId);
  assert.equal(readFormulaAudioMapping(db, 'p', batchId, firstPlan).result?.status, 'mapped');
  assert.throws(() => readFormulaAudioMapping(db, 'foreign', batchId, request.outputs[0].planId), /不存在|不属于/);
  console.log('formula audio stage tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  const resolved = fs.realpathSync(root);
  assert(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('formula-audio-stage-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
