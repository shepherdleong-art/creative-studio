import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { checkBatchProductionReadiness } from '../lib/live-mixcut/readiness.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } from '../lib/live-mixcut/versions.ts';
import { createFormulaImportSession, confirmFormulaImportSession, readFormulaInputs, remapFormulaImportSession, analyzeFormulaImportSession } from '../lib/live-mixcut/formula/import-store.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-import-session-'));
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试'),('other','另一个项目');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p','other']);
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p','other']);
  const batchId = createBatchProduction(db, 'p', '公式导入', undefined, { planningMode: 'formula' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('脚本');
  ws.addRow(['序号', '平台', '镜头数', '预估时长(s)', '画面分镜（逻辑镜号组合）', '脚本文案']);
  for (let i = 1; i <= 300; i++) ws.addRow([i, '抖音', 2, 16, 'G1 VO1', `文案 ${i}`]);
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const request = { kind: 'scripts' as const, filename: '300条.xlsx', bytes, expectedRevision: 0 };
  const session = await createFormulaImportSession(db, 'p', batchId, request);
  assert.equal(session.preview.rows.length, 300);
  assert.equal(readFormulaInputs(db, 'p', batchId).scripts, null, '预览不能提前成为正式输入');
  assert.equal((await createFormulaImportSession(db, 'p', batchId, request)).id, session.id);
  const receipt = confirmFormulaImportSession(db, 'p', batchId, session.id, { expectedRevision: 0, excludedKeys: [] });
  assert.equal(receipt.importedRows, 300);
  assert.equal(readFormulaInputs(db, 'p', batchId).scripts?.rows.length, 300);
  assert.deepEqual(confirmFormulaImportSession(db, 'p', batchId, session.id, { expectedRevision: 0, excludedKeys: [] }), receipt);
  assert.throws(() => readFormulaInputs(db, 'other', batchId), /不存在/);
  ws.getCell('E3').value = { formula: '"G1"', result: 'G1' };
  const bad = await createFormulaImportSession(db, 'p', batchId, { ...request, bytes: Buffer.from(await wb.xlsx.writeBuffer()), expectedRevision: 1 });
  assert.equal(bad.preview.issues.length, 1);
  assert.throws(() => confirmFormulaImportSession(db, 'p', batchId, bad.id, { expectedRevision: 1, excludedKeys: [] }), /错误行/);
  assert.equal(readFormulaInputs(db, 'p', batchId).scripts?.rows.length, 300, '错误确认不得覆盖原整批资料');
  const otherDraft = await createFormulaImportSession(db, 'p', batchId, { ...request, expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, bad.id, { expectedRevision: 1, excludedKeys: [bad.preview.issues[0].key] });
  assert.equal(readFormulaInputs(db, 'p', batchId).scripts?.rows.length, 299);
  assert.equal(readFormulaInputs(db, 'p', batchId).scripts?.excludedKeys.length, 1);
  assert.throws(() => confirmFormulaImportSession(db, 'p', batchId, otherDraft.id, { expectedRevision: 1, excludedKeys: [] }), /刷新/);
  const otherBatch = createBatchProduction(db, 'p', '其他公式批次', undefined, { planningMode: 'formula' });
  assert.throws(() => confirmFormulaImportSession(db, 'p', otherBatch, bad.id, { expectedRevision: 1, excludedKeys: [] }), /不存在/);
  const custom = new ExcelJS.Workbook();
  const customSheet = custom.addWorksheet('自定义列');
  customSheet.addRow(['编号', '渠道', '镜头数量', '秒数', '素材顺序', '口播']);
  customSheet.addRow([7, '抖音', 2, 16, 'G1 VO1', '不能被模型改写的原文']);
  const draft = await createFormulaImportSession(db, 'p', otherBatch, {
    ...request, filename: '自定义列.xlsx', bytes: Buffer.from(await custom.xlsx.writeBuffer()),
  });
  assert.equal(draft.preview.rows.length, 0);
  assert.match(draft.preview.issues[0].message, /列对应/);
  const corrected = await remapFormulaImportSession(db, 'p', otherBatch, draft.id, {
    expectedRevision: 0, expectedDraftRevision: 0, mapping: [{ sheetId: customSheet.id, headerRow: 1,
      columns: { '序号': 1, '平台': 2, '镜头数': 3, '预估时长(s)': 4, '画面分镜(逻辑镜号组合)': 5, '脚本文案': 6 } }],
  });
  assert.equal(corrected.draftRevision, 1);
  assert.equal(readFormulaInputs(db, 'p', otherBatch).drafts[0].draftRevision, 1);
  assert.equal(corrected.preview.rows.length, 1);
  assert.throws(() => confirmFormulaImportSession(db, 'p', otherBatch, draft.id, { expectedRevision: 0, expectedDraftRevision: 0, excludedKeys: [] }), /预览已更新/);
  confirmFormulaImportSession(db, 'p', otherBatch, draft.id, { expectedRevision: 0, expectedDraftRevision: 1, excludedKeys: [] });
  assert.equal(readFormulaInputs(db, 'p', otherBatch).scripts?.rows[0].source.cells['脚本文案'], 'F2');
  const aiDraft = await createFormulaImportSession(db, 'p', otherBatch, {
    ...request, bytes: Buffer.from(await custom.xlsx.writeBuffer()), expectedRevision: 1,
  });
  const aiResult = await analyzeFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: 0,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: async () => ({ mapping: corrected.preview.mapping }) });
  assert.equal(aiResult.extraction?.state, 'completed');
  assert.equal(aiResult.extraction?.model, 'fixture-model');
  assert.equal(aiResult.preview.rows.length, 1);
  assert.equal('bodyText' in aiResult.preview.rows[0] && aiResult.preview.rows[0].bodyText, '不能被模型改写的原文');
  assert.equal(readFormulaInputs(db, 'p', otherBatch).drafts.find(item => item.id === aiDraft.id)?.extraction?.state, 'completed');
  // 不确定或错误响应不得声称成功，也不清空上一份可用预览。
  await assert.rejects(() => analyzeFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: aiResult.draftRevision,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: async () => ({ mapping: [] }) }), /未能确定/);
  const failedDraft = readFormulaInputs(db, 'p', otherBatch).drafts.find(item => item.id === aiDraft.id)!;
  assert.equal(failedDraft.extraction?.state, 'failed');
  assert.equal(failedDraft.preview.rows.length, 1);
  // 模型正在响应时，另一页面手动修改。迟到响应不能覆盖人工结果。
  let finishModel!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { finishModel = resolve; });
  const analyzing = analyzeFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: failedDraft.draftRevision,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: () => pending });
  const running = readFormulaInputs(db, 'p', otherBatch).drafts.find(item => item.id === aiDraft.id)!;
  assert.equal(running.extraction?.state, 'running');
  assert.throws(() => confirmFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: running.draftRevision, excludedKeys: [],
  }), /AI 正在识别/);
  await assert.rejects(() => analyzeFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: running.draftRevision,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: async () => { throw new Error('不应重复调用'); } }), /已在识别/);
  const manual = await remapFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: running.draftRevision, mapping: corrected.preview.mapping,
  });
  finishModel({ mapping: corrected.preview.mapping });
  await assert.rejects(() => analyzing, /预览已更新/);
  assert.equal(readFormulaInputs(db, 'p', otherBatch).drafts.find(item => item.id === aiDraft.id)?.draftRevision, manual.draftRevision);
  assert.equal(manual.extraction?.manualOverride, true);
  await assert.rejects(() => analyzeFormulaImportSession(db, 'p', otherBatch, aiDraft.id, {
    expectedRevision: 1, expectedDraftRevision: manual.draftRevision,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: async () => { throw new Error('秘密 API key 不可回显'); } }), /识别未完成/);
  assert(!JSON.stringify(readFormulaInputs(db, 'p', otherBatch)).includes('秘密 API key'));
  const modelBatch = createBatchProduction(db, 'p', 'AI 全量提取', undefined, { planningMode: 'formula' });
  const fullDraft = await createFormulaImportSession(db, 'p', modelBatch, request);
  const fullResult = await analyzeFormulaImportSession(db, 'p', modelBatch, fullDraft.id, {
    expectedRevision: 0, expectedDraftRevision: 0,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: async input => {
    const prompt = JSON.parse(input.userPrompt);
    assert.equal(prompt.sheet.samples.length, 20, '模型只看表头样本，不负责重写 300 条脚本');
    return { mapping: session.preview.mapping, rows: [{ scriptNumber: '300', bodyText: '模型试图改写原文', codes: ['P100'] }] };
  } });
  assert.equal(fullResult.preview.rows.length, 300, '不能只导入模型看到的 20 行');
  assert.equal('bodyText' in fullResult.preview.rows[299] && fullResult.preview.rows[299].bodyText, '文案 300');
  assert.equal(fullResult.preview.rows[299].source.cells['脚本文案'], 'F301');
  const controller = new AbortController();
  await assert.rejects(() => analyzeFormulaImportSession(db, 'p', modelBatch, fullDraft.id, {
    expectedRevision: 0, expectedDraftRevision: fullResult.draftRevision, signal: controller.signal,
  }, { id: 'fixture', name: '验收模型', model: 'fixture-model', complete: async () => {
    controller.abort(); return { mapping: session.preview.mapping };
  } }), /中断或超时/);
  const interrupted = readFormulaInputs(db, 'p', modelBatch).drafts[0];
  assert.equal(interrupted.extraction?.state, 'failed');
  assert.equal(interrupted.preview.rows.length, 300);
  createBatchProductionVersion(db, batchId, { copyCount: 1 });
  updateBatchProductionStatus(db, 'p', batchId, 'running');
  assert.deepEqual(confirmFormulaImportSession(db, 'p', batchId, session.id, { expectedRevision: 0, excludedKeys: [] }), receipt,
    '成功确认的回执即使在输入冻结后重试也须原样返回');
  await assert.rejects(() => createFormulaImportSession(db, 'p', batchId, { ...request, expectedRevision: 2 }), /冻结/);
  console.log('formula-import-session: 300 行整批确认、预览隔离与重试幂等通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
