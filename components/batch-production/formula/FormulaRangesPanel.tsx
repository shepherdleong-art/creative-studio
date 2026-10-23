'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaAssetRangesView } from '@/lib/batch-production/formula/asset-ranges';
import type { FormulaAvailableRange } from '@/lib/batch-production/formula/range-contract';

interface RangeDraft { label: string; start: string; end: string; protect: boolean; protectedStart: string; protectedEnd: string }
const field = 'min-w-0 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink';
function draft(range?: FormulaAvailableRange): RangeDraft {
  return { label: range?.label ?? '', start: String((range?.inUs ?? 0) / 1_000_000), end: range ? String(range.outUs / 1_000_000) : '',
    protect: !!range?.protected, protectedStart: range?.protected ? String(range.protected.inUs / 1_000_000) : '',
    protectedEnd: range?.protected ? String(range.protected.outUs / 1_000_000) : '' };
}
async function read(response: Response): Promise<FormulaAssetRangesView> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '读取区间失败');
  return body;
}
function micros(value: string): number {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('请填写有效的起止时间');
  return Math.round(Number(value) * 1_000_000);
}

export default function FormulaRangesPanel({ projectId, batchId, inputRevision, disabled, onChanged }: {
  projectId: string; batchId: string; inputRevision: number; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaAssetRangesView | null>(null);
  const [assetId, setAssetId] = useState('');
  const [ranges, setRanges] = useState<RangeDraft[]>([draft()]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const dirty = useRef(false);
  const activeAsset = useRef('');
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const previewFrame = useRef<number | null>(null);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/ranges?projectId=${encodeURIComponent(projectId)}`;
  const apply = useCallback((next: FormulaAssetRangesView, selected: string) => {
    setView(next);
    const saved = next.items.find(item => item.assetId === selected)?.saved;
    setRanges(saved ? saved.ranges.map(item => draft(item)) : [draft()]);
    setConfirmed(false); dirty.current = false;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read).then(next => {
      if (controller.signal.aborted) return;
      if (dirty.current) { setError('资料已更新，未保存的区间仍保留。请重新读取并核对后保存。'); return; }
      apply(next, activeAsset.current);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision, apply]);
  useEffect(() => () => {
    if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
    stopAt.current = null;
  }, []);
  const item = view?.items.find(item => item.assetId === assetId);
  const refreshing = !!view && view.inputRevision !== inputRevision;
  const locked = disabled || busy || !view?.editable || refreshing;
  function edit(index: number, patch: Partial<RangeDraft>) {
    setRanges(ranges.map((range, i) => i === index ? { ...range, ...patch } : range));
    dirty.current = true; setConfirmed(false); setMessage('区间尚未保存。');
  }
  async function save() {
    if (!item || !view || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await read(await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, contentFingerprint: item.contentFingerprint, expectedInputRevision: view.inputRevision,
          expectedRangeRevision: item.saved?.revision ?? 0, confirmed, ranges: ranges.map(range => ({ label: range.label,
            inUs: micros(range.start), outUs: micros(range.end), protected: range.protect
              ? { inUs: micros(range.protectedStart), outUs: micros(range.protectedEnd) } : null })) }) }));
      apply(next, assetId);
      await onChanged();
      setMessage(ranges.length ? '可用区间已保存，声音仍待核验。' : '已撤回这份原片的可用区间，轮换候选需重新确认。');
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败，区间已保留'); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError(''); setMessage('');
    try { apply(await read(await fetch(url, { cache: 'no-store' })), assetId); }
    catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
    finally { setBusy(false); }
  }
  async function playRange(range: RangeDraft) {
    setError('');
    try {
      const start = micros(range.start) / 1_000_000;
      const end = micros(range.end) / 1_000_000;
      if (!video.current || duration === null || start < 0 || end <= start || end > duration) throw new Error('请先加载原片，并填写原片范围内的起止时间');
      video.current.currentTime = start; stopAt.current = end;
      await video.current.play();
      if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current);
      const watch = () => {
        previewFrame.current = null;
        const element = video.current;
        if (!element || stopAt.current === null) return;
        if (element.currentTime >= stopAt.current || element.paused) { element.pause(); stopAt.current = null; return; }
        previewFrame.current = requestAnimationFrame(watch);
      };
      previewFrame.current = requestAnimationFrame(watch);
    } catch (err) { setError(err instanceof Error ? err.message : '片段播放失败'); }
  }
  return <section className="card space-y-3 p-4" aria-label="可用区间">
    <h2 className="text-base font-semibold text-ink">标记可用区间</h2>
    <p className="text-sm text-ink-secondary">可选操作。预览原片，标出能用的片段；要保留完整动作时再填写保护范围。加入候选轮换前，每份原片都需要确认可用区间。</p>
    {view && !view.editable && <p className="text-sm text-ink-secondary">本次制作输入已冻结，区间只读；修改需建立新的输入版本。</p>}
    {refreshing && !error && <p role="status" className="text-sm text-ink-secondary">正在更新素材与可用区间…</p>}
    <select className={`${field} w-full`} aria-label="标记可用区间的原片" value={assetId} disabled={busy || disabled || !view || refreshing}
      onChange={event => {
        if (dirty.current) { setError('当前区间尚未保存。请先保存，或重新读取以放弃修改后再切换原片。'); return; }
        const selected = event.target.value;
        activeAsset.current = selected; setAssetId(selected); setDuration(null); stopAt.current = null; setError(''); setMessage('');
        if (view) apply(view, selected);
      }}>
      <option value="">选择需要标记的原片</option>
      {view?.items.map(item => <option key={item.assetId} value={item.assetId}>{item.names[0]} · {item.saved?.ranges.length ?? 0} 个已确认区间{!item.available ? '（当前不可用）' : ''}</option>)}
    </select>
    {item && <>
      <video ref={video} key={assetId} controls preload="metadata" className="max-h-64 w-full" aria-label="区间原片预览"
        src={`/api/batch-production/assets/${encodeURIComponent(assetId)}/preview?projectId=${encodeURIComponent(projectId)}`}
        onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null)}
        onError={() => setError('原片暂时无法播放，请检查素材后重试。')} />
      <p className="text-xs text-ink-tertiary">{duration !== null ? `原片时长 ${duration.toFixed(3)} 秒。` : '正在读取原片时长…'} 起点包含在片段内，终点是片段结束位置。每段至少容纳 0.5 秒；保存时会再次核验实际文件。</p>
      {ranges.map((range, index) => <fieldset key={index} className="space-y-2 rounded-lg border border-hairline p-3" disabled={locked}>
        <legend className="px-1 text-sm text-ink">片段 {index + 1}</legend>
        <input className={`${field} w-full`} aria-label={`片段 ${index + 1} 名称`} placeholder="片段名称（可选）" maxLength={100} value={range.label} onChange={event => edit(index, { label: event.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm text-ink-secondary">起点（秒）<input type="number" min="0" step="0.001" className={`${field} w-full`} aria-label={`片段 ${index + 1} 起点（秒）`} value={range.start} onChange={event => edit(index, { start: event.target.value })} /></label>
          <label className="space-y-1 text-sm text-ink-secondary">终点（秒）<input type="number" min="0" step="0.001" className={`${field} w-full`} aria-label={`片段 ${index + 1} 终点（秒）`} value={range.end} onChange={event => edit(index, { end: event.target.value })} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={range.protect} aria-label={`片段 ${index + 1} 保留完整动作`} onChange={event => edit(index, { protect: event.target.checked })} />保留完整动作，不可裁掉下列范围</label>
        {range.protect && <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm text-ink-secondary">动作开始（秒）<input type="number" min="0" step="0.001" className={`${field} w-full`} aria-label={`片段 ${index + 1} 动作开始（秒）`} value={range.protectedStart} onChange={event => edit(index, { protectedStart: event.target.value })} /></label>
          <label className="space-y-1 text-sm text-ink-secondary">动作结束（秒）<input type="number" min="0" step="0.001" className={`${field} w-full`} aria-label={`片段 ${index + 1} 动作结束（秒）`} value={range.protectedEnd} onChange={event => edit(index, { protectedEnd: event.target.value })} /></label>
        </div>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => void playRange(range)}>播放片段 {index + 1}</button>
          <button type="button" className="btn-secondary" onClick={() => { setRanges(ranges.filter((_, i) => i !== index)); dirty.current = true; setConfirmed(false); setMessage('区间尚未保存。'); }}>移除片段 {index + 1}</button>
        </div>
      </fieldset>)}
      <button type="button" className="btn-secondary" disabled={locked || ranges.length >= 100} onClick={() => { setRanges([...ranges, draft()]); dirty.current = true; setConfirmed(false); }}>添加可用区间</button>
      {ranges.length > 0 && <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" disabled={locked} checked={confirmed}
        onChange={event => setConfirmed(event.target.checked)} />我已看过这些片段，确认画面可用且动作完整</label>}
      {!ranges.length && <p className="text-sm text-ink-secondary">保存后将撤回此原片的区间批准，已冻结的制作记录不变。</p>}
      <p className="text-xs text-ink-tertiary">此处确认画面范围，台词和声音仍待核验。未标记的普通素材仍可进入后续待确认预览，不要求逐条手动标记才能制作。</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-primary" disabled={locked || !item || (ranges.length > 0 && !confirmed)} onClick={() => void save()}>{ranges.length ? '确认并保存区间' : '保存区间撤回'}</button>
      <button type="button" className="btn-secondary" disabled={busy || disabled} onClick={() => void reload()}>重新读取区间（放弃未保存修改）</button>
    </div>
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {message && <p role="status" className="text-sm text-ok">{message}</p>}
  </section>;
}
