import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { normalizeLogicalCode } from './parse.ts';
import { validateScriptInputs, type FormulaScriptInput, type FormulaScriptFields } from './script-rows.ts';
import { FORMULA_WORKBOOK_LIMITS, validateFormulaWorkbookBudget } from './workbook-budget.ts';
import { FORMULA_WORKBOOK_FIELDS } from './workbook-fields.ts';

export type FormulaWorkbookKind = 'materials' | 'scripts';
export interface FormulaSheetMapping { sheetId: number; headerRow: number; columns: Record<string, number> }
export interface FormulaWorkbookSheet {
  id: number; name: string; rowCount: number; columnCount: number;
  samples: Array<{ row: number; cells: Array<{ column: number; text: string }> }>;
}
export interface FormulaWorkbookOptions { mapping?: FormulaSheetMapping[]; allowUnmapped?: boolean }
export interface FormulaRowSource { sheet: string; row: number; cells: Record<string, string> }
export interface FormulaScriptRow {
  key: string;
  source: FormulaRowSource;
  scriptNumber: string;
  platform: string;
  targetDurationSec: number;
  bodyText: string;
  originalFormula: string;
  original?: FormulaScriptFields;
  formula?: string;
  codes: string[];
}
export interface FormulaMaterialRow {
  key: string;
  source: FormulaRowSource;
  logicalCode: string;
  fields: Record<string, string>;
}
export interface FormulaWorkbookPreview<T> {
  kind: FormulaWorkbookKind;
  fingerprint: string;
  extraction: 'local_headers' | 'mapped_columns';
  mapping: FormulaSheetMapping[];
  sheets: FormulaWorkbookSheet[];
  rowCount: number;
  rows: T[];
  issues: Array<{ key: string; sheet: string; row: number; message: string }>;
  scriptInputs?: FormulaScriptInput[];
  revisionOf?: string;
}

function text(cell: ExcelJS.Cell): string {
  if (cell.type === ExcelJS.ValueType.Formula || (cell.value && typeof cell.value === 'object'
    && ('formula' in cell.value || 'sharedFormula' in cell.value))) {
    throw new Error(`单元格 ${cell.address} 是计算公式，请转为值后导入`);
  }
  if (cell.type === ExcelJS.ValueType.Error) throw new Error(`单元格 ${cell.address} 包含错误值`);
  return cell.text.trim();
}

