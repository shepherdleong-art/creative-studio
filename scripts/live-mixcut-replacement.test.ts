import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import type { TextJsonModel } from '../lib/media-core/adapters/text-json.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-replacement-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createBatchProduction, createBatchProductionVersion } = await import('../lib/live-mixcut/versions.ts');
const { registerManagedCopy, listAssetSources, resolveSourceFilePath } = await import('../lib/live-mixcut/media-catalog.ts');
const { registerFormulaAssetBinding, getFormulaMaterialIndex } = await import('../lib/live-mixcut/formula/material-bindings.ts');
const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
const { selectFormulaOutput } = await import('../lib/live-mixcut/formula/selection.ts');
const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
const { queueFormulaSelection, readFormulaSelection } = await import('../lib/live-mixcut/formula/selection-store.ts');
const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
const { readFormulaMaterialNotes, saveFormulaMaterialNote } = await import('../lib/live-mixcut/formula/material-notes.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');

const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试'),('other','其他项目');");
  const readiness = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  const formulaReady = await checkBatchProductionReadiness(readiness);
  seedLiveMixcutProjects(readiness, ['p','other']);
  assert.equal(formulaReady.available, true, JSON.stringify(formulaReady));
  const batchId = createBatchProduction(db, 'p', '缺片替换', undefined, { planningMode: 'formula' });
  const video = path.join(root, 'cleaning.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  const assetId = await registerManagedCopy(db, 'p', { sourcePath: video });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId, sourcePath: '实拍/S25_用纸擦净污渍.mp4' });
  const materials = new ExcelJS.Workbook();
  materials.addWorksheet('素材').addRows([
    ['逻辑编号', '画面描述', '核心卖点', '景别', '文件路径'],
    ['S29', '布料沾污后用湿布轻擦', '抗污易清洁', '特写', 'E:/private/original.mp4'],
    ['S25', '用纸擦掉表面污渍', '污渍一擦即净', '中景', 'E:/private/candidate.mp4'],
  ]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'materials', filename: '素材.xlsx',
    bytes: Buffer.from(await materials.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const scripts = new ExcelJS.Workbook();
  scripts.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [1, '抖音', 2, 16, 'S29 S29', '不怕弄脏，擦一擦就干净'],
  ]);
  const draft = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await scripts.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', batchId, draft.id, { expectedRevision: 2, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: draft.id, settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'replace',
    settingsId: settings.saved!.id, expectedInputRevision: getFormulaMaterialIndex(db, 'p', batchId).revision });
  const validReply = { matches: [{ logicalCode: 'S25', basis: 'selling_point', preservesIntent: true,
      reason: '两份资料都描述了污渍容易擦除，能表达这条脚本的清洁卖点',
      evidence: [{ originalField: '核心卖点', originalQuote: '抗污易清洁', replacementField: '核心卖点', replacementQuote: '污渍一擦即净' }],
      differences: ['湿布变为纸擦拭', '特写变为中景'] }] };
  let reply: unknown = validReply;
  const model: TextJsonModel = { id: 'local-fixture', name: '本机测试模型', model: 'fixture-model', async complete(input) {
    assert.ok(!input.userPrompt.includes('E:/private'), '不向模型发送表格里的磁盘路径');
    return reply;
  } };
  const result = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.equal(result.status, 'selected', '缺片时能根据同一卖点的不同表述自动找到合法替代素材');
  assert.deepEqual(result.slots.map(slot => slot.assetId), [assetId, assetId]);
  assert.deepEqual(result.slots.map(slot => slot.logicalCode), ['S29', 'S29'], '保留原公式和重复槽位');
  assert.deepEqual(result.slots.map(slot => slot.sourceLogicalCode), ['S25', 'S25']);
  assert.equal(result.slots[0].reason, 'automatic_replacement');
  assert.equal(result.slots[0].replacement?.reviewStatus, 'pending');
  assert.equal(result.slots[0].replacement?.evidence[0].original.cell, 'C2');
  assert.equal(result.slots[0].replacement?.evidence[0].replacement.cell, 'C3');
  assert.ok(result.slots[0].replacement?.differences.includes('湿布变为纸擦拭'));
  assert.equal(result.slots[0].rangeStatus, 'pending');
  assert.equal(result.executionReady, false, '选到替代素材不代表声音、动作区间或正式成片已核验');
  const hintedRequest = structuredClone(request);
  hintedRequest.input.replacementHints = { id: 'old-hints', filename: 'substitutions.json', fingerprint: 'a'.repeat(64),
    baseInputRevision: 0, createdAt: 'then', hints: [{ originalCode: 'S29', replacementCode: 'S25', sourceLine: null, note: '旧表说明，仅作参考' }] };
  const hinted = await selectFormulaOutput(db, 'p', hintedRequest, hintedRequest.outputs[0], new AbortController().signal, () => {},
    async () => ({ ...model, async complete(input) {
      assert.deepEqual(JSON.parse(input.userPrompt).importedSuggestions, [{ originalCode: 'S29', replacementCode: 'S25' }]);
      return validReply;
    } }));
  assert.equal(hinted.status, 'selected');
  assert.equal(hinted.slots[0].replacement?.importedSuggestion?.sourceId, 'old-hints');
  assert.equal(hinted.slots[0].replacement?.importedSuggestion?.filename, 'substitutions.json');
  assert.equal(hinted.slots[0].manualReplacement, undefined, '导入旧建议不能冒充用户明确指定的统一替换');
  const unsupportedHint = await selectFormulaOutput(db, 'p', hintedRequest, hintedRequest.outputs[0], new AbortController().signal, () => {},
    async () => ({ ...model, async complete() { return { matches: [{ ...validReply.matches[0],
      evidence: [{ ...validReply.matches[0].evidence[0], originalQuote: '旧表说等价就等价' }] }] }; } }));
  assert.equal(unsupportedHint.status, 'needs_attention', '已有建议也必须有当前素材资料的真实引用');
  reply = { matches: [{ ...validReply.matches[0], differences: [] }] };
  const omittedDifference = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.ok(omittedDifference.slots[0].replacement?.differences.some(item => item.includes('景别') && item.includes('特写') && item.includes('中景')),
    '模型漏写景别差异时，不能把表格里明确的变化藏起来');

  // 资料有证据不代表模型任意返回都可信：伪造引用、只同类别、表外编号均不能成为替换。
  for (const invalid of [
    { ...validReply.matches[0], evidence: [{ ...validReply.matches[0].evidence[0], replacementQuote: '防水耐火，十年不坏' }] },
    { ...validReply.matches[0], logicalCode: 'P999' },
    { ...validReply.matches[0], preservesIntent: false },
    { ...validReply.matches[0], basis: 'category' },
    { ...validReply.matches[0], basis: 'speech' },
  ]) {
    reply = { matches: [invalid] };
    const rejected = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {}, async () => model);
    assert.equal(rejected.status, 'needs_attention');
    assert.ok(rejected.slots.every(slot => !slot.replacement && !slot.assetId));
  }
  reply = validReply;
  const source = listAssetSources(db, assetId).find(source => source.sourceKind === 'managed')!;
  const controlled = resolveSourceFilePath(source.locationJson);
  assert.ok(path.relative(root, controlled) && !path.relative(root, controlled).startsWith('..'));
  const originalBytes = fs.readFileSync(controlled);
  fs.writeFileSync(controlled, '文件已损坏');
  const damaged = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.equal(damaged.status, 'needs_attention', '描述相符但实际文件损坏不能成为替代素材');
  fs.writeFileSync(controlled, originalBytes);

  createBatchProductionVersion(db, batchId, { copyCount: 2 });
  const alternateVideo = path.join(root, 'alternate.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', alternateVideo]);
  const alternateId = await registerManagedCopy(db, 'p', { sourcePath: alternateVideo });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: alternateId, sourcePath: 'S25_污渍轻擦即净.mp4' });
  const withAlternate = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'binding-evidence',
    settingsId: settings.saved!.id, expectedInputRevision: 4 });
  const evidenceAsset = [assetId, alternateId].sort()[1];
  const binding = withAlternate.input.materialIndex.bindings.find(item => item.assetId === evidenceAsset)!;
  reply = { matches: [{ ...validReply.matches[0], evidence: [{ originalField: '核心卖点', originalQuote: '抗污易清洁',
    replacementField: `文件名:${binding.id}`, replacementQuote: binding.sourceName }] }] };
  const bound = await selectFormulaOutput(db, 'p', withAlternate, withAlternate.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.deepEqual(bound.slots.map(slot => slot.assetId), [evidenceAsset, evidenceAsset],
    '证据引用一份具体文件时，不能因为另一份同号候选排序靠前就改用另一份');

  const executor = createFormulaStageExecutor(async () => model);
  assert.equal(await runPendingOnce({ db, workerId: 'replacement', executors: [executor], log: () => {} }), 6);
  const persisted = readFormulaSelection(db, 'p', batchId, withAlternate.outputs[0].planId)!;
  assert.equal(persisted.status, 'selected');
  assert.equal(persisted.slots[0].replacement?.reviewStatus, 'pending');
  reply = { matches: [] };
  queueFormulaSelection(db, 'p', batchId, withAlternate.id);
  assert.equal(await runPendingOnce({ db, workerId: 'replacement-retry', executors: [executor], log: () => {} }), 0);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, withAlternate.outputs[0].planId), persisted,
    '模型后来改变判断，已保存的替换理由和实际文件都不改变');

  createBatchProductionVersion(db, batchId, { copyCount: 2 });
  registerFormulaAssetBinding(db, 'p', batchId, { assetId: alternateId, sourcePath: 'S29_补回的原片.mp4' });
  const withOriginal = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'original-restored',
    settingsId: settings.saved!.id, expectedInputRevision: 5 });
  const exact = await selectFormulaOutput(db, 'p', withOriginal, withOriginal.outputs[0], new AbortController().signal, () => {},
    async () => { throw new Error('原片可用时不应请求替换模型'); });
  assert.deepEqual(exact.slots.map(slot => slot.reason), ['exact_code', 'exact_code']);
  assert.deepEqual(exact.slots.map(slot => slot.assetId), [alternateId, alternateId]);
  assert.deepEqual(readFormulaSelection(db, 'p', batchId, withAlternate.outputs[0].planId), persisted,
    '补回原片只影响新请求，不偷偷替换旧请求里的用片');

  const unavailableModel = await selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {});
  assert.equal(unavailableModel.slots[0].replacementCheck?.status, 'model_unavailable');
  let foreignModelRequested = false;
  await assert.rejects(selectFormulaOutput(db, 'other', request, request.outputs[0], new AbortController().signal, () => {},
    async () => { foreignModelRequested = true; return model; }), { code: 'not_found' });
  assert.equal(foreignModelRequested, false, '跨项目请求不能向模型发送素材资料');
  await assert.rejects(selectFormulaOutput(db, 'p', request, request.outputs[0], new AbortController().signal, () => {}, async () => ({ ...model,
    complete: async () => { throw new Error('secret-provider-response'); },
  })), error => error instanceof Error && /分析失败/.test(error.message) && !error.message.includes('secret-provider-response'));
  const controller = new AbortController();
  await assert.rejects(selectFormulaOutput(db, 'p', request, request.outputs[0], controller.signal, () => {}, async () => ({ ...model,
    complete: async () => { controller.abort(); return validReply; },
  })), { name: 'AbortError' });

  const safetyBatch = createBatchProduction(db, 'p', '不能猜测等价', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'p', safetyBatch, { assetId, sourcePath: 'S1_沙发整体外观.mp4' });
  registerFormulaAssetBinding(db, 'p', safetyBatch, { assetId, sourcePath: 'P1_坐姿.mp4' });
  registerFormulaAssetBinding(db, 'p', safetyBatch, { assetId, sourcePath: 'VO13_口播.mp4' });
  const safetyMaterials = new ExcelJS.Workbook();
  safetyMaterials.addWorksheet('素材').addRows([
    ['逻辑编号', '画面描述', '核心卖点', '台词'],
    ['S76', '3cm金属脚与扫地机同框', '3cm金属脚', ''],
    ['S1', '沙发整体外观', '整体造型', ''],
    ['P1', '坐在沙发上', '坐姿展示', ''],
    ['VO49', '绿幕真人口播', '舒适', '坐着真舒服'],
    ['VO13', '沙发旁口播', '舒适', '坐着不舒服'],
    ['S200', '缺文件的整体外观', '整体造型', ''],
  ]);
  const safetyImport = await createFormulaImportSession(db, 'p', safetyBatch, { kind: 'materials', filename: '不可猜测.xlsx',
    bytes: Buffer.from(await safetyMaterials.xlsx.writeBuffer()), expectedRevision: 3 });
  confirmFormulaImportSession(db, 'p', safetyBatch, safetyImport.id, { expectedRevision: 3, excludedKeys: [] });
  const safetyScripts = new ExcelJS.Workbook();
  safetyScripts.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [1, '抖音', 1, 16, 'S76', '介绍金属脚'], [2, '抖音', 1, 16, 'P100', '原编号意图未知'],
    [3, '抖音', 1, 16, 'VO49', '坐着真舒服'],
  ]);
  const safetyScriptImport = await createFormulaImportSession(db, 'p', safetyBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await safetyScripts.xlsx.writeBuffer()), expectedRevision: 4 });
  confirmFormulaImportSession(db, 'p', safetyBatch, safetyScriptImport.id, { expectedRevision: 4, excludedKeys: [] });
  const safetySettings = await saveFormulaSettings(db, 'p', safetyBatch, { expectedInputRevision: 5, expectedSettingsRevision: 0,
    scriptsSessionId: safetyScriptImport.id, settings: { selections: ['1:2', '1:3', '1:4'].map(key => ({ key, copies: 1 })), bgm: { mode: 'none', trackIds: [] } } });
  const safetyRequest = await createFormulaGenerationRequest(db, 'p', safetyBatch, { requestKey: 'safety', settingsId: safetySettings.saved!.id, expectedInputRevision: 5 });
  reply = { matches: [{ ...validReply.matches[0], logicalCode: 'S1', evidence: [{ originalField: '核心卖点', originalQuote: '3cm金属脚',
    replacementField: '核心卖点', replacementQuote: '整体造型' }] }] };
  const foot = await selectFormulaOutput(db, 'p', safetyRequest, safetyRequest.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.equal(foot.status, 'needs_attention', '整体外观不能证明 3cm 金属脚的具体卖点，即使模型声称等价');
  const undefinedCode = await selectFormulaOutput(db, 'p', safetyRequest, safetyRequest.outputs[1], new AbortController().signal, () => {},
    async () => { throw new Error('P100 没有定义时不能调用模型猜替换'); });
  assert.equal(undefinedCode.slots[0].replacementCheck?.status, 'undefined');
  reply = { matches: [{ ...validReply.matches[0], logicalCode: 'VO13', basis: 'speech', evidence: [{ originalField: '台词', originalQuote: '坐着真舒服',
    replacementField: '台词', replacementQuote: '坐着不舒服' }] }] };
  const speech = await selectFormulaOutput(db, 'p', safetyRequest, safetyRequest.outputs[2], new AbortController().signal, () => {}, async () => model);
  assert.equal(speech.status, 'needs_attention', '不能把台词中的否定差异称为同台词替换');
  reply = { matches: [{ ...validReply.matches[0], logicalCode: 'S200' }] };
  const chain = await selectFormulaOutput(db, 'p', safetyRequest, safetyRequest.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.equal(chain.status, 'needs_attention', '替换目标也缺片时不能递归沿链猜下一个编号');

  const conflictBatch = createBatchProduction(db, 'p', '资料冲突不能替换', undefined, { planningMode: 'formula' });
  const conflictBinding = registerFormulaAssetBinding(db, 'p', conflictBatch, { assetId, sourcePath: 'S25_摆拍全景.mp4' });
  const conflictMaterials = await createFormulaImportSession(db, 'p', conflictBatch, { kind: 'materials', filename: '素材.xlsx',
    bytes: Buffer.from(await materials.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', conflictBatch, conflictMaterials.id, { expectedRevision: 1, excludedKeys: [] });
  const conflictScripts = await createFormulaImportSession(db, 'p', conflictBatch, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await scripts.xlsx.writeBuffer()), expectedRevision: 2 });
  confirmFormulaImportSession(db, 'p', conflictBatch, conflictScripts.id, { expectedRevision: 2, excludedKeys: [] });
  saveFormulaMaterialNote(db, 'p', conflictBatch, conflictBinding.id, { expectedRevision: 3, expectedProfileId: null,
    content: { description: '文件名是摆拍全景，但表格写清洁演示，尚未核对', category: '', sellingPoints: [], actions: [], speech: 'unknown', evidence: [],
      conflicts: [{ filenameQuote: '摆拍全景', tableQuote: '用纸擦掉表面污渍', message: '动作描述不一致，需要人工确认' }] } });
  const conflictSettings = await saveFormulaSettings(db, 'p', conflictBatch, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: conflictScripts.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } });
  const conflictRequest = await createFormulaGenerationRequest(db, 'p', conflictBatch, { requestKey: 'unresolved-conflict', settingsId: conflictSettings.saved!.id, expectedInputRevision: 3 });
  reply = validReply;
  const conflict = await selectFormulaOutput(db, 'p', conflictRequest, conflictRequest.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.equal(conflict.status, 'needs_attention', '已知命名与素材表冲突尚未解释时，不能只挑表格中的有利说法来自动替换');
  createBatchProductionVersion(db, conflictBatch, { copyCount: 1 });
  const conflictNote = readFormulaMaterialNotes(db, 'p', conflictBatch).items[0];
  saveFormulaMaterialNote(db, 'p', conflictBatch, conflictBinding.id, { expectedRevision: 3, expectedProfileId: conflictNote.profile!.id,
    content: { ...conflictNote.profile!.content, description: '人工核对：文件名有误，确实是纸擦清洁演示，以素材表为准', conflicts: [] } });
  const explained = await createFormulaGenerationRequest(db, 'p', conflictBatch, { requestKey: 'conflict-explained', settingsId: conflictSettings.saved!.id, expectedInputRevision: 3 });
  const explainedSelection = await selectFormulaOutput(db, 'p', explained, explained.outputs[0], new AbortController().signal, () => {}, async () => model);
  assert.equal(explainedSelection.status, 'selected', '人工解释冲突后，新请求可以使用确认后的资料');
  assert.equal(conflictRequest.input.materialNotes[0].profile?.content.conflicts?.length, 1, '旧输入保留当时尚未解释的冲突');
  assert.equal((await checkBatchProductionReadiness(readiness)).available, true);
  seedLiveMixcutProjects(readiness, ['p','other']);
  console.log('公式替换：资料依据/具体候选、原片优先、差异/待审持久化、S76/P100/台词/冲突、错误取消与项目隔离通过');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
