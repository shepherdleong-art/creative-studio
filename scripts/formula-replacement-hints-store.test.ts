import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkFormulaReadiness } from '../lib/batch-production/formula/readiness.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { readFormulaReplacementHints, saveFormulaReplacementHints } from '../lib/batch-production/formula/replacement-hints-store.ts';
import { createFormulaImportSession, confirmFormulaImportSession } from '../lib/batch-production/formula/import-store.ts';
import { saveFormulaSettings } from '../lib/batch-production/formula/settings-store.ts';
import { createFormulaGenerationRequest, readFormulaGenerationRequest } from '../lib/batch-production/formula/generation.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-hints-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
let db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES ('p','测试'),('q','其他');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  assert.equal((await checkFormulaReadiness(options)).available, true);
  const batchId = createBatchProduction(db, 'p', '旧建议', undefined, { planningMode: 'formula' });
  const input = { expectedInputRevision: 0, filename: 'substitutions.json', bytes: Buffer.from('{"S76":{"sub":"S1"},"P100":{"sub":"P1"}}') };
  const first = saveFormulaReplacementHints(db, 'p', batchId, input);
  assert.equal(first.inputRevision, 1); assert.equal(first.saved!.hints.length, 2);
  assert.ok(first.rows.every(row => row.status === 'undefined'), '保存旧建议不等于给缺号创建了定义');
  assert.equal(saveFormulaReplacementHints(db, 'p', batchId, input).acceptedId, first.acceptedId);
  assert.throws(() => saveFormulaReplacementHints(db, 'q', batchId, input), /不存在|不属于/);
  assert.throws(() => saveFormulaReplacementHints(db, 'p', batchId, { ...input, bytes: Buffer.from('{"S76":{"sub":"S2"}}') }), /更新|冲突/);
  assert.throws(() => saveFormulaReplacementHints(db, 'p', batchId, { ...input, expectedInputRevision: 1, bytes: Buffer.from('{broken') }), /JSON/);
  assert.equal(readFormulaReplacementHints(db, 'p', batchId).inputRevision, 1);
  db.exec("CREATE TRIGGER reject_hints BEFORE INSERT ON batch_formula_replacement_hints BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  assert.throws(() => saveFormulaReplacementHints(db, 'p', batchId, { expectedInputRevision: 1, clear: true }), /fixture rollback/);
  assert.equal(readFormulaReplacementHints(db, 'p', batchId).inputRevision, 1);
  db.exec('DROP TRIGGER reject_hints');
  db.close(); db = new Database(path.join(root, 'test.db')); db.pragma('foreign_keys=ON');
  assert.equal(readFormulaReplacementHints(db, 'p', batchId).saved!.id, first.acceptedId);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [1, '抖音', 1, 3, 'S76', '金属脚。']]);
  const imported = await createFormulaImportSession(db, 'p', batchId, { kind: 'scripts', filename: '脚本.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'p', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  const settings = await saveFormulaSettings(db, 'p', batchId, { expectedInputRevision: 2, expectedSettingsRevision: 0, scriptsSessionId: imported.id,
    settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'p', batchId, { requestKey: 'hints', settingsId: settings.saved!.id, expectedInputRevision: 2 });
  assert.equal(request.input.replacementHints?.id, first.acceptedId);
  assert.deepEqual(request.input.replacementHints?.hints, first.saved!.hints);
  assert.throws(() => saveFormulaReplacementHints(db, 'p', batchId, { expectedInputRevision: 2, clear: true }), /冻结|输入/);
  assert.equal(saveFormulaReplacementHints(db, 'p', batchId, input).acceptedId, first.acceptedId, '已冻结后重试同次导入仍可确认原回执');
  assert.deepEqual(readFormulaGenerationRequest(db, 'p', batchId, request.id).input.replacementHints, first.saved);
  console.log('替换建议保存：原子导入、重试、跨项目/旧版本拒绝、重启及生成冻结通过');
} finally {
  db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