export function readFormulaWorkbook(bytes: Buffer, kind: 'scripts', options?: FormulaWorkbookOptions): Promise<FormulaWorkbookPreview<FormulaScriptRow>>;
export function readFormulaWorkbook(bytes: Buffer, kind: 'materials', options?: FormulaWorkbookOptions): Promise<FormulaWorkbookPreview<FormulaMaterialRow>>;
export function readFormulaWorkbook(bytes: Buffer, kind: FormulaWorkbookKind, options?: FormulaWorkbookOptions): Promise<FormulaWorkbookPreview<FormulaScriptRow | FormulaMaterialRow>>;
export async function readFormulaWorkbook(bytes: Buffer, kind: FormulaWorkbookKind, options: FormulaWorkbookOptions = {}): Promise<FormulaWorkbookPreview<FormulaScriptRow | FormulaMaterialRow>> {
  validateFormulaWorkbookBudget(bytes);
  const workbook = new ExcelJS.Workbook();
  type LoadInput = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];
  await workbook.xlsx.load(bytes as unknown as LoadInput);
  const preview: FormulaWorkbookPreview<FormulaScriptRow | FormulaMaterialRow> = {
    kind, fingerprint: createHash('sha256').update(bytes).digest('hex'),
    extraction: options.mapping ? 'mapped_columns' : 'local_headers', mapping: [], sheets: [], rowCount: 0, rows: [], issues: [],
    ...(kind === 'scripts' ? { scriptInputs: [] } : {}),
  };
  if (options.mapping && (!Array.isArray(options.mapping)
    || options.mapping.some(item => !item || !Number.isSafeInteger(item.sheetId))
    || new Set(options.mapping.map(item => item.sheetId)).size !== options.mapping.length
    || options.mapping.some(item => !workbook.worksheets.some(sheet => sheet.id === item.sheetId && sheet.rowCount)))) {
    throw new Error('工作表映射重复或不存在');
  }
  const counts = new Map<string, number>();
  for (const sheet of workbook.worksheets) {
    if (!sheet.rowCount) continue;
    if (sheet.rowCount > FORMULA_WORKBOOK_LIMITS.rows || sheet.columnCount > FORMULA_WORKBOOK_LIMITS.columns) {
      throw new Error('工作簿超过 10,000 行或 50 列，请拆分后导入');
    }
    const samples: FormulaWorkbookSheet['samples'] = [];
    for (let n = 1; n <= Math.min(sheet.rowCount, 20); n++) {
      const cells: FormulaWorkbookSheet['samples'][number]['cells'] = [];
      sheet.getRow(n).eachCell(cell => {
        let value: string;
        try { value = text(cell); } catch { value = '[计算或错误单元格，请转为值]'; }
        cells.push({ column: Number(cell.col), text: value.slice(0, 160) });
      });
      samples.push({ row: n, cells });
    }
    preview.sheets.push({ id: sheet.id, name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount, samples });
    const selected = options.mapping?.find(item => item.sheetId === sheet.id);
    const headerRow = selected?.headerRow ?? 1;
    if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > Math.min(sheet.rowCount, 20)) throw new Error('表头行须位于工作表前 20 行内');
    const headers = new Map<string, number>();
    sheet.getRow(headerRow).eachCell(cell => {
      const header = text(cell).normalize('NFKC');
      if (!header) return;
      if (headers.has(header)) throw new Error(`工作表「${sheet.name}」包含重复表头「${header}」`);
      headers.set(header, Number(cell.col));
    });
    const required = FORMULA_WORKBOOK_FIELDS[kind];
    if (options.mapping) {
      if (!selected || !selected.columns || typeof selected.columns !== 'object'
        || Array.isArray(selected.columns) || Object.keys(selected.columns).some(key => !(required as readonly string[]).includes(key))
        || !required.every(field => Number.isSafeInteger(selected.columns[field]) && selected.columns[field] >= 1 && selected.columns[field] <= sheet.columnCount)
        || new Set(Object.values(selected.columns)).size !== required.length) throw new Error(`工作表「${sheet.name}」列对应不完整、重复或越界`);
      for (const field of required) headers.set(field, selected.columns[field]);
      for (let n = 1; n < headerRow; n++) {
        const candidate = sheet.getRow(n).getCell(selected.columns[kind === 'scripts' ? '序号' : '逻辑编号']);
        const value = text(candidate).normalize('NFKC');
        if ((kind === 'scripts' && /^[1-9][0-9]*$/.test(value)) || (kind === 'materials' && /^[A-Z]+[0-9]+$/i.test(value))) {
          throw new Error(`工作表「${sheet.name}」表头之前已有编号资料，请检查表头行，不能遗漏这些行`);
        }
      }
    }
    if (!required.every(header => headers.has(header))) {
      if (!options.allowUnmapped) throw new Error(`工作表「${sheet.name}」缺少必需列，请先核对表头`);
      sheet.eachRow((_row, rowNumber) => { if (rowNumber > headerRow) preview.rowCount++; });
      preview.issues.push({ key: `sheet:${sheet.id}`, sheet: sheet.name, row: headerRow, message: '尚未识别列对应，请使用 AI 识别或手动选择列' });
      continue;
    }
    preview.mapping.push({ sheetId: sheet.id, headerRow, columns: Object.fromEntries(required.map(field => [field, headers.get(field)!])) });
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      preview.rowCount++;
      if (preview.rowCount > FORMULA_WORKBOOK_LIMITS.rows) throw new Error('整个工作簿超过 10,000 行，请拆分导入');
      const key = `${sheet.id}:${rowNumber}`;
      const source: FormulaRowSource = { sheet: sheet.name, row: rowNumber, cells: {} };
      if (kind === 'scripts') {
        const original = {} as FormulaScriptFields;
        const blocked: string[] = [];
        for (const field of FORMULA_WORKBOOK_FIELDS.scripts) {
          const cell = row.getCell(headers.get(field)!);
          source.cells[field] = cell.address;
          try { text(cell); original[field] = cell.text; }
          catch (error) {
            const message = error instanceof Error ? error.message : '单元格无效';
            blocked.push(message);
            original[field] = `[${message}]`;
          }
        }
        preview.scriptInputs!.push({ key, source, original, values: { ...original }, blocked, edits: [] });
        return;
      }
      const get = (header: string) => {
        const cell = row.getCell(headers.get(header)!);
        source.cells[header] = cell.address;
        return text(cell);
      };
      try {
        // 先登记身份；同号的另一行即使有字段错误，也不能自动选中这一行。
        const identity = normalizeLogicalCode(get('逻辑编号'));
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
        if (!get('画面描述')) throw new Error('画面描述不能为空');
        preview.rows.push({ key, source, logicalCode: identity,
          fields: Object.fromEntries([...headers.keys()].map(header => [header, get(header)])),
        });
      } catch (error) {
        preview.issues.push({ key, sheet: sheet.name, row: rowNumber, message: error instanceof Error ? error.message : '行内容无效' });
      }
    });
  }
  if (preview.rowCount > FORMULA_WORKBOOK_LIMITS.rows) throw new Error('整个工作簿超过 10,000 行，请拆分导入');
  if (!preview.rowCount && !preview.issues.length) throw new Error('工作簿没有可导入的资料行');
  if (kind === 'scripts') {
    const validated = validateScriptInputs(preview.scriptInputs!);
    preview.rows = validated.rows;
    preview.issues.push(...validated.issues);
    return preview;
  }
  preview.rows = preview.rows.filter(row => {
    const identity = 'logicalCode' in row ? row.logicalCode : row.scriptNumber;
    if ((counts.get(identity) ?? 0) === 1) return true;
    preview.issues.push({ key: row.key, sheet: row.source.sheet, row: row.source.row, message: `编号 ${identity} 重复，请修正后重新导入` });
    return false;
  });
  return preview;
}
