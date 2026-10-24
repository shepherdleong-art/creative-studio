import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-selection-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction, createBatchProductionVersion, getBatchProduction } = await import('../lib/live-mixcut/versions.ts');
const { registerManagedCopy, listAssetSources, resolveSourceFilePath } = await import('../lib/live-mixcut/media-catalog.ts');
const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
const { queueFormulaSelection, readFormulaSelection } = await import('../lib/live-mixcut/formula/selection-store.ts');
const { formulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
const { listBatchTasks, createBatchTask } = await import('../lib/live-mixcut/tasks.ts');
const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
const { pauseBatch, resumeBatch, claimNextTask, recoverInterruptedWork } = await import('../lib/live-mixcut/scheduler.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');

const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const batchId = createBatchProduction(db, 'p', '按公式选片', undefined, { planningMode: 'formula' });
  const video = path.join(root, 'original.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: video });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: 'G1_正面.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'G1 G1', '保留重复镜头'],
    [141, '抖音', 1, 16, 'VO1', '缺素材的一条'],
  ]);
  const draft = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, draft.id, { expectedRevision: 1, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: draft.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'start', settingsId: settings.saved!.id, expectedInputRevision: 2 });
  const tasks = queueFormulaSelection(db, 'p', batchId, request.id);
  assert.equal(getBatchProduction(db, 'p', batchId)?.status, 'running', '正式接受制作请求后不能仍显示为草稿');
  assert.equal(tasks.length, 3);
  assert.deepEqual(queueFormulaSelection(db, 'p', batchId, request.id), tasks);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
  const ordinary = createBatchProduction(db, 'p', '普通任务继续');
  createBatchTask(db, 'p', { batchId: ordinary, workType: 'asset_prepare', targetKind: 'asset', targetId: assetId });
  assert.equal(await runPendingOnce({ db, workerId: 'disabled', executors: [formulaStageExecutor,
    { workTypes: ['asset_prepare'], execute: async () => ({ resultJson: { ordinary: true } }) }], log: () => {} }), 1,
    '关闭公式能力只能领取普通任务');
  assert.ok(listBatchTasks(db, batchId).every(task => task.status === 'queued'));
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  assert.equal(await runPendingOnce({ db, workerId: 'test', executors: [formulaStageExecutor], log: () => {} }), 7, '三条选片，素材齐全的两份各衔接原声检查和文案映射');
  const selected = readFormulaSelection(db, 'p', batchId, request.outputs[0].planId)!;
  assert.equal(selected.status, 'selected');
  assert.deepEqual(selected.slots.map(slot => slot.assetId), [assetId, assetId]);
  assert.deepEqual(selected.slots.map(slot => slot.slotId), request.outputs[0].slots.map(slot => slot.slotId));
  assert.equal(selected.slots[0].media?.durationUs, 500_000);
  assert.equal(selected.slots[0].rangeStatus, 'pending', '选中文件不代表台词和动作区间已核验');
  assert.equal(readFormulaSelection(db, 'p', batchId, request.outputs[2].planId)?.status, 'needs_attention');
  assert.ok(listBatchTasks(db, batchId).every(task => task.status === 'succeeded'));
  assert.equal(await runPendingOnce({ db, workerId: 'retry', executors: [formulaStageExecutor], log: () => {} }), 0);
  async function nextRequest(key: string) {
    createBatchProductionVersion(db, batchId, { copyCount: 3 });
    return createFormulaGenerationRequest(db, 'p', batchId, { requestKey: key, settingsId: settings.saved!.id, expectedInputRevision: 2 });
  }
  const interrupted = await nextRequest('off-during-run');
  assert.equal(await runPendingOnce({ db, workerId: 'turn-off', concurrency: 1, log: () => {}, executors: [{
    workTypes: ['formula_stage'], async execute(context) {
      const prepared = await formulaStageExecutor.execute(context);
      process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '0';
      return prepared;
    },
  }] }), 1);
  assert.equal(readFormulaSelection(db, 'p', batchId, interrupted.outputs[0].planId), null, '关掉能力后迟到结果不能落库');
  assert.equal(listBatchTasks(db, batchId).filter(task => task.status === 'queued').length, 3);
  process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
  pauseBatch(db, 'p', batchId);
  assert.equal(await runPendingOnce({ db, workerId: 'paused', executors: [formulaStageExecutor], log: () => {} }), 0);
  resumeBatch(db, 'p', batchId);
  const crashed = claimNextTask(db, { workerId: 'old-process' })!;
  assert.equal(crashed.task.workType, 'formula_stage');
  recoverInterruptedWork(db);
  assert.equal(await runPendingOnce({ db, workerId: 'restarted', executors: [formulaStageExecutor], log: () => {} }), 7);
  assert.ok(readFormulaSelection(db, 'p', batchId, interrupted.outputs[0].planId));
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, request.outputs[0].planId), selected, '旧请求的选片记录不受新任务影响');

  const old = await nextRequest('old-version');
  let newer: typeof old | null = null;
  await runPendingOnce({ db, workerId: 'superseded', concurrency: 1, log: () => {}, executors: [{
    workTypes: ['formula_stage'], async execute(context) {
      const prepared = await formulaStageExecutor.execute(context);
      if (!newer) newer = await nextRequest('new-version');
      return prepared;
    },
  }] });
  assert.ok(newer);
  assert.equal(readFormulaSelection(db, 'p', batchId, old.outputs[0].planId), null, '切换输入后不能提交旧选片结果');
  assert.equal(listBatchTasks(db, batchId).filter(task => task.status === 'queued' || task.status === 'running').length, 0);
  assert.equal(listBatchTasks(db, batchId).filter(task => task.status === 'cancelled').length, 3);
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const alternateVideo = path.join(root, 'alternate.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', alternateVideo]);
  const alternate = await registerManagedCopy(db, 'p', { sourcePath: alternateVideo });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: alternate, sourcePath: '另一份/G1_正面.mp4' });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: alternate, sourcePath: 'VO1.preview.mp4' });
  const fallback = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'corrupted-candidate', settingsId: settings.saved!.id, expectedInputRevision: 4 });
  const [bad, good] = [assetId, alternate].sort();
  const frozenSource = listAssetSources(db, bad).find(source => source.sourceKind === 'managed')!;
  const controlled = resolveSourceFilePath(frozenSource.locationJson);
  const relative = path.relative(root, controlled);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const originalBytes = fs.readFileSync(controlled);
  fs.writeFileSync(controlled, '同一路径被换成了另一份内容');
  await runPendingOnce({ db, workerId: 'fallback', executors: [formulaStageExecutor], log: () => {} });
  const fallbackSelection = readFormulaSelection(db, 'p', batchId, fallback.outputs[0].planId)!;
  assert.deepEqual(fallbackSelection.slots.map(slot => slot.assetId), [good, good], '坏候选不能蒙混过关，改选同号的真实可用文件');
  assert.equal(fallbackSelection.slots[0].reason, 'same_code_stable_choice');
  assert.equal(readFormulaSelection(db, 'p', batchId, fallback.outputs[2].planId)?.slots[0].assetId, null, 'preview 文件不能充当正式口播素材');
  fs.writeFileSync(controlled, originalBytes);
  queueFormulaSelection(db, 'p', batchId, fallback.id);
  assert.equal(await runPendingOnce({ db, workerId: 'keep-decision', executors: [formulaStageExecutor], log: () => {} }), 0);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, fallback.outputs[0].planId), fallbackSelection, '补回较早候选不改写已保存选片');
  const { readFormulaSelectionRules, saveFormulaSelectionRules } = await import('../lib/live-mixcut/formula/selection-rules.ts');
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const rules = readFormulaSelectionRules(db, 'p', batchId);
  const manual = saveFormulaSelectionRules(db, 'p', batchId, {
    expectedInputRevision: rules.inputRevision, expectedRulesRevision: 0, scriptsSessionId: rules.scriptsSessionId,
    rules: { primary: [{ logicalCode: 'G1', assetId: good }], overrides: [] },
  });
  const fixed = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'manual-primary',
    settingsId: settings.saved!.id, expectedInputRevision: manual.inputRevision });
  await runPendingOnce({ db, workerId: 'manual-primary', executors: [formulaStageExecutor], log: () => {} });
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, fixed.outputs[0].planId)!.slots.map(slot => slot.assetId), [good, good],
    '人工主片应优先于稳定排序靠前的另一份可用素材');
  assert.equal(readFormulaSelection(db, 'p', batchId, fixed.outputs[0].planId)!.slots[0].reason, 'manual_primary');
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: bad, sourcePath: 'G2_手动替换.mp4' });
  const overrideView = readFormulaSelectionRules(db, 'p', batchId);
  const overridden = saveFormulaSelectionRules(db, 'p', batchId, {
    expectedInputRevision: overrideView.inputRevision, expectedRulesRevision: overrideView.saved!.revision,
    scriptsSessionId: overrideView.scriptsSessionId,
    rules: { primary: [{ logicalCode: 'G1', assetId: good }],
      overrides: [{ scriptKey: '1:2', slotIndex: 0, logicalCode: 'G1', sourceLogicalCode: 'G2', assetId: bad }] },
  });
  const overrideRequest = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'manual-slot',
    settingsId: settings.saved!.id, expectedInputRevision: overridden.inputRevision });
  await runPendingOnce({ db, workerId: 'manual-slot', executors: [formulaStageExecutor], log: () => {} });
  for (const output of overrideRequest.outputs.slice(0, 2)) {
    const decision = readFormulaSelection(db, 'p', batchId, output.planId)!;
    assert.deepEqual(decision.slots.map(slot => slot.assetId), [bad, good], '只覆盖第一处 G1，第二处仍用主片，两份脚本均遵守同一规则');
    assert.equal(decision.slots[0].reason, 'manual_slot');
    assert.equal(decision.slots[0].sourceLogicalCode, 'G2', '原公式编号和人工指定的实际编号分别保留');
  }
  const savedRules = readFormulaSelectionRules(db, 'p', batchId);
  const validRules = { primary: [{ logicalCode: 'G1', assetId: good }],
    overrides: [{ scriptKey: '1:2', slotIndex: 0, logicalCode: 'G1', sourceLogicalCode: 'G2', assetId: bad }] };
  const saveInput = { expectedInputRevision: savedRules.inputRevision, expectedRulesRevision: savedRules.saved!.revision,
    scriptsSessionId: savedRules.scriptsSessionId, rules: validRules };
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, saveInput), /冻结/);
  assert.throws(() => readFormulaSelectionRules(db, '其他项目', batchId), /不存在|项目/);
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { ...saveInput, expectedRulesRevision: 0 }), /更新/);
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { ...saveInput,
    rules: { primary: [{ logicalCode: 'VO1', assetId: alternate }], overrides: [] } }), /同号素材/);
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { ...saveInput,
    rules: { primary: [], overrides: [{ ...validRules.overrides[0], slotIndex: 99 }] } }), /镜头/);
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { ...saveInput,
    rules: { primary: [], overrides: [validRules.overrides[0], validRules.overrides[0]] } }), /重复/);
  assert.deepEqual(readFormulaSelectionRules(db, 'p', batchId).saved, savedRules.saved, '拒绝非法修改时保留原选择');
  const unavailable = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'manual-file-lost',
    settingsId: settings.saved!.id, expectedInputRevision: savedRules.inputRevision });
  fs.writeFileSync(controlled, '指定的文件损坏，不能改选另一份');
  await runPendingOnce({ db, workerId: 'manual-file-lost', executors: [formulaStageExecutor], log: () => {} });
  const missingFixed = readFormulaSelection(db, 'p', batchId, unavailable.outputs[0].planId)!;
  assert.equal(missingFixed.status, 'needs_attention');
  assert.deepEqual(missingFixed.slots.map(slot => slot.assetId), [null, good]);
  assert.equal(missingFixed.slots[0].reason, 'manual_unusable');
  fs.writeFileSync(controlled, originalBytes);
  queueFormulaSelection(db, 'p', batchId, unavailable.id);
  assert.equal(await runPendingOnce({ db, workerId: 'keep-manual', executors: [formulaStageExecutor], log: () => {} }), 0);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, unavailable.outputs[0].planId), missingFixed);
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  book.getWorksheet('脚本')!.getRow(2).getCell(6).value = '脚本已修订，旧镜头指定需要重新核对';
  const revised = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本修订.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: savedRules.inputRevision });
  confirmFormulaImportSession(db, 'p', batchId, revised.id, { expectedRevision: savedRules.inputRevision, excludedKeys: [] });
  const staleRules = readFormulaSelectionRules(db, 'p', batchId);
  assert.equal(staleRules.stale, true);
  const revisedSettings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: staleRules.inputRevision,
    expectedSettingsRevision: settings.saved!.revision, scriptsSessionId: revised.id, settings: settings.saved!.settings });
  await assert.rejects(createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'stale-slot',
    settingsId: revisedSettings.saved!.id, expectedInputRevision: staleRules.inputRevision }), /单镜头指定/);
  saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: staleRules.inputRevision,
    expectedRulesRevision: staleRules.saved!.revision, scriptsSessionId: revised.id, rules: { primary: validRules.primary, overrides: [] } });
  assert.equal(readFormulaSelectionRules(db, 'p', batchId).stale, false);
  assert.equal(overrideRequest.input.selectionRules!.rules.overrides[0].sourceLogicalCode, 'G2', '脚本修订和清除旧指定不改冻结请求');
  assert.equal((await checkBatchProductionReadiness(options)).available, true, '带真实阶段和历史任务的数据仍通过完整归属检查');
  seedLiveMixcutProjects(options, ['p']);
  console.log('公式选片：共享任务队列、重复槽位、实际文件核验及逐条缺片状态通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
