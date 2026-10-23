'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaManualAudioView } from '@/lib/batch-production/formula/manual-audio-mapping';

type Draft = { text: string; choice: string; displayText?: string };
type SaveRequest = FormulaManualAudioView['expected'] & { requestKey: string; confirmed: boolean; blocks: unknown[] };
const field = 'w-full rounded-lg border border-hairline bg-surface p-2 text-ink disabled:opacity-50';
const button = 'rounded-lg border border-hairline px-3 py-2 disabled:opacity-50';
function drafts(view: FormulaManualAudioView): Draft[] {
  return view.blocks.length ? view.blocks.map(block => ({ text: block.text, choice: block.kind === 'source' ? `source:${block.slotId}`
    : block.kind === 'tts' ? `tts:${block.slotIds?.[0]}` : block.kind === 'on_screen' ? `screen:${block.slotId}` : 'reference',
    displayText: block.displayText })) : [{ text: view.bodyText, choice: '' }];
}

export default function FormulaManualAudioPanel({ projectId, batchId, planId, refreshKey, disabled, onSaved }: {
  projectId: string; batchId: string; planId: string; refreshKey: string; disabled: boolean; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false), [view, setView] = useState<FormulaManualAudioView | null>(null);
  const [rows, setRows] = useState<Draft[]>([]), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [retrySaved, setRetrySaved] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const dirty = useRef(false), base = useRef<FormulaManualAudioView['expected'] | null>(null);
  const pending = useRef<SaveRequest | null>(null), sequence = useRef(0);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/manual-audio?projectId=${encodeURIComponent(projectId)}`;
  const load = useCallback(async (discard: boolean, signal?: AbortSignal) => {
    const current = ++sequence.current;
    const response = await fetch(url, { cache: 'no-store', signal });
    const next = await response.json();
    if (!response.ok) throw new Error(next.message || '读取声音用途失败');
    if (signal?.aborted || current !== sequence.current) return;
    if (discard || !dirty.current) {
      setView(next); setRows(drafts(next)); base.current = next.expected;
      setConfirmed(false); setStale(false); setRetrySaved(false); pending.current = null; dirty.current = false;
    } else if (JSON.stringify(base.current) !== JSON.stringify(next.expected) && !pending.current) setStale(true);
  }, [url]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(false, controller.signal).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取失败'); });
    return () => controller.abort();
  }, [open, refreshKey, load]);
  function change(next: Draft[]) {
    setRows(next); dirty.current = true; pending.current = null;
    setConfirmed(false); setRetrySaved(false); setMessage(''); setError('');
  }
  async function reload() {
    setBusy(true); setError('');
    try { await load(true); setMessage('已读取当前声音用途，未保存修改已放弃。'); }
    catch (error) { setError(error instanceof Error ? error.message : '读取失败'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!view || !base.current || busy || disabled || stale || !confirmed) return;
    if (!pending.current) {
      pending.current = { ...base.current, requestKey: crypto.randomUUID(), confirmed,
        blocks: rows.map(row => row.choice.startsWith('source:') ? { text: row.text, kind: 'source', slotId: row.choice.slice(7) }
          : row.choice.startsWith('tts:') ? { text: row.text, kind: 'tts', slotIds: view.windows.find(window => window.slotIds[0] === row.choice.slice(4))?.slotIds }
            : row.choice.startsWith('screen:') ? { text: row.text, kind: 'on_screen', slotId: row.choice.slice(7), displayText: row.displayText ?? row.text }
            : { text: row.text, kind: row.choice }) };
    }
    dirty.current = true; setBusy(true); setError(''); setMessage(''); setRetrySaved(true);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.current) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) { pending.current = null; setRetrySaved(false); if (response.status === 409) setStale(true); }
        throw new Error(result.message || '声音用途未保存，请重试');
      }
      pending.current = null; dirty.current = false; setRetrySaved(false); setConfirmed(false);
      setMessage('声音用途已保存，正在重做这条成片；其他成片不变。');
      await load(true); onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : '保存回复未收到，可以按原内容重试。'); }
    finally { setBusy(false); }
  }
  const locked = busy || disabled || stale || (!view?.editable && !retrySaved);
  const complete = !!view && rows.length > 0 && rows.every(row => row.choice && row.text)
    && rows.every(row => !row.choice.startsWith('screen:') || (!!(row.displayText ?? row.text).trim() && row.text.includes(row.displayText ?? row.text)))
    && rows.map(row => row.text).join('') === view.bodyText;
  return <div className="space-y-2">
    <button type="button" className={button} aria-expanded={open} onClick={() => setOpen(value => !value)}>人工分配声音用途</button>
    {open && <section aria-label="人工声音用途编辑" className="space-y-3 rounded-lg border border-hairline p-3 text-xs text-ink">
      <p>自动分配有疑问时，把文案拆成几段，选原声、配音、画面花字或仅供参考。保存后按原公式和已选原片重做这一条，当前时间轴上的人工调整不会带入新结果；旧版本保留，其他成片不变。</p>
      <p className="text-ink-secondary">原声完整保留，字幕按实际台词。仅供参考的文字不朗读，也不自动贴到画面上。</p>
      {error && <p role="alert" className="text-fail">{error}</p>}
      {message && <p role="status" className="text-ok">{message}</p>}
      {stale && <p role="status" className="text-warn">成片或声音依据已更新，未保存内容保留。请重新读取后核对。</p>}
      {!view ? <p>正在读取声音用途…</p> : <>
        {view.reason && <p role="status" className="text-warn">{view.reason}</p>}
        <div className="space-y-1"><p className="font-medium">脚本原文</p><p className="whitespace-pre-wrap">{view.bodyText}</p></div>
        {view.sources.map(source => <p key={source.slotId} className="whitespace-pre-wrap text-ink-secondary">{source.label}实际台词：{source.text}</p>)}
        <button type="button" className={button} disabled={locked} onClick={() => change((view.bodyText.match(/[^。！？!?；;\r\n]+[。！？!?；;\r\n]*|[。！？!?；;\r\n]+/gu) ?? [view.bodyText])
          .map(text => ({ text, choice: '' })))}>按句重新拆分</button>
        {rows.map((row, index) => <div key={index} className="space-y-2 rounded-lg border border-hairline p-2">
          <label className="block space-y-1"><span>文案段 {index + 1}</span><textarea aria-label={`文案段 ${index + 1}`} className={field} disabled={locked}
            value={row.text} onChange={event => change(rows.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></label>
          <label className="block space-y-1"><span>这段怎么用</span><select aria-label={`文案段 ${index + 1} 用途`} className={field} disabled={locked}
            value={row.choice} onChange={event => change(rows.map((item, i) => i === index ? { ...item, choice: event.target.value } : item))}>
            <option value="">请选择用途</option>
            {view.sources.map(source => <option key={source.slotId} value={`source:${source.slotId}`}>用{source.label}原声</option>)}
            {view.windows.map(window => <option key={window.slotIds[0]} value={`tts:${window.slotIds[0]}`}>配音放在{window.label}</option>)}
            {view.pictures.map(picture => <option key={picture.slotId} value={`screen:${picture.slotId}`} disabled={!view.packagingEnabled}>花字显示在{picture.label}</option>)}
            <option value="reference">仅作参考（不朗读）</option>
          </select></label>
          {row.choice.startsWith('screen:') && <label className="block space-y-1"><span>画面上显示的文字（从本段原文选取，最多 60 字符）</span>
            <input aria-label={`文案段 ${index + 1} 花字正文`} className={field} disabled={locked} maxLength={60}
              value={row.displayText ?? row.text} onChange={event => change(rows.map((item, i) => i === index ? { ...item, displayText: event.target.value } : item))} />
          </label>}
          <button type="button" className={button} disabled={locked || rows.length <= 1} onClick={() => change(rows.filter((_, i) => i !== index))}>移除文案段 {index + 1}</button>
        </div>)}
        {!view.packagingEnabled && <p className="text-ink-secondary">本次关闭了包装；要显示花字，请回第二步启用包装并重新生成。</p>}
        <button type="button" className={button} disabled={locked || rows.length >= 1000} onClick={() => change([...rows, { text: '', choice: '' }])}>添加文案段</button>
        {rows.map(row => row.text).join('') !== view.bodyText && <p className="text-warn">各段按顺序拼起来须与脚本原文完全一致。要改文案，请到第二步「修改输入」。</p>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={locked}
          onChange={event => setConfirmed(event.target.checked)} /><span>我已试听并核对用途，原声字幕按实际台词保留</span></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={locked || !complete || !confirmed} onClick={() => void save()}>{busy ? '保存中…' : '保存并重做这条'}</button>
          <button type="button" className={button} disabled={busy} onClick={() => void reload()}>放弃修改，重新读取</button>
        </div>
      </>}
    </section>}
  </div>;
}
