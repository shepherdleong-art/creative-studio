'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaSettingsView } from '@/lib/batch-production/formula/settings-store';
import { FORMULA_DEFAULT_BGM, FORMULA_MAX_OUTPUTS, type FormulaBgmMode, type FormulaSettings } from '@/lib/batch-production/formula/settings';
import { defaultFormulaProductionSettings, formulaProductionSettingsError } from '@/lib/batch-production/formula/production-settings';
import FormulaProductionSettingsPanel from './FormulaProductionSettingsPanel';
import FormulaExternalNarrationPanel from './FormulaExternalNarrationPanel';
import { defaultFormulaTimingSettings, parseFormulaTimingSettings, type FormulaTimingSettings } from '@/lib/batch-production/formula/timing-settings';

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '请求未完成，请重试');
  return body;
}

export default function FormulaGenerationSettings({ projectId, batchId, inputRevision, pendingImport, disabled, onEdit, onGenerated, onInputsChanged }: {
  projectId: string; batchId: string; inputRevision: number; pendingImport: boolean; disabled: boolean; onEdit: (key: string) => void;
  onGenerated: () => Promise<void>;
  onInputsChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaSettingsView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState<Record<string, string>>({});
  const [music, setMusic] = useState<FormulaSettings['bgm']>({ ...FORMULA_DEFAULT_BGM });
  const [production, setProduction] = useState(defaultFormulaProductionSettings);
  const [timing, setTiming] = useState(defaultFormulaTimingSettings);
  const [durationText, setDurationText] = useState('');
  const [marginText, setMarginText] = useState('120');
  const [busy, setBusy] = useState(false);
  const [externalBusy, setExternalBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const musicInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/settings?projectId=${encodeURIComponent(projectId)}`;
  const apply = useCallback((next: FormulaSettingsView) => {
    setView(next);
    const previous = next.saved && !next.stale ? next.saved.settings.selections : next.scripts.map(row => ({ key: row.key, copies: 1 }));
    setSelected(new Set(previous.map(item => item.key)));
    const counts = new Map(previous.map(item => [item.key, item.copies]));
    setCopies(Object.fromEntries(next.scripts.map(row => [row.key, String(counts.get(row.key) ?? 1)])));
    setMusic(next.saved?.settings.bgm ?? { ...FORMULA_DEFAULT_BGM });
    setProduction(next.saved?.settings.production ?? defaultFormulaProductionSettings());
    const savedTiming = next.saved?.settings.timing ?? defaultFormulaTimingSettings();
    setTiming(savedTiming); setDurationText(savedTiming.overrideDurationSec === null ? '' : String(savedTiming.overrideDurationSec));
    setMarginText(String(savedTiming.speechMarginMs));
    setDirty(!next.saved || next.stale); setError(''); setMessage('');
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(responseBody<FormulaSettingsView>).then(next => {
      if (!controller.signal.aborted) apply(next);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision, apply]);

  async function reload() {
    setBusy(true); setError('');
    try { apply(await responseBody<FormulaSettingsView>(await fetch(url, { cache: 'no-store' }))); }
    catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
    finally { setBusy(false); }
  }
  async function persistSettings(): Promise<FormulaSettingsView> {
    if (!view?.scriptsSessionId || !validTiming) throw new Error('请先确认脚本和生成设置。');
    return responseBody<FormulaSettingsView>(await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedInputRevision: view.inputRevision, expectedSettingsRevision: view.saved?.revision ?? 0,
        scriptsSessionId: view.scriptsSessionId, settings: { selections: view.scripts.filter(row => selected.has(row.key)).map(row => ({ key: row.key, copies: Number(copies[row.key]) })), bgm: music, production, timing: validTiming } }) }));
  }
  async function save() {
    if (!view || !view.scriptsSessionId || busy || !validTiming || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await persistSettings();
      apply(next); setMessage('设置已保存，尚未开始制作。');
    } catch (err) { setError(err instanceof Error ? err.message : '设置未保存'); }
    finally { setBusy(false); submitting.current = false; }
  }
  async function generate() {
    if (locked || invalidSettings || submitting.current || !view) return;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const saved = dirty || !view.saved ? await persistSettings() : view;
      apply(saved);
      if (!saved.saved) throw new Error('生成设置尚未保存，请重试。');
      await responseBody(await fetch(url.replace('/settings?', '/generation?'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsId: saved.saved.id, expectedInputRevision: saved.inputRevision,
          requestKey: `generate:${saved.saved.id}:${saved.inputRevision}` }) }));
      setView({ ...saved, editable: false }); setMessage('已开始制作，可在本页顶部查看逐条进度。');
      await onGenerated();
    } catch (err) { setError(err instanceof Error ? err.message : '制作未能开始，请重试。'); }
    finally { setBusy(false); submitting.current = false; }
  }
  async function scanMusic() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await responseBody<{ tracks: FormulaSettingsView['tracks'] }>(await fetch('/api/batch-production/bgm', {
        method: 'POST', headers: { 'x-creative-studio-action': 'rescan' },
      }));
      setView(current => current ? { ...current, tracks: result.tracks } : current);
      setMessage(`曲库已刷新，共 ${result.tracks.length} 首；当前脚本选择和份数保留。`);
    } catch (err) { setError(err instanceof Error ? err.message : '曲库扫描失败'); }
    finally { setBusy(false); }
  }
  async function addMusic(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (files.length > 100) throw new Error('单次最多添加 100 个音乐文件，请分批添加。');
      const oversized = files.find(file => file.size > 256 * 1024 * 1024);
      if (oversized) throw new Error(`“${oversized.name}”超过单文件 256 MB 限制。`);
      if (files.reduce((size, file) => size + file.size, 0) > 512 * 1024 * 1024) {
        throw new Error('单次上传总大小不能超过 512 MB，请分批添加。');
      }
      const form = new FormData();
      for (const file of files) form.append('files', file);
      // 沿用已有的公共曲库上传接口；只更新可选曲目，不替用户修改当前批次的音乐选择。
      const response = await fetch('/api/final-edit-bgm', { method: 'POST', body: form });
      const result = await response.json() as {
        imported?: unknown[]; reused?: unknown[]; errors?: Array<{ filename: string; message: string }>;
        tracks?: FormulaSettingsView['tracks']; message?: string;
      };
      if ((!response.ok && response.status !== 422) || !result.imported || !result.reused || !result.errors || !result.tracks) {
        throw new Error(result.message || '音乐添加未完成，请重试。');
      }
      setView(current => current ? { ...current, tracks: result.tracks! } : current);
      setMessage(`已添加 ${result.imported.length} 首，已复用 ${result.reused.length} 首，失败 ${result.errors.length} 首。当前脚本、份数和音乐选择保留；手动模式请勾选要使用的曲目。`);
      setError(result.errors.map(item => `${item.filename}：${item.message}`).join('\n'));
    } catch (err) { setError(err instanceof Error ? err.message : '音乐添加未完成，请重试。'); }
    finally { setBusy(false); }
  }
  function changeMode(mode: FormulaBgmMode) {
    setMusic({ mode, trackIds: [] }); setDirty(true); setMessage('');
  }

  const locked = disabled || busy || externalBusy || !view || !view.editable || view.inputRevision !== inputRevision || pendingImport || view.hasPendingScripts;
  const invalidCopies = [...selected].some(key => !Number.isSafeInteger(Number(copies[key])) || Number(copies[key]) < 1);
  const total = [...selected].reduce((sum, key) => sum + (Number(copies[key]) || 0), 0);
  const tracks = view?.tracks ?? [];
  const productionError = view ? formulaProductionSettingsError(production, view.productionOptions) : '';
  let validTiming: FormulaTimingSettings | null = null;
  let timingError = '';
  try {
    validTiming = parseFormulaTimingSettings({ ...timing, overrideDurationSec: durationText.trim() ? Number(durationText) : null,
      speechMarginMs: marginText.trim() ? Number(marginText) : Number.NaN });
  } catch (error) { timingError = error instanceof Error ? error.message : '请检查时长设置'; }
  const missingTracks = music.trackIds.some(id => !tracks.some(track => track.id === id));
  const musicError = music.mode === 'auto' && !tracks.length ? '曲库为空，请添加音乐或改为不加音乐。'
    : music.mode === 'manual' && !music.trackIds.length ? '请至少选择一首音乐，或改为不加音乐。'
      : music.mode === 'manual' && missingTracks ? '有已选音乐不在当前曲库，请重新选择或改为不加音乐。' : '';
  const matching = (view?.scripts ?? []).filter(row => !query || `${row.scriptNumber} ${row.platform} ${row.bodyText}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const rows = showAll ? matching : matching.slice(0, 20);
  const invalidSettings = !view?.scriptsSessionId || !selected.size || invalidCopies || total > FORMULA_MAX_OUTPUTS || !!musicError || !!productionError || !!timingError;

  return <section className="card space-y-4 p-4" aria-label="生成设置">
    <div><h2 className="text-base font-semibold text-ink">选择脚本与生成设置</h2>
      <p className="mt-1 text-sm text-ink-secondary">选好后点「生成」，会保存当前设置并开始制作；也可以只保存，稍后再做。每批最多制作 1,000 条成片。</p></div>
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-fail">{error}</p>}
    {message && <p role="status" className="text-sm text-ok">{message}</p>}
    {!view ? <p className="text-sm text-ink-secondary">正在读取生成设置…</p> : <>
      {!view.editable && <p className="text-sm text-ink-secondary">当前批次已开始制作，设置只读。</p>}
      {view.stale && <p role="status" className="text-sm text-warn">脚本已更新，请按当前脚本重新选择并保存设置。</p>}
      {(pendingImport || view.hasPendingScripts) && <p className="text-sm text-ink-secondary">请先确认上方的脚本预览，再设置份数和音乐；此前已保存的设置仍保留。</p>}
      {!view.scripts.length && <p className="text-sm text-ink-secondary">确认脚本表后，即可选择脚本和份数。</p>}
      {!pendingImport && !view.hasPendingScripts && view.scripts.length > 0 && <>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary" disabled={locked} onClick={() => { setSelected(new Set(view.scripts.map(row => row.key))); setDirty(true); setMessage(''); }}>全选脚本</button>
          <button type="button" className="btn-secondary" disabled={locked} onClick={() => { setSelected(new Set()); setDirty(true); setMessage(''); }}>取消全选</button>
          <input aria-label="查找脚本" placeholder="按序号、平台或文案查找" value={query} onChange={event => { setQuery(event.target.value); setShowAll(false); }}
            className="min-w-48 flex-1 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink" />
          <p className="text-sm font-medium text-ink">已选 {selected.size} 条脚本，共 {total} 份</p>
        </div>
        {(invalidCopies || total > FORMULA_MAX_OUTPUTS || !selected.size) && <p className="text-sm text-fail">
          {!selected.size ? '请至少选择一条脚本。' : invalidCopies ? '份数须为正整数，请检查已选脚本。' : '已超过每批 1,000 份，请减少份数或拆批。'}
        </p>}
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs text-ink-tertiary">显示 {rows.length} / {matching.length} 条{query ? '匹配脚本；查找不改变已选范围' : ''}</p>
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-hairline text-ink-secondary"><th className="p-2">选择</th><th className="p-2">序号</th><th className="p-2">脚本内容</th><th className="p-2">份数</th><th className="p-2">操作</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.key} className="border-b border-hairline align-top text-ink">
              <td className="p-2"><input type="checkbox" aria-label={`选择脚本 ${row.scriptNumber}`} disabled={locked} checked={selected.has(row.key)} onChange={event => {
                setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; }); setDirty(true); setMessage('');
              }} /></td>
              <td className="p-2">{row.scriptNumber}</td>
              <td className="p-2"><p>{row.codes.join(' → ')}</p><p className="mt-1 whitespace-pre-wrap text-ink-secondary">{row.bodyText}</p><p className="mt-1 text-xs text-ink-tertiary">{row.platform} · 目标 {row.targetDurationSec} 秒 · {row.source.sheet} 第 {row.source.row} 行</p></td>
              <td className="p-2"><input type="number" min={1} max={FORMULA_MAX_OUTPUTS} step={1} aria-label={`脚本 ${row.scriptNumber} 份数`} value={copies[row.key] ?? '1'} disabled={locked || !selected.has(row.key)}
                onChange={event => { setCopies(previous => ({ ...previous, [row.key]: event.target.value })); setDirty(true); setMessage(''); }} className="w-20 rounded-lg border border-hairline bg-surface p-2 text-ink disabled:opacity-40" /></td>
              <td className="p-2"><button type="button" className="btn-secondary whitespace-nowrap" disabled={locked} onClick={() => onEdit(row.key)}>修改脚本 {row.scriptNumber}</button></td>
            </tr>)}</tbody>
          </table>
          {matching.length > 20 && <button type="button" className="btn-secondary mt-3" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看全部 ${matching.length} 条`}</button>}
          {!matching.length && <p className="py-3 text-sm text-ink-secondary">没有找到匹配的脚本。</p>}
        </div>
      </>}
      <fieldset disabled={locked || !view.scripts.length} className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink">背景音乐</legend>
        <div className="flex flex-wrap gap-4">{([['none', '不加音乐'], ['auto', '自动分配'], ['manual', '手动选音乐']] as const).map(([mode, label]) => <label key={mode} className="flex items-center gap-2 text-sm text-ink">
          <input type="radio" name={`formula-bgm-${batchId}`} checked={music.mode === mode} onChange={() => changeMode(mode)} />{label}
        </label>)}</div>
        {music.mode === 'none' ? <p className="text-xs text-ink-secondary">不添加背景音乐。原声和配音由声音设置决定。</p> : <>
          <p className="text-xs text-ink-secondary">{music.mode === 'auto' ? '从当前可用曲库自动分配；开始制作时会核验并保存候选曲目。' : '从下面勾选的音乐中分配。'}共 {tracks.length} 首可选音乐。</p>
          <input ref={musicInput} type="file" multiple accept=".mp3,.wav,.m4a,.aac,.flac,.ogg" aria-label="添加背景音乐文件" className="hidden" onChange={event => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void addMusic(files);
          }} />
          <button type="button" className="btn-secondary mr-2" onClick={() => musicInput.current?.click()}>添加音乐</button>
          <button type="button" className="btn-secondary" onClick={() => void scanMusic()}>重新扫描曲库</button>
          <p className="text-xs text-ink-tertiary">支持 MP3、WAV、M4A、AAC、FLAC、OGG。每次最多 100 个文件，单文件 256 MB，合计 512 MB。</p>
          {music.mode === 'manual' && <>
            <button type="button" className="btn-secondary ml-2" onClick={() => { setMusic({ mode: 'manual', trackIds: [] }); setDirty(true); setMessage(''); }}>清空音乐选择</button>
            <div className="max-h-48 space-y-2 overflow-auto">{tracks.map(track => <label key={track.id} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" aria-label={`选择音乐 ${track.filename}`} checked={music.trackIds.includes(track.id)} onChange={event => {
                setMusic(previous => ({ mode: 'manual', trackIds: event.target.checked ? [...previous.trackIds, track.id] : previous.trackIds.filter(id => id !== track.id) })); setDirty(true); setMessage('');
              }} />{track.filename} · {Math.round(track.durationUs / 1_000_000)} 秒
            </label>)}</div>
          </>}
        </>}
        {musicError && <p className="text-sm text-fail">{musicError}</p>}
      </fieldset>
      <fieldset aria-label="成片时长" disabled={locked || !view.scripts.length} className="space-y-3">
        <legend className="mb-2 text-sm font-medium text-ink">成片时长</legend>
        <label className="block space-y-1 text-sm text-ink"><span>时长规则</span>
          <select aria-label="时长规则" value={timing.mode} className="w-full rounded-lg border border-hairline bg-surface p-2"
            onChange={event => { setTiming(previous => ({ ...previous, mode: event.target.value as FormulaTimingSettings['mode'] })); setDirty(true); setMessage(''); }}>
            <option value="reference">尽量接近目标，保留完整内容</option><option value="strict_max">不能超过目标时长</option><option value="fixed">必须达到指定时长</option>
          </select>
        </label>
        <p className="text-xs text-ink-secondary">{timing.mode === 'reference' ? '素材或台词不适合目标时长时，保留完整内容，并显示实际片长与差距。'
          : '无法同时保留完整台词和满足时长时，会提示处理；不会加速台词、截断声音或循环画面凑时长。'}</p>
        <div className="flex flex-wrap gap-3">
          <label className="flex-1 space-y-1 text-sm text-ink"><span>目标秒数</span><input aria-label="目标秒数" type="number" step="any" min="0.001"
            placeholder="留空，按每条 Excel 时长" value={durationText} className="w-full rounded-lg border border-hairline bg-surface p-2"
            onChange={event => { setDurationText(event.target.value); setDirty(true); setMessage(''); }} /></label>
          <label className="flex-1 space-y-1 text-sm text-ink"><span>计时范围</span><select aria-label="计时范围" value={timing.scope}
            className="w-full rounded-lg border border-hairline bg-surface p-2" onChange={event => { setTiming(previous => ({ ...previous, scope: event.target.value as FormulaTimingSettings['scope'] })); setDirty(true); setMessage(''); }}>
            <option value="total">整条成片（含封面）</option><option value="body">正文（不含封面）</option>
          </select></label>
        </div>
        <p className="text-xs text-ink-secondary">目标留空时分别使用脚本表里的时长。封面固定约 0.83 秒，成片按 24 帧/秒取整。</p>
        <label className="block space-y-1 text-sm text-ink"><span>原声前后各保留（毫秒）</span><input aria-label="原声前后保留毫秒" type="number" min={0} max={2000} step={1}
          value={marginText} className="ml-2 w-24 rounded-lg border border-hairline bg-surface p-2"
          onChange={event => { setMarginText(event.target.value); setDirty(true); setMessage(''); }} /></label>
        <p className="text-xs text-ink-secondary">默认各留 120 毫秒，可填 0～2000。仅在原片可用范围内保留，不删句子中间的停顿。</p>
        {timingError && <p role="alert" className="text-sm text-fail">{timingError}</p>}
      </fieldset>
      <FormulaProductionSettingsPanel value={production} options={view.productionOptions} disabled={locked || !view.scripts.length} groupId={batchId}
        onChange={next => { setProduction(next); setDirty(true); setMessage(''); }} />
      {productionError && <p className="text-sm text-fail">{productionError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={locked || invalidSettings} onClick={() => void generate()}>{busy ? '处理中…' : '生成'}</button>
        <button type="button" className="btn-secondary" disabled={locked || invalidSettings} onClick={() => void save()}>保存生成设置</button>
        <button type="button" className="btn-secondary" disabled={busy || disabled} onClick={() => void reload()}>重新读取设置</button>
        <span className="text-xs text-ink-secondary">{dirty ? '当前设置尚未保存' : '设置已保存'}</span>
      </div>
      <FormulaExternalNarrationPanel projectId={projectId} batchId={batchId} inputRevision={inputRevision}
        disabled={disabled || busy || pendingImport || view.hasPendingScripts} dirty={dirty} mode={production.audio.mode}
        onBusy={setExternalBusy} onSaved={onInputsChanged} />
    </>}
  </section>;
}
