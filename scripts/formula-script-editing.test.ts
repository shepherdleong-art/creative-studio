import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkFormulaReadiness } from '../lib/batch-production/formula/readiness.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } from '../lib/batch-production/versions.ts';
import { createFormulaImportSession, confirmFormulaImportSession, readFormulaInputs, editFormulaScriptRow, reviseFormulaScriptImport, remapFormulaImportSession, analyzeFormulaImportSession } from '../lib/batch-production/formula/import-store.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-script-edit-'));
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','测试'),('other','其他项目');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  const base = await checkBatchProductionReadiness(options);
  assert.equal(base.available, true, JSON.stringify(base));
  const ready = await checkFormulaReadiness(options);
  assert.equal(ready.available, true, JSON.stringify(ready));
  const batch = createBatchProduction(db, 'p', '脚本修改', undefined, { planningMode: 'formula' });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('脚本');
  sheet.addRow(['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案']);
  sheet.addRow([1, '抖音', 2, 16, 'G1 VO1', '第一条原文']);
  sheet.addRow([2, '淘宝', 2, 18, 'G10', '  第二条原文\n保留换行  ']);
  const session = await createFormulaImportSession(db, 'p', batch, {
    kind: 'scripts', filename: '脚本.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0,
  });
  assert.equal(session.preview.issues.length, 1);
  const original = session.preview.scriptInputs!.find(row => row.key === '1:3')!;
  assert.equal(original.original['脚本文案'], '  第二条原文\n保留换行  ');
  const edited = await editFormulaScriptRow(db, 'p', batch, session.id, {
    expectedRevision: 0, expectedDraftRevision: 0, key: '1:3',
    values: { ...original.values, '平台': '小红书', '预估时长(s)': '24',
      '画面分镜(逻辑镜号组合)': 'G10 VO1', '脚本文案': '人工修改后的第二条。' },
  });
  assert.equal(edited.preview.rows.length, 2);
  assert.deepEqual(edited.preview.issues, []);
  const corrected = edited.preview.rows[1];
  assert('bodyText' in corrected);
  assert.equal(corrected.bodyText, '人工修改后的第二条。');
  assert.equal(corrected.platform, '小红书');
  assert.equal(corrected.targetDurationSec, 24);
  assert.deepEqual(corrected.codes, ['G10', 'VO1']);
  assert.equal(corrected.originalFormula, 'G10');
  assert.equal(corrected.formula, 'G10 VO1');
  assert.equal(corrected.source.cells['脚本文案'], 'F3');
  assert.equal(edited.preview.scriptInputs![1].edits.length, 1);
  assert.equal(readFormulaInputs(db, 'p', batch).drafts[0].preview.scriptInputs![1].original['脚本文案'], '  第二条原文\n保留换行  ');
  assert.throws(() => confirmFormulaImportSession(db, 'p', batch, session.id, { expectedRevision: 0, expectedDraftRevision: 0, excludedKeys: [] }), /预览已更新/);
  confirmFormulaImportSession(db, 'p', batch, session.id, { expectedRevision: 0, expectedDraftRevision: edited.draftRevision, excludedKeys: [] });
  assert.equal(readFormulaInputs(db, 'p', batch).scripts?.rows.length, 2);
  const revision = await reviseFormulaScriptImport(db, 'p', batch, session.id, { expectedRevision: 1 });
  assert.notEqual(revision.id, session.id);
  assert.equal(revision.preview.revisionOf, session.id);
  assert.equal((await reviseFormulaScriptImport(db, 'p', batch, session.id, { expectedRevision: 1 })).id, revision.id);
  const changedAgain = await editFormulaScriptRow(db, 'p', batch, revision.id, {
    expectedRevision: 1, expectedDraftRevision: 0, key: '1:3',
    values: { ...revision.preview.scriptInputs![1].values, '脚本文案': '第二次修改，未确认前不影响已保存的资料。' },
  });
  const stillSaved = readFormulaInputs(db, 'p', batch).scripts!.rows[1];
  assert('bodyText' in stillSaved);
  assert.equal(stillSaved.bodyText, '人工修改后的第二条。');
  const remapped = await remapFormulaImportSession(db, 'p', batch, revision.id, {
    expectedRevision: 1, expectedDraftRevision: changedAgain.draftRevision, mapping: revision.preview.mapping,
  });
  assert.equal(remapped.preview.scriptInputs![1].values['脚本文案'], '第二次修改，未确认前不影响已保存的资料。', '重新识别相同列不能冲掉人工修改');
  assert.equal(remapped.preview.scriptInputs![1].edits.length, 2);
  assert.equal(remapped.preview.scriptInputs![1].original['脚本文案'], '  第二条原文\n保留换行  ');
  confirmFormulaImportSession(db, 'p', batch, revision.id, { expectedRevision: 1, expectedDraftRevision: remapped.draftRevision, excludedKeys: [] });
  assert.equal(readFormulaInputs(db, 'p', batch).scripts?.sessionId, revision.id);
  assert.equal(confirmFormulaImportSession(db, 'p', batch, session.id, { expectedRevision: 0, expectedDraftRevision: edited.draftRevision, excludedKeys: [] }).revision, 1, '旧确认回执保持原样，不替换新资料');
  const pending = await reviseFormulaScriptImport(db, 'p', batch, revision.id, { expectedRevision: 2 });
  const second = pending.preview.scriptInputs![1];
  const duplicate = await editFormulaScriptRow(db, 'p', batch, pending.id, {
    expectedRevision: 2, expectedDraftRevision: 0, key: second.key, values: { ...second.values, '序号': '1', '预估时长(s)': '0' },
  });
  assert.equal(duplicate.preview.rows.length, 0, '修改为重复序号时，另一行即使有效也不能继续被采用');
  assert.equal(duplicate.preview.issues.length, 2);
  assert.throws(() => confirmFormulaImportSession(db, 'p', batch, pending.id, { expectedRevision: 2, expectedDraftRevision: duplicate.draftRevision, excludedKeys: [] }), /错误行/);
  await assert.rejects(() => editFormulaScriptRow(db, 'p', batch, pending.id, {
    expectedRevision: 2, expectedDraftRevision: 0, key: second.key, values: second.values,
  }), /预览已更新/);
  const restored = await editFormulaScriptRow(db, 'p', batch, pending.id, {
    expectedRevision: 2, expectedDraftRevision: duplicate.draftRevision, key: second.key, values: second.values,
  });
  const swapped = restored.preview.mapping.map(item => ({ ...item, columns: { ...item.columns, '平台': 6, '脚本文案': 2 } }));
  await assert.rejects(() => remapFormulaImportSession(db, 'p', batch, pending.id, {
    expectedRevision: 2, expectedDraftRevision: restored.draftRevision, mapping: swapped,
  }), /已有手工修改/);
  assert.equal(readFormulaInputs(db, 'p', batch).drafts.find(item => item.id === pending.id)?.draftRevision, restored.draftRevision);
  await assert.rejects(() => editFormulaScriptRow(db, 'other', batch, pending.id, {
    expectedRevision: 2, expectedDraftRevision: restored.draftRevision, key: second.key, values: second.values,
  }), /不存在/);
  await assert.rejects(() => editFormulaScriptRow(db, 'p', batch, revision.id, {
    expectedRevision: 2, expectedDraftRevision: 0, key: second.key, values: second.values,
  }), /已确认/);

  // 模型迟到不能覆盖另一个页面的手动修改。
  let finish!: (value: unknown) => void;
  const delayed = new Promise(resolve => { finish = resolve; });
  const analyzing = analyzeFormulaImportSession(db, 'p', batch, pending.id, { expectedRevision: 2, expectedDraftRevision: restored.draftRevision },
    { id: 'fixture', name: '测试模型', model: 'fixture', complete: () => delayed });
  const running = readFormulaInputs(db, 'p', batch).drafts.find(item => item.id === pending.id)!;
  const manual = await editFormulaScriptRow(db, 'p', batch, pending.id, { expectedRevision: 2, expectedDraftRevision: running.draftRevision,
    key: second.key, values: { ...second.values, '脚本文案': '人工修改优先保留。' } });
  finish({ mapping: pending.preview.mapping });
  await assert.rejects(() => analyzing);
  const preserved = readFormulaInputs(db, 'p', batch).drafts.find(item => item.id === pending.id)!;
  assert.equal(preserved.preview.scriptInputs![1].values['脚本文案'], '人工修改优先保留。');
  assert.equal(preserved.draftRevision, manual.draftRevision);

  // 旧排除行在新修订里继续排除；修正该行才重新加入。
  const excludedBatch = createBatchProduction(db, 'p', '排除行修订', undefined, { planningMode: 'formula' });
  const excludedDraft = await createFormulaImportSession(db, 'p', excludedBatch, {
    kind: 'scripts', filename: '有错误.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 0,
  });
  confirmFormulaImportSession(db, 'p', excludedBatch, excludedDraft.id, { expectedRevision: 0, excludedKeys: ['1:3'] });
  const excludedRevision = await reviseFormulaScriptImport(db, 'p', excludedBatch, excludedDraft.id, { expectedRevision: 1 });
  assert.deepEqual(excludedRevision.excludedKeys, ['1:3']);
  const repair = await editFormulaScriptRow(db, 'p', excludedBatch, excludedRevision.id, { expectedRevision: 1, expectedDraftRevision: 0,
    key: '1:3', values: { ...excludedRevision.preview.scriptInputs![1].values, '镜头数': '1' } });
  assert.deepEqual(repair.excludedKeys, []);
  assert.equal(confirmFormulaImportSession(db, 'p', excludedBatch, repair.id, { expectedRevision: 1, expectedDraftRevision: repair.draftRevision, excludedKeys: [] }).importedRows, 2);

  sheet.getCell('F3').value = { formula: '"不可使用缓存"', result: '不可使用缓存' };
  const computed = await createFormulaImportSession(db, 'p', excludedBatch, { kind: 'scripts', filename: '计算字段.xlsx',
    bytes: Buffer.from(await workbook.xlsx.writeBuffer()), expectedRevision: 2 });
  await assert.rejects(() => editFormulaScriptRow(db, 'p', excludedBatch, computed.id, { expectedRevision: 2, expectedDraftRevision: 0,
    key: '1:3', values: { ...computed.preview.scriptInputs![1].values, '脚本文案': '不能靠改字段绕过原表计算类型' } }), /转为值/);

  createBatchProductionVersion(db, batch, { copyCount: 1 });
  updateBatchProductionStatus(db, 'p', batch, 'running');
  await assert.rejects(() => editFormulaScriptRow(db, 'p', batch, pending.id, { expectedRevision: 2, expectedDraftRevision: manual.draftRevision,
    key: second.key, values: second.values }), /冻结/);
  await assert.rejects(() => reviseFormulaScriptImport(db, 'p', batch, revision.id, { expectedRevision: 2 }), /冻结/);
  console.log('formula-script-editing: 修正错误行、保留原文、整批重新校验和修订确认通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
