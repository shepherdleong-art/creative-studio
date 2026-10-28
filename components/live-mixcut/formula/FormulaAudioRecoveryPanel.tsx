'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormulaManualAudioBlock, FormulaManualAudioView } from '@/lib/live-mixcut/formula/manual-audio-mapping';

/** 展示实际台词；只有用户逐段选择并确认后，才追加这一条的声音修订。 */
export default function FormulaAudioRecoveryPanel({ projectId, batchId, planId, assets, onChanged }: {
  projectId: string; batchId: string; planId: string;
  assets: Array<{ slotId: string; assetId: string }>;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaManualAudioView | null>(null);
  const [blocks, setBlocks] = useState<FormulaManualAudioBlock[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const cursors = useRef<Record<number, number>>({});
  const url = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/manual-audio?projectId=${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.message || '无法读取声音依据');
      if (controller.signal.aborted) return;
      setView(body);
      setBlocks(body.blocks.length ? body.blocks : (body.bodyText.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text: string) => ({ text, kind: 'tts' })));
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '无法读取声音依据'); });
    return () => controller.abort();
  }, [url]);
  function update(index: number, block: FormulaManualAudioBlock) {
    setBlocks(current => current.map((value, i) => i === index ? block : value)); setConfirmed(false);
  }
  function split(index: number) {
    const at = cursors.current[index]; const block = blocks[index];
    if (!at || at >= block.text.length) { setError('请先在该段文字中点击需要拆分的位置。'); return; }
    // 分段改变了确认范围，必须重新指定用途，不能复制原声覆盖决定。
    setBlocks(current => current.flatMap((value, i) => i === index
      ? [{ text: value.text.slice(0, at), kind: 'tts' as const }, { text: value.text.slice(at), kind: 'tts' as const }] : [value]));
    setConfirmed(false); setError(''); cursors.current = {};
  }
  async function save() {
    if (!view || busy || !confirmed) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...view.expected, requestKey: crypto.randomUUID(), confirmed, blocks }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || '声音分配未保存');
      setSaved(true); await onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : '声音分配未保存'); }
    finally { setBusy(false); }
  }
  const disabled = busy || saved || !view?.editable;
  const complete = blocks.length > 0 && blocks.every(block => block.kind === 'reference'
    || block.kind === 'tts' && !!block.slotIds?.length
    || block.kind === 'source' && !!block.slotId
    || block.kind === 'on_screen' && !!block.slotId && !!block.displayText?.trim());
  return <section className="space-y-4" aria-label="核对文案与实际原声">
    <p className="text-sm text-ink-secondary">先试听以下原片，对照实际台词，再为每段文案选择用途。原声会整段保留，包括多说的内容；字幕使用实际台词。若需要改台词、声音模式或镜头，请返回修改输入。</p>
    {view?.sources.map(source => {
      const asset = assets.find(asset => asset.slotId === source.slotId);
      return <div key={source.slotId} className="space-y-2 rounded-xl border border-hairline p-3">
        <p className="font-medium text-ink">{source.label} · 实际台词</p>
        <p className="whitespace-pre-wrap text-sm text-ink-secondary">{source.text}</p>
        {asset && <video controls preload="metadata" className="max-h-40 w-full rounded-lg" aria-label={`${source.label}原声试听`}
          src={`/api/live-mixcut/assets/${encodeURIComponent(asset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`} />}
      </div>;
    })}
    {view && !view.sources.length && <p className="text-sm text-ink-secondary">这条成片没有可用的原声台词。</p>}
    {blocks.map((block, index) => <fieldset disabled={disabled} key={index} className="space-y-2 rounded-xl border border-hairline p-3">
      <legend className="text-sm font-medium text-ink">文案第 {index + 1} 段</legend>
      <textarea readOnly value={block.text} aria-label={`文案第 ${index + 1} 段原文`} rows={2}
        onSelect={event => { cursors.current[index] = event.currentTarget.selectionStart; }}
        className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink" />
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" onClick={() => split(index)}>在光标处拆段</button>
        {index < blocks.length - 1 && <button type="button" className="btn-secondary" onClick={() => {
          setBlocks(current => [...current.slice(0, index), { text: current[index].text + current[index + 1].text, kind: 'tts' }, ...current.slice(index + 2)]);
          setConfirmed(false); cursors.current = {};
        }}>合并下一段</button>}
      </div>
      <select aria-label={`第 ${index + 1} 段用途`} value={block.kind} className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink"
        onChange={event => update(index, { text: block.text, kind: event.target.value as FormulaManualAudioBlock['kind'] })}>
        <option value="tts">配音朗读</option><option value="source" disabled={!view?.sources.length}>使用对应原声</option>
        <option value="on_screen" disabled={!view?.packagingEnabled}>只显示花字</option><option value="reference">仅作备注，不朗读也不显示</option>
      </select>
      {block.kind === 'source' && <select aria-label={`第 ${index + 1} 段对应原声`} value={block.slotId ?? ''}
        className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink"
        onChange={event => update(index, { ...block, slotId: event.target.value })}>
        <option value="">请选择已试听并确认的原声</option>
        {view?.sources.map(source => <option key={source.slotId} value={source.slotId}>{source.label}：{source.text}</option>)}
      </select>}
      {block.kind === 'tts' && <>
        <select aria-label={`第 ${index + 1} 段配音位置`} value={JSON.stringify(block.slotIds ?? [])}
          className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink"
          onChange={event => update(index, { ...block, slotIds: JSON.parse(event.target.value) })}>
          <option value="[]">请选择无原声的连续镜头</option>
          {view?.windows.map(window => <option key={window.slotIds.join(',')} value={JSON.stringify(window.slotIds)}>{window.label}</option>)}
        </select>
        {view && !view.windows.length && <p className="text-sm text-fail">没有可安排配音的无原声镜头，请修改输入或原片选择。</p>}
      </>}
      {block.kind === 'on_screen' && <>
        <select aria-label={`第 ${index + 1} 段花字位置`} value={block.slotId ?? ''}
          className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink" onChange={event => update(index, { ...block, slotId: event.target.value })}>
          <option value="">请选择显示镜头</option>{view?.pictures.map(picture => <option key={picture.slotId} value={picture.slotId}>{picture.label}</option>)}
        </select>
        <input aria-label={`第 ${index + 1} 段花字正文`} value={block.displayText ?? ''} maxLength={60} placeholder="从本段原文摘取，最多 60 字"
          className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink" onChange={event => update(index, { ...block, displayText: event.target.value })} />
      </>}
    </fieldset>)}
    {view?.reason && <p className="text-sm text-ink-secondary">{view.reason}</p>}
    <label className="flex gap-2 text-sm text-ink"><input type="checkbox" checked={confirmed} disabled={disabled || !complete}
      onChange={event => setConfirmed(event.target.checked)} />我已试听原片并确认以上用途；未分配的原声仍保留，配音不重复台词。</label>
    <button type="button" className="btn-primary" disabled={disabled || !confirmed || !complete} onClick={() => void save()}>{busy ? '正在保存…' : '保存声音分配并继续这条'}</button>
    {!view && !error && <p role="status" className="text-sm text-ink-secondary">正在读取实际原声…</p>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {saved && <p role="status" className="text-sm text-ok">已保存这条成片的声音分配并继续制作，其他成片不变。</p>}
  </section>;
}
