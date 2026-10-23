import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-replacement-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const { checkBatchProductionReadiness } = await import('../lib/batch-production/readiness.ts');
const { checkFormulaReadiness } = await import('../lib/batch-production/formula/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction, createBatchProductionVersion } = await import('../lib/batch-production/versions.ts');
const { registerManagedCopy, listAssetSources, resolveSourceFilePath } = await import('../lib/batch-production/media-catalog.ts');
const { registerFormulaAssetBinding, getFormulaMaterialIndex } = await import('../lib/batch-production/formula/material-bindings.ts');
const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
const { readFormulaSelectionRules, saveFormulaSelectionRules } = await import('../lib/batch-production/formula/selection-rules.ts');
const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
const { createFormulaGenerationRequest, readFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
const { selectFormulaOutput } = await import('../lib/batch-production/formula/selection.ts');
const { readFormulaSelection } = await import('../lib/batch-production/formula/selection-store.ts');
const { readFormulaSelectionHistory, reselectFormulaOutput } = await import('../lib/batch-production/formula/reselection.ts');
const { createFormulaStageExecutor } = await import('../lib/batch-production/formula/stage-executor.ts');
const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','统一替换'),('other','别的项目');");
  const readiness = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  const ready = await checkFormulaReadiness(readiness);
  assert.equal(ready.available, true, JSON.stringify(ready));
  const batchId = createBatchProduction(db, 'p', '统一缺号规则', undefined, { planningMode: 'formula' });
  const assets: string[] = [];
  for (const [i, color] of ['red', 'blue'].entries()) {
    const video = path.join(root, `${color}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
    const id = await registerManagedCopy(db, 'p', { sourcePath: video }); assets.push(id);
    registerFormulaAssetBinding(db, 'p', batchId, { assetId: id, sourcePath: `S${25 + i}_清洁展示.mp4` });
  }
  async function importRows(kind: 'materials' | 'scripts', rows: unknown[][]) {
    const book = new ExcelJS.Workbook(); book.addWorksheet(kind).addRows(rows);
    const revision = getFormulaMaterialIndex(db, 'p', batchId).revision;
    const session = await createFormulaImportSession(db, 'p', batchId, { kind, filename: `${kind}.xlsx`,
      bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: revision });
    confirmFormulaImportSession(db, 'p', batchId, session.id, { expectedRevision: revision, excludedKeys: [] });
    return session;
  }
  await importRows('materials', [
    ['逻辑编号', '画面描述', '核心卖点', '景别'],
    ['S29', '湿布擦净布料污渍', '容易清洁', '特写'],
    ['S25', '用纸擦净表面污渍', '清洁效果', '中景'],
    ['S26', '清洁后的展示', '展示效果', '全景'],
  ]);
  const scripts = await importRows('scripts', [
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 3, 16, 'S29 S25 S29', '容易清洁'],
    [141, '抖音', 1, 16, 'S29', '清洁效果'],
  ]);
  const rule = { logicalCode: 'S29', replacementCode: 'S25', reason: '本批缺少 S29，人工指定用擦拭展示补位', differences: ['湿布变成纸擦拭'] };
  const before = readFormulaSelectionRules(db, 'p', batchId);
  const anotherBatch = createBatchProduction(db, 'p', '同项目另一集合', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', anotherBatch, { assetId: assets[1], sourcePath: 'S99_别的集合.mp4' });
  for (const replacements of [
    [{ ...rule, logicalCode: 'P100' }], [{ ...rule, replacementCode: 'S29' }], [rule, rule],
    [rule, { ...rule, logicalCode: 'S25', replacementCode: 'S26' }],
    [{ ...rule, logicalCode: 'S25', replacementCode: 'S26' }, { ...rule, logicalCode: 'S26', replacementCode: 'S25' }],
    [{ ...rule, replacementCode: 'S99' }], [{ ...rule, reason: '' }], [{ ...rule, differences: ['x'.repeat(301)] }],
  ]) {
    assert.throws(() => saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: 4, expectedRulesRevision: 0,
      scriptsSessionId: scripts.id, rules: { primary: [], overrides: [], replacements } }));
    assert.deepEqual(readFormulaSelectionRules(db, 'p', batchId), before, '非法映射不能保存半份规则或推进资料版本');
  }
  assert.throws(() => saveFormulaSelectionRules(db, 'other', batchId, { expectedInputRevision: 4, expectedRulesRevision: 0,
    scriptsSessionId: scripts.id, rules: { primary: [], overrides: [], replacements: [rule] } }), /不存在|项目/);
  let rules = saveFormulaSelectionRules(db, 'p', batchId, {
    expectedInputRevision: 4, expectedRulesRevision: 0, scriptsSessionId: scripts.id,
    rules: { primary: [], overrides: [{ scriptKey: '1:2', slotIndex: 0, logicalCode: 'S29', sourceLogicalCode: 'S26', assetId: assets[1] }], replacements: [rule] },
  });
  rules = saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: rules.inputRevision, expectedRulesRevision: rules.saved!.revision,
    scriptsSessionId: scripts.id, rules: { primary: [], overrides: rules.saved!.rules.overrides.map(({ scriptKey, slotIndex, logicalCode, sourceLogicalCode, assetId }) =>
      ({ scriptKey, slotIndex, logicalCode, sourceLogicalCode, assetId })) } });
  assert.deepEqual(rules.saved!.rules.replacements, [rule], '旧客户端只改主片或单镜头时不能清空统一替换');
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: rules.inputRevision, expectedSettingsRevision: 0,
    scriptsSessionId: scripts.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'manual-map', settingsId: settings.saved!.id, expectedInputRevision: rules.inputRevision });
  const executor = createFormulaStageExecutor(async () => { throw new Error('人工指定的直接映射不应调用模型另选素材'); });
  assert.equal(await runPendingOnce({ db, workerId: 'manual', executors: [executor], log: () => {} }), 11, '三份选片后分别检查实际来源并各自映射文案');
  const selected = request.outputs.map(output => readFormulaSelection(db, 'p', batchId, output.planId)!);
  assert.deepEqual(selected[0].slots.map(slot => slot.sourceLogicalCode), ['S26', 'S25', 'S25']);
  assert.deepEqual(selected[1].slots.map(slot => slot.sourceLogicalCode), ['S26', 'S25', 'S25']);
  assert.deepEqual(selected[2].slots.map(slot => slot.sourceLogicalCode), ['S25']);
  assert.equal(selected[0].slots[0].reason, 'manual_slot');
  assert.equal(selected[0].slots[2].reason, 'manual_replacement');
  assert.equal(selected[0].slots[2].logicalCode, 'S29');
  assert.equal(selected[0].slots[2].replacement, undefined, '人工指定不冒充 AI 核验的替换');
  const provenance = selected[0].slots[2].manualReplacement!;
  assert.equal(provenance.basisScope, 'manual_choice');
  assert.equal(provenance.ruleId, rules.saved!.id);
  assert.equal(provenance.reviewStatus, 'pending');
  assert.equal(provenance.reason, rule.reason);
  assert.ok(provenance.differences.includes('湿布变成纸擦拭'));
  assert.ok(provenance.differences.some(item => item.includes('特写') && item.includes('中景')));
  assert.ok(provenance.evidence.some(pair => pair.original.cell === 'B2' && pair.replacement.cell === 'B3'));
  assert.equal(selected[0].executionReady, false);
  const beforeReselect = readFormulaSelectionHistory(db, 'p', batchId, request.outputs[0].planId);
  reselectFormulaOutput(db, 'p', batchId, request.outputs[0].planId, { requestKey: 'inherit-unified-rule',
    expectedStageId: beforeReselect.current.id, expectedOutputVersionId: null, expectedEditRevision: 0, overrides: [] });
  assert.equal(await runPendingOnce({ db, workerId: 'reselect', executors: [executor], log: () => {} }), 3);
  assert.deepEqual(readFormulaSelectionHistory(db, 'p', batchId, request.outputs[0].planId).history[1].result, selected[0]);
  selected[0] = readFormulaSelection(db, 'p', batchId, request.outputs[0].planId)!;
  assert.deepEqual(selected[0].slots.map(slot => slot.sourceLogicalCode), ['S25', 'S25', 'S25'], '清除这一份的单镜头指定后沿用冻结的统一替换规则');
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, request.outputs[1].planId), selected[1], '另一份仍保留单镜头指定');
  const resolver = async () => { throw new Error('已有人工映射时不能另找其他替代项'); };
  async function nextRequest(key: string) {
    return createFormulaGenerationRequest(db, 'p', batchId, { requestKey: key, settingsId: settings.saved!.id,
      expectedInputRevision: getFormulaMaterialIndex(db, 'p', batchId).revision });
  }
  const targetSource = resolveSourceFilePath(listAssetSources(db, assets[0]).find(source => source.sourceKind === 'managed')!.locationJson);
  assert(!path.relative(root, targetSource).startsWith('..'));
  const targetBytes = fs.readFileSync(targetSource);
  fs.writeFileSync(targetSource, '损坏的替代原片');
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const damagedRequest = await nextRequest('damaged-target');
  const damaged = await selectFormulaOutput(db, 'p', damagedRequest, damagedRequest.outputs[2], new AbortController().signal, () => {}, resolver);
  assert.equal(damaged.status, 'needs_attention');
  assert.equal(damaged.slots[0].assetId, null);
  assert.equal(damaged.slots[0].reason, 'manual_replacement_unusable');
  assert.match(damaged.slots[0].replacementCheck!.message, /直接替代素材/);
  fs.writeFileSync(targetSource, targetBytes);

  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const originalVideo = path.join(root, 'original.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', originalVideo]);
  const originalAsset = await registerManagedCopy(db, 'p', { sourcePath: originalVideo });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: originalAsset, sourcePath: 'S29_补回原片.mp4' });
  const restoredRequest = await nextRequest('original-back');
  const restored = await selectFormulaOutput(db, 'p', restoredRequest, restoredRequest.outputs[2], new AbortController().signal, () => {}, resolver);
  assert.equal(restored.slots[0].assetId, originalAsset, '新请求优先恢复可用原编号，不能被备用规则强制替换');
  assert.equal(restored.slots[0].manualReplacement, undefined);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, request.outputs[2].planId), selected[2], '补回原片不能改旧记录');

  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const current = readFormulaSelectionRules(db, 'p', batchId);
  saveFormulaSelectionRules(db, 'p', batchId, { expectedInputRevision: current.inputRevision, expectedRulesRevision: current.saved!.revision,
    scriptsSessionId: scripts.id, rules: { primary: [], overrides: [], replacements: [{ ...rule, replacementCode: 'S26' }] } });
  const revised = await nextRequest('new-mapping');
  assert.equal(revised.input.selectionRules!.rules.replacements![0].replacementCode, 'S26');
  assert.equal(readFormulaGenerationRequest(db, 'p', batchId, request.id).input.selectionRules!.rules.replacements![0].replacementCode, 'S25');
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, request.outputs[0].planId), selected[0]);
  const originalSource = resolveSourceFilePath(listAssetSources(db, originalAsset).find(source => source.sourceKind === 'managed')!.locationJson);
  assert(!path.relative(root, originalSource).startsWith('..'));
  fs.writeFileSync(originalSource, '原片不可读');
  const newChoice = await selectFormulaOutput(db, 'p', revised, revised.outputs[2], new AbortController().signal, () => {}, resolver);
  assert.equal(newChoice.slots[0].sourceLogicalCode, 'S26');
  assert.equal(newChoice.slots[0].reason, 'manual_replacement');
  createBatchProductionVersion(db, batchId, { copyCount: 3 });
  await importRows('materials', [['逻辑编号', '画面描述'], ['S25', '擦拭展示'], ['S26', '展示清洁效果']]);
  const undefinedRequest = await nextRequest('definition-removed');
  const undefinedResult = await selectFormulaOutput(db, 'p', undefinedRequest, undefinedRequest.outputs[2], new AbortController().signal, () => {}, resolver);
  assert.equal(undefinedResult.status, 'needs_attention', '新资料移除原编号定义后，旧备用规则不能让未知编号直接继续');
  assert.equal(undefinedResult.slots[0].assetId, null);
  assert.match(undefinedResult.slots[0].replacementCheck!.message, /定义|资料/);
  console.log('公式人工替换：同集合统一规则、单槽位优先、跨脚本多份和人工来源标识通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
