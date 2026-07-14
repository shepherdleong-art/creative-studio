'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ArrangementEditor, { type ReviewDraft } from './final-video/ArrangementEditor';
import { TEMPLATE_OPTIONS, type CoverTemplateId } from '@/lib/final-video/cover-templates';
import type { PackageConfig } from '@/lib/final-video/types';

interface ShotSetOption { id: string; name: string }
interface ScriptDraftOption { id: string; provider: string | null; model: string | null; createdAt: string; outputJson: string }
interface NarrationProviderOption { id: string; name: string; configured?: boolean; voices: string[] }
interface PreviewJob {
  id: string; kind: 'preview'; draftRevision: number | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'; progress: number;
  currentStep: string; outputUrl: string; coverUrl: string; errorMessage: string | null;
}
interface FinalJob {
  id: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'; currentStep: string;
  progress: number; durationSec: number | null; errorMessage: string | null; createdAt: string;
  packageConfig: { outputName?: string }; outputUrl: string; coverUrl: string;
}
interface WorkflowConfig {
  packageConfig: PackageConfig;
  selectedClipIds: string[];
}
interface Draft extends ReviewDraft {
  stage: 'draft' | 'preparing' | 'review' | 'failed';
  shotSetId: string; scriptDraftId: string | null; previewJobId: string | null; previewRevision: number | null;
  errorMessage: string | null; workflowConfig: WorkflowConfig; issues: Array<{ code: string }>;
}

const STEP_LABELS: Record<string, string> = {
  queued: '排队中', preparing: '准备素材', tts: '合成口播', narration: '拼装口播音轨',
  cover: '生成封面', subtitles: '生成字幕', render: '合成视频', finalize: '写入产物', done: '完成',
};
const NARRATION_FLOW = ['创建草稿', '准备口播', '审核', '预览', '正式渲染'];
const BGM_FLOW = ['创建草稿', '准备素材', '选择画面', '审核', '预览', '正式渲染'];

