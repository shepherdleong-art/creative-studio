'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormulaReplacementHintsFile } from '@/lib/batch-production/formula/replacement-hints';
import type { FormulaReplacementHintsView } from '@/lib/batch-production/formula/replacement-hints-store';

async function read<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '替换建议处理失败');
  return result;
}
export default function FormulaReplacementHintsPanel({ projectId, batchId, inputRevision, disabled, onChanged }: {
  projectId: string; batchId: string; inputRevision: number; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaReplacementHintsView | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ file: File; parsed: FormulaReplacementHintsFile; revision: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/replacement-hints?projectId=${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read<FormulaReplacementHintsView>).then(next => {
      if (!controller.signal.aborted) setView(next);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision]);
  async function act(action: 'preview' | 'save' | 'clear') {
    if (!view || busy || disabled) return;
    const selected = action === 'save' ? preview?.file : file;
    if (action !== 'clear' && !selected) return;
    if (selected && selected.size > 256 * 1024) { setError('文件不能超过 256 KiB'); return; }
    const revision = action === 'save' ? preview!.revision : view.inputRevision;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${url}&action=${action}&expectedRevision=${revision}&filename=${encodeURIComponent(selected?.name ?? '')}`,
        { method: 'POST', body: action === 'clear' ? undefined : selected });
      if (action === 'preview') setPreview({ file: selected!, revision, parsed: await read<FormulaReplacementHintsFile>(response) });
      else { setView(await read<FormulaReplacementHintsView>(response)); setPreview(null); await onChanged(); }
    } catch (error) { setError(error instanceof Error ? error.message : '回复未收到，可以重试原操作'); }
    finally { setBusy(false); }
  }
  const locked = busy || disabled || !view?.editable;
  const hints = preview?.parsed.hints ?? view?.saved?.hints ?? [];
  return <section aria-label="替换建议参考" className="space-y-3 rounded-xl border border-hairline bg-surface p-4 text-sm text-ink">
    <h2 className="font-semibold">导入已有替换建议（可选）</h2>
    <p className="text-ink-secondary">可读取 substitutions.json 或 TXT。旧表只提供候选，生成时仍按当前台词、动作和卖点检查；不会直接变成你指定的统一替换规则。</p>
    <p className="text-xs text-ink-secondary">保存会替换本批正在使用的建议文件，已生成成片不变。JSON/TXT 使用 UTF-8 编码，最多 256 KiB；TXT 的备选和同号文件说明不会直接采用。</p>
    {error && <p role="alert" className="text-fail">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <input ref={fileInput} className="hidden" type="file" aria-label="替换建议文件" accept=".json,.txt" disabled={locked} onChange={event => {
        setFile(event.target.files?.[0] ?? null); setPreview(null); setError('');
      }} />
      <button type="button" className="btn-secondary" disabled={locked} onClick={() => fileInput.current?.click()}>选择建议文件</button>
      <span className="text-xs text-ink-secondary">{file?.name ?? '未选择文件'}</span>
      <button type="button" className="btn-secondary" disabled={locked || !file} onClick={() => void act('preview')}>读取建议</button>
      {preview && <button type="button" className="btn-primary" disabled={locked} onClick={() => void act('save')}>保存为候选参考</button>}
      {!!view?.saved?.hints.length && <button type="button" className="btn-secondary" disabled={locked} onClick={() => void act('clear')}>清除本批建议</button>}
    </div>
    <p role="status">{busy ? '正在处理…' : preview ? `预览 ${hints.length} 项，尚未保存` : hints.length ? `已保存 ${hints.length} 项 · ${view?.saved?.filename}` : '未使用导入的替换建议'}</p>
    {preview && preview.revision !== inputRevision && <p className="text-warn">资料已更新。若上次保存回复未收到，可重试同次保存；否则重新读取文件后再核对。</p>}
    <ul className="max-h-80 space-y-2 overflow-auto">{hints.map(hint => {
      const status = !preview ? view?.rows.find(row => row.originalCode === hint.originalCode)?.status : null;
      return <li key={hint.originalCode} className="rounded-lg border border-hairline p-2">
        <p className="font-medium">{hint.originalCode} → {hint.replacementCode}</p>
        <p className="text-xs text-warn">{status === 'undefined' ? '原编号尚未定义，请补充资料或修正公式；不能自动采用。'
          : status === 'missing_target' ? '替代编号缺少可用原片；不能自动采用。' : '仅为候选参考，尚未核验台词、动作及卖点。'}</p>
        <details className="text-xs text-ink-secondary"><summary className="cursor-pointer">原建议说明{hint.sourceLine ? ` · 第 ${hint.sourceLine} 行` : ''}</summary>
          <p className="whitespace-pre-wrap break-words">{hint.note}</p></details>
      </li>;
    })}</ul>
  </section>;
}
