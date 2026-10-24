'use client';

import { useState } from 'react';
import { FORMULA_WORKBOOK_FIELDS } from '@/lib/live-mixcut/formula/workbook-fields';
import type { FormulaImportSessionView } from '@/lib/live-mixcut/formula/import-store';
import type { FormulaSheetMapping } from '@/lib/live-mixcut/formula/workbook';

export default function FormulaColumnMapping({ session, busy, onApply }: {
  session: FormulaImportSessionView; busy: boolean; onApply: (mapping: FormulaSheetMapping[]) => void;
}) {
  const fields = FORMULA_WORKBOOK_FIELDS[session.kind];
  const [mapping, setMapping] = useState<FormulaSheetMapping[]>(() => (session.preview.sheets ?? []).map(sheet =>
    session.preview.mapping?.find(item => item.sheetId === sheet.id) ?? { sheetId: sheet.id, headerRow: 1, columns: {} }));
  if (!mapping.length) return <p className="text-sm text-ink-secondary">此旧预览未保存表头样本，请重新选择工作簿后修改。</p>;
  function update(sheetId: number, next: Partial<FormulaSheetMapping>) {
    setMapping(current => current.map(item => item.sheetId === sheetId ? { ...item, ...next } : item));
  }
  return <details className="rounded-lg border border-hairline p-3" open={session.preview.mapping?.length !== session.preview.sheets.length}>
    <summary className="cursor-pointer text-sm font-medium text-ink">手动选择列 / 修改识别结果</summary>
    <p className="mt-2 text-xs text-ink-secondary">指定表头行和各字段所在列。保存后重新读取整张表，保留原文；需要改台词或编号时，请修改原 Excel 后重新导入。</p>
    {session.preview.sheets.map(sheet => {
      const selected = mapping.find(item => item.sheetId === sheet.id)!;
      const header = sheet.samples.find(item => item.row === selected.headerRow);
      return <fieldset key={sheet.id} className="mt-3 space-y-3 border-t border-hairline pt-3" disabled={busy}>
        <legend className="text-sm text-ink">{sheet.name} · 共 {sheet.rowCount} 行</legend>
        <label className="flex items-center gap-2 text-sm text-ink">表头位于
          <select aria-label={`${sheet.name} 表头行`} value={selected.headerRow} onChange={event => update(sheet.id, { headerRow: Number(event.target.value) })}
            className="rounded border border-hairline bg-surface px-2 py-1 text-ink">
            {sheet.samples.map(sample => <option key={sample.row} value={sample.row}>第 {sample.row} 行</option>)}
          </select>
        </label>
        {selected.headerRow > 1 && <p className="text-xs text-ink-secondary">第 1–{selected.headerRow - 1} 行作为标题说明，资料从第 {selected.headerRow + 1} 行开始。</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map(field => <label key={field} className="flex flex-col gap-1 text-xs text-ink-secondary">{field}
            <select aria-label={`${sheet.name} ${field}对应列`} value={selected.columns[field] ?? ''}
              onChange={event => update(sheet.id, { columns: { ...selected.columns, [field]: Number(event.target.value) } })}
              className="min-w-0 rounded border border-hairline bg-surface px-2 py-2 text-sm text-ink">
              <option value="">请选择列</option>
              {Array.from({ length: sheet.columnCount }, (_, i) => <option key={i} value={i + 1}>第 {i + 1} 列 · {header?.cells.find(cell => cell.column === i + 1)?.text || '空表头'}</option>)}
            </select>
          </label>)}
        </div>
      </fieldset>;
    })}
    <button type="button" className="btn-secondary mt-3" disabled={busy || mapping.some(item => fields.some(field => !item.columns[field]))}
      onClick={() => onApply(mapping)}>保存列对应并重新预览</button>
  </details>;
}
