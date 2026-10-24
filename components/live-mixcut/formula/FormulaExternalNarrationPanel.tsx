'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormulaExternalNarrationPublicView } from '@/lib/live-mixcut/formula/external-narration';

async function result(response: Response): Promise<FormulaExternalNarrationPublicView> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '外部配音未保存，请重试');
  return body;
}
export default function FormulaExternalNarrationPanel({ projectId, batchId, inputRevision, disabled, dirty, mode, onBusy, onSaved }: {
  projectId: string; batchId: string; inputRevision: number; disabled: boolean; dirty: boolean; mode: string;
  onBusy: (value: boolean) => void; onSaved: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaExternalNarrationPublicView | null>(null);
  const [scriptKey, setScriptKey] = useState(''), [audio, setAudio] = useState<File | null>(null), [srt, setSrt] = useState<File | null>(null);
  const [srtText, setSrtText] = useState(''), [confirmed, setConfirmed] = useState(false), [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [pending, setPending] = useState<FormData | null>(null);
  const inFlight = useRef(false), srtRead = useRef(0);
  const url = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/external-narration?projectId=${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(result).then(next => {
      if (!controller.signal.aborted) { setView(next); setScriptKey(current => next.items.some(item => item.scriptKey === current) ? current : next.items[0]?.scriptKey ?? ''); }
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '无法读取外部配音'); });
    return () => controller.abort();
  }, [url, inputRevision]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const item = view?.items.find(item => item.scriptKey === scriptKey);
  const locked = disabled || dirty || busy || !view?.editable || view.inputRevision !== inputRevision;
  function clearFiles() { srtRead.current++; setAudio(null); setAudioUrl(''); setSrt(null); setSrtText(''); setConfirmed(false); setPlaying(false); }
  async function submit(remove = false) {
    if (inFlight.current || !view?.scriptsSessionId || !item || locked) return;
    let form = pending;
    if (!form) {
      if (!remove && (!audio || !srt || !confirmed)) return;
      form = new FormData();
      form.set('metadata', JSON.stringify({ scriptKey, scriptsSessionId: view.scriptsSessionId, expectedInputRevision: view.inputRevision,
        expectedNarrationRevision: item.saved?.revision ?? 0, confirmed: remove || confirmed, ...(remove ? { remove: true } : {}) }));
      if (!remove) { form.set('audio', audio!); form.set('srt', srt!); }
      setPending(form);
    }
    inFlight.current = true; setBusy(true); onBusy(true); setError(''); setMessage('');
    try {
      const next = await result(await fetch(url, { method: 'PUT', body: form }));
      setView(next); setPending(null); clearFiles();
      setMessage(JSON.parse(String(form.get('metadata'))).remove ? '已移除，下次生成使用所选音色；已生成的成片保留原声音。' : '外部配音和字幕已保存，这条脚本生成时使用它，不重复生成 TTS。');
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : '未收到保存结果，可原样重试或重新读取'); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-hairline p-4" aria-label="外部配音与字幕">
    <div><h3 className="font-medium text-ink">已有配音？导入音频和字幕</h3>
      <p className="mt-1 text-sm text-ink-secondary">统一配音模式下，可为每条脚本上传整篇声音和对应 SRT。请先把脚本文案整理成实际朗读内容；每份成片沿用这份声音，原片静音。</p></div>
    {dirty && <p className="text-sm text-warn">请先保存生成设置，再导入外部配音。</p>}
    {mode !== 'narration' && <p className="text-sm text-warn">导入前请将声音方式改为「统一配音」并保存；已有外部配音可在此移除。</p>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {message && <p role="status" className="text-sm text-ok">{message}</p>}
    <label className="block text-sm text-ink-secondary">选择配音对应的脚本
      <select aria-label="外部配音对应脚本" className="mt-1 w-full rounded-lg border border-hairline bg-surface p-2 text-ink" value={scriptKey}
        disabled={locked || !!pending} onChange={event => { setScriptKey(event.target.value); clearFiles(); setMessage(''); setError(''); }}>
        {!view?.items.length && <option value="">请先导入并确认脚本</option>}
        {view?.items.map(row => <option key={row.scriptKey} value={row.scriptKey}>脚本 {row.scriptNumber} · {row.text.slice(0, 40)}{row.saved?.durationUs ? ' · 已导入' : ''}</option>)}
      </select></label>
    {item && <p className="whitespace-pre-wrap text-sm text-ink">实际朗读文案：{item.text}</p>}
    {item?.saved?.durationUs && <div className="space-y-2 text-sm text-ink-secondary">
      <p>已保存：{item.saved.filename} · {(item.saved.durationUs / 1_000_000).toFixed(2)} 秒 · {item.saved.channels === 2 ? '立体声' : '单声道'} · 字幕时间由你确认</p>
      {item.stale && <p role="alert" className="text-warn">文案已改，旧配音不能用于下一轮生成。请重新导入或移除。</p>}
      <audio controls preload="metadata" aria-label="已保存外部配音试听" src={`${url}&narrationId=${encodeURIComponent(item.saved.id)}`} />
      <button type="button" className="btn-secondary" disabled={locked || !!pending} onClick={() => void submit(true)}>移除这条脚本的外部配音</button>
    </div>}
    <fieldset disabled={locked || !!pending || mode !== 'narration'} className="space-y-3">
      <p className="text-xs text-ink-secondary">音频支持 WAV / MP3 / M4A / AAC / FLAC，最多 60 MiB、10 分钟，单声道或立体声。SRT 须为 UTF-8，最多 256 KiB；不自动猜字幕时间。</p>
      <label className="block text-sm text-ink-secondary">配音音频<input aria-label="外部配音音频" type="file" accept=".wav,.mp3,.m4a,.aac,.flac" className="peer sr-only"
        onChange={event => { const file = event.target.files?.[0] ?? null; setAudio(file); setAudioUrl(file ? URL.createObjectURL(file) : ''); setConfirmed(false); setPlaying(false); setMessage(''); event.target.value = ''; }} />
        <span className="btn-secondary ml-3 inline-flex cursor-pointer peer-focus-visible:outline peer-disabled:cursor-not-allowed peer-disabled:opacity-50">选择音频文件</span></label>
      {audio && <><p className="text-sm text-ink-secondary">待导入：{audio.name}</p><audio controls preload="metadata" aria-label="待导入配音试听" src={audioUrl}
        onTimeUpdate={event => { if (event.currentTarget.currentTime > 0) setPlaying(true); }} /></>}
      <label className="block text-sm text-ink-secondary">对应 SRT<input aria-label="外部配音 SRT" type="file" accept=".srt" className="peer sr-only" onChange={async event => {
        const token = ++srtRead.current; const file = event.target.files?.[0] ?? null; event.target.value = ''; setSrt(null); setSrtText(''); setConfirmed(false); setError('');
        if (!file) return;
        try {
          if (file.size > 256 * 1024) throw new Error('SRT 超过 256 KiB');
          const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); if (token === srtRead.current) { setSrt(file); setSrtText(value); }
        } catch { if (token === srtRead.current) setError('请选择不超过 256 KiB、UTF-8 编码的 SRT'); }
      }} /><span className="btn-secondary ml-3 inline-flex cursor-pointer peer-focus-visible:outline peer-disabled:cursor-not-allowed peer-disabled:opacity-50">选择字幕文件</span></label>
      {srt && <details open><summary className="text-sm text-ink-secondary">核对字幕：{srt.name}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-sm text-ink">{srtText}</pre></details>}
      <label className="flex items-start gap-2 text-sm text-ink"><input type="checkbox" checked={confirmed} disabled={!audio || !srt || !playing}
        onChange={event => setConfirmed(event.target.checked)} />我已试听，确认音频实际朗读这条脚本文案，SRT 内容和时间对应这份音频。</label>
    </fieldset>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-secondary" disabled={locked || (!pending && (!confirmed || !audio || !srt || mode !== 'narration'))}
        onClick={() => void submit()}>{busy ? '正在核验并保存…' : pending ? '原样重试保存' : '保存这条脚本的外部配音'}</button>
      {pending && <button type="button" className="btn-secondary" disabled={busy} onClick={async () => {
        try { const next = await result(await fetch(url, { cache: 'no-store' })); setView(next); setPending(null); clearFiles(); setError(''); await onSaved(); }
        catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
      }}>重新读取已保存结果</button>}
    </div>
  </section>;
}