export default function FinalVideoPanel({ projectId }: { projectId: string }) {
  const [shotSets, setShotSets] = useState<ShotSetOption[]>([]);
  const [scriptDrafts, setScriptDrafts] = useState<ScriptDraftOption[]>([]);
  const [narrationProviders, setNarrationProviders] = useState<NarrationProviderOption[]>([]);
  const [selectedSetId, setSelectedSetId] = useState('');
  const [mode, setMode] = useState<'narration' | 'bgm-only'>('narration');
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [bgmTargetDurationSec, setBgmTargetDurationSec] = useState(15);
  const [narrationProviderId, setNarrationProviderId] = useState('');
  const [voice, setVoice] = useState('Cherry');
  const [coverTitle, setCoverTitle] = useState('');
  const [coverTemplate, setCoverTemplate] = useState<CoverTemplateId>('minimal-01');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewJob, setPreviewJob] = useState<PreviewJob | null>(null);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<FinalJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalJobsPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Never let a draft refresh or preview poll replace a title the user has typed.
  const titleTouchedRef = useRef(false);
  const lastAutoTitleRef = useRef('');

  const acceptDraft = useCallback((next: Draft, preservePreviewJob = false) => {
    setDraft(next);
    setPreviewJobId((previous) => next.previewJobId || (preservePreviewJob ? previous : null));
    setSelectedSetId(next.shotSetId);
    setMode(next.workflowConfig.packageConfig.mode);
    setSelectedScriptId(next.scriptDraftId ?? '');
    if (next.workflowConfig.packageConfig.mode === 'narration') {
      setNarrationProviderId(next.workflowConfig.packageConfig.narration.providerId);
      setVoice(next.workflowConfig.packageConfig.narration.voice);
    } else {
      setBgmTargetDurationSec(next.workflowConfig.packageConfig.targetDurationSec);
    }
    setCoverTemplate(next.workflowConfig.packageConfig.cover.templateId ?? 'minimal-01');
    const autoTitle = next.workflowConfig?.packageConfig?.cover?.titleText ?? '';
    if (!titleTouchedRef.current) {
      lastAutoTitleRef.current = autoTitle;
      setCoverTitle(autoTitle);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/final-videos`);
    const data = await response.json().catch(() => ({}));
    if (response.ok) setJobs(data.jobs ?? []);
  }, [projectId]);

  const loadDraft = useCallback(async (draftId: string, preservePreviewJob = false) => {
    const response = await fetch(`/api/final-video-drafts/${draftId}`);
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.draft) acceptDraft(data.draft as Draft, preservePreviewJob);
    return data.draft as Draft | undefined;
  }, [acceptDraft]);

  const loadPreviewJob = useCallback(async (jobId: string) => {
    const response = await fetch(`/api/final-video-jobs/${jobId}`);
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.job) setPreviewJob(data.job as PreviewJob);
  }, []);

  useEffect(() => {
    let active = true;
    // Tab entry only reads saved choices and jobs; paid workflow routes 不自动调用.
    void Promise.all([
      fetch(`/api/projects/${projectId}/shot-sets`).then((response) => response.json()).catch(() => []),
      fetch(`/api/projects/${projectId}/script`).then((response) => response.json()).catch(() => ({})),
      fetch('/api/providers/narration').then((response) => response.json()).catch(() => []),
      fetch(`/api/projects/${projectId}/final-video-drafts`).then((response) => response.json()).catch(() => ({})),
      fetch(`/api/projects/${projectId}/final-videos`).then((response) => response.json()).catch(() => ({})),
    ]).then(([setsData, scriptsData, narrationProviderData, draftsData, jobsData]) => {
      if (!active) return;
      const sets = (Array.isArray(setsData) ? setsData : []).map((item: { id: string; name: string }) => ({ id: item.id, name: item.name }));
      const scripts = Array.isArray(scriptsData.drafts) ? scriptsData.drafts as ScriptDraftOption[] : [];
      const narration = (Array.isArray(narrationProviderData) ? narrationProviderData : []).filter((item: NarrationProviderOption) => item.configured !== false) as NarrationProviderOption[];
      setShotSets(sets); setScriptDrafts(scripts); setNarrationProviders(narration); setJobs(jobsData.jobs ?? []);
      setSelectedSetId((previous) => sets.some((set) => set.id === previous) ? previous : sets[0]?.id ?? '');
      setSelectedScriptId((previous) => scripts.some((item) => item.id === previous) ? previous : scripts[0]?.id ?? '');
      setNarrationProviderId((previous) => narration.some((item) => item.id === previous) ? previous : narration[0]?.id ?? '');
      const latest = Array.isArray(draftsData.drafts) ? draftsData.drafts[0] as Draft | undefined : undefined;
      if (latest) acceptDraft(latest);
    });
    return () => { active = false; };
  }, [projectId, acceptDraft]);

  useEffect(() => {
    if (!previewJobId) return;
    if (previewJob && previewJob.status !== 'pending' && previewJob.status !== 'running') return;
    const refresh = () => { void loadPreviewJob(previewJobId); if (draft?.id) void loadDraft(draft.id, true); };
    pollTimer.current = setInterval(refresh, 2000);
    return () => { if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; } };
  }, [previewJobId, previewJob, draft?.id, loadDraft, loadPreviewJob]);

  const activeFinalJob = jobs.some((job) => job.status === 'pending' || job.status === 'running');
  useEffect(() => {
    if (!activeFinalJob) return;
    finalJobsPollTimer.current = setInterval(() => { void loadJobs(); }, 2000);
    return () => {
      if (finalJobsPollTimer.current) {
        clearInterval(finalJobsPollTimer.current);
        finalJobsPollTimer.current = null;
      }
    };
  }, [activeFinalJob, loadJobs]);

  const handleTitleChange = (value: string) => {
    setCoverTitle(value);
    titleTouchedRef.current = true;
  };

  // 口播模式：目标时长属于脚本层——它只指导模型写多少文案，实际成片由 TTS 的真实时长决定，
  // 所以从脚本读，表单不再暴露一个无法改变结果的重复控制器。
  const selectedScriptTargetDurationSec = useMemo(() => {
    const scriptDraft = scriptDrafts.find((item) => item.id === selectedScriptId);
    if (!scriptDraft) return null;
    try {
      const output = JSON.parse(scriptDraft.outputJson || '{}') as { targetDurationSec?: unknown };
      return typeof output.targetDurationSec === 'number' && output.targetDurationSec > 0
        ? output.targetDurationSec
        : null;
    } catch {
      return null;
    }
  }, [scriptDrafts, selectedScriptId]);

  // 纯 BGM 模式没有口播，targetDurationSec 是 solve-bgm-timeline 计算成片长度的唯一依据
  // （contentDurationSec = targetDurationSec - introDurationSec），必须由用户直接控制。
  const targetDurationSec = mode === 'narration'
    ? (selectedScriptTargetDurationSec ?? 20)
    : bgmTargetDurationSec;

  const workflowConfig = (): WorkflowConfig => ({
    packageConfig: mode === 'narration' ? {
      mode: 'narration', outputName: `final-${Date.now()}`, width: 1080, height: 1920, fps: 30,
      targetDurationSec, durationTolerancePct: 0.2, bgm: null,
      cover: { titleText: coverTitle, titleSize: 72, titleColor: '#ffffff', introDurationSec: 0, templateId: coverTemplate },
      subtitle: { enabled: true, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 },
      narration: { mode: 'tts', providerId: narrationProviderId, voice, speed: 1 },
    } : {
      mode: 'bgm-only', outputName: `final-${Date.now()}`, width: 1080, height: 1920, fps: 30,
      targetDurationSec, durationTolerancePct: 0.2, bgm: null,
      cover: { titleText: coverTitle, titleSize: 72, titleColor: '#ffffff', introDurationSec: 0, templateId: coverTemplate },
      subtitle: { enabled: false, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 },
      narration: { mode: 'none' },
    },
    selectedClipIds: [],
  });

  const reportConflict = async (draftId: string) => { await loadDraft(draftId); setError('草稿已更新，请确认最新编排后重试。'); };

  const createDraft = async () => {
    if (!selectedSetId || (mode === 'narration' && (!selectedScriptId || !narrationProviderId))) { setError(mode === 'narration' ? '请先选择分镜、脚本和口播供应商。' : '请先选择分镜组。'); return; }
    if (mode === 'bgm-only' && !(targetDurationSec > 0)) { setError('目标时长必须大于 0 秒。'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/final-video-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shotSetId: selectedSetId, scriptDraftId: mode === 'narration' ? selectedScriptId : null, workflowConfig: workflowConfig() }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '创建草稿失败');
      titleTouchedRef.current = false;
      acceptDraft(data.draft as Draft);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  const runDraftAction = async () => {
    if (!draft) return;
    const endpoint = `/api/final-video-drafts/${draft.id}/prepare`;
    setBusy(true); setError('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: draft.revision }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) { await reportConflict(draft.id); return; }
      if (!response.ok) throw new Error(data.error || '工作流操作失败');
      acceptDraft(data.draft as Draft);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  const syncPackaging = async (): Promise<Draft | null> => {
    if (!draft) return null;
    const nextWorkflow = { ...draft.workflowConfig, packageConfig: { ...draft.workflowConfig.packageConfig, cover: { ...draft.workflowConfig.packageConfig.cover, titleText: coverTitle, templateId: coverTemplate } } };
    const response = await fetch(`/api/final-video-drafts/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: draft.revision, workflowConfig: nextWorkflow }) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) { await reportConflict(draft.id); return null; }
    if (!response.ok) { setError(data.error || '保存包装配置失败'); return null; }
    const next = data.draft as Draft;
    acceptDraft(next);
    return next;
  };

  const updateBgmSelection = async (selectedClipIds: string[]): Promise<void> => {
    if (!draft || draft.workflowConfig.packageConfig.mode !== 'bgm-only') return;
    setBusy(true); setError('');
    try {
      const workflowConfig = { ...draft.workflowConfig, selectedClipIds };
      const response = await fetch(`/api/final-video-drafts/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: draft.revision, workflowConfig }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) { await reportConflict(draft.id); return; }
      if (!response.ok) throw new Error(data.error || '保存视频选择失败');
      acceptDraft(data.draft as Draft);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  const submitJob = async (kind: 'preview' | 'render') => {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const current = await syncPackaging();
      if (!current) return;
      const endpoint = kind === 'preview'
        ? `/api/final-video-drafts/${draft.id}/preview`
        : `/api/final-video-drafts/${draft.id}/render`;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.revision }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) { await reportConflict(current.id); return; }
      if (!response.ok) throw new Error(data.error || '提交渲染失败');
      if (kind === 'preview') { setPreviewJobId(data.jobId as string); await loadPreviewJob(data.jobId as string); }
      if (kind === 'render') await loadJobs();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  const handleRetry = async (id: string) => { await fetch(`/api/final-video-jobs/${id}/retry`, { method: 'POST' }); await loadJobs(); };
  const handleDelete = async (id: string) => { await fetch(`/api/final-video-jobs/${id}`, { method: 'DELETE' }); await loadJobs(); };
  const createAnotherDraft = () => { setDraft(null); setPreviewJob(null); setPreviewJobId(null); setError(''); titleTouchedRef.current = false; };
  const previewMatchesDraft = Boolean(draft && draft.previewRevision === draft.revision && previewJob?.draftRevision === draft.revision);
  const selectedNarration = narrationProviders.find((item) => item.id === narrationProviderId);
  const bgmSelectionReady = draft?.workflowConfig.packageConfig.mode !== 'bgm-only' || draft.workflowConfig.selectedClipIds.length > 0;

  return (
    <div className="mt-3 space-y-4">
      <div className="rounded-lg border border-hairline p-4"><p className="text-xs text-ink-tertiary">{(mode === 'narration' ? NARRATION_FLOW : BGM_FLOW).join(' → ')}</p><p className="mt-1 text-xs text-ink-tertiary">进入此页不自动调用付费服务；带供应商名称的按钮才会发起对应调用。</p></div>
      <div className="rounded-lg border border-hairline p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="label">分镜组<select value={selectedSetId} onChange={(event) => setSelectedSetId(event.target.value)} className="input-field text-sm"><option value="">请选择</option>{shotSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select></label>
          <label className="label">成片模式<select value={mode} disabled={Boolean(draft)} onChange={(event) => setMode(event.target.value as 'narration' | 'bgm-only')} className="input-field text-sm"><option value="narration">口播</option><option value="bgm-only">纯 BGM</option></select></label>
          {mode === 'bgm-only' && <label className="label">目标时长（秒）<input type="number" min="1" step="0.1" value={bgmTargetDurationSec} disabled={Boolean(draft)} onChange={(event) => setBgmTargetDurationSec(Number(event.target.value))} className="input-field text-sm" /></label>}
          {mode === 'narration' && <>
            <label className="label">口播脚本<select value={selectedScriptId} onChange={(event) => setSelectedScriptId(event.target.value)} className="input-field text-sm"><option value="">请选择</option>{scriptDrafts.map((item) => <option key={item.id} value={item.id}>{item.provider || '脚本'} · {item.model || item.id.slice(0, 8)}</option>)}</select></label>
            <label className="label">口播供应商<select value={narrationProviderId} onChange={(event) => setNarrationProviderId(event.target.value)} className="input-field text-sm"><option value="">请选择</option>{narrationProviders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="label">音色<select value={voice} onChange={(event) => setVoice(event.target.value)} className="input-field text-sm">{(selectedNarration?.voices ?? ['Cherry']).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          </>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="label">封面标题<input value={coverTitle} onChange={(event) => handleTitleChange(event.target.value)} className="input-field text-sm" placeholder="如：三大亮点一次看完" /></label><label className="label">封面模板<select value={coverTemplate} onChange={(event) => setCoverTemplate(event.target.value as CoverTemplateId)} className="input-field text-sm">{TEMPLATE_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
        {!draft && <button type="button" disabled={busy} onClick={() => void createDraft()} className="btn-primary btn-sm">{busy ? '创建中…' : '创建成片草稿'}</button>}
        {draft && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary"><span>当前草稿 revision {draft.revision} · {draft.stage}</span><button type="button" onClick={createAnotherDraft} className="btn-secondary btn-sm">新建草稿</button></div>}
      </div>

      {draft?.stage === 'draft' && <button type="button" disabled={busy} onClick={() => void runDraftAction()} className="btn-primary btn-sm">{draft.workflowConfig.packageConfig.mode === 'narration' ? '准备口播' : '准备素材'}</button>}
      {draft?.stage === 'failed' && <p className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-600">{draft.errorMessage || '草稿执行失败，请新建草稿后重试。'}</p>}
      {draft?.stage === 'review' && <>
        {draft.issues.some((issue) => issue.code === 'script_image_stale') && (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700">
            分镜图在脚本生成后被重新生成过，文案可能与画面不匹配。可以继续出片，也可以回到脚本步骤重新生成。
          </p>
        )}
        {draft.issues.some((issue) => issue.code === 'planned_clip_substituted') && (
          <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-600">
            脚本计划中的部分画面缺失（视频未生成或生成失败），已用备用画面替补。
          </p>
        )}
        <ArrangementEditor draft={draft} onDraft={(next) => acceptDraft(next as Draft)} onConflict={setError} onError={setError} mode={draft.workflowConfig.packageConfig.mode} selectedClipIds={draft.workflowConfig.selectedClipIds} targetDurationSec={draft.workflowConfig.packageConfig.targetDurationSec} onSelectedClipIds={updateBgmSelection} />
        {!bgmSelectionReady && <p className="text-xs text-amber-600">请至少选择一条视频素材后再渲染。</p>}
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !bgmSelectionReady} onClick={() => void submitJob('preview')} className="btn-primary btn-sm">{busy ? '提交中…' : '生成预览（本地渲染）'}</button><button type="button" disabled={busy || !bgmSelectionReady} onClick={() => void submitJob('render')} className="btn-secondary btn-sm">{busy ? '提交中…' : '正式渲染（本地渲染）'}</button></div>
        {previewJob && <div className="rounded-lg border border-hairline p-3 text-xs"><p>预览任务：{STEP_LABELS[previewJob.currentStep] || previewJob.currentStep}</p>{previewJob.status === 'failed' && <p className="mt-1 text-red-500">{previewJob.errorMessage || '预览失败'}</p>}{previewMatchesDraft && previewJob.status === 'succeeded' && previewJob.outputUrl && <video controls preload="metadata" src={previewJob.outputUrl} poster={previewJob.coverUrl || undefined} className="mt-2 max-h-72 rounded border border-hairline" />}{!previewMatchesDraft && previewJob.status === 'succeeded' && <p className="mt-1 text-ink-tertiary">此预览来自旧版本草稿，不会展示。</p>}</div>}
      </>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="space-y-2"><h3 className="text-sm font-medium">正式成片任务</h3>{jobs.length === 0 && <p className="text-xs text-ink-tertiary">暂无正式成片任务。</p>}{jobs.map((job) => <div key={job.id} className="rounded-lg border border-hairline p-3"><div className="flex items-center justify-between gap-2"><div><p className="text-sm">{job.packageConfig.outputName || job.id}</p><p className="text-xs text-ink-tertiary">{STEP_LABELS[job.currentStep] || job.currentStep}{job.status === 'succeeded' && job.durationSec ? ` · ${job.durationSec.toFixed(1)}s` : ''}</p></div><div className="flex gap-2">{job.status === 'failed' && <button type="button" onClick={() => void handleRetry(job.id)} className="btn-secondary btn-sm">重试</button>}{job.status !== 'pending' && job.status !== 'running' && <button type="button" onClick={() => void handleDelete(job.id)} className="btn-danger btn-sm">删除</button>}{job.status === 'succeeded' && job.outputUrl && <a href={job.outputUrl} download className="btn-secondary btn-sm">下载</a>}</div></div>{(job.status === 'pending' || job.status === 'running') && <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-subtle"><div className="h-full bg-accent" style={{ width: `${Math.round(job.progress)}%` }} /></div>}{job.status === 'failed' && job.errorMessage && <p className="mt-2 text-xs text-red-500">{job.errorMessage}</p>}{job.status === 'succeeded' && job.outputUrl && <video controls preload="metadata" src={job.outputUrl} poster={job.coverUrl || undefined} className="mt-2 max-h-72 rounded border border-hairline" />}</div>)}</div>
    </div>
  );
}
