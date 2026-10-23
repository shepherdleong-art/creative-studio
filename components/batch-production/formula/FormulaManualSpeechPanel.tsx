'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaManualSpeechMode, FormulaManualSpeechSegment, FormulaManualSpeechView } from '@/lib/batch-production/formula/manual-speech';

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

export default function FormulaManualSpeechPanel({ projectId, batchId, inputRevision, disabled, onChanged }: {
  projectId: string; batchId: string; inputRevision: number; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaManualSpeechView | null>(null);
  const [assetId, setAssetId] = useState('');
  const [mode, setMode] = useState<FormulaManualSpeechMode>('automatic');
  const [segments, setSegments] = useState<SegmentDraft[]>([draft()]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = useRef(false), activeAsset = useRef('');
  const video = useRef<HTMLVideoElement>(null);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/manual-speech?projectId=${encodeURIComponent(projectId)}`;
  const apply = useCallback((next: FormulaManualSpeechView, selected: string) => {
    setView(next);
    const saved = next.items.find(item => item.assetId === selected)?.saved;
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
  const refreshing = !!view && view.inputRevision !== inputRevision;
  const locked = disabled || busy || !view?.editable || refreshing;
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
  return <section className="card space-y-3 p-4" aria-label="人工核对原声">
    <h2 className="text-base font-semibold text-ink">人工核对原声</h2>
    <p className="text-sm text-ink-secondary">识别不准或没有识别服务时，试听原片，填写实际说话内容及时间。保存后用于下一轮字幕和剪辑；时间按你的填写使用，不会凭一句话猜出逐字时间。</p>
    <select className={`${field} w-full`} aria-label="人工核对的原片" value={assetId} disabled={busy || !view || refreshing}
      onChange={event => {
        if (dirty.current) { setError('当前台词尚未保存，请先保存或重新读取后再切换原片。'); return; }
        setAssetId(event.target.value); activeAsset.current = event.target.value;
        setError(''); setMessage(''); if (view) apply(view, event.target.value);
      }}>
      <option value="">选择需要核对的原片</option>
      {view?.items.map(source => <option key={source.assetId} value={source.assetId}>{source.names[0]}{source.saved && source.saved.mode !== 'automatic' ? ' · 已人工核对' : ''}{!source.available ? '（当前不可用）' : ''}</option>)}
    </select>
    {item && <>
      <video ref={video} key={assetId} controls preload="metadata" className="max-h-64 w-full" aria-label="人工台词原片预览"
        src={`/api/batch-production/assets/${encodeURIComponent(assetId)}/preview?projectId=${encodeURIComponent(projectId)}`}
        onError={() => setError('原片暂时无法播放，请检查素材后重试。')} />
      {item.automatic && <div className="rounded-lg border border-hairline p-3 text-sm text-ink-secondary">
        <p>本轮自动识别：{item.automatic.text}</p>
        <button className="btn-secondary mt-2" type="button" disabled={locked} onClick={() => {
          setMode('speech'); setSegments(item.automatic!.segments.map(draft)); changed();
        }}>填入识别结果再修改</button>
      </div>}
      {!view?.editable && <p className="text-sm text-ink-secondary">本次输入已锁定，先点上方「修改输入」再校正。</p>}
      <fieldset disabled={locked} className="space-y-3">
        <legend className="text-sm font-medium text-ink">这份原片的声音</legend>
        {([['automatic', '自动识别'], ['speech', '人工填写台词和时间'], ['no_speech', '我已确认整段原片没有人声']] as const).map(([value, label]) =>
          <label key={value} className="flex items-center gap-2 text-sm text-ink"><input type="radio" name={`manual-speech-${batchId}`} checked={mode === value}
            onChange={() => { setMode(value); changed(); }} />{label}</label>)}
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
