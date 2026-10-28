import { seedLiveMixcutProjects, seedFormulaMaterialAnalysis } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-reselection-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
const { readFormulaSelection, queueFormulaSelection } = await import('../lib/live-mixcut/formula/selection-store.ts');
const { readFormulaSelectionHistory, reselectFormulaOutput } = await import('../lib/live-mixcut/formula/reselection.ts');
const { formulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
const { createOutputVersion, getOutputVersion, getOutputPlan } = await import('../lib/live-mixcut/plans.ts');
const { listBatchTasks } = await import('../lib/live-mixcut/tasks.ts');
const { pauseBatch, resumeBatch, recoverInterruptedWork, claimNextTask } = await import('../lib/live-mixcut/scheduler.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','重选'),('other','其他项目');");
  const readiness = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  const batchId = createBatchProduction(db, 'p', '逐条重选', undefined, { planningMode: 'formula' });
  const assets: string[] = [];
  for (const [index, color] of ['red', 'blue'].entries()) {
    const source = path.join(root, `${color}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
    const assetId = await registerManagedCopy(db, 'p', { sourcePath: source });
    assets.push(assetId);
    registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: `G${index + 1}_${color}.mp4` });
  }
  await seedFormulaMaterialAnalysis({ db }, 'p', batchId);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'G1 G1', '同一脚本做两份'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 2, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'first', settingsId: settings.saved!.id, expectedInputRevision: 3 });
  assert.equal(await runPendingOnce({ db, workerId: 'first', executors: [formulaStageExecutor], log: () => {} }), 6);
  const [first, second] = request.outputs;
  const original = readFormulaSelection(db, 'p', batchId, first.planId)!;
  const untouched = readFormulaSelection(db, 'p', batchId, second.planId)!;
  const before = readFormulaSelectionHistory(db, 'p', batchId, first.planId);
  assert.equal(before.current.revision, 1);
  const input = { requestKey: 'choose-blue', expectedStageId: before.current.id, expectedOutputVersionId: null, expectedEditRevision: 0,
    overrides: [{ slotId: first.slots[0].slotId, sourceLogicalCode: 'G2', assetId: assets[1] }] };
  const queued = reselectFormulaOutput(db, 'p', batchId, first.planId, input);
  assert.equal(queued.current.revision, 2);
  assert.equal(queued.current.result, null);
  assert.equal(readFormulaSelection(db, 'p', batchId, first.planId), null, '重选排队时不能把旧结果冒充当前结果');
  assert.deepEqual(queued.history[1].result, original);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, second.planId), untouched);
  assert.equal(await runPendingOnce({ db, workerId: 'reselect', executors: [formulaStageExecutor], log: () => {} }), 4, '换片后分别检查两个实际来源，再映射文案');
  const current = readFormulaSelection(db, 'p', batchId, first.planId)!;
  assert.deepEqual(current.slots.map(slot => slot.assetId), [assets[1], assets[0]]);
  assert.deepEqual(current.slots.map(slot => slot.slotId), first.slots.map(slot => slot.slotId));
  assert.deepEqual(current.slots.map(slot => slot.logicalCode), ['G1', 'G1']);
  assert.equal(current.slots[0].sourceLogicalCode, 'G2');
  assert.equal(current.slots[0].reason, 'manual_slot');
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, second.planId), untouched, '同脚本另一份不跟着换片');
  assert.equal(reselectFormulaOutput(db, 'p', batchId, first.planId, input).current.id, queued.current.id, '重复请求只返回已有修订');
  queueFormulaSelection(db, 'p', batchId, request.id);
  assert.equal(await runPendingOnce({ db, workerId: 'resume', executors: [formulaStageExecutor], log: () => {} }), 0);
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, first.planId).history[1].result, original);

  assert.throws(() => readFormulaSelectionHistory(db, 'other', batchId, first.planId), /不存在|项目/);
  assert.throws(() => reselectFormulaOutput(db, 'p', batchId, second.planId, input), /变化/);
  assert.throws(() => reselectFormulaOutput(db, 'p', batchId, first.planId, { ...input, requestKey: 'stale-window' }), /更新/);
  assert.throws(() => reselectFormulaOutput(db, 'p', batchId, first.planId, { ...input, overrides: [] }), /同一个/);
  const expected = { expectedStageId: queued.current.id, expectedOutputVersionId: null, expectedEditRevision: 0 };
  assert.throws(() => reselectFormulaOutput(db, 'p', batchId, first.planId, { ...expected, requestKey: 'foreign-slot',
    overrides: [{ ...input.overrides[0], slotId: second.slots[0].slotId }] }), /镜头/);
  assert.throws(() => reselectFormulaOutput(db, 'p', batchId, first.planId, { ...expected, requestKey: 'wrong-source',
    overrides: [{ ...input.overrides[0], sourceLogicalCode: 'G9' }] }), /候选/);
  assert.equal(readFormulaSelectionHistory(db, 'p', batchId, first.planId).history.length, 2);

  const oldVersion = createOutputVersion(db, first.planId, { arrangementJson: { editRevision: 3, review: { decision: 'approved' } } });
  const otherVersion = createOutputVersion(db, second.planId, { arrangementJson: { editRevision: 1 } });
  const next = { requestKey: 'reset-to-auto', expectedStageId: queued.current.id, expectedOutputVersionId: oldVersion, expectedEditRevision: 3, overrides: [] };
  assert.throws(() => reselectFormulaOutput(db, 'p', batchId, first.planId, { ...next, expectedEditRevision: 2 }), /更新/);
  const reset = reselectFormulaOutput(db, 'p', batchId, first.planId, next);
  assert.equal(reset.current.revision, 3);
  assert.equal(getOutputPlan(db, request.batchVersionId, first.planId)?.currentVersionId, null, '新修订不能继续沿用旧成片的审核/导出候选');
  assert.ok(getOutputVersion(db, first.planId, oldVersion), '历史成片版本仍然可读取');
  assert.equal(getOutputPlan(db, request.batchVersionId, second.planId)?.currentVersionId, otherVersion);
  pauseBatch(db, 'p', batchId);
  assert.equal(await runPendingOnce({ db, workerId: 'paused', executors: [formulaStageExecutor], log: () => {} }), 0);
  resumeBatch(db, 'p', batchId);
  const abandoned = claimNextTask(db, { workerId: 'interrupted-process' })!;
  assert.equal(abandoned.task.targetId, reset.current.id);
  recoverInterruptedWork(db);
  assert.equal(await runPendingOnce({ db, workerId: 'restart', executors: [formulaStageExecutor], log: () => {} }), 3);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, first.planId)?.slots.map(slot => slot.assetId), [assets[0], assets[0]], '显式清除单镜头指定后才恢复自动规则');

  // 正在执行的旧修订被新修订替代后，其迟到的结果不能提交。
  const running = reselectFormulaOutput(db, 'p', batchId, first.planId, { ...next, requestKey: 'running-old',
    expectedStageId: reset.current.id, expectedOutputVersionId: null, expectedEditRevision: 0 });
  let superseded = false;
  await runPendingOnce({ db, workerId: 'race', concurrency: 1, log: () => {}, executors: [{ workTypes: ['formula_stage'],
    async execute(context) {
      const prepared = await formulaStageExecutor.execute(context);
      if (!superseded) {
        superseded = true;
        reselectFormulaOutput(db, 'p', batchId, first.planId, { ...input, requestKey: 'running-new', expectedStageId: running.current.id });
      }
      return prepared;
    },
  }] });
  const afterRace = readFormulaSelectionHistory(db, 'p', batchId, first.planId);
  assert.equal(afterRace.current.revision, 5);
  assert.equal(afterRace.history.find(item => item.id === running.current.id)?.result, null, '旧执行不能回写为新输出');
  assert.equal(afterRace.history.find(item => item.id === running.current.id)?.task?.status, 'cancelled');
  assert.deepEqual(afterRace.current.result?.slots.map(slot => slot.assetId), [assets[1], assets[0]]);
  assert.ok(listBatchTasks(db, batchId).every(task => task.status !== 'running'));
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  console.log('公式重选：逐条新修订、单槽位指定、旧结果保留和幂等恢复通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
