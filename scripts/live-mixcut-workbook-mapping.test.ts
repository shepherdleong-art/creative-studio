import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readFormulaWorkbook } from '../lib/live-mixcut/formula/workbook.ts';

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('视频清单');
sheet.addRow(['PS866 投放脚本']);
sheet.addRow(['编号', '投放渠道', '镜头数量', '秒数', '素材顺序', '旁白']);
for (let i = 1; i <= 300; i++) sheet.addRow([i, '抖音', 3, 16, 'G1 VO1 G1', `原文 ${i}，保持标点。`]);
const mapping = [{ sheetId: sheet.id, headerRow: 2, columns: {
  '序号': 1, '平台': 2, '镜头数': 3, '预估时长(s)': 4, '画面分镜(逻辑镜号组合)': 5, '脚本文案': 6,
} }];
const preview = await readFormulaWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), 'scripts', { mapping });
assert.equal(preview.extraction, 'mapped_columns');
assert.equal(preview.rowCount, 300);
assert.equal(preview.rows.length, 300);
assert.equal(preview.rows[299].bodyText, '原文 300，保持标点。');
assert.deepEqual(preview.rows[0].codes, ['G1', 'VO1', 'G1']);
assert.equal(preview.rows[0].source.cells['脚本文案'], 'F3');
assert.equal(preview.rows[0].source.row, 3);
const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
await assert.rejects(() => readFormulaWorkbook(bytes, 'scripts', { mapping: [{ ...mapping[0], columns: { ...mapping[0].columns, '脚本文案': 5 } }] }), /重复/);
await assert.rejects(() => readFormulaWorkbook(bytes, 'scripts', { mapping: [{ ...mapping[0], headerRow: 4 }] }), /表头之前已有编号/);
await assert.rejects(() => readFormulaWorkbook(bytes, 'scripts', { mapping: [] }), /不完整/);
sheet.getCell('F302').value = { formula: '"伪装台词"', result: '伪装台词' };
const computed = await readFormulaWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), 'scripts', { mapping });
assert.equal(computed.rows.length, 299);
assert.match(computed.issues[0].message, /计算公式/);
console.log('formula-workbook-mapping: 非标准表头完整导入 300 行，原文与编号顺序不变');
