'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { CoverPresetV2, FinalEditGroupView, FinalEditVariantView, OutputPresetId } from '@/lib/final-edit/types';
import { createOverlayBundlePayload, measureTextOverflowDetails, TextOverflowError, type TextOverflowDetail } from './text-canvas-renderer';
import { FinalEditAssetPool, type AssetFilter } from './FinalEditAssetPool';
import { FinalEditInspector, type InspectorMode, type StyleTarget, type TitlePresetView } from './FinalEditInspector';
import { FinalEditPreview } from './FinalEditPreview';
import { FinalEditTimeline } from './FinalEditTimeline';
import type { GroupCommandInput, VariantCommandInput } from './command-types';
import { findUnusedCoverCandidate } from './editor-repair';
import styles from './FinalEditEditor.module.css';

interface Bootstrap {
  drafts: Array<{ id: string; title: string; shotSetId: string; targetDurationSec: number; segmentCount: number; createdAt: string }>;
  groups: Array<{ id: string; scriptDraftId: string; status: string; phase: string; narrationDurationUs: number; variantCount: number; createdAt: string }>;
  visionProviders: Array<{ id: string; name: string; model: string; configured: boolean }>;
  ttsProvider: { id: string; name: string; model: string; enabled: boolean; hasApiKey: boolean };
  voices: Array<{ id: string; label: string }>;
  alignmentConfigured: boolean;
  defaults: { count: number; outputPreset: OutputPresetId; voice: string; speed: number };
}

type TitlePreset = TitlePresetView;

