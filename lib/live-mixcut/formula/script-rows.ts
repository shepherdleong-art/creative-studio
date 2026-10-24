import { FORMULA_WORKBOOK_FIELDS } from './workbook-fields.ts';
import { parseFormula } from './parse.ts';
import type { FormulaRowSource, FormulaScriptRow } from './workbook.ts';

export type FormulaScriptField = typeof FORMULA_WORKBOOK_FIELDS.scripts[number];
export type FormulaScriptFields = Record<FormulaScriptField, string>;
export interface FormulaScriptInput {
  key: string;
  source: FormulaRowSource;
  original: FormulaScriptFields;
  values: FormulaScriptFields;
  blocked: string[];
  edits: Array<{ at: string; draftRevision: number; changes: Partial<Record<FormulaScriptField, { before: string; after: string; cell: string }>> }>;
}

/** 手工输入只改变有效值；原表值、计算单元格阻断及来源不能由请求覆盖。 */
export function readScriptEditValues(value: unknown): FormulaScriptFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('脚本字段格式不正确');
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== FORMULA_WORKBOOK_FIELDS.scripts.length
    || !FORMULA_WORKBOOK_FIELDS.scripts.every(field => typeof fields[field] === 'string')) throw new Error('请填写完整的六个脚本字段');
  for (const field of FORMULA_WORKBOOK_FIELDS.scripts) {
    const limit = field === '脚本文案' || field === '画面分镜(逻辑镜号组合)' ? 65_536 : field === '平台' ? 200 : 64;
    if ((fields[field] as string).length > limit) throw new Error(`${field}超过 ${limit} 字，请缩短后保存`);
  }
  return Object.fromEntries(FORMULA_WORKBOOK_FIELDS.scripts.map(field => [field, fields[field]])) as FormulaScriptFields;
}

/** 每次修改重验整表，包括另一行本身有错时仍然存在的重复序号。 */
export function validateScriptInputs(inputs: FormulaScriptInput[]): {
  rows: FormulaScriptRow[]; issues: Array<{ key: string; sheet: string; row: number; message: string }>;
} {
  const counts = new Map<string, number>();
  const rows: FormulaScriptRow[] = [];
  const issues: Array<{ key: string; sheet: string; row: number; message: string }> = [];
  const issue = (input: FormulaScriptInput, message: string) => issues.push({ key: input.key, sheet: input.source.sheet, row: input.source.row, message });
  for (const input of inputs) {
    const get = (field: FormulaScriptField) => input.values[field].trim();
    try {
      const scriptNumber = get('序号').normalize('NFKC');
      if (!/^[1-9][0-9]*$/.test(scriptNumber) || !Number.isSafeInteger(Number(scriptNumber))) throw new Error('脚本序号须为正整数');
      counts.set(scriptNumber, (counts.get(scriptNumber) ?? 0) + 1);
      if (input.blocked.length) throw new Error(input.blocked.join('；'));
      const targetDurationSec = Number(get('预估时长(s)'));
      if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) throw new Error('预估时长须为大于零的秒数');
      const bodyText = get('脚本文案');
      const platform = get('平台');
      if (!bodyText || !platform) throw new Error('平台和脚本文案不能为空');
      const formula = get('画面分镜(逻辑镜号组合)');
      rows.push({ key: input.key, source: input.source, scriptNumber, platform, targetDurationSec, bodyText,
        originalFormula: input.original['画面分镜(逻辑镜号组合)'], original: input.original, formula,
        codes: parseFormula(formula, Number(get('镜头数'))) });
    } catch (error) { issue(input, error instanceof Error ? error.message : '行内容无效'); }
  }
  return { rows: rows.filter(row => {
    if (counts.get(row.scriptNumber) === 1) return true;
    issues.push({ key: row.key, sheet: row.source.sheet, row: row.source.row, message: `编号 ${row.scriptNumber} 重复，请修改序号后确认` });
    return false;
  }), issues };
}
