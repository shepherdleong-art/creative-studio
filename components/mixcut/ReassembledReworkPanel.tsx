'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { readFilmRework, ReworkCommand } from '@/lib/final-edit/reassembled/rework';
import { videoDurationOptions } from '@/lib/video-duration';

type View = ReturnType<typeof readFilmRework>;
type Provider = { id: string; name: string; type: string; model?: string; defaultModel?: string; enabled: number; configured: boolean };
async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error);
  return body;
}

export function ReassembledReworkPanel({ groupId, clipId, step }: { groupId: string; clipId: string; step: 'storyboard' | 'video' }) {
  const [view, setView] = useState<View | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [inputId, setInputId] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('standard');
  const [duration, setDuration] = useState(5);
  const [videoId, setVideoId] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [editingRevision, setEditingRevision] = useState(0);
  const pending = useRef<ReworkCommand | null>(null);
  const url = `/api/final-edit-groups/${encodeURIComponent(groupId)}/rework/${encodeURIComponent(clipId)}`;
  const reload = useCallback(async (acceptRevision = false) => {
    const next = await read<View>(await fetch(url, { cache: 'no-store' }));
    setView(next);
    if (acceptRevision) setEditingRevision(next.revision);
  }, [url]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [next, choices] = await Promise.all([fetch(url).then(r => read<View>(r)), fetch(step === 'storyboard' ? '/api/providers' : '/api/providers/video').then(r => read<Provider[]>(r))]);
        if (cancelled) return;
        setView(next); setEditingRevision(next.revision); setProviders(choices.filter(p => p.enabled && p.configured));
        const kind = step === 'storyboard' ? 'generate_image' : 'generate_video';
        const last = next.history.filter(h => h.kind === kind).at(-1)?.request as ReworkCommand | undefined;
        const original = next.provenance;
        const chosen = last?.providerId || (step === 'storyboard' ? original.provenance.imageProvider : original.providerId);
        setProviderId(choices.find(p => p.enabled && p.configured && (p.id === chosen || p.name === chosen))?.id || '');
        setPrompt(last?.prompt || (step === 'storyboard' ? original.provenance.imagePrompt : original.prompt));
        setInputId(last?.inputImageId || next.sourceImageId); setReferences(last?.referenceImageIds || []);
        setSize(last?.size || '1024x1024'); setQuality(last?.quality || 'standard'); setDuration(last?.durationSec || 5);
      } catch (error) { if (!cancelled) setMessage(String(error)); }
    };
    void load();
    return () => { cancelled = true; };
  }, [url, step]);
  useEffect(() => {
    if (!view || ![...view.imageJobs, ...view.videoJobs].some(j => ['pending', 'retrying', 'running', 'needs_check'].includes(j.status))) return;
    const timer = setInterval(() => void reload().catch(error => setMessage(String(error))), 1800);
    return () => clearInterval(timer);
  }, [view, reload]);
  const send = async (input: Omit<ReworkCommand, 'requestId' | 'expectedRevision'>) => {
    if (!view) return;
    setBusy(true); setMessage('');
    const command: ReworkCommand = pending.current || { ...input, expectedRevision: editingRevision, requestId: crypto.randomUUID() };
    pending.current = command;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      if (response.status < 500) pending.current = null;
      await read(response);
      pending.current = null;
      await reload(true); setMessage('已保存。生成结果只进入候选，不会自动替换当前图片或成片。');
    } catch (error) { setMessage(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  };
  const provider = providers.find(p => p.id === providerId);
  const resume = async (jobId: string) => {
    const entry = view?.history.find(h => h.jobId === jobId && (h.kind === 'generate_image' || h.kind === 'generate_video'));
    if (!entry) return;
    setBusy(true);
    try {
      await read(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.request) }));
      await reload(); setMessage('已继续原任务，保留原任务 ID 和生成参数。');
    } catch (error) { setMessage(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  };
  const model = provider?.model || provider?.defaultModel || '';
  const durations = provider ? videoDurationOptions(provider.type, model) : [];
  const selectedVideo = view?.videoJobs.find(j => j.id === videoId);
  const link = (tab: string) => `/projects/${view?.projectId}?tab=${tab}&filmGroup=${groupId}&filmShotSet=${view?.shotSetId}&filmClip=${encodeURIComponent(clipId)}`;
  return <section data-testid="film-rework" style={{ padding: 24, display: 'grid', gap: 14, background: 'var(--color-surface)', color: 'var(--color-text)' }}>
    <h2>局部返工 · 镜头 {clipId} · {step === 'storyboard' ? '第二步：分镜图' : '第四步：视频'}</h2>
    <p>当前镜头版本 {view?.revision ?? '…'}。其他镜头和已交付成片保持原样；新候选需明确采用。</p>
    {view && <nav style={{ display: 'flex', gap: 18 }}><Link href={link('storyboard')}>编辑分镜图</Link><Link href={link('video')}>生成该镜头视频</Link><Link href={link('final-edit')}>返回第五步替换镜头</Link></nav>}
    <p role="status">{message}</p>
    <button className="btn-secondary" disabled={busy} onClick={() => void reload(true).catch(e => setMessage(String(e)))}>刷新当前版本（保留输入）</button>
    {view && <>
      <div style={{ display: 'flex', gap: 16 }}>{[view.sourceImageId, view.currentImageId].map((id, index) => <figure key={index}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={view.images.find(i => i.id === id)?.url || ''} alt={index ? '当前采用分镜图' : '原始实拍'} style={{ height: 160, maxWidth: 240, objectFit: 'contain' }} /><figcaption>{index ? '当前采用分镜图' : '原始实拍'}</figcaption>
      </figure>)}</div>
      <details><summary>原始生成出处</summary><p>图片：{view.provenance.provenance.imageProvider} / {view.provenance.provenance.imageModel}</p><p>{view.provenance.provenance.imagePrompt}</p><p>视频：{view.provenance.providerId} / {view.provenance.model}</p><p>{view.provenance.prompt}</p></details>
      <label>供应商 <select aria-label="返工供应商" value={providerId} disabled={busy} onChange={e => setProviderId(e.target.value)}><option value="">请选择已配置供应商</option>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select> 模型：{model || '未选择'}</label>
      <label>本次实际提示词<textarea aria-label="返工提示词" value={prompt} onChange={e => setPrompt(e.target.value)} rows={5} style={{ display: 'block', width: '100%' }} /></label>
      {step === 'storyboard' ? <>
        <button className="btn-secondary" disabled={busy || view.currentImageId === view.importedImageId} onClick={() => void send({ type: 'select_image', imageId: view.importedImageId })}>恢复导入时的分镜图</button>
        <label>编辑底图 <select aria-label="编辑底图" value={inputId} onChange={e => setInputId(e.target.value)}>{view.images.map(i => <option key={i.id} value={i.id}>{i.name} · {i.id.slice(0, 8)}</option>)}</select></label>
        <label>参考图（可多选）<select aria-label="返工参考图" multiple value={references} onChange={e => setReferences([...e.target.selectedOptions].map(o => o.value))}>{view.images.filter(i => i.id !== inputId).map(i => <option key={i.id} value={i.id}>{i.name} · {i.id.slice(0, 8)}</option>)}</select></label>
        <label>图片尺寸 <input aria-label="返工图片尺寸" value={size} onChange={e => setSize(e.target.value)} /></label>
        <label>图片质量 <input value={quality} onChange={e => setQuality(e.target.value)} /></label>
        <button className="btn-primary" disabled={busy || !provider || !prompt.trim()} onClick={() => void send({ type: 'generate_image', providerId, model, prompt, inputImageId: inputId, referenceImageIds: references, size, quality })}>生成该镜头分镜候选</button>
        {view.imageJobs.map(job => <article key={job.id}><p>{job.status} · {job.model} · {job.errorMessage}</p><p>{job.prompt}</p>{['pending', 'retrying', 'running'].includes(job.status) && <button className="btn-secondary" disabled={busy} onClick={() => void resume(job.id)}>继续原图片任务</button>}{job.outputImageId && <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="返工图片候选" src={view.images.find(i => i.id === job.outputImageId)?.url || ''} style={{ height: 160 }} />
          <button className="btn-secondary" disabled={busy || job.status !== 'succeeded' || view.currentImageId === job.outputImageId} onClick={() => void send({ type: 'select_image', imageId: job.outputImageId! })}>采用这张分镜图</button>
        </>}</article>)}
      </> : <>
        <label>生成时长 <select aria-label="返工视频时长" value={duration} onChange={e => setDuration(Number(e.target.value))}>{[...new Set([duration, ...durations])].map(value => <option key={value} value={value}>{value} 秒</option>)}</select></label>
        <button className="btn-primary" disabled={busy || !provider || !prompt.trim() || !durations.includes(duration)} onClick={() => void send({ type: 'generate_video', providerId, model, prompt, imageId: view.currentImageId, durationSec: duration })}>用当前分镜图生成视频候选</button>
        <label>视频候选 <select aria-label="返工视频候选" value={videoId} onChange={e => { setVideoId(e.target.value); const job = view.videoJobs.find(j => j.id === e.target.value); setStart(0); setEnd(job?.durationSec || 5); }}><option value="">选择任务查看</option>{view.videoJobs.map(j => <option key={j.id} value={j.id}>{j.status} · {j.id.slice(0, 8)}{view.registeredVideoIds.includes(j.id) ? ' · 已登记' : ''}</option>)}</select></label>
        {selectedVideo && <><p>{selectedVideo.prompt} · {selectedVideo.errorMessage}</p>{['pending', 'running', 'needs_check'].includes(selectedVideo.status) && <button className="btn-secondary" disabled={busy} onClick={() => void resume(selectedVideo.id)}>继续原视频任务</button>}{selectedVideo.previewUrl && <video controls src={selectedVideo.previewUrl} style={{ height: 260, width: '100%' }} />}
          <label>已审核起点（秒）<input type="number" min={0} step={1 / 24} value={start} onChange={e => setStart(Number(e.target.value))} /></label>
          <label>已审核终点（秒）<input type="number" min={0} step={1 / 24} value={end} onChange={e => setEnd(Number(e.target.value))} /></label>
          <button className="btn-secondary" disabled={busy || selectedVideo.status !== 'succeeded' || view.registeredVideoIds.includes(videoId)} onClick={() => void send({ type: 'register_video', videoJobId: videoId, approvedRangeSec: [start, end] })}>登记到第五步候选</button>
        </>}
      </>}
      <details><summary>返工记录（{view.history.length}）</summary>{view.history.map(h => <p key={h.id}>版本 {h.baseRevision} → {h.baseRevision + 1} · {h.actor} · {h.kind} · {h.createdAt} · {h.jobId}</p>)}</details>
    </>}
  </section>;
}