const JOB_PHASE_LABELS: Record<string, string> = {
  validating: '正在校验脚本与素材',
  analyzing: '正在分析视频素材',
  synthesizing: '正在生成口播并对齐字幕',
  planning: '正在编排成片时间轴',
  saving: '正在保存成片组',
  preflight: '正在检查导出条件',
  rendering: '正在渲染成片',
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

export default function FinalEditPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [group, setGroup] = useState<FinalEditGroupView | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [previewAssetId, setPreviewAssetId] = useState('');
  const [selectedCueId, setSelectedCueId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [scriptDraftId, setScriptDraftId] = useState('');
  const [count, setCount] = useState(2);
  const [outputPreset, setOutputPreset] = useState<OutputPresetId>('3x4');
  const [voice, setVoice] = useState('Cherry');
  const [speed, setSpeed] = useState(1);
  const [jobId, setJobId] = useState('');
  const [jobProgress, setJobProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [titlePresets, setTitlePresets] = useState<TitlePreset[]>([]);
  const [redoRevision, setRedoRevision] = useState<number | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [repairingIssues, setRepairingIssues] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<'setup' | 'overview' | 'editor'>('editor');
  const [playheadSec, setPlayheadSec] = useState(0);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>('subtitle');
  const [styleTarget, setStyleTarget] = useState<StyleTarget>('coverPrimary');
  const [textOverflowDetails, setTextOverflowDetails] = useState<TextOverflowDetail[]>([]);

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
        const job = await readJson<{ kind: string; status: string; phase: string; progress: number; groupId: string; errorMessage?: string }>(await fetch(`/api/final-edit-jobs/${jobId}`));
        const progress = Math.max(0, Math.min(1, Number(job.progress) || 0));
        setJobProgress(progress);
        setMessage(`${JOB_PHASE_LABELS[job.phase] || `正在处理：${job.phase}`} · ${Math.round(progress * 100)}%`);
        if (job.status === 'succeeded' || job.status === 'failed') {
          window.clearInterval(timer);
          setBusy(false);
          setJobId('');
          if (job.status === 'failed') { setJobProgress(0); setMessage(job.errorMessage || '准备任务失败'); return; }
          const loaded = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${job.groupId}`));
          setGroup(loaded);
          setSelectedVariantId(loaded.variants[0]?.id || '');
          setSelectedAssetId(loaded.assets[0]?.videoJobId || '');
          setPreviewAssetId('');
          setSelectedCueId(loaded.subtitleCues[0]?.id || '');
          setJobProgress(1);
          setWorkspaceView(job.kind === 'prepare' ? 'overview' : 'editor');
          setMessage(job.kind === 'prepare' ? '成片草稿已生成' : '成片已渲染完成');
        }
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobId]);

  const selectedVariant = (group?.variants.find((variant) => variant.id === selectedVariantId) || group?.variants[0] || null) as FinalEditVariantView;
  const selectedAsset = group?.assets.find((asset) => asset.videoJobId === selectedAssetId) || group?.assets[0] || null;
  const selectedCue = group?.subtitleCues.find((cue) => cue.id === selectedCueId) || group?.subtitleCues[0] || null;
  const previewAsset = group?.assets.find((asset) => asset.videoJobId === previewAssetId) || null;
  const selectedClip = selectedVariant?.timeline.clips.find((clip) => clip.id === selectedClipId) || null;
  const renderedJob = group?.jobs.find((job) => job.kind === 'render' && job.variantId === selectedVariant?.id && job.status === 'succeeded') || null;
  const selectedCueOverflow = textOverflowDetails.find((detail) => detail.target === 'subtitle' && detail.cueId === selectedCue?.id) || null;
  const overflowCueIds = textOverflowDetails.flatMap((detail) => detail.target === 'subtitle' && detail.cueId ? [detail.cueId] : []);
  const subtitleOverflowCount = overflowCueIds.length;
  const titleOverflowCount = textOverflowDetails.length - subtitleOverflowCount;
  const textOverflowMessage = textOverflowDetails.length
    ? `有 ${[subtitleOverflowCount ? `${subtitleOverflowCount} 条字幕` : '', titleOverflowCount ? `${titleOverflowCount} 处封面标题` : ''].filter(Boolean).join('、')}超出单行安全宽度`
    : '';
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

  useEffect(() => {
    if (!group || !selectedVariant) return;
    let cancelled = false;
    const refresh = () => {
      if (!cancelled) setTextOverflowDetails(measureTextOverflowDetails(group, selectedVariant.outputPreset));
    };
    void document.fonts.ready.then(refresh);
    return () => { cancelled = true; };
  }, [group, selectedVariant]);

  const focusTextOverflow = (detail: TextOverflowDetail) => {
    setWorkspaceView('editor');
    if (detail.target === 'subtitle' && detail.cueId) {
      const cue = group?.subtitleCues.find((item) => item.id === detail.cueId);
      setSelectedCueId(detail.cueId);
      setInspectorMode('subtitle');
      if (cue) setPlayheadSec(20 / 24 + cue.startUs / 1_000_000);
      return;
    }
    setInspectorMode('cover');
    setStyleTarget(detail.target);
    setPlayheadSec(0);
  };

  const start = async () => {
    if (!scriptDraftId) return;
    setBusy(true); setJobProgress(0.02); setMessage('正在估算素材容量…');
    try {
      const preflight = await readJson<{ warnings: string[] }>(await fetch(`/api/projects/${projectId}/final-edit/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptDraftId, count, outputPreset }) }));
      if (preflight.warnings.length) setMessage(preflight.warnings.join('；'));
      const job = await readJson<{ id: string; groupId: string }>(await fetch(`/api/projects/${projectId}/final-edit/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptDraftId, count, outputPreset, providerId: bootstrap?.ttsProvider.id, voice, speed, analysisProviderId: bootstrap?.visionProviders.find((item) => item.configured)?.id }) }));
      setJobProgress(0.05);
      setJobId(job.id);
    } catch (error) { setBusy(false); setJobProgress(0); setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const openGroup = async (groupId: string) => {
    try {
      const loaded = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${groupId}`));
      setGroup(loaded); setSelectedVariantId(loaded.variants[0]?.id || ''); setSelectedAssetId(loaded.assets[0]?.videoJobId || ''); setPreviewAssetId(''); setSelectedCueId(loaded.subtitleCues[0]?.id || ''); setSelectedClipId(''); setPlayheadSec(0); setWorkspaceView('editor');
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

  const updateAssetAnalysis = async (videoJobId: string, patch: { autoUseDisabled?: boolean }) => {
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

  const applyVariant = async (command: VariantCommandInput) => {
    if (!selectedVariant || !group) return false;
    try {
      const result = await readJson<{ view: FinalEditVariantView }>(await fetch(`/api/final-edit-variants/${selectedVariant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: selectedVariant.revision, ...command }) }));
      setGroup({ ...group, variants: group.variants.map((variant) => variant.id === result.view.id ? result.view : variant) });
      setMessage('已自动保存');
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return false; }
  };

  const applyGroup = async (command: GroupCommandInput) => {
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
    } catch (error) {
      setBusy(false);
      if (error instanceof TextOverflowError) {
        setTextOverflowDetails(error.details);
        if (error.details[0]) focusTextOverflow(error.details[0]);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const repairBlockingIssues = async () => {
    if (!group || !selectedVariant || repairingIssues) return;
    setRepairingIssues(true);
    setMessage('正在检查可自动修复的导出阻断…');
    try {
      let currentGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${group.id}`));
      let currentVariant = currentGroup.variants.find((variant) => variant.id === selectedVariant.id);
      if (!currentVariant) throw new Error('当前成片不存在');
      let repairedCount = 0;

      if (currentVariant.issues.some((issue) => issue.severity === 'blocking' && (issue.code === 'duplicate_cover' || issue.code === 'cover_missing'))) {
        const coverKey = findUnusedCoverCandidate(currentGroup, currentVariant.id);
        if (coverKey) {
          await readJson(await fetch(`/api/final-edit-variants/${currentVariant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: currentVariant.revision, type: 'set_cover', coverKey }) }));
          repairedCount += 1;
          currentGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${group.id}`));
          currentVariant = currentGroup.variants.find((variant) => variant.id === selectedVariant.id)!;
        }
      }

      if (currentVariant.issues.some((issue) => issue.severity === 'blocking' && issue.code === 'timeline_gap')) {
        const proposal = await readJson<{ id: string; addedClipCount: number }>(await fetch(`/api/final-edit-variants/${currentVariant.id}/proposals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'fill_all_gaps' }) }));
        if (proposal.addedClipCount > 0) {
          await readJson(await fetch(`/api/final-edit-proposals/${proposal.id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: currentVariant.revision }) }));
          repairedCount += 1;
          currentGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${group.id}`));
          currentVariant = currentGroup.variants.find((variant) => variant.id === selectedVariant.id)!;
        }
      }

      setGroup(currentGroup);
      const remaining = currentVariant.issues.filter((issue) => issue.severity === 'blocking');
      if (remaining.length === 0) setMessage(`一键修复完成${repairedCount ? `，已处理 ${repairedCount} 类问题` : ''}，现在可以导出`);
      else {
        setMessage(`${repairedCount ? `已处理 ${repairedCount} 类问题；` : ''}仍需手动处理：${remaining.map((issue) => issue.message).join('；')}`);
        if (remaining.some((issue) => issue.code === 'timeline_gap')) setInspectorMode('framing');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairingIssues(false);
    }
  };

  const saveTitlePreset = async () => {
    if (!group || !selectedVariant) return;
    const name = window.prompt('预设名称', `我的标题预设 ${titlePresets.length + 1}`)?.trim();
    if (!name) return;
    try {
      const stylesByPreset = Object.fromEntries((['3x4', '9x16', '16x9'] as OutputPresetId[]).map((preset) => [preset, {
        primary: group.textStyles[preset].coverPrimary,
        secondary: group.textStyles[preset].coverSecondary,
        framing: { scale: 1, offsetX: 0, offsetY: 0 },
      }])) as CoverPresetV2['stylesByPreset'];
      const created = await readJson<TitlePreset>(await fetch('/api/final-edit/title-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version: 2, stylesByPreset }) }));
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

  const effectiveView = group ? workspaceView : 'setup';
  const activeVariant = selectedVariant;
  const readyGroups = bootstrap.groups.filter((item) => ['ready', 'partial'].includes(item.status));

  const insertAssetAt = (asset: NonNullable<typeof selectedAsset>, requestedFrame: number) => {
    if (!activeVariant) return;
    const clips = [...activeVariant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
    const gaps: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const clip of clips) {
      if (clip.timelineInFrame > cursor) gaps.push({ start: cursor, end: clip.timelineInFrame });
      cursor = Math.max(cursor, clip.timelineOutFrame);
    }
    if (cursor < activeVariant.timeline.bodyFrames) gaps.push({ start: cursor, end: activeVariant.timeline.bodyFrames });
    const gap = gaps.find((item) => requestedFrame >= item.start && requestedFrame < item.end)
      || gaps.find((item) => item.start >= requestedFrame)
      || gaps[0];
    if (!gap) { setMessage('当前视频轨没有可插入的空白位置'); return; }
    const timelineInFrame = Math.max(gap.start, requestedFrame < gap.end ? requestedFrame : gap.start);
    const length = Math.min(72, gap.end - timelineInFrame, Math.floor(asset.durationUs / 1_000_000 * 24));
    if (length < 1) { setMessage('该位置没有足够空间插入素材'); return; }
    void applyVariant({ type: 'insert_clip', videoJobId: asset.videoJobId, sourceFingerprint: asset.fingerprint, sourceInFrame: 0, sourceOutFrame: length, timelineInFrame, timelineOutFrame: timelineInFrame + length });
  };

  const moveTextOverlay = (target: StyleTarget, x: number, y: number, commit: boolean) => {
    if (!group || !activeVariant) return;
    const style = { ...group.textStyles[activeVariant.outputPreset][target], x, y };
    setGroup({ ...group, textStyles: { ...group.textStyles, [activeVariant.outputPreset]: { ...group.textStyles[activeVariant.outputPreset], [target]: style } } });
    if (commit) void applyGroup({ type: 'set_text_style', preset: activeVariant.outputPreset, target, style });
  };

  return (
    <section className={styles.breakout}>
      <div className={styles.shell}>
        <header className={styles.workspaceHeader}>
          <div>
            <p className={styles.eyebrow}>第五步 · 成片剪辑</p>
            <h2 className={styles.workspaceTitle}>{projectName}</h2>
            {group && <select aria-label="成片组" className={styles.groupSelect} value={group.id} onChange={(event) => void openGroup(event.target.value)}>{readyGroups.map((item) => <option key={item.id} value={item.id}>{bootstrap.drafts.find((draft) => draft.id === item.scriptDraftId)?.title || '脚本成片组'} · {item.variantCount} 条</option>)}</select>}
          </div>
          <nav className={styles.viewSwitch} aria-label="成片剪辑流程">
            {([['setup', '1', '生成设置'], ['overview', '2', '成片组'], ['editor', '3', '单条编辑']] as const).map(([id, step, label]) => <button type="button" key={id} disabled={!group && id !== 'setup'} className={effectiveView === id ? styles.activeView : ''} onClick={() => setWorkspaceView(id)}><span>{step}</span>{label}</button>)}
          </nav>
          <div className={styles.headerActions}>
            {textOverflowDetails.length > 0
              ? <button type="button" className={styles.textOverflowAlert} onClick={() => focusTextOverflow(textOverflowDetails[0])}>{textOverflowMessage}<span>点击定位</span></button>
              : <span className={styles.saved}>{message || (group ? '已自动保存' : '等待生成')}</span>}
            {group && activeVariant && <>
              <button type="button" className={styles.actionButton} disabled={activeVariant.revision <= 0} onClick={() => { setRedoRevision(activeVariant.revision); void applyVariant({ type: 'restore_revision', revision: Math.max(0, activeVariant.revision - 1) }); }}>撤销</button>
              <button type="button" className={styles.actionButton} disabled={redoRevision == null} onClick={() => { if (redoRevision != null) void applyVariant({ type: 'restore_revision', revision: redoRevision }); setRedoRevision(null); }}>重做</button>
              <button type="button" className={styles.primaryButton} disabled={busy || Boolean(activeVariant.issues.some((issue) => issue.severity === 'blocking'))} onClick={() => void renderCurrent()}><Icon name="download" size={13} />导出</button>
            </>}
          </div>
        </header>

        {effectiveView === 'setup' && (
          <div className={styles.setup}>
            <div className={styles.overviewHeader}><div><h2>生成设置</h2><p className={styles.assetMeta}>选择脚本、音色和输出规格，生成新的可编辑成片组。</p></div>{group && <button type="button" className={styles.actionButton} onClick={() => setWorkspaceView('editor')}>返回当前成片</button>}</div>
            <div className={styles.setupGrid}>
              <div className={styles.setupCard}><h3>内容</h3><Field label="脚本版本"><select className={styles.input} value={scriptDraftId} onChange={(event) => setScriptDraftId(event.target.value)}>{bootstrap.drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.title} · {draft.targetDurationSec}s · {draft.segmentCount} 段</option>)}</select></Field><Field label="生成数量"><input className={styles.input} type="number" min="1" max="5" value={count} onChange={(event) => setCount(Math.max(1, Math.min(5, Number(event.target.value))))} /></Field></div>
              <div className={styles.setupCard}><h3>口播</h3><Field label="音色"><select className={styles.input} value={voice} onChange={(event) => setVoice(event.target.value)}>{bootstrap.voices.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</select></Field><Field label={'语速 ' + speed.toFixed(2) + 'x'}><input className="w-full accent-accent" type="range" min="0.75" max="1.5" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></Field><button type="button" className={styles.actionButton} disabled={previewingVoice || !bootstrap.ttsProvider.hasApiKey} onClick={() => void previewVoice()}>{previewingVoice ? '生成中' : '试听音色'}</button></div>
              <div className={styles.setupCard}><h3>输出</h3><Field label="画面比例"><select className={styles.input} value={outputPreset} onChange={(event) => setOutputPreset(event.target.value as OutputPresetId)}><option value="3x4">3:4</option><option value="9x16">9:16</option><option value="16x9">16:9</option></select></Field><p className={bootstrap.ttsProvider.hasApiKey ? 'text-success text-xs' : 'text-fail text-xs'}>{bootstrap.ttsProvider.hasApiKey ? '✓ V-API TTS 已配置' : '需要配置 V-API TTS'}</p><p className={bootstrap.alignmentConfigured ? 'mt-2 text-success text-xs' : 'mt-2 text-warn text-xs'}>{bootstrap.alignmentConfigured ? '✓ 强制对齐已配置' : '需要配置强制对齐'}</p></div>
            </div>
            <div className={styles.setupFooter}>
              {busy && <div className={styles.jobProgressWrap}>
                <div className={styles.jobProgressMeta}><span>{message || '正在准备任务'}</span><strong>{Math.round(jobProgress * 100)}%</strong></div>
                <div className={styles.jobProgressTrack} role="progressbar" aria-label="素材分析与自动剪辑进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(jobProgress * 100)}><span style={{ width: `${Math.round(jobProgress * 100)}%` }} /></div>
              </div>}
              <button type="button" disabled={busy || !scriptDraftId || !bootstrap.ttsProvider.hasApiKey || !bootstrap.alignmentConfigured} className={styles.primaryButton} onClick={() => void start()}><Icon name="film" size={14} />{busy ? '处理中…' : '分析素材并自动剪辑'}</button>
            </div>
          </div>
        )}

        {effectiveView === 'overview' && group && (
          <div className={styles.overview}>
            <div className={styles.overviewHeader}><div><h2>成片组</h2><p className={styles.assetMeta}>{group.variants.length} 条成片，共用口播与字幕，画面编排互相独立。</p></div><a className={styles.actionButton} href={'/api/final-edit-groups/' + group.id + '/download'}>下载整组 ZIP</a></div>
            <div className={styles.overviewGrid}>{group.variants.map((variant) => {
              const job = group.jobs.find((item) => item.kind === 'render' && item.variantId === variant.id && item.status === 'succeeded');
              return <button type="button" key={variant.id} className={styles.overviewCard} onClick={() => { setSelectedVariantId(variant.id); setSelectedClipId(''); setPreviewAssetId(''); setPlayheadSec(0); setWorkspaceView('editor'); }}>{variant.cover.sourceUrl ? <img src={variant.cover.sourceUrl} alt={'成片 ' + variant.indexNum + ' 封面'} /> : <div className={styles.previewGap}>暂无封面</div>}<div className={styles.overviewInfo}><strong>成片 {String(variant.indexNum).padStart(2, '0')} · {variant.outputPreset.replace('x', ':')}</strong><p>正文 {(variant.timeline.bodyFrames / 24).toFixed(2)} 秒<br />{variant.timeline.clips.length} 个画面片段 · 最大重叠 {variant.maxOverlap.toFixed(2)}<br />{variant.issues.length ? variant.issues[0].message : '没有阻断问题'}</p>{job && <span className={styles.saved}>已渲染，可下载 MP4 / JPG</span>}</div></button>;
            })}</div>
          </div>
        )}

        {effectiveView === 'editor' && group && activeVariant && (
          <>
            <div className={styles.editorTopbar}>
              <div className={styles.variantTabs}>{group.variants.map((variant) => <button type="button" key={variant.id} className={[styles.variantTab, activeVariant.id === variant.id ? styles.activeVariant : ''].join(' ')} onClick={() => { setSelectedVariantId(variant.id); setSelectedClipId(''); setPreviewAssetId(''); setPlayheadSec(0); }}>成片 {String(variant.indexNum).padStart(2, '0')} · {variant.outputPreset.replace('x', ':')}</button>)}</div>
              <div className={styles.topbarTools}>
                {renderedJob && <><a className={styles.actionButton} href={'/api/final-edit-jobs/' + renderedJob.id + '/video'}>MP4</a><a className={styles.actionButton} href={'/api/final-edit-jobs/' + renderedJob.id + '/cover'}>JPG</a></>}
                <button type="button" className={styles.actionButton} onClick={() => setWorkspaceView('overview')}>查看整组</button>
              </div>
            </div>
            <div className={styles.editorMain}>
              <FinalEditAssetPool assets={group.assets} filteredAssets={filteredAssets} selectedAsset={selectedAsset} filter={assetFilter} busy={busy} onFilter={setAssetFilter} onSelect={(id) => { setSelectedAssetId(id); setPreviewAssetId(id); }} onToggleAutoUse={(id, disabled) => void updateAssetAnalysis(id, { autoUseDisabled: disabled })} onReanalyze={(id) => void reanalyzeAsset(id)} />
              <FinalEditPreview group={group} variant={activeVariant} assets={group.assets} selectedAsset={previewAsset} playheadSec={playheadSec} textTarget={inspectorMode === 'subtitle' ? 'subtitle' : inspectorMode === 'cover' ? styleTarget : null} onPlayheadChange={setPlayheadSec} onTextPositionChange={moveTextOverlay} />
              <FinalEditInspector group={group} variant={activeVariant} selectedCue={selectedCue} selectedCueOverflow={selectedCueOverflow} selectedClip={selectedClip} selectedAsset={selectedAsset} mode={inspectorMode} styleTarget={styleTarget} titlePresets={titlePresets} firstVideoGap={firstVideoGap} onDraftGroup={setGroup} onDraftVariant={(draft) => setGroup({ ...group, variants: group.variants.map((variant) => variant.id === draft.id ? draft : variant) })} onVariantCommand={(command) => void applyVariant(command)} onGroupCommand={(command) => void applyGroup(command)} onSavePreset={() => void saveTitlePreset()} onApplyPreset={(id) => void applyTitlePreset(id)} onRenamePreset={renameTitlePreset} onDeletePreset={(id) => void deleteTitlePreset(id)} onFillGaps={() => void proposeGapFill()} onModeChange={(mode) => { setInspectorMode(mode); if (mode === 'cover') setPlayheadSec(0); else if (mode === 'subtitle' && playheadSec < 20 / 24) setPlayheadSec(20 / 24); }} onStyleTargetChange={setStyleTarget} />
            </div>
            <FinalEditTimeline variant={activeVariant} cues={group.subtitleCues} assets={group.assets} overflowCueIds={overflowCueIds} selectedCueId={selectedCue?.id || ''} selectedClipId={selectedClip?.id || ''} playheadSec={playheadSec} onSeek={setPlayheadSec} onSelectCue={(id) => { setSelectedCueId(id); setInspectorMode('subtitle'); }} onSelectClip={(id) => { setSelectedClipId(id); setInspectorMode('framing'); setPreviewAssetId(''); setSelectedAssetId(activeVariant.timeline.clips.find((clip) => clip.id === id)?.videoJobId || selectedAssetId); }} onMoveCue={(cueId, startUs, endUs) => void applyGroup({ type: 'move_subtitle_cue', cueId, startUs, endUs })} onTrimCue={(cueId, startUs, endUs) => void applyGroup({ type: 'trim_subtitle_cue', cueId, startUs, endUs })} onMoveClip={(clipId, timelineInFrame) => applyVariant({ type: 'move_clip', clipId, timelineInFrame })} onTrimClip={(clipId, sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame) => applyVariant({ type: 'trim_clip', clipId, sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame })} onDeleteClip={(clipId) => void applyVariant({ type: 'delete_clip', clipId })} onInsertAsset={insertAssetAt} onRepairIssues={() => void repairBlockingIssues()} repairingIssues={repairingIssues} />
          </>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className={styles.fieldLabel}>{label}</label>{children}</div>; }
