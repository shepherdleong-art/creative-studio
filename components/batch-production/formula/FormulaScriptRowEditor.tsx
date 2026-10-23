'use client';

import { useState } from 'react';
import { FORMULA_WORKBOOK_FIELDS } from '@/lib/batch-production/formula/workbook-fields';
import type { FormulaScriptInput, FormulaScriptFields, FormulaScriptField } from '@/lib/batch-production/formula/script-rows';

const labels: Record<FormulaScriptField, string> = {
  '序号': '脚本序号', '平台': '平台', '镜头数': '镜头数', '预估时长(s)': '目标时长（秒）',
  '画面分镜(逻辑镜号组合)': '镜头顺序', '脚本文案': '脚本文案',
};

export default function FormulaScriptRowEditor({ input, busy, onSave, onClose }: {
  input: FormulaScriptInput; busy: boolean; onSave: (values: FormulaScriptFields) => void; onClose: () => void;
}) {
  const [values, setValues] = useState<FormulaScriptFields>({ ...input.values });
  return <section className="card space-y-3 p-4" aria-label="修改脚本行">
    <h3 className="font-semibold text-ink">修改脚本 · {input.source.sheet} 第 {input.source.row} 行</h3>
    <p className="text-sm text-ink-secondary">修改先保存到预览，整表确认后才替换已保存资料。Excel 原文和修改记录都会保留。</p>
    <form onSubmit={event => { event.preventDefault(); if (!busy) onSave(values); }}>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        {FORMULA_WORKBOOK_FIELDS.scripts.map(field => {
          const long = field === '脚本文案' || field === '画面分镜(逻辑镜号组合)';
          const props = { 'aria-label': labels[field], value: values[field], onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues(current => ({ ...current, [field]: event.target.value })),
            className: 'mt-1 w-full rounded-lg border border-hairline bg-surface p-2 text-ink', maxLength: long ? 65_536 : field === '平台' ? 200 : 64 };
          return <label key={field} className={`text-sm text-ink-secondary ${long ? 'sm:col-span-2' : ''}`}>
            {labels[field]}
            {long ? <textarea {...props} rows={field === '脚本文案' ? 4 : 2} /> : <input {...props} inputMode={field === '平台' ? 'text' : 'decimal'} />}
          </label>;
        })}
        <p className="text-xs text-ink-tertiary sm:col-span-2">镜头顺序可写 G1 → VO1 → G1；重复编号会保留。镜头数应与编号个数一致。</p>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button className="btn-primary" type="submit">保存修改</button>
          <button className="btn-secondary" type="button" onClick={() => setValues({ ...input.original })}>填回 Excel 原文</button>
          <button className="btn-secondary" type="button" onClick={onClose}>取消修改</button>
        </div>
      </fieldset>
    </form>
    <details className="text-sm text-ink-secondary">
      <summary className="cursor-pointer py-1">查看 Excel 原文与修改记录</summary>
      <div className="mt-2 max-h-72 space-y-3 overflow-auto rounded-lg border border-hairline p-3">
        <dl className="space-y-2">{FORMULA_WORKBOOK_FIELDS.scripts.map(field => <div key={field}>
          <dt className="font-medium text-ink">{labels[field]} · {input.source.cells[field]}</dt>
          <dd className="whitespace-pre-wrap break-words">{input.original[field] || '（空）'}</dd>
        </div>)}</dl>
        <p>{input.edits.length ? `已保存 ${input.edits.length} 次手工修改` : '尚无手工修改记录'}</p>
        {input.edits.map((edit, index) => <div key={`${edit.at}:${index}`} className="border-t border-hairline pt-2">
          <p className="text-xs text-ink-tertiary">第 {index + 1} 次 · {new Date(edit.at).toLocaleString('zh-CN')}</p>
          {Object.entries(edit.changes).map(([field, change]) => <div key={field} className="mt-1 whitespace-pre-wrap break-words">
            <p className="font-medium text-ink">{labels[field as FormulaScriptField]} · {change.cell}</p>
            <p>修改前：{change.before || '（空）'}</p><p>修改后：{change.after || '（空）'}</p>
          </div>)}
        </div>)}
      </div>
    </details>
  </section>;
}
