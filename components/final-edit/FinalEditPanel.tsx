'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Icon } from '@/components/ui/Icon';
import type { FinalEditAssetView, FinalEditGroupView, FinalEditVariantView, OutputPresetId, SubtitleCue, TextStyle } from '@/lib/final-edit/types';
import { createOverlayBundlePayload, drawEditorOverlay } from './text-canvas-renderer';

interface Bootstrap {
  drafts: Array<{ id: string; title: string; shotSetId: string; targetDurationSec: number; segmentCount: number; createdAt: string }>;
  groups: Array<{ id: string; scriptDraftId: string; status: string; phase: string; narrationDurationUs: number; variantCount: number; createdAt: string }>;
  visionProviders: Array<{ id: string; name: string; model: string; configured: boolean }>;
  ttsProvider: { id: string; name: string; model: string; enabled: boolean; hasApiKey: boolean };
  voices: Array<{ id: string; label: string }>;
  alignmentConfigured: boolean;
  defaults: { count: number; outputPreset: OutputPresetId; voice: string; speed: number };
}

interface TitlePreset { id: string; name: string; stylesByPreset: Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle }> }

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

function seconds(timeUs: number) { return timeUs / 1_000_000; }
function formatTime(timeUs: number) {
  const total = Math.max(0, seconds(timeUs));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${(total % 60).toFixed(2).padStart(5, '0')}`;
}

export default function FinalEditPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [group, setGroup] = useState<FinalEditGroupView | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [selectedCueId, setSelectedCueId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [scriptDraftId, setScriptDraftId] = useState('');
  const [count, setCount] = useState(2);
  const [outputPreset, setOutputPreset] = useState<OutputPresetId>('3x4');
  const [voice, setVoice] = useState('Cherry');
  const [speed, setSpeed] = useState(1);
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [assetFilter, setAssetFilter] = useState<'all' | 'recommended' | 'used' | 'failed' | 'disabled'>('all');
  const [styleTarget, setStyleTarget] = useState<'coverPrimary' | 'coverSecondary' | 'subtitle'>('subtitle');
  const [titlePresets, setTitlePresets] = useState<TitlePreset[]>([]);
  const [redoRevision, setRedoRevision] = useState<number | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState(false);

  const loadBootstrap = useCallback(async () => {
    const data = await readJson<Bootstrap>(await fetch(`/api/projects/${projectId}/final-edit/bootstrap`));
    setBootstrap(data);
    setScriptDraftId((value) => value || data.drafts[0]?.id || '');
    setCount(data.defaults.count);
    setOutputPreset(data.defaults.outputPreset);
    setVoice(data.defaults.voice);
    setSpeed(data.defaults.speed);
    if (!group && data.groups[0]?.id && ['ready', 'partial'].includes(data.groups[0].status)) {
      const loaded = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${data.groups[0].id}`));
      setGroup(loaded);
      setSelectedVariantId(loaded.variants[0]?.id || '');
      setSelectedAssetId(loaded.assets[0]?.videoJobId || '');
      setSelectedCueId(loaded.subtitleCues[0]?.id || '');
    }
  }, [group, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadBootstrap().catch((error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [loadBootstrap]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/final-edit/title-presets').then((response) => readJson<TitlePreset[]>(response)).then(setTitlePresets).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const timer = window.setInterval(async () => {
      try {
        const job = await readJson<{ status: string; phase: string; groupId: string; errorMessage?: string }>(await fetch(`/api/final-edit-jobs/${jobId}`));
        setMessage(`正在处理：${job.phase}`);
        if (job.status === 'succeeded' || job.status === 'failed') {
          window.clearInterval(timer);
          setBusy(false);
          setJobId('');
          if (job.status === 'failed') { setMessage(job.errorMessage || '准备任务失败'); return; }
          const loaded = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${job.groupId}`));
          setGroup(loaded);
          setSelectedVariantId(loaded.variants[0]?.id || '');
          setSelectedAssetId(loaded.assets[0]?.videoJobId || '');
          setSelectedCueId(loaded.subtitleCues[0]?.id || '');
          setMessage('成片草稿已生成');
        }
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId]);

  const selectedVariant = (group?.variants.find((variant) => variant.id === selectedVariantId) || group?.variants[0] || null) as FinalEditVariantView;
  const selectedAsset = group?.assets.find((asset) => asset.videoJobId === selectedAssetId) || group?.assets[0] || null;
  const selectedCue = group?.subtitleCues.find((cue) => cue.id === selectedCueId) || group?.subtitleCues[0] || null;
  const selectedClip = selectedVariant?.timeline.clips.find((clip) => clip.id === selectedClipId) || selectedVariant?.timeline.clips[0] || null;
  const renderedJob = group?.jobs.find((job) => job.kind === 'render' && job.variantId === selectedVariant?.id && job.status === 'succeeded') || null;
  const usedIds = useMemo(() => new Set(selectedVariant?.timeline.clips.map((clip) => clip.videoJobId) || []), [selectedVariant]);
  const filteredAssets = (group?.assets || []).filter((asset) => assetFilter === 'all' || (assetFilter === 'recommended' && asset.analysisStatus === 'succeeded' && !asset.autoUseDisabled) || (assetFilter === 'used' && usedIds.has(asset.videoJobId)) || (assetFilter === 'failed' && asset.analysisStatus === 'failed') || (assetFilter === 'disabled' && asset.autoUseDisabled));
  const firstVideoGap = (() => {
    if (!selectedVariant) return null;
    let cursor = 0;
    for (const clip of [...selectedVariant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame)) {
      if (clip.timelineInFrame > cursor) return { start: cursor, end: clip.timelineInFrame };
      cursor = Math.max(cursor, clip.timelineOutFrame);
    }
    return cursor < selectedVariant.timeline.bodyFrames ? { start: cursor, end: selectedVariant.timeline.bodyFrames } : null;
  })();

  const start = async () => {
    if (!scriptDraftId) return;
    setBusy(true); setMessage('正在估算素材容量…');
    try {
      const preflight = await readJson<{ warnings: string[] }>(await fetch(`/api/projects/${projectId}/final-edit/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptDraftId, count, outputPreset }) }));
      if (preflight.warnings.length) setMessage(preflight.warnings.join('；'));
      const job = await readJson<{ id: string; groupId: string }>(await fetch(`/api/projects/${projectId}/final-edit/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptDraftId, count, outputPreset, providerId: bootstrap?.ttsProvider.id, voice, speed, analysisProviderId: bootstrap?.visionProviders.find((item) => item.configured)?.id }) }));
      setJobId(job.id);
    } catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const openGroup = async (groupId: string) => {
    try {
      const loaded = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${groupId}`));
      setGroup(loaded); setSelectedVariantId(loaded.variants[0]?.id || ''); setSelectedAssetId(loaded.assets[0]?.videoJobId || ''); setSelectedCueId(loaded.subtitleCues[0]?.id || ''); setSelectedClipId('');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const previewVoice = async () => {
    if (!bootstrap) return;
    setPreviewingVoice(true);
    try {
      const response = await fetch(`/api/providers/tts/${bootstrap.ttsProvider.id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, speed }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || body.error || '试听失败'); }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setPreviewingVoice(false); }
  };

  const updateAssetAnalysis = async (videoJobId: string, patch: Record<string, unknown>) => {
    if (!group) return;
    try {
      await readJson(await fetch(`/api/final-edit-assets/${videoJobId}/analysis`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
      await openGroup(group.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const reanalyzeAsset = async (videoJobId: string) => {
    if (!group) return;
    setBusy(true);
    try {
      await readJson(await fetch(`/api/final-edit-assets/${videoJobId}/reanalyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: bootstrap?.visionProviders.find((item) => item.configured)?.id }) }));
      await openGroup(group.id); setMessage('素材分析已刷新');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const proposeGapFill = async () => {
    if (!selectedVariant || !group) return;
    try {
      const proposal = await readJson<{ id: string; addedClipCount: number }>(await fetch(`/api/final-edit-variants/${selectedVariant.id}/proposals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'fill_all_gaps' }) }));
      if (proposal.addedClipCount < 1) { setMessage('当前没有可补入缺口的可靠素材'); return; }
      if (!window.confirm(`AI 候选将新增 ${proposal.addedClipCount} 个片段。确认应用到当前草稿吗？`)) return;
      const result = await readJson<{ view: FinalEditVariantView }>(await fetch(`/api/final-edit-proposals/${proposal.id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: selectedVariant.revision }) }));
      setGroup({ ...group, variants: group.variants.map((variant) => variant.id === result.view.id ? result.view : variant) }); setMessage('AI 补缺口候选已应用');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const applyVariant = async (command: Record<string, unknown>) => {
    if (!selectedVariant || !group) return;
    try {
      const result = await readJson<{ view: FinalEditVariantView }>(await fetch(`/api/final-edit-variants/${selectedVariant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: selectedVariant.revision, ...command }) }));
      setGroup({ ...group, variants: group.variants.map((variant) => variant.id === result.view.id ? result.view : variant) });
      setMessage('已自动保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const applyGroup = async (command: Record<string, unknown>) => {
    if (!group) return;
    try {
      const result = await readJson<{ view: FinalEditGroupView }>(await fetch(`/api/final-edit-groups/${group.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: group.revision, ...command }) }));
      setGroup(result.view);
      setMessage('已自动保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const renderCurrent = async () => {
    if (!group || !selectedVariant) return;
    setBusy(true); setMessage('正在生成不可变文字图层…');
    try {
      const payload = await createOverlayBundlePayload(group, selectedVariant.outputPreset);
      const bundle = await readJson<{ id: string }>(await fetch(`/api/final-edit-groups/${group.id}/overlay-bundles/${selectedVariant.outputPreset}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
      const job = await readJson<{ id: string }>(await fetch(`/api/final-edit-variants/${selectedVariant.id}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: group.id, expectedGroupRevision: group.revision, expectedVariantRevision: selectedVariant.revision, overlayBundleId: bundle.id }) }));
      setJobId(job.id); setMessage('已进入串行渲染队列');
    } catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const saveTitlePreset = async () => {
    if (!group) return;
    const name = window.prompt('预设名称', `我的标题预设 ${titlePresets.length + 1}`)?.trim();
    if (!name) return;
    try {
      const stylesByPreset = Object.fromEntries((['3x4', '9x16', '16x9'] as OutputPresetId[]).map((preset) => [preset, { coverPrimary: group.textStyles[preset].coverPrimary, coverSecondary: group.textStyles[preset].coverSecondary }]));
      const created = await readJson<TitlePreset>(await fetch('/api/final-edit/title-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, stylesByPreset }) }));
      setTitlePresets((items) => [created, ...items]); setMessage(`已保存预设「${name}」`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const applyTitlePreset = async (presetId: string) => { await applyGroup({ type: 'apply_title_preset', presetId }); };
  const renameTitlePreset = async (preset: TitlePreset) => {
    const name = window.prompt('重命名标题预设', preset.name)?.trim(); if (!name) return;
    try { const updated = await readJson<TitlePreset>(await fetch(`/api/final-edit/title-presets/${preset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })); setTitlePresets((items) => items.map((item) => item.id === preset.id ? { ...item, ...updated } : item)); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const deleteTitlePreset = async (presetId: string) => {
    const response = await fetch(`/api/final-edit/title-presets/${presetId}`, { method: 'DELETE' });
    if (response.ok) setTitlePresets((items) => items.filter((item) => item.id !== presetId));
  };

  if (!bootstrap) return <div className="card p-10 text-center text-sm text-ink-tertiary">正在加载成片剪辑工作区…</div>;

  if (!group) return (
    <section className="card overflow-hidden">
      <div className="border-b border-hairline bg-surface-subtle px-7 py-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">第五步 · 成片剪辑</p>
        <h2 className="mt-1 text-2xl font-semibold">{projectName}</h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-secondary">选择脚本与配音后，系统只分析该脚本所属分镜组的完整视频，生成可人工修正的成片草稿。</p>
      </div>
      <div className="grid gap-5 p-7 md:grid-cols-2">
        <Field label="脚本版本">
          <select className="input-field" value={scriptDraftId} onChange={(event) => setScriptDraftId(event.target.value)}>
            {bootstrap.drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title} · {draft.targetDurationSec}s · {draft.segmentCount} 段</option>)}
          </select>
        </Field>
        <Field label="音色"><div className="flex gap-2"><select className="input-field" value={voice} onChange={(event) => setVoice(event.target.value)}>{bootstrap.voices.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</select><button type="button" className="btn-secondary shrink-0" disabled={previewingVoice || !bootstrap.ttsProvider.hasApiKey} onClick={() => void previewVoice()}>{previewingVoice ? '生成中' : '试听'}</button></div></Field>
        <Field label={`语速 ${speed.toFixed(2)}x`}><input className="w-full accent-accent" type="range" min="0.75" max="1.5" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></Field>
        <Field label="生成数量"><input className="input-field" type="number" min="1" max="5" value={count} onChange={(event) => setCount(Math.max(1, Math.min(5, Number(event.target.value))))} /></Field>
        <Field label="输出比例"><div className="segmented grid grid-cols-3 gap-1 p-1">{(['3x4', '9x16', '16x9'] as OutputPresetId[]).map((preset) => <button type="button" key={preset} className={outputPreset === preset ? 'active' : ''} onClick={() => setOutputPreset(preset)}>{preset.replace('x', ':')}</button>)}</div></Field>
        <div className="rounded-[14px] border border-hairline bg-surface-subtle p-4 text-sm">
          <p className={bootstrap.ttsProvider.hasApiKey ? 'text-success' : 'text-fail'}>{bootstrap.ttsProvider.hasApiKey ? '✓ V-API TTS 已配置' : '需要先在设置页配置 V-API TTS'}</p>
          <p className={bootstrap.alignmentConfigured ? 'mt-1 text-success' : 'mt-1 text-warn'}>{bootstrap.alignmentConfigured ? '✓ 生产强制对齐已配置' : '强制对齐未配置；系统会在调用付费 TTS 前停止'}</p>
        </div>
      </div>
      {message && <p className="mx-7 mb-4 rounded-xl bg-accent-tint/20 px-4 py-3 text-sm text-ink-secondary">{message}</p>}
      <div className="flex justify-end border-t border-hairline px-7 py-5"><button type="button" disabled={busy || !scriptDraftId || !bootstrap.ttsProvider.hasApiKey || !bootstrap.alignmentConfigured} className="btn-primary" onClick={() => void start()}><Icon name="film" size={16} />{busy ? '处理中…' : '分析素材并自动剪辑'}</button></div>
    </section>
  );

  return (
    <section className="relative left-1/2 w-screen -translate-x-1/2 overflow-x-auto bg-[#f5f6f8] py-5">
      <div className="mx-auto min-w-[1240px] max-w-[1580px] px-5">
        <header className="mb-3 flex items-center justify-between rounded-2xl border border-hairline bg-white px-5 py-3 shadow-sm">
          <div><p className="text-xs font-semibold text-accent">第五步 · 成片剪辑</p><h2 className="font-semibold">{projectName}</h2><select aria-label="成片组" className="mt-1 max-w-[250px] rounded-lg border border-hairline bg-white px-2 py-1 text-xs" value={group.id} onChange={(event) => void openGroup(event.target.value)}>{bootstrap.groups.filter((item) => ['ready', 'partial'].includes(item.status)).map((item) => <option key={item.id} value={item.id}>{bootstrap.drafts.find((draft) => draft.id === item.scriptDraftId)?.title || '脚本成片组'} · {item.variantCount} 条</option>)}</select></div>
          <div className="flex items-center gap-2">{group.variants.map((variant) => <button type="button" key={variant.id} onClick={() => setSelectedVariantId(variant.id)} className={`rounded-xl border px-3 py-2 text-sm ${selectedVariant?.id === variant.id ? 'border-accent bg-accent text-white' : 'border-hairline bg-white'}`}>成片 {String(variant.indexNum).padStart(2, '0')} <span className="opacity-70">{variant.outputPreset.replace('x', ':')}</span></button>)}</div>
          <div className="text-right"><p className="text-xs text-success">{message || '已自动保存'}</p><div className="mt-1 flex gap-1"><button type="button" className="btn-secondary btn-sm" disabled={selectedVariant.revision <= 0} onClick={() => { setRedoRevision(selectedVariant.revision); void applyVariant({ type: 'restore_revision', revision: Math.max(0, selectedVariant.revision - 1) }); }}>撤销</button><button type="button" className="btn-secondary btn-sm" disabled={redoRevision == null} onClick={() => { if (redoRevision != null) void applyVariant({ type: 'restore_revision', revision: redoRevision }); setRedoRevision(null); }}>重做</button>{renderedJob && <><a className="btn-secondary btn-sm" href={`/api/final-edit-jobs/${renderedJob.id}/video`}>MP4</a><a className="btn-secondary btn-sm" href={`/api/final-edit-jobs/${renderedJob.id}/cover`}>JPG</a></>}<a className="btn-secondary btn-sm" href={`/api/final-edit-groups/${group.id}/download`}>整组 ZIP</a><button type="button" className="btn-primary btn-sm" onClick={() => void renderCurrent()} disabled={busy || Boolean(selectedVariant?.issues.some((issue) => issue.severity === 'blocking'))}><Icon name="download" size={14} />导出</button></div></div>
        </header>

        <div className="grid grid-cols-[440px_minmax(420px,1fr)_330px] gap-3">
          <aside className="max-h-[720px] overflow-y-auto rounded-2xl border border-hairline bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between"><div><h3 className="font-semibold">视频素材</h3><p className="text-xs text-ink-tertiary">仅当前分镜组 · {group.assets.length} 条</p></div><span className="status-badge status-succeeded">同组</span></div>
            <div className="mt-3 flex flex-wrap gap-1">{([['all', '全部'], ['recommended', '推荐'], ['used', '使用中'], ['failed', '分析失败'], ['disabled', '禁止自动']] as const).map(([id, label]) => <button type="button" key={id} onClick={() => setAssetFilter(id)} className={`rounded-lg px-2.5 py-1.5 text-xs ${assetFilter === id ? 'bg-accent text-white' : 'bg-surface-subtle text-ink-secondary'}`}>{label}</button>)}</div>
            <div className="mt-3 grid h-[420px] grid-cols-2 content-start gap-2 overflow-y-auto pr-1">
              {filteredAssets.map((asset) => <button type="button" key={asset.videoJobId} onClick={() => setSelectedAssetId(asset.videoJobId)} className={`overflow-hidden rounded-xl border text-left ${selectedAsset?.videoJobId === asset.videoJobId ? 'border-accent ring-2 ring-accent/10' : 'border-hairline'}`}><video className="aspect-[4/3] w-full bg-black object-cover" muted preload="metadata" src={asset.previewUrl} /><div className="p-2"><p className="truncate text-xs font-medium">{asset.filename}</p><p className="mt-1 text-[11px] text-ink-tertiary">使用 {asset.usageCount} 次 · {asset.analysisStatus === 'succeeded' ? '已分析' : asset.analysisStatus === 'failed' ? '失败' : '待分析'}</p></div></button>)}
            </div>
            {selectedAsset && <div className="mt-3 rounded-xl bg-surface-subtle p-3 text-xs"><p className="font-medium">分析摘要</p><p className="mt-1 text-ink-secondary">{selectedAsset.summary || '暂无可靠摘要'}</p><div className="mt-2 flex items-center justify-between"><label className="flex items-center gap-2"><input type="checkbox" checked={selectedAsset.autoUseDisabled} onChange={(event) => void updateAssetAnalysis(selectedAsset.videoJobId, { autoUseDisabled: event.target.checked })} />禁止自动使用</label><button type="button" className="text-accent" disabled={busy} onClick={() => void reanalyzeAsset(selectedAsset.videoJobId)}>重新分析</button></div></div>}
            <p className="mt-3 text-xs text-ink-tertiary">点击卡片预览；素材数量增加只会在此区域滚动。</p>
          </aside>

          <main className="rounded-2xl border border-hairline bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between"><h3 className="font-semibold">画面预览</h3><span className="text-xs text-ink-tertiary">{selectedVariant?.outputPreset.replace('x', ':')} · 24 fps</span></div>
            <EditorPreview group={group} variant={selectedVariant} assets={group.assets} />
          </main>

          <aside className="rounded-2xl border border-hairline bg-white p-4 shadow-sm">
            <h3 className="font-semibold">属性</h3>
            {selectedCue && <div className="mt-4"><label className="label">当前字幕文字</label><input className="input-field" value={selectedCue.text} onChange={(event) => setGroup({ ...group, subtitleCues: group.subtitleCues.map((cue) => cue.id === selectedCue.id ? { ...cue, text: event.target.value.replace(/\n/g, '') } : cue) })} onBlur={(event) => void applyGroup({ type: 'set_subtitle_cue_text', cueId: selectedCue.id, text: event.target.value })} /><div className="mt-2 flex gap-2"><button type="button" className="btn-secondary btn-sm flex-1" onClick={() => { const chars = Array.from(selectedCue.text); const cut = Math.max(1, Math.floor(chars.length / 2)); void applyGroup({ type: 'split_subtitle_cue', cueId: selectedCue.id, splitUs: Math.round((selectedCue.startUs + selectedCue.endUs) / 2), leftText: chars.slice(0, cut).join(''), rightText: chars.slice(cut).join('') }); }}>从中间拆分</button><button type="button" className="btn-secondary btn-sm text-fail" onClick={() => void applyGroup({ type: 'delete_subtitle_cue', cueId: selectedCue.id })}>删除</button></div><p className="mt-2 text-xs text-ink-tertiary">{formatTime(selectedCue.startUs)} — {formatTime(selectedCue.endUs)}；拖动下方字幕块或两侧把手调整时间。</p></div>}
            <div className="mt-5 border-t border-hairline pt-4"><label className="label">封面第一段</label><input className="input-field" value={group.coverTitle.primary.text} onChange={(event) => setGroup({ ...group, coverTitle: { ...group.coverTitle, primary: { ...group.coverTitle.primary, text: event.target.value } } })} onBlur={(event) => void applyGroup({ type: 'set_cover_title_part_text', part: 'primary', text: event.target.value })} /><label className="label mt-3">封面第二段</label><input className="input-field" value={group.coverTitle.secondary.text} onChange={(event) => setGroup({ ...group, coverTitle: { ...group.coverTitle, secondary: { ...group.coverTitle.secondary, text: event.target.value } } })} onBlur={(event) => void applyGroup({ type: 'set_cover_title_part_text', part: 'secondary', text: event.target.value })} /></div>
            {selectedVariant && <div className="mt-5 border-t border-hairline pt-4"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold">文字样式</h4><button type="button" className="text-xs text-accent" onClick={() => void saveTitlePreset()}>保存标题预设</button></div><div className="mt-2 grid grid-cols-3 gap-1">{([['coverPrimary', '标题一'], ['coverSecondary', '标题二'], ['subtitle', '字幕']] as const).map(([id, label]) => <button type="button" key={id} className={`rounded-lg px-2 py-1.5 text-xs ${styleTarget === id ? 'bg-accent text-white' : 'bg-surface-subtle'}`} onClick={() => setStyleTarget(id)}>{label}</button>)}</div><TextStyleEditor value={group.textStyles[selectedVariant.outputPreset][styleTarget]} onChange={(style) => setGroup({ ...group, textStyles: { ...group.textStyles, [selectedVariant.outputPreset]: { ...group.textStyles[selectedVariant.outputPreset], [styleTarget]: style } } })} onCommit={(style) => void applyGroup({ type: 'set_text_style', preset: selectedVariant.outputPreset, target: styleTarget, style })} />{styleTarget !== 'subtitle' && <div className="mt-3 space-y-1">{titlePresets.map((preset) => <div key={preset.id} className="flex items-center gap-1 rounded-lg bg-surface-subtle px-2 py-1.5 text-xs"><button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => void applyTitlePreset(preset.id)}>{preset.name}</button><button type="button" onClick={() => void renameTitlePreset(preset)}>改名</button><button type="button" className="text-fail" onClick={() => void deleteTitlePreset(preset.id)}>删除</button></div>)}</div>}</div>}
            {selectedVariant && <div className="mt-5 border-t border-hairline pt-4"><Field label="封面底图"><select className="input-field text-xs" value={selectedVariant.cover.coverKey || ''} onChange={(event) => void applyVariant({ type: 'set_cover', coverKey: event.target.value })}>{group.coverCandidates.map((candidate, index) => <option key={candidate.coverKey} value={candidate.coverKey}>候选封面 {index + 1}</option>)}</select></Field><Field label="BGM"><select className="input-field mt-2 text-xs" value={selectedVariant.bgm.trackId || ''} onChange={(event) => void applyVariant({ type: 'set_bgm', trackId: event.target.value || null })}><option value="">无 BGM</option>{group.bgmTracks.map((track) => <option key={track.id} value={track.id}>{track.relativePath}</option>)}</select></Field><label className="label mt-3">BGM 增益 {selectedVariant.bgm.gainDb} dB</label><input key={`${selectedVariant.id}-${selectedVariant.revision}-bgm`} className="w-full accent-accent" type="range" min="-40" max="0" step="0.5" defaultValue={selectedVariant.bgm.gainDb} onPointerUp={(event) => void applyVariant({ type: 'set_bgm_gain', gainDb: Number(event.currentTarget.value) })} /></div>}
            {selectedClip && selectedAsset && <div className="mt-5 border-t border-hairline pt-4"><h4 className="text-sm font-semibold">视频片段</h4><p className="mt-1 text-xs text-ink-tertiary">时间轴 {selectedClip.timelineInFrame}–{selectedClip.timelineOutFrame} 帧 · 源 {selectedClip.sourceInFrame}–{selectedClip.sourceOutFrame} 帧</p><div className="mt-2 grid grid-cols-2 gap-2"><Field label="时间轴起点"><input className="input-field text-xs" type="number" min="0" max={selectedVariant.timeline.bodyFrames - (selectedClip.timelineOutFrame - selectedClip.timelineInFrame)} defaultValue={selectedClip.timelineInFrame} onBlur={(event) => void applyVariant({ type: 'move_clip', clipId: selectedClip.id, timelineInFrame: Number(event.target.value) })} /></Field><Field label="源入点"><input className="input-field text-xs" type="number" min="0" defaultValue={selectedClip.sourceInFrame} onBlur={(event) => { const sourceInFrame = Number(event.target.value); const length = selectedClip.sourceOutFrame - sourceInFrame; void applyVariant({ type: 'trim_clip', clipId: selectedClip.id, sourceInFrame, sourceOutFrame: selectedClip.sourceOutFrame, timelineInFrame: selectedClip.timelineInFrame, timelineOutFrame: selectedClip.timelineInFrame + length }); }} /></Field><Field label="源出点"><input className="input-field text-xs" type="number" min={selectedClip.sourceInFrame + 1} defaultValue={selectedClip.sourceOutFrame} onBlur={(event) => { const sourceOutFrame = Number(event.target.value); void applyVariant({ type: 'trim_clip', clipId: selectedClip.id, sourceInFrame: selectedClip.sourceInFrame, sourceOutFrame, timelineInFrame: selectedClip.timelineInFrame, timelineOutFrame: selectedClip.timelineInFrame + sourceOutFrame - selectedClip.sourceInFrame }); }} /></Field><Field label="缩放"><input className="input-field text-xs" type="number" min="1" max="3" step="0.05" defaultValue={selectedClip.framing.scale} onBlur={(event) => void applyVariant({ type: 'set_framing', clipId: selectedClip.id, scale: Number(event.target.value), offsetX: selectedClip.framing.offsetX, offsetY: selectedClip.framing.offsetY })} /></Field><Field label="水平偏移"><input className="input-field text-xs" type="number" min="-1" max="1" step="0.05" defaultValue={selectedClip.framing.offsetX} onBlur={(event) => void applyVariant({ type: 'set_framing', clipId: selectedClip.id, scale: selectedClip.framing.scale, offsetX: Number(event.target.value), offsetY: selectedClip.framing.offsetY })} /></Field><Field label="垂直偏移"><input className="input-field text-xs" type="number" min="-1" max="1" step="0.05" defaultValue={selectedClip.framing.offsetY} onBlur={(event) => void applyVariant({ type: 'set_framing', clipId: selectedClip.id, scale: selectedClip.framing.scale, offsetX: selectedClip.framing.offsetX, offsetY: Number(event.target.value) })} /></Field></div><Field label="绑定口播"><select className="input-field mt-1 text-xs" value={selectedClip.boundSegmentId || ''} onChange={(event) => void applyVariant(event.target.value ? { type: 'bind_clip', clipId: selectedClip.id, segmentId: event.target.value } : { type: 'unbind_clip', clipId: selectedClip.id })}><option value="">不绑定</option>{[...new Set(group.subtitleCues.map((cue) => cue.segmentId))].map((segmentId) => <option key={segmentId} value={segmentId}>{segmentId}</option>)}</select></Field>{selectedAsset.videoJobId !== selectedClip.videoJobId && <button type="button" className="btn-secondary btn-sm mt-2 w-full" onClick={() => void applyVariant({ type: 'replace_clip', clipId: selectedClip.id, videoJobId: selectedAsset.videoJobId, sourceFingerprint: selectedAsset.fingerprint, sourceInFrame: 0, sourceOutFrame: selectedClip.sourceOutFrame - selectedClip.sourceInFrame })}>用当前素材替换片段</button>}{firstVideoGap && <button type="button" className="btn-secondary btn-sm mt-2 w-full" onClick={() => { const length = Math.min(72, firstVideoGap.end - firstVideoGap.start, Math.floor(selectedAsset.durationUs / 1_000_000 * 24)); void applyVariant({ type: 'insert_clip', videoJobId: selectedAsset.videoJobId, sourceFingerprint: selectedAsset.fingerprint, sourceInFrame: 0, sourceOutFrame: length, timelineInFrame: firstVideoGap.start, timelineOutFrame: firstVideoGap.start + length }); }}>把当前素材插入第一个缺口</button>}</div>}
            {selectedAsset && firstVideoGap && !selectedClip && <button type="button" className="btn-secondary btn-sm mt-4 w-full" onClick={() => { const length = Math.min(72, firstVideoGap.end - firstVideoGap.start, Math.floor(selectedAsset.durationUs / 1_000_000 * 24)); void applyVariant({ type: 'insert_clip', videoJobId: selectedAsset.videoJobId, sourceFingerprint: selectedAsset.fingerprint, sourceInFrame: 0, sourceOutFrame: length, timelineInFrame: firstVideoGap.start, timelineOutFrame: firstVideoGap.start + length }); }}>把当前素材插入时间轴</button>}
            <div className="mt-5 border-t border-hairline pt-4"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold">问题</h4>{selectedVariant?.issues.some((issue) => issue.code === 'timeline_gap') && <button type="button" className="text-xs text-accent" onClick={() => void proposeGapFill()}>AI 补齐缺口</button>}</div><div className="mt-2 space-y-2">{selectedVariant?.issues.length ? selectedVariant.issues.map((issue, index) => <div key={`${issue.code}-${index}`} className={`rounded-lg px-3 py-2 text-xs ${issue.severity === 'blocking' ? 'bg-fail/10 text-fail' : 'bg-warn/10 text-warn'}`}>{issue.message}</div>) : <p className="text-xs text-success">未发现阻断问题</p>}</div></div>
          </aside>
        </div>

        {selectedVariant && <Timeline variant={selectedVariant} cues={group.subtitleCues} selectedCueId={selectedCueId} selectedClipId={selectedClipId} onSelectCue={setSelectedCueId} onSelectClip={setSelectedClipId} onMoveCue={(cueId, startUs, endUs) => void applyGroup({ type: 'move_subtitle_cue', cueId, startUs, endUs })} onMoveClip={(clipId, timelineInFrame) => void applyVariant({ type: 'move_clip', clipId, timelineInFrame })} onTrimClip={(clipId, sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame) => void applyVariant({ type: 'trim_clip', clipId, sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame })} onDeleteClip={(clipId) => void applyVariant({ type: 'delete_clip', clipId })} />}
      </div>
    </section>
  );
}

function EditorPreview({ group, variant, assets }: { group: FinalEditGroupView; variant: FinalEditVariantView; assets: FinalEditAssetView[] }) {
  const introSec = 20 / 24;
  const bodySec = variant.timeline.bodyFrames / 24;
  const totalSec = introSec + bodySec;
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const narrationRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const playbackStartRef = useRef(0);
  const bodyFrame = Math.max(0, Math.floor((playheadSec - introSec) * 24));
  const activeClip = playheadSec >= introSec ? variant.timeline.clips.find((clip) => bodyFrame >= clip.timelineInFrame && bodyFrame < clip.timelineOutFrame) || null : null;
  const activeAsset = activeClip ? assets.find((asset) => asset.videoJobId === activeClip.videoJobId) || null : null;
  const bodyTimeUs = Math.max(0, (playheadSec - introSec) * 1_000_000);
  const activeCue = playheadSec >= introSec ? group.subtitleCues.find((cue) => bodyTimeUs >= cue.startUs && bodyTimeUs < cue.endUs) || null : null;

  useEffect(() => {
    if (canvasRef.current) drawEditorOverlay(canvasRef.current, group, variant.outputPreset, activeCue, playheadSec < introSec);
  }, [activeCue, group, introSec, playheadSec, variant.outputPreset]);

  useEffect(() => {
    if (!playing) return;
    const origin = performance.now() - playbackStartRef.current * 1000;
    let animationFrame = 0;
    const tick = (time: number) => {
      const next = (time - origin) / 1000;
      if (next >= totalSec) { setPlayheadSec(totalSec); setPlaying(false); return; }
      if (bgmRef.current && next >= introSec) {
        const gain = Math.min(1, Math.pow(10, variant.bgm.gainDb / 20));
        const remaining = Math.max(0, totalSec - next);
        bgmRef.current.volume = gain * Math.min(1, remaining / Math.max(0.01, variant.bgm.fadeOutSec));
      }
      setPlayheadSec(next);
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [introSec, playing, totalSec, variant.bgm.fadeOutSec, variant.bgm.gainDb]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;
    const expected = activeClip.sourceInFrame / 24 + Math.max(0, bodyFrame - activeClip.timelineInFrame) / 24;
    if (Math.abs(video.currentTime - expected) > 0.2) video.currentTime = expected;
    if (playing) void video.play().catch(() => undefined); else video.pause();
  }, [activeClip, bodyFrame, playing]);

  useEffect(() => {
    const narration = narrationRef.current;
    const bgm = bgmRef.current;
    const stop = () => { narration?.pause(); bgm?.pause(); };
    if (!playing) { stop(); return; }
    const startPlayhead = playbackStartRef.current;
    const delayMs = Math.max(0, (introSec - startPlayhead) * 1000);
    const timer = window.setTimeout(() => {
      const offset = Math.max(0, startPlayhead - introSec + delayMs / 1000);
      if (narration) { narration.currentTime = offset; void narration.play().catch(() => undefined); }
      if (bgm) { bgm.currentTime = offset % Math.max(0.1, bgm.duration || bodySec); bgm.volume = Math.min(1, Math.pow(10, variant.bgm.gainDb / 20)); void bgm.play().catch(() => undefined); }
    }, delayMs);
    return () => { window.clearTimeout(timer); stop(); };
  }, [bodySec, group.id, introSec, playing, variant.bgm.gainDb, variant.bgm.trackId]);

  const seek = (next: number) => { const bounded = Math.max(0, Math.min(totalSec, next)); playbackStartRef.current = bounded; setPlaying(false); setPlayheadSec(bounded); };
  const framing = activeClip?.framing || { scale: 1, offsetX: 0, offsetY: 0 };
  return <div className="mt-3 rounded-xl bg-[#111827] p-5">
    <div className="flex h-[470px] items-center justify-center">
      <div className={`relative overflow-hidden bg-black shadow-2xl ${variant.outputPreset === '16x9' ? 'aspect-video w-full' : variant.outputPreset === '9x16' ? 'aspect-[9/16] h-full' : 'aspect-[3/4] h-full'}`}>
        {playheadSec < introSec && variant.cover.sourceUrl && <Image className="object-cover" src={variant.cover.sourceUrl} alt="封面预览" fill unoptimized />}
        {activeAsset && <video ref={videoRef} key={`${activeClip?.id}-${activeAsset.videoJobId}`} className={`h-full w-full ${variant.outputPreset === '16x9' ? 'object-contain' : 'object-cover'}`} muted playsInline src={activeAsset.previewUrl} style={{ objectPosition: `${50 + framing.offsetX * 50}% ${50 + framing.offsetY * 50}%`, transform: `scale(${framing.scale})` }} />}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      </div>
    </div>
    <div className="mt-3 flex items-center gap-3 text-xs text-white"><button type="button" className="rounded-lg bg-white/15 px-3 py-2" onClick={() => { const startAt = playheadSec >= totalSec ? 0 : playheadSec; playbackStartRef.current = startAt; if (startAt !== playheadSec) setPlayheadSec(startAt); setPlaying((value) => !value); }}>{playing ? '暂停' : '播放成片'}</button><span>{formatTime(playheadSec * 1_000_000)} / {formatTime(totalSec * 1_000_000)}</span><input className="min-w-0 flex-1 accent-white" type="range" min="0" max={totalSec} step={1 / 24} value={playheadSec} onChange={(event) => seek(Number(event.target.value))} /></div>
    <audio ref={narrationRef} preload="metadata" src={`/api/final-edit-groups/${group.id}/narration`} />
    {variant.bgm.trackId && <audio ref={bgmRef} preload="metadata" loop src={`/api/final-edit-bgm/${variant.bgm.trackId}/file`} style={{ display: 'none' }} />}
  </div>;
}

function Timeline({ variant, cues, selectedCueId, selectedClipId, onSelectCue, onSelectClip, onMoveCue, onMoveClip, onTrimClip, onDeleteClip }: { variant: FinalEditVariantView; cues: SubtitleCue[]; selectedCueId: string; selectedClipId: string; onSelectCue: (id: string) => void; onSelectClip: (id: string) => void; onMoveCue: (id: string, startUs: number, endUs: number) => void; onMoveClip: (id: string, timelineInFrame: number) => void; onTrimClip: (id: string, sourceInFrame: number, sourceOutFrame: number, timelineInFrame: number, timelineOutFrame: number) => void; onDeleteClip: (id: string) => void }) {
  const bodyUs = variant.timeline.bodyFrames / 24 * 1_000_000;
  const introUs = 20 / 24 * 1_000_000;
  const totalUs = introUs + bodyUs;
  const left = (timeUs: number) => `${timeUs / totalUs * 100}%`;
  const width = (timeUs: number) => `${timeUs / totalUs * 100}%`;
  return <div className="mt-3 rounded-2xl border border-hairline bg-white p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">时间轴</h3><span className="text-xs text-ink-tertiary">20 帧封面 · 正文 {seconds(bodyUs).toFixed(2)}s · 总时长 {seconds(totalUs).toFixed(2)}s</span></div><div className="grid grid-cols-[80px_1fr] gap-y-1 text-xs"><TrackLabel label="字幕" /><div className="relative h-10 overflow-hidden rounded-lg bg-surface-subtle">{cues.map((cue) => <DraggableCue key={`${cue.id}-${cue.startUs}-${cue.endUs}`} cue={cue} selected={cue.id === selectedCueId} introUs={introUs} bodyUs={bodyUs} totalUs={totalUs} onSelect={onSelectCue} onCommit={onMoveCue} />)}</div><TrackLabel label="视频" /><div className="relative h-12 overflow-hidden rounded-lg bg-surface-subtle"><div className="absolute inset-y-1 left-0 rounded-md bg-[#dbeafe] px-1 text-[10px] text-accent" style={{ width: width(introUs) }}>20帧</div>{variant.timeline.clips.map((clip) => <DraggableClip key={`${clip.id}-${clip.sourceInFrame}-${clip.sourceOutFrame}-${clip.timelineInFrame}-${clip.timelineOutFrame}`} clip={clip} selected={selectedClipId === clip.id} bodyFrames={variant.timeline.bodyFrames} introUs={introUs} totalUs={totalUs} onSelect={onSelectClip} onMove={onMoveClip} onTrim={onTrimClip} onDelete={onDeleteClip} />)}</div><TrackLabel label="TTS" /><div className="relative h-8 rounded-lg bg-surface-subtle"><div className="absolute inset-y-1 rounded-md bg-blue-100 px-2 text-blue-700" style={{ left: left(introUs), width: width(bodyUs) }}>锁定口播</div></div><TrackLabel label="BGM" /><div className="relative h-8 rounded-lg bg-surface-subtle"><div className="absolute inset-y-1 rounded-md bg-violet-100 px-2 text-violet-700" style={{ left: left(introUs), width: width(bodyUs) }}>-16 dB · 淡出</div></div></div></div>;
}

function DraggableCue({ cue, selected, introUs, bodyUs, totalUs, onSelect, onCommit }: { cue: SubtitleCue; selected: boolean; introUs: number; bodyUs: number; totalUs: number; onSelect: (id: string) => void; onCommit: (id: string, startUs: number, endUs: number) => void }) {
  const [draft, setDraft] = useState({ startUs: cue.startUs, endUs: cue.endUs });
  const begin = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); onSelect(cue.id);
    const track = event.currentTarget.closest('[data-cue-block]')?.parentElement;
    if (!track) return;
    const startX = event.clientX;
    const initial = { ...draft };
    let latest = initial;
    const frameUs = 1_000_000 / 24;
    const move = (pointer: PointerEvent) => {
      const deltaUs = Math.round((pointer.clientX - startX) / Math.max(1, track.getBoundingClientRect().width) * totalUs / frameUs) * frameUs;
      if (mode === 'move') {
        const duration = initial.endUs - initial.startUs;
        const startUs = Math.max(0, Math.min(bodyUs - duration, initial.startUs + deltaUs));
        latest = { startUs, endUs: startUs + duration };
      } else if (mode === 'start') latest = { startUs: Math.max(0, Math.min(initial.endUs - frameUs, initial.startUs + deltaUs)), endUs: initial.endUs };
      else latest = { startUs: initial.startUs, endUs: Math.min(bodyUs, Math.max(initial.startUs + frameUs, initial.endUs + deltaUs)) };
      setDraft(latest);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onCommit(cue.id, Math.round(latest.startUs), Math.round(latest.endUs)); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  };
  return <div data-cue-block role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(cue.id); }} onPointerDown={(event) => begin('move', event)} className={`absolute top-1 flex h-8 touch-none items-center overflow-hidden whitespace-nowrap rounded-md border text-left ${selected ? 'border-accent bg-accent text-white' : 'border-accent/30 bg-accent-tint text-ink'}`} style={{ left: `${(introUs + draft.startUs) / totalUs * 100}%`, width: `${(draft.endUs - draft.startUs) / totalUs * 100}%` }}><div className="h-full w-2 cursor-ew-resize bg-black/10" onPointerDown={(event) => begin('start', event)} /><span className="min-w-0 flex-1 truncate px-1">{cue.text}</span><div className="h-full w-2 cursor-ew-resize bg-black/10" onPointerDown={(event) => begin('end', event)} /></div>;
}

function DraggableClip({ clip, selected, bodyFrames, introUs, totalUs, onSelect, onMove, onTrim, onDelete }: { clip: FinalEditVariantView['timeline']['clips'][number]; selected: boolean; bodyFrames: number; introUs: number; totalUs: number; onSelect: (id: string) => void; onMove: (id: string, timelineInFrame: number) => void; onTrim: (id: string, sourceInFrame: number, sourceOutFrame: number, timelineInFrame: number, timelineOutFrame: number) => void; onDelete: (id: string) => void }) {
  const [draft, setDraft] = useState({ sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame });
  const begin = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); onSelect(clip.id);
    const track = event.currentTarget.closest('[data-clip-block]')?.parentElement;
    if (!track) return;
    const startX = event.clientX;
    const initial = { ...draft };
    let latest = initial;
    const move = (pointer: PointerEvent) => {
      const deltaFrames = Math.round((pointer.clientX - startX) / Math.max(1, track.getBoundingClientRect().width) * totalUs / 1_000_000 * 24);
      if (mode === 'move') {
        const duration = initial.timelineOutFrame - initial.timelineInFrame;
        const timelineInFrame = Math.max(0, Math.min(bodyFrames - duration, initial.timelineInFrame + deltaFrames));
        latest = { ...initial, timelineInFrame, timelineOutFrame: timelineInFrame + duration };
      } else if (mode === 'start') {
        const delta = Math.max(-Math.min(initial.timelineInFrame, initial.sourceInFrame), Math.min(initial.timelineOutFrame - initial.timelineInFrame - 1, deltaFrames));
        latest = { ...initial, sourceInFrame: initial.sourceInFrame + delta, timelineInFrame: initial.timelineInFrame + delta };
      } else {
        const delta = Math.max(-(initial.timelineOutFrame - initial.timelineInFrame - 1), Math.min(bodyFrames - initial.timelineOutFrame, deltaFrames));
        latest = { ...initial, sourceOutFrame: initial.sourceOutFrame + delta, timelineOutFrame: initial.timelineOutFrame + delta };
      }
      setDraft(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (mode === 'move') onMove(clip.id, latest.timelineInFrame);
      else onTrim(clip.id, latest.sourceInFrame, latest.sourceOutFrame, latest.timelineInFrame, latest.timelineOutFrame);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  };
  return <div data-clip-block role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(clip.id); }} onPointerDown={(event) => begin('move', event)} className={`absolute inset-y-1 flex touch-none items-center overflow-hidden rounded-md border text-left ${selected ? 'border-accent bg-accent-tint' : 'border-hairline bg-white'}`} style={{ left: `${(introUs + draft.timelineInFrame / 24 * 1_000_000) / totalUs * 100}%`, width: `${((draft.timelineOutFrame - draft.timelineInFrame) / 24 * 1_000_000) / totalUs * 100}%` }}><div className="h-full w-2 cursor-ew-resize bg-accent/15" onPointerDown={(event) => begin('start', event)} /><span className="min-w-0 flex-1 truncate px-1">{clip.videoJobId.slice(0, 8)}</span><button type="button" aria-label="删除片段" className="px-1 text-fail" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onDelete(clip.id); }}><Icon name="trash" size={11} /></button><div className="h-full w-2 cursor-ew-resize bg-accent/15" onPointerDown={(event) => begin('end', event)} /></div>;
}

function TrackLabel({ label }: { label: string }) { return <div className="flex items-center font-medium text-ink-secondary">{label}</div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="label">{label}</label>{children}</div>; }

function TextStyleEditor({ value, onChange, onCommit }: { value: TextStyle; onChange: (value: TextStyle) => void; onCommit: (value: TextStyle) => void }) {
  const set = (patch: Partial<TextStyle>) => onChange({ ...value, ...patch });
  return <div className="mt-3 space-y-3 text-xs"><Field label="字体"><input className="input-field text-xs" value={value.fontFamily} onChange={(event) => set({ fontFamily: event.target.value })} onBlur={() => onCommit(value)} /></Field><NumberControl label="字号" value={value.fontSizePx} min={12} max={180} step={1} onChange={(fontSizePx) => set({ fontSizePx })} onCommit={() => onCommit(value)} /><NumberControl label="X 位置" value={value.x} min={0} max={1} step={0.01} onChange={(x) => set({ x })} onCommit={() => onCommit(value)} /><NumberControl label="Y 位置" value={value.y} min={0} max={1} step={0.01} onChange={(y) => set({ y })} onCommit={() => onCommit(value)} /><NumberControl label="缩放" value={value.scale} min={0.5} max={2} step={0.01} onChange={(scale) => set({ scale })} onCommit={() => onCommit(value)} /><NumberControl label="单行宽度" value={value.boxWidthPx} min={200} max={1800} step={10} onChange={(boxWidthPx) => set({ boxWidthPx })} onCommit={() => onCommit(value)} /><div className="grid grid-cols-2 gap-2"><Field label="颜色"><input className="h-9 w-full" type="color" value={value.color} onChange={(event) => set({ color: event.target.value })} onBlur={() => onCommit(value)} /></Field><Field label="对齐"><select className="input-field text-xs" value={value.align} onChange={(event) => { const next = { ...value, align: event.target.value as TextStyle['align'] }; onChange(next); onCommit(next); }}><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></Field></div><label className="flex items-center gap-2"><input type="checkbox" checked={value.stroke.enabled} onChange={(event) => { const next = { ...value, stroke: { ...value.stroke, enabled: event.target.checked } }; onChange(next); onCommit(next); }} />描边</label>{value.stroke.enabled && <div className="grid grid-cols-2 gap-2"><input type="color" value={value.stroke.color} onChange={(event) => set({ stroke: { ...value.stroke, color: event.target.value } })} onBlur={() => onCommit(value)} /><NumberControl label="粗细" value={value.stroke.widthPx} min={0} max={16} step={0.5} onChange={(widthPx) => set({ stroke: { ...value.stroke, widthPx } })} onCommit={() => onCommit(value)} /></div>}<label className="flex items-center gap-2"><input type="checkbox" checked={value.shadow.enabled} onChange={(event) => { const next = { ...value, shadow: { ...value.shadow, enabled: event.target.checked } }; onChange(next); onCommit(next); }} />阴影</label>{value.shadow.enabled && <><input type="color" value={value.shadow.color} onChange={(event) => set({ shadow: { ...value.shadow, color: event.target.value } })} onBlur={() => onCommit(value)} /><NumberControl label="不透明度" value={value.shadow.opacity} min={0} max={1} step={0.05} onChange={(opacity) => set({ shadow: { ...value.shadow, opacity } })} onCommit={() => onCommit(value)} /><NumberControl label="模糊" value={value.shadow.blurPx} min={0} max={40} step={1} onChange={(blurPx) => set({ shadow: { ...value.shadow, blurPx } })} onCommit={() => onCommit(value)} /><NumberControl label="距离" value={value.shadow.distancePx} min={0} max={40} step={1} onChange={(distancePx) => set({ shadow: { ...value.shadow, distancePx } })} onCommit={() => onCommit(value)} /><NumberControl label="角度" value={value.shadow.angleDeg} min={0} max={360} step={1} onChange={(angleDeg) => set({ shadow: { ...value.shadow, angleDeg } })} onCommit={() => onCommit(value)} /></>}</div>;
}

function NumberControl({ label, value, min, max, step, onChange, onCommit }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; onCommit: () => void }) { return <div><div className="mb-1 flex items-center justify-between"><label className="text-ink-secondary">{label}</label><input className="w-20 rounded border border-hairline px-1 py-0.5 text-right" type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} onBlur={onCommit} /></div><input className="w-full accent-accent" type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} onPointerUp={onCommit} /></div>; }
