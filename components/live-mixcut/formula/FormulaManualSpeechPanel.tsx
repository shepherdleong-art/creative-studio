'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaManualSpeechMode, FormulaManualSpeechSegment, FormulaManualSpeechView } from '@/lib/live-mixcut/formula/manual-speech';

interface SegmentDraft { text: string; start: string; end: string }
const field = 'min-w-0 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink';
function draft(segment?: FormulaManualSpeechSegment): SegmentDraft {
  return { text: segment?.text ?? '', start: segment ? String(segment.startUs / 1_000_000) : '', end: segment ? String(segment.endUs / 1_000_000) : '' };
}
async function read(response: Response): Promise<FormulaManualSpeechView> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '读取人工台词失败');
  return body;
}
function micros(value: string): number {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('请填写有效的起止时间');
  return Math.round(Number(value) * 1_000_000);
}

/** 人工核对原声：从制作进度标红项进入，保存后用于下一轮生成。 */
export default function FormulaManualSpeechPanel({ projectId, batchId, planId, inputRevision, disabled, onChanged, onEditInput }: {
  projectId: string; batchId: string; planId?: string; inputRevision?: number; disabled: boolean; onChanged: () => Promise<void>; onEditInput?: () => void;
}) {
  const [view, setView] = useState<FormulaManualSpeechView | null>(null);
  const [assetId, setAssetId] = useState('');
  const [mode, setMode] = useState<FormulaManualSpeechMode>('automatic');
  const [segments, setSegments] = useState<SegmentDraft[]>([draft()]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showAll, setShowAll] = useState(false);
  const dirty = useRef(false), activeAsset = useRef('');
  const video = useRef<HTMLVideoElement>(null);
  const url = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/manual-speech?projectId=${encodeURIComponent(projectId)}${planId ? `&planId=${encodeURIComponent(planId)}` : ''}`;
  const apply = useCallback((next: FormulaManualSpeechView, selected: string) => {
    setView(next);
    const target = next.items.find(item => item.assetId === selected) ?? next.items.find(item => item.review?.needsAttention) ?? next.items[0];
    setAssetId(target?.assetId ?? ''); activeAsset.current = target?.assetId ?? '';
    const saved = target?.saved;
    setMode(saved?.mode ?? 'automatic');
    setSegments(saved?.segments.length ? saved.segments.map(draft) : [draft()]);
    setConfirmed(false); dirty.current = false;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read).then(next => {
      if (controller.signal.aborted) return;
      if (dirty.current) { setError('资料已更新，未保存的台词仍保留。请重新读取并核对后保存。'); return; }
      apply(next, activeAsset.current);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision, apply]);
  const item = view?.items.find(item => item.assetId === assetId);
  const refreshing = !!view && inputRevision !== undefined && view.inputRevision !== inputRevision;
  const locked = disabled || busy || !view?.editable || refreshing;
  const attention = view?.items.filter(source => source.review?.needsAttention) ?? [];
  const visibleItems = showAll || !attention.length ? view?.items ?? [] : attention;
  function selectAsset(selected: string) {
    if (dirty.current) { setError('当前台词尚未保存，请先保存或重新读取后再切换原片。'); return; }
    setError(''); setMessage(''); if (view) apply(view, selected);
  }
  function changed() { dirty.current = true; setConfirmed(false); setMessage('修改尚未保存。'); }
  function edit(index: number, patch: Partial<SegmentDraft>) {
    setSegments(current => current.map((segment, i) => i === index ? { ...segment, ...patch } : segment)); changed();
  }
  async function save() {
    if (!item || !view || locked) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await read(await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        assetId, contentFingerprint: item.contentFingerprint, expectedInputRevision: view.inputRevision,
        expectedSpeechRevision: item.saved?.revision ?? 0, mode, confirmed,
        segments: mode === 'speech' ? segments.map(segment => ({ text: segment.text, startUs: micros(segment.start), endUs: micros(segment.end) })) : [],
      }) }));
      apply(next, assetId); await onChanged();
      setMessage(mode === 'automatic' ? '已撤回人工核对；下一轮使用自动识别。旧制作记录保留。' : '人工原声记录已保存。下一次生成将使用这份记录，旧成片不变。');
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败，修改仍保留'); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError(''); setMessage('');
    try { apply(await read(await fetch(url, { cache: 'no-store' })), assetId); await onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3" aria-label="人工核对原声">
    {!view && !error && <p role="status" className="text-sm text-ink-secondary">正在定位这条脚本的原片…</p>}
    {view?.context && <div className="space-y-2">
      <p className="font-medium text-ink">脚本 {view.context.scriptNumber} · 第 {view.context.copyIndex} 份</p>
      <p className="text-sm text-ink-secondary">{attention.length ? `这条脚本有 ${attention.length} 条原片需要处理，已定位到具体原片。` : '这条脚本当前没有失败的原声检查，可选择原片试听核对。'}</p>
      <div className="space-y-2" aria-label="本条脚本的原片">
        {visibleItems.map(source => <button key={source.assetId} type="button" aria-pressed={assetId === source.assetId}
          disabled={busy || refreshing} onClick={() => selectAsset(source.assetId)}
          className={`w-full rounded-lg border p-3 text-left ${assetId === source.assetId ? 'border-accent bg-accent/10' : 'border-hairline bg-surface'}`}>
          <span className="block text-sm font-medium text-ink">{source.review?.logicalCodes.join(' / ')} · {source.saved && source.saved.mode !== 'automatic' ? '人工记录已保存，待下一轮应用' : source.review?.needsAttention ? '需处理' : '可核对'}</span>
          <span className="block break-all text-xs text-ink-secondary">{source.names[0]}</span>
        </button>)}
      </div>
      {!!attention.length && attention.length < view.items.length && <button type="button" className="btn-secondary text-xs" disabled={busy}
        onClick={() => setShowAll(current => !current)}>{showAll ? '只看需要处理的原片' : `查看本条脚本全部 ${view.items.length} 条原片`}</button>}
      {!view.items.length && <p role="status" className="text-sm text-warn">没有可核对的当前原片。请返回检查选片或素材是否已变化。</p>}
    </div>}
    <p className="text-sm text-ink-secondary">播放下方原片，听清是否有人说话。没有人声就选择「我已确认整段原片没有人声」；有人声则核对台词及起止时间。</p>
    {!view?.context && !planId && <select className={`${field} w-full`} aria-label="人工核对的原片" value={assetId} disabled={busy || !view || refreshing}
      onChange={event => selectAsset(event.target.value)}>
      <option value="">选择需要核对的原片</option>
      {view?.items.map(source => <option key={source.assetId} value={source.assetId}>{source.names[0]}{source.saved && source.saved.mode !== 'automatic' ? ' · 已人工核对' : ''}{!source.available ? '（当前不可用）' : ''}</option>)}
    </select>}
    {item && <>
      {item.review && <div className="rounded-lg border border-hairline p-3 text-sm">
        <p className="font-medium text-ink">当前核对：{item.review.logicalCodes.join(' / ')}</p>
        <p className="break-all text-ink-secondary">{item.names[0]}</p>
        <p className={item.review.needsAttention ? 'text-fail' : 'text-ink-secondary'}>{item.review.message}</p>
      </div>}
      <video ref={video} key={assetId} controls preload="metadata" className="max-h-64 w-full rounded-lg" aria-label="人工台词原片预览"
        src={`/api/live-mixcut/assets/${encodeURIComponent(assetId)}/preview?projectId=${encodeURIComponent(projectId)}`}
        onError={() => setError('原片暂时无法播放，请检查素材后重试。')} />
      {item.automatic && <div className="rounded-lg border border-hairline p-3 text-sm text-ink-secondary">
        <p>本轮自动识别：{item.automatic.text}</p>
        <button className="btn-secondary mt-2" type="button" disabled={locked} onClick={() => {
          setMode('speech'); setSegments(item.automatic!.segments.map(draft)); changed();
        }}>填入识别结果再修改</button>
      </div>}
      {!view?.editable && <div className="space-y-2 text-sm text-ink-secondary"><p>现在可以试听。本次输入已锁定，保存人工核对前，须回「脚本与口播」点「修改输入」，再打开此窗口。保存后重新生成才会应用。</p>
        {onEditInput && <button type="button" className="btn-secondary" onClick={onEditInput}>返回脚本与口播</button>}</div>}
      <fieldset disabled={locked} className="space-y-3">
        <legend className="text-sm font-medium text-ink">这份原片的声音</legend>
        {([['automatic', '自动识别'], ['speech', '人工填写台词和时间'], ['no_speech', '我已确认整段原片没有人声']] as const).map(([value, label]) =>
          <label key={value} className="flex items-center gap-2 text-sm text-ink"><input type="radio" name={`manual-speech-${batchId}`} checked={mode === value}
            onChange={() => { setMode(value); changed(); }} />{label}</label>
        )}
        {mode === 'speech' && <>
          {segments.map((segment, index) => <div key={index} className="space-y-2 rounded-lg border border-hairline p-3">
            <label className="block text-sm text-ink-secondary">台词片段 {index + 1}
              <textarea className={`${field} mt-1 w-full`} aria-label={`台词片段 ${index + 1}`} value={segment.text} maxLength={20_000} rows={2}
                onChange={event => edit(index, { text: event.target.value })} /></label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-sm text-ink-secondary">开始（秒）<input type="number" min={0} step="0.001" className={`${field} mt-1 w-full`} aria-label={`片段 ${index + 1} 开始秒`}
                value={segment.start} onChange={event => edit(index, { start: event.target.value })} /></label>
              <label className="text-sm text-ink-secondary">结束（秒）<input type="number" min={0} step="0.001" className={`${field} mt-1 w-full`} aria-label={`片段 ${index + 1} 结束秒`}
                value={segment.end} onChange={event => edit(index, { end: event.target.value })} /></label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => { if (video.current) edit(index, { start: video.current.currentTime.toFixed(3) }); }}>当前播放位置设为起点</button>
              <button type="button" className="btn-secondary" onClick={() => { if (video.current) edit(index, { end: video.current.currentTime.toFixed(3) }); }}>当前播放位置设为终点</button>
              <button type="button" className="btn-secondary" disabled={segments.length === 1} onClick={() => { setSegments(segments.filter((_, i) => i !== index)); changed(); }}>移除台词片段 {index + 1}</button>
            </div>
          </div>)}
          <button type="button" className="btn-secondary" disabled={segments.length >= 1000} onClick={() => { setSegments([...segments, draft()]); changed(); }}>添加台词片段</button>
          <p className="text-xs text-ink-secondary">按原片时间先后填写，片段不要重叠；句内停顿会保留。请把需要保留的完整话语写齐，生成后仍需审片。</p>
        </>}
        {mode !== 'automatic' && <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          {mode === 'speech' ? '我已试听，确认台词和时间与原片一致' : '我已试听，确认整段原片没有人声'}</label>}
        <button type="button" className="btn-primary" disabled={mode !== 'automatic' && !confirmed} onClick={() => void save()}>
          {busy ? '保存中…' : mode === 'automatic' ? '保存为自动识别' : '确认并保存原声记录'}</button>
      </fieldset>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => void reload()}>重新读取原声记录（放弃未保存修改）</button>
    </>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {message && <p role="status" className="text-sm text-ok">{message}</p>}
  </section>;
}
