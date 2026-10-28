import { seedLiveMixcutProjects, seedFormulaMaterialAnalysis } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-ranges-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction, createBatchProductionVersion } = await import('../lib/live-mixcut/versions.ts');
const { registerManagedCopy, listAssetSources, resolveSourceFilePath } = await import('../lib/live-mixcut/media-catalog.ts');
const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','区间与轮换');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const batchId = createBatchProduction(db, 'p', '已批准候选轮换', undefined, { planningMode: 'formula' });
  const assets: string[] = [];
  for (const color of ['red', 'blue', 'green', 'white']) {
    const file = path.join(root, `${color}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=50:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
    const assetId = await registerManagedCopy(db, 'p', { sourcePath: file });
    assets.push(assetId);
    registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: `G1_${color}${color === 'green' ? '.preview' : ''}.mp4` });
  }
  await seedFormulaMaterialAnalysis({ db }, 'p', batchId);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'G1 G1', '重复槽位轮换'], [141, '抖音', 1, 16, 'G1', '第二条脚本'],
  ]);
  const draft = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '轮换.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 4 });
  confirmFormulaImportSession(db, 'p', batchId, draft.id, { expectedRevision: 4, excludedKeys: [] });
  const { readFormulaAssetRanges, saveFormulaAssetRanges } = await import('../lib/live-mixcut/formula/asset-ranges.ts');
  const view = readFormulaAssetRanges(db, 'p', batchId);
  const saved = await saveFormulaAssetRanges(db, 'p', batchId, { assetId: assets[0], expectedInputRevision: view.inputRevision,
    expectedRangeRevision: 0, contentFingerprint: view.items.find(item => item.assetId === assets[0])!.contentFingerprint,
    confirmed: true, ranges: [{ label: '完整展示', inUs: 200_000, outUs: 1_800_000, protected: { inUs: 400_000, outUs: 1_200_000 } }] });
  const approved = saved.items.find(item => item.assetId === assets[0])!.saved!;
  assert.equal(approved.origin, 'manual');
  assert.equal(approved.audioStatus, 'pending', '人工确认画面不等于台词或声音已核验');
  assert.equal(approved.mediaDurationUs, 2_000_000);
  assert.equal(approved.ranges[0].inUs, 200_000);
  assert.equal(approved.ranges[0].outUs, 1_800_000);
  assert.deepEqual(approved.ranges[0].protected, { inUs: 400_000, outUs: 1_200_000 });
  assert.equal(readFormulaAssetRanges(db, 'p', batchId).items.find(item => item.assetId === assets[0])!.saved!.id, approved.id);
  const edit = { assetId: assets[0], expectedInputRevision: saved.inputRevision, expectedRangeRevision: 1,
    contentFingerprint: approved.contentFingerprint, confirmed: true };
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, confirmed: false,
    ranges: [{ inUs: 0, outUs: 2_000_000 }] }), /确认/);
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, ranges: [{ inUs: 0, outUs: 2_100_000 }] }), /实际时长/);
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, ranges: [{ inUs: 0, outUs: 100_000 }] }), /12 个/);
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit,
    ranges: [{ inUs: 200_000, outUs: 1_800_000, protected: { inUs: 0, outUs: 1_000_000 } }] }), /保护动作/);
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, contentFingerprint: 'sha256:不是这份文件', ranges: [] }), /内容已变化/);
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, assetId: assets[2], ranges: [] }), /正式编号素材/);
  assert.equal(readFormulaAssetRanges(db, 'p', batchId).inputRevision, saved.inputRevision, '无效区间不改资料或批准记录');
  const originalPath = resolveSourceFilePath(listAssetSources(db, assets[0]).find(source => source.sourceKind === 'managed')!.locationJson);
  assert(path.resolve(originalPath).startsWith(path.resolve(root) + path.sep));
  const originalBytes = fs.readFileSync(originalPath);
  fs.writeFileSync(originalPath, '原片内容已被替换');
  try { await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, ranges: [{ inUs: 0, outUs: 1_000_000 }] }), /无法核验原片/); }
  finally { fs.writeFileSync(originalPath, originalBytes); }
  const second = await saveFormulaAssetRanges(db, 'p', batchId, { assetId: assets[1], expectedInputRevision: saved.inputRevision,
    expectedRangeRevision: 0, contentFingerprint: saved.items.find(item => item.assetId === assets[1])!.contentFingerprint,
    confirmed: true, ranges: [{ label: '另一份完整展示', inUs: 0, outUs: 2_000_000, protected: null }] });
  const secondApproval = second.items.find(item => item.assetId === assets[1])!.saved!;
  const { saveFormulaSelectionRules } = await import('../lib/live-mixcut/formula/selection-rules.ts');
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: second.inputRevision,
    expectedRulesRevision: 0, scriptsSessionId: draft.id, rules: { primary: [], overrides: [], rotation: [{ logicalCode: 'G1',
      candidates: [{ assetId: assets[3], rangeRevisionId: approved.id }] }] } }), /当前已确认区间/);
  const rotated = saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: second.inputRevision,
    expectedRulesRevision: 0, scriptsSessionId: draft.id, rules: { primary: [], overrides: [], rotation: [{ logicalCode: 'G1',
      candidates: [{ assetId: assets[0], rangeRevisionId: approved.id }, { assetId: assets[1], rangeRevisionId: secondApproval.id }] }] } });
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: rotated.inputRevision, expectedSettingsRevision: 0,
    scriptsSessionId: draft.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  const { createFormulaGenerationRequest, readFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { selectFormulaOutput } = await import('../lib/live-mixcut/formula/selection.ts');
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'rotate',
    settingsId: settings.saved!.id, expectedInputRevision: rotated.inputRevision });
  const decisions = [];
  for (const output of request.outputs) decisions.push(await selectFormulaOutput(db, 'p', request, output, new AbortController().signal, () => {}));
  assert.equal(decisions[0].slots[0].assetId, decisions[1].slots[1].assetId);
  assert.equal(decisions[0].slots[1].assetId, decisions[1].slots[0].assetId);
  assert.notEqual(decisions[0].slots[0].assetId, decisions[0].slots[1].assetId, '同号重复槽位按批准集合轮换');
  assert.notEqual(decisions[2].slots[0].assetId, decisions[3].slots[0].assetId, '同脚本不同份数轮换候选');
  for (const decision of decisions) for (const slot of decision.slots) {
    assert.ok(assets.slice(0, 2).includes(slot.assetId!));
    assert.equal(slot.reason, 'approved_rotation');
    assert.equal(slot.rangeStatus, 'confirmed');
    assert.ok(slot.approvedRanges?.ranges.length);
    assert.equal(decision.executionReady, false);
  }
  const restored = readFormulaGenerationRequest(db, 'p', batchId, request.id);
  assert.deepEqual(await selectFormulaOutput(db, 'p', restored, restored.outputs[0], new AbortController().signal, () => {}), decisions[0],
    '恢复读取冻结请求后，选片和确认区间完全一致');
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...edit, ranges: [] }), /冻结/);
  // 首次决策提交前可以在批准池内回退；池外有合法原片也不能使用。
  const controlled = assets.slice(0, 2).map(assetId => resolveSourceFilePath(listAssetSources(db, assetId).find(source => source.sourceKind === 'managed')!.locationJson));
  const bytes = controlled.map(file => fs.readFileSync(file));
  for (const file of controlled) { assert(path.resolve(file).startsWith(path.resolve(root) + path.sep)); fs.writeFileSync(file, '损坏的批准候选'); }
  const emptyPool = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {});
  assert.equal(emptyPool.status, 'needs_attention');
  assert.ok(emptyPool.slots.every(slot => slot.assetId === null && slot.reason === 'rotation_unusable'));
  fs.writeFileSync(controlled[1], bytes[1]);
  const fallback = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {});
  assert.deepEqual(fallback.slots.map(slot => slot.assetId), [assets[1], assets[1]]);
  const { formulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { readFormulaSelection, queueFormulaSelection } = await import('../lib/live-mixcut/formula/selection-store.ts');
  await runPendingOnce({ db, workerId: 'rotation-fallback', executors: [formulaStageExecutor], log: () => {} });
  const committed = readFormulaSelection(db, 'p', batchId, request.outputs[0].planId);
  fs.writeFileSync(controlled[0], bytes[0]);
  queueFormulaSelection(db, 'p', batchId, request.id);
  assert.equal(await runPendingOnce({ db, workerId: 'rotation-retry', executors: [formulaStageExecutor], log: () => {} }), 0);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, request.outputs[0].planId), committed, '提交后补回另一候选不重新抽');
  createBatchProductionVersion(db, batchId, { copyCount: 4 });
  const current = readFormulaAssetRanges(db, 'p', batchId);
  const changed = await saveFormulaAssetRanges(db, 'p', batchId, { ...edit, expectedInputRevision: current.inputRevision,
    ranges: [{ label: '重新限定范围', inUs: 0, outUs: 1_000_000 }] });
  await assert.rejects(createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'changed-ranges', settingsId: settings.saved!.id,
    expectedInputRevision: changed.inputRevision }), /重新批准轮换候选/);
  assert.equal(readFormulaGenerationRequest(db, 'p', batchId, request.id).input.assetRanges!.find(item => item.assetId === assets[0])!.id, approved.id);
  const latestApproval = changed.items.find(item => item.assetId === assets[0])!.saved!;
  assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: changed.inputRevision,
    expectedRulesRevision: rotated.saved!.revision, scriptsSessionId: draft.id, rules: { primary: [{ logicalCode: 'G1', assetId: assets[0] }],
      overrides: [], rotation: [{ logicalCode: 'G1', candidates: [{ assetId: assets[0], rangeRevisionId: latestApproval.id }] }] } }), /一种方式/);
  const withOverride = saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: changed.inputRevision,
    expectedRulesRevision: rotated.saved!.revision, scriptsSessionId: draft.id, rules: { primary: [],
      overrides: [{ scriptKey: '1:2', slotIndex: 0, logicalCode: 'G1', sourceLogicalCode: 'G1', assetId: assets[3] }],
      rotation: [{ logicalCode: 'G1', candidates: [{ assetId: assets[0], rangeRevisionId: latestApproval.id }, { assetId: assets[1], rangeRevisionId: secondApproval.id }] }] } });
  const overrideRequest = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'override-rotation', settingsId: settings.saved!.id,
    expectedInputRevision: withOverride.inputRevision });
  const overrideResult = await selectFormulaOutput(db, 'p', overrideRequest, overrideRequest.outputs[0], new AbortController().signal, () => {});
  assert.equal(overrideResult.slots[0].assetId, assets[3], '用户明确的单镜头指定优先于该编号的轮换池');
  assert.equal(overrideResult.slots[0].rangeStatus, 'pending');
  assert.equal(overrideResult.slots[0].reason, 'manual_slot');
  assert.equal(overrideResult.slots[1].reason, 'approved_rotation');
  createBatchProductionVersion(db, batchId, { copyCount: 4 });
  const concurrentView = readFormulaAssetRanges(db, 'p', batchId);
  const concurrentInput = { ...edit, expectedInputRevision: concurrentView.inputRevision, expectedRangeRevision: latestApproval.revision };
  const stopped = new AbortController();
  stopped.abort(new Error('停止区间核验'));
  await assert.rejects(saveFormulaAssetRanges(db, 'p', batchId, { ...concurrentInput, signal: stopped.signal,
    ranges: [{ inUs: 0, outUs: 1_000_000 }] }), /停止区间核验/);
  const concurrentSaves = await Promise.allSettled([
    saveFormulaAssetRanges(db, 'p', batchId, { ...concurrentInput, ranges: [{ label: '窗口一', inUs: 0, outUs: 1_000_000 }] }),
    saveFormulaAssetRanges(db, 'p', batchId, { ...concurrentInput, ranges: [{ label: '窗口二', inUs: 0, outUs: 1_500_000 }] }),
  ]);
  assert.equal(concurrentSaves.filter(result => result.status === 'fulfilled').length, 1, '两个旧窗口只能有一个成功提交区间');
  const rejected = concurrentSaves.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /已更新/);
  const beforeWithdrawal = readFormulaAssetRanges(db, 'p', batchId);
  const withdrawal = await saveFormulaAssetRanges(db, 'p', batchId, { ...edit, expectedInputRevision: beforeWithdrawal.inputRevision,
    expectedRangeRevision: beforeWithdrawal.items.find(item => item.assetId === assets[0])!.saved!.revision, confirmed: false, ranges: [] });
  assert.equal(withdrawal.items.find(item => item.assetId === assets[0])!.saved!.ranges.length, 0);
  assert.equal(readFormulaGenerationRequest(db, 'p', batchId, overrideRequest.id).input.assetRanges!.find(item => item.assetId === assets[0])!.id, latestApproval.id,
    '撤回区间只影响新输入，已冻结制作请求仍保留原范围');
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  console.log('公式区间与轮换：真实文件/边界/保护动作、批准池/多份/覆盖、损坏回退/冻结恢复、修订/并发/撤回通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
