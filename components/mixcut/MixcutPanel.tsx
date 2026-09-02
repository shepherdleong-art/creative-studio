'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ProjectInfoDialog, type ProjectInfoValue } from '@/components/ProjectInfoDialog';
import {
  createScriptEditorState,
  editActiveScript,
  hasNewerScriptRevision,
  isMixcutScriptChoiceVisible,
  markScriptSaved,
  resolveScriptSwitch,
  restoreImportedScript,
  syncScriptToRevision,
  type ScriptEditorState,
  type ScriptSourceRevisionState,
  type ScriptSwitchResolution,
} from '@/lib/final-edit/mixcut-creation-state';
import {
  initializeMaterialSelection,
  materialSelectionForShotSet,
  toggleMaterialSelection,
  type MaterialSelectionByShotSet,
} from '@/lib/final-edit/material-selection';
import type { FinalEditExternalAssetView, FinalEditGroupView, MixcutContextResponse, OutputPresetId } from '@/lib/final-edit/types';
import { CreationStep, type MixcutPrepareJobView, type MixcutTtsProviderView } from './CreationStep';
import { MaterialStep, type MaterialCardView } from './MaterialStep';
import { MixcutSidebar } from './MixcutSidebar';
import MixcutShell, { type MixcutStepDef } from './MixcutShell';
import { PreviewStep } from './PreviewStep';
import { ExportStep } from './ExportStep';
import styles from './mixcut-shell.module.css';

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

const STEPS: MixcutStepDef[] = [
  { label: '导入素材', hint: '选择当前分镜组', icon: 'folder', enabled: true },
  { label: 'AI 智能创作', hint: '脚本·音色·真实进度', icon: 'sparkle', enabled: true },
  { label: '预览调整', hint: '完整时间轴·自动保存', icon: 'play-circle', enabled: true },
  { label: '导出渲染', hint: '写回项目成片目录', icon: 'download', enabled: true },
];

interface VisionProviderView { id: string; configured: boolean; supportsVision?: boolean }
interface MixcutDraftRef { id: string; shotSetId: string; revision: number }
interface MixcutPanelProps {
  projectId: string;
  projectName: string;
  projectInfo: ProjectInfoValue;
  onProjectInfoChange: (project: ProjectInfoValue) => void;
}

const MANUAL_SCRIPT_ID = '__manual__';

function isLegacyDurationReviewJob<T extends Pick<MixcutPrepareJobView, 'status' | 'phase'>>(
  job: T | null | undefined,
): job is T & { status: 'needs_input'; phase: 'duration_review' } {
  return job?.status === 'needs_input' && job.phase === 'duration_review';
}

function isPreviewGroupReady(group: FinalEditGroupView | null | undefined): group is FinalEditGroupView {
  return Boolean(group && ['ready', 'partial'].includes(group.status) && group.variants.length > 0);
}

function prepareCreatedAt(group: FinalEditGroupView): string {
  return group.jobs.find((job) => job.kind === 'prepare')?.createdAt ?? '';
}

function scriptSourceFromGroup(script: FinalEditGroupView['script'] | undefined): (ScriptSourceRevisionState & { draftId: string }) | null {
  if (!script || !script.sourceDraftId) return null;
  return {
    draftId: script.sourceDraftId,
    sourceRevisionId: script.sourceScriptRevisionId ?? null,
    sourceRevisionNumber: script.sourceScriptRevisionNumber ?? null,
    sourceUpdatedAt: script.sourceScriptUpdatedAt ?? null,
  };
}

export default function MixcutPanel({
  projectId, projectName, projectInfo, onProjectInfoChange,
}: MixcutPanelProps) {
  const [context, setContext] = useState<MixcutContextResponse | null>(null);
  const [activeStep, setActiveStep] = useState<0 | 1 | 2 | 3>(0);
  const [projectInfoOpen, setProjectInfoOpen] = useState(false);
  const [exportVariantId, setExportVariantId] = useState('');
  const [selectionByShotSet, setSelectionByShotSet] = useState<MaterialSelectionByShotSet>({});
  const [externalByShotSet, setExternalByShotSet] = useState<Record<string, FinalEditExternalAssetView[]>>({});
  const [scriptEditor, setScriptEditor] = useState<ScriptEditorState>(() => createScriptEditorState({ id: MANUAL_SCRIPT_ID, narrationText: '' }));
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);
  const [pendingSyncDraftId, setPendingSyncDraftId] = useState<string | null>(null);
  const [groupScriptSource, setGroupScriptSource] = useState<(ScriptSourceRevisionState & { draftId: string }) | null>(null);
  const [pendingShotSetId, setPendingShotSetId] = useState<string | null>(null);
  const [ttsProviders, setTtsProviders] = useState<MixcutTtsProviderView[]>([]);
  const [ttsProviderId, setTtsProviderId] = useState('');
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [visionProviderId, setVisionProviderId] = useState('');
  const [outputPreset, setOutputPreset] = useState<OutputPresetId>('3x4');
  const [activeJob, setActiveJob] = useState<MixcutPrepareJobView | null>(null);
  const [durationReviewGroup, setDurationReviewGroup] = useState<FinalEditGroupView | null>(null);
  const [preparedGroup, setPreparedGroup] = useState<FinalEditGroupView | null>(null);
  const [recentGroups, setRecentGroups] = useState<FinalEditGroupView[]>([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploadingShotSetIds, setUploadingShotSetIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [persistVersion, setPersistVersion] = useState(0);

  const requestRef = useRef<{ sequence: number; controller: AbortController } | null>(null);
  const jobPollRef = useRef<symbol | null>(null);
  const startRequestRef = useRef<{ sequence: number; shotSetId: string; controller: AbortController } | null>(null);
  const startSequenceRef = useRef(0);
  const submittingRef = useRef(false);
  const durationAutoContinueRef = useRef('');
  const draftGroupRef = useRef<MixcutDraftRef | null>(null);
  const persistVersionRef = useRef(0);
  const lastSavedVersionRef = useRef(0);
  const persistenceEpochRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveAbortRef = useRef<AbortController | null>(null);
  const scriptEditorByShotSetRef = useRef<Record<string, ScriptEditorState>>({});
  const activeJobStartedAt = activeJob?.startedAt ?? null;
  const activeJobFinishedAt = activeJob?.finishedAt ?? null;
  const activeJobId = activeJob?.id ?? '';
  const activeJobStatus = activeJob?.status ?? '';

  const loadContext = useCallback(async (shotSetId?: string | null, selectedGroupId?: string | null) => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const sequence = (requestRef.current?.sequence ?? 0) + 1;
    requestRef.current = { sequence, controller };
    setLoading(true);
    try {
      const query = shotSetId ? `?shotSetId=${encodeURIComponent(shotSetId)}` : '';
      const next = await readJson<MixcutContextResponse>(
        await fetch(`/api/projects/${projectId}/final-edit/context${query}`, { signal: controller.signal }),
      );
      if (requestRef.current?.sequence !== sequence) return;
      const [external, groupsResult, providersResult, visionProviders] = await Promise.all([
        next.currentShotSetId
          ? readJson<{ assets: FinalEditExternalAssetView[] }>(
            await fetch(`/api/projects/${projectId}/final-edit/shot-sets/${encodeURIComponent(next.currentShotSetId)}/external-assets`, { signal: controller.signal }),
          )
          : Promise.resolve({ assets: [] }),
        readJson<{ groups: FinalEditGroupView[] }>(await fetch(`/api/projects/${projectId}/final-edit/groups`, { signal: controller.signal })).catch(() => ({ groups: [] })),
        readJson<MixcutTtsProviderView[]>(await fetch('/api/providers/tts', { signal: controller.signal })).catch(() => []),
        readJson<VisionProviderView[]>(await fetch('/api/providers/script', { signal: controller.signal })).catch(() => []),
      ]);
      if (requestRef.current?.sequence !== sequence) return;
      setContext(next);
      setRecentGroups(groupsResult.groups);
      setTtsProviders(providersResult);
      const configuredTts = providersResult.find((provider) => provider.configured) ?? providersResult[0] ?? null;
      setTtsProviderId(configuredTts?.id ?? '');
      setVoice(configuredTts?.voices[0]?.id ?? '');
      setVisionProviderId(visionProviders.find((provider) => provider.configured && provider.supportsVision)?.id ?? '');
      if (next.currentShotSetId) {
        const currentShotSetId = next.currentShotSetId;
        setExternalByShotSet((current) => ({ ...current, [currentShotSetId]: external.assets }));
        const module4Keys = next.videoAssets.map((asset) => `module4:${asset.videoJobId}`);
        const readyExternalKeys = external.assets.filter((asset) => asset.status === 'ready').map((asset) => `external:${asset.id}`);
        const selectedGroup = selectedGroupId
          ? groupsResult.groups.find((group) => group.id === selectedGroupId && group.shotSetId === currentShotSetId)
          : null;
        const latestGroup = selectedGroup ?? groupsResult.groups.find((group) => group.shotSetId === currentShotSetId);
        const editingGroup = groupsResult.groups.find((group) => group.shotSetId === currentShotSetId && group.status === 'editing');
        const latestPreparedGroup = selectedGroupId
          ? isPreviewGroupReady(selectedGroup) ? selectedGroup : null
          : groupsResult.groups.find((group) => group.shotSetId === currentShotSetId && isPreviewGroupReady(group)) || null;
        setPreparedGroup(latestPreparedGroup);
        setDurationReviewGroup(latestGroup?.status === 'needs_input' && latestGroup.phase === 'duration_review' ? latestGroup : null);
        if (latestPreparedGroup?.variants[0]?.outputPreset) setOutputPreset(latestPreparedGroup.variants[0].outputPreset);
        draftGroupRef.current = !selectedGroupId && editingGroup
          ? { id: editingGroup.id, shotSetId: editingGroup.shotSetId, revision: editingGroup.revision }
          : null;
        persistVersionRef.current = 0;
        lastSavedVersionRef.current = 0;
        setPersistVersion(0);
        const persistedSelection = latestGroup?.script?.selectedMaterialKeys.filter((key) => [...module4Keys, ...readyExternalKeys].includes(key)) ?? [];
        setSelectionByShotSet((current) => latestGroup
          ? { [currentShotSetId]: persistedSelection }
          : initializeMaterialSelection(current, currentShotSetId, module4Keys, [...module4Keys, ...readyExternalKeys]));
        const groupScript = latestGroup?.script;
        const visibleDraftIds = new Set(next.shotSets.map((shotSet) => shotSet.id));
        const sourceDraftId = groupScript
          ? groupScript.sourceDraftId ?? MANUAL_SCRIPT_ID
          : next.drafts.find((draft) => isMixcutScriptChoiceVisible(draft, currentShotSetId, visibleDraftIds))?.id ?? MANUAL_SCRIPT_ID;
        const sourceDraft = next.drafts.find((draft) => draft.id === sourceDraftId);
        const importedText = groupScript?.importedNarrationText ?? sourceDraft?.narrationText ?? '';
        const editedText = groupScript ? groupScript.editedNarrationText : importedText;
        const persistedEditor = createScriptEditorState(
          { id: sourceDraftId, narrationText: importedText },
          { editedNarrationText: editedText },
        );
        const cachedEditor = scriptEditorByShotSetRef.current[currentShotSetId];
        const cachedSourceStillExists = cachedEditor?.activeDraftId === MANUAL_SCRIPT_ID || next.drafts.some((draft) => draft.id === cachedEditor?.activeDraftId && isMixcutScriptChoiceVisible(draft, currentShotSetId, visibleDraftIds));
        setScriptEditor(!selectedGroupId && cachedEditor && cachedSourceStillExists ? cachedEditor : persistedEditor);
        setGroupScriptSource(scriptSourceFromGroup(groupScript));
        if (groupScript?.narrationConfig) {
          const persistedProvider = providersResult.find((provider) => provider.id === groupScript.narrationConfig.providerId && provider.configured);
          const selectedProvider = persistedProvider ?? configuredTts;
          setTtsProviderId(selectedProvider?.id ?? '');
          setVoice(selectedProvider?.voices.some((item) => item.id === groupScript.narrationConfig.voice)
            ? groupScript.narrationConfig.voice
            : selectedProvider?.voices[0]?.id ?? '');
          setSpeed(groupScript.narrationConfig.speed);
        }
        const latestPrepare = latestGroup?.jobs.find((job) => job.kind === 'prepare');
        if (latestGroup && latestPrepare) {
          setActiveJob({
            id: latestPrepare.id,
            groupId: latestGroup.id,
            status: latestPrepare.status,
            phase: latestPrepare.phase,
            progress: latestPrepare.progress,
            startedAt: latestPrepare.startedAt ?? null,
            finishedAt: latestPrepare.finishedAt ?? null,
            errorMessage: latestPrepare.errorMessage,
          });
          if (['queued', 'running', 'needs_input'].includes(latestPrepare.status)) setActiveStep(1);
        } else setActiveJob(null);
        if (selectedGroupId) setActiveStep(latestPreparedGroup ? 2 : 1);
      }
      setMessage('');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestRef.current?.sequence === sequence) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestRef.current?.sequence === sequence) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadContext(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.controller.abort();
    };
  }, [loadContext]);

  useEffect(() => {
    if (!activeJobId || !['queued', 'running'].includes(activeJobStatus)) return;
    const token = Symbol(activeJobId);
    jobPollRef.current = token;
    const poll = async () => {
      try {
        const job = await readJson<MixcutPrepareJobView>(await fetch(`/api/final-edit-jobs/${activeJobId}`));
        if (jobPollRef.current !== token) return;
        if (isLegacyDurationReviewJob(job)) {
          const reviewGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${job.groupId}`));
          if (jobPollRef.current !== token) return;
          setActiveJob(job);
          setDurationReviewGroup(reviewGroup);
          setPreparedGroup(null);
          setMessage('检测到旧版时长审核任务，正在按实际时长自动继续');
        } else if (job.status === 'succeeded') {
          const completedGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${job.groupId}`));
          if (jobPollRef.current !== token) return;
          setActiveJob(job);
          setPreparedGroup(completedGroup);
          setRecentGroups((current) => [completedGroup, ...current.filter((group) => group.id !== completedGroup.id)]);
          setDurationReviewGroup(null);
          setMessage('智能创作任务已完成，可以进入预览调整');
        } else {
          setActiveJob(job);
          if (job.status === 'failed') setMessage(job.errorMessage || '智能创作任务失败');
        }
      } catch (error) {
        if (jobPollRef.current === token) setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    const immediate = window.setTimeout(() => void poll(), 0);
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      jobPollRef.current = null;
      window.clearTimeout(immediate);
      window.clearInterval(timer);
    };
  }, [activeJobId, activeJobStatus]);

  useEffect(() => {
    if (!activeJobId || !isLegacyDurationReviewJob(activeJob) || activeJob?.durationReview) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const job = await readJson<MixcutPrepareJobView>(await fetch(`/api/final-edit-jobs/${activeJobId}`, { signal: controller.signal }));
        if (!controller.signal.aborted) setActiveJob((current) => current?.id === job.id ? { ...job, groupId: current.groupId } : current);
      })().catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setMessage(error instanceof Error ? error.message : String(error));
      });
    }, 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [activeJob, activeJobId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const start = activeJobStartedAt ? new Date(activeJobStartedAt).getTime() : 0;
      setElapsedSec(start > 0 ? Math.max(0, Math.floor(((activeJobFinishedAt ? new Date(activeJobFinishedAt).getTime() : Date.now()) - start) / 1000)) : 0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeJobStartedAt, activeJobFinishedAt]);

  const refreshExternalAssets = useCallback(async (shotSetId: string) => {
    const refreshed = await readJson<{ assets: FinalEditExternalAssetView[] }>(
      await fetch(`/api/projects/${projectId}/final-edit/shot-sets/${encodeURIComponent(shotSetId)}/external-assets`),
    );
    setExternalByShotSet((current) => ({ ...current, [shotSetId]: refreshed.assets }));
  }, [projectId]);

  const activeShotSetId = context?.currentShotSetId ?? null;
  const activeShotSet = context?.shotSets.find((shotSet) => shotSet.id === activeShotSetId) ?? null;
  const selectedIds = materialSelectionForShotSet(selectionByShotSet, activeShotSetId);
  const externalAssets = activeShotSetId ? externalByShotSet[activeShotSetId] ?? [] : [];
  // 左辅栏「当前步骤概览」与「最近会话」（PRD §6 信息架构）
  const stepOverviews = [
    { label: STEPS[0].label, detail: activeShotSet ? `${activeShotSet.name} · 已选 ${selectedIds.length} 条素材` : '请先选择分镜组' },
    { label: STEPS[1].label, detail: ['queued', 'running'].includes(activeJobStatus) ? `任务${activeJobStatus === 'running' ? '运行中' : '排队中'} ${Math.round((activeJob?.progress ?? 0) * 100)}%` : scriptEditor.editedNarrationText.trim() ? `文案 ${scriptEditor.editedNarrationText.trim().length} 字` : '待选择脚本或填写文案' },
    { label: STEPS[2].label, detail: preparedGroup ? `${preparedGroup.variants.length} 条时间线草稿` : '等待 AI 创作完成' },
    { label: STEPS[3].label, detail: preparedGroup ? '可预检并导出' : '等待 AI 创作完成' },
  ];
  const versionGroups = recentGroups
    .filter((group) => group.shotSetId === activeShotSetId && group.status !== 'editing')
    .sort((left, right) => prepareCreatedAt(right).localeCompare(prepareCreatedAt(left)));
  const sessions = versionGroups.map((group, index) => ({
    id: group.id,
    title: group.script?.title || '未命名会话',
    versionLabel: `版本 ${versionGroups.length - index}`,
    shotSetName: context?.shotSets.find((shotSet) => shotSet.id === group.shotSetId)?.name || group.shotSetId,
    status: group.status,
    variantCount: group.variants.length,
    speed: group.script.narrationConfig.speed,
    createdAt: prepareCreatedAt(group),
  }));
  const materials: MaterialCardView[] = [
    ...(context?.videoAssets ?? []).map((asset) => ({
      key: `module4:${asset.videoJobId}`,
      // MaterialCardView.filename 只做展示：module4 素材优先用友好名称（D5），
      // 播放/预览 URL 继续走 previewUrl（物理 filename），不受影响。
      filename: asset.displayName || asset.filename,
      durationUs: asset.durationUs,
      width: asset.width,
      height: asset.height,
      thumbnailUrl: asset.thumbnailUrl,
      previewUrl: asset.previewUrl,
      summary: asset.summary,
      source: 'module4' as const,
      status: 'ready' as const,
    })),
    ...externalAssets.map((asset) => ({
      key: `external:${asset.id}`,
      filename: asset.originalFilename,
      durationUs: asset.durationUs,
      width: asset.width,
      height: asset.height,
      thumbnailUrl: asset.thumbnailUrl,
      previewUrl: asset.previewUrl,
      summary: '',
      source: 'external' as const,
      status: asset.status,
      errorMessage: asset.errorMessage,
    })),
  ];

  const performShotSetSwitch = (shotSetId: string) => {
    persistenceEpochRef.current += 1;
    saveAbortRef.current?.abort();
    draftGroupRef.current = null;
    persistVersionRef.current = 0;
    lastSavedVersionRef.current = 0;
    setPersistVersion(0);
    setSelectionByShotSet({});
    setActiveStep(0);
    setPendingDraftId(null);
    setPendingSyncDraftId(null);
    setPendingShotSetId(null);
    setActiveJob(null);
    setDurationReviewGroup(null);
    setPreparedGroup(null);
    void loadContext(shotSetId);
  };

  const selectShotSet = (shotSetId: string) => {
    if (!shotSetId || shotSetId === activeShotSetId) return;
    if (submittingRef.current) return;
    if (persistVersionRef.current > lastSavedVersionRef.current) {
      setPendingShotSetId(shotSetId);
      return;
    }
    performShotSetSwitch(shotSetId);
  };

  const selectSession = async (groupId: string) => {
    const group = recentGroups.find((item) => item.id === groupId);
    if (!group || submittingRef.current || group.id === preparedGroup?.id) return;
    try {
      if (persistVersionRef.current > lastSavedVersionRef.current) await persistCurrentState(persistVersionRef.current);
      persistenceEpochRef.current += 1;
      saveAbortRef.current?.abort();
      setPendingDraftId(null);
      setPendingSyncDraftId(null);
      setPendingShotSetId(null);
      setDurationReviewGroup(null);
      setPreparedGroup(null);
      await loadContext(group.shotSetId, group.id);
    } catch { /* persistCurrentState/loadContext expose the actionable error */ }
  };

  const resolveShotSetSwitch = async (resolution: ScriptSwitchResolution) => {
    const targetShotSetId = pendingShotSetId;
    if (!targetShotSetId) return;
    if (resolution === 'cancel') { setPendingShotSetId(null); return; }
    if (resolution === 'preserve' && persistVersionRef.current > lastSavedVersionRef.current) {
      try { await persistCurrentState(persistVersionRef.current); }
      catch { return; }
    }
    setPendingShotSetId(null);
    if (activeShotSetId) {
      if (resolution === 'preserve') scriptEditorByShotSetRef.current[activeShotSetId] = markScriptSaved(scriptEditor);
      else delete scriptEditorByShotSetRef.current[activeShotSetId];
    }
    performShotSetSwitch(targetShotSetId);
  };

  const toggleMaterial = (materialKey: string) => {
    if (!activeShotSetId) return;
    setSelectionByShotSet((current) => toggleMaterialSelection(current, activeShotSetId, materialKey));
    markPersistenceDirty();
  };

  const importFiles = async (files: File[]) => {
    const targetShotSetId = activeShotSetId;
    if (!targetShotSetId || files.length === 0) return;
    const targetShotSetName = activeShotSet?.name || targetShotSetId;
    setUploadingShotSetIds((current) => current.includes(targetShotSetId) ? current : [...current, targetShotSetId]);
    let importMessage = '';
    try {
      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      const result = await readJson<{ assets: FinalEditExternalAssetView[]; errors: Array<{ filename: string; message: string }> }>(
        await fetch(`/api/projects/${projectId}/final-edit/shot-sets/${encodeURIComponent(targetShotSetId)}/external-assets`, { method: 'POST', body: formData }),
      );
      importMessage = result.errors.length > 0
        ? `已向「${targetShotSetName}」导入 ${result.assets.length} 个视频；${result.errors.map((item) => `${item.filename}：${item.message}`).join('；')}`
        : `已向「${targetShotSetName}」导入 ${result.assets.length} 个视频`;
    } catch (error) {
      importMessage = `「${targetShotSetName}」导入失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      try {
        await refreshExternalAssets(targetShotSetId);
      } catch (error) {
        const refreshMessage = error instanceof Error ? error.message : String(error);
        importMessage = `${importMessage}；刷新导入记录失败：${refreshMessage}`;
      }
      setMessage(importMessage);
      setUploadingShotSetIds((current) => current.filter((shotSetId) => shotSetId !== targetShotSetId));
    }
  };

  const validShotSetIds = useMemo(() => new Set((context?.shotSets ?? []).map((shotSet) => shotSet.id)), [context?.shotSets]);
  const activeDrafts = useMemo(
    () => (context?.drafts ?? []).filter((draft) => isMixcutScriptChoiceVisible(draft, activeShotSetId, validShotSetIds)),
    [context?.drafts, activeShotSetId, validShotSetIds],
  );
  const pendingDraft = activeDrafts.find((draft) => draft.id === pendingDraftId) ?? null;
  const pendingSyncDraft = activeDrafts.find((draft) => draft.id === pendingSyncDraftId) ?? null;
  const activeProvider = ttsProviders.find((provider) => provider.id === ttsProviderId) ?? null;
  // 源脚本新版本提示：已有混剪的快照 revision 落后于当前可选脚本 revision 时，
  // 提供显式「同步最新版本」入口；刷新/切组绝不静默覆盖用户文案。
  const sourceScriptUpdate = groupScriptSource
    && groupScriptSource.draftId === scriptEditor.activeDraftId
    && groupScriptSource.draftId !== MANUAL_SCRIPT_ID
    && activeDrafts.some((draft) => draft.id === groupScriptSource.draftId && hasNewerScriptRevision(groupScriptSource, draft))
    ? activeDrafts.find((draft) => draft.id === groupScriptSource.draftId) ?? null
    : null;

  const markPersistenceDirty = useCallback(() => {
    const version = persistVersionRef.current + 1;
    persistVersionRef.current = version;
    setPersistVersion(version);
  }, []);

  const persistCurrentState = useCallback((version: number): Promise<void> => {
    const shotSetId = activeShotSetId;
    if (!shotSetId || !ttsProviderId || !voice || version <= lastSavedVersionRef.current) return Promise.resolve();
    const epoch = persistenceEpochRef.current;
    const snapshot = {
      shotSetId,
      scriptDraftId: scriptEditor.activeDraftId === MANUAL_SCRIPT_ID ? '' : scriptEditor.activeDraftId,
      editedNarrationText: scriptEditor.editedNarrationText,
      selectedMaterialKeys: [...selectedIds],
      providerId: ttsProviderId,
      voice,
      speed,
      analysisProviderId: visionProviderId,
    };
    const save = async () => {
      if (persistenceEpochRef.current !== epoch) return;
      const controller = new AbortController();
      saveAbortRef.current = controller;
      try {
        const currentGroup = draftGroupRef.current?.shotSetId === shotSetId ? draftGroupRef.current : null;
        let view: FinalEditGroupView;
        if (currentGroup) {
          const result = await readJson<{ view: FinalEditGroupView }>(await fetch(`/api/final-edit-groups/${currentGroup.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            keepalive: true,
            body: JSON.stringify({
              type: 'set_mixcut_script_state',
              expectedRevision: currentGroup.revision,
              ...snapshot,
            }),
          }));
          view = result.view;
        } else {
          view = await readJson<FinalEditGroupView>(await fetch(`/api/projects/${projectId}/final-edit/draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            keepalive: true,
            body: JSON.stringify(snapshot),
          }));
        }
        if (persistenceEpochRef.current !== epoch) return;
        draftGroupRef.current = { id: view.id, shotSetId: view.shotSetId, revision: view.revision };
        setGroupScriptSource(scriptSourceFromGroup(view.script));
        if (version === persistVersionRef.current) {
          lastSavedVersionRef.current = version;
          setScriptEditor((current) => current.editedNarrationText === snapshot.editedNarrationText
            && current.activeDraftId === (snapshot.scriptDraftId || MANUAL_SCRIPT_ID)
            ? markScriptSaved(current)
            : current);
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (!aborted && persistenceEpochRef.current === epoch) setMessage(`自动保存失败：${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        if (saveAbortRef.current === controller) saveAbortRef.current = null;
      }
    };
    const queued = saveQueueRef.current.then(save, save);
    saveQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, [activeShotSetId, projectId, scriptEditor.activeDraftId, scriptEditor.editedNarrationText, selectedIds, speed, ttsProviderId, visionProviderId, voice]);

  useEffect(() => {
    if (persistVersion <= lastSavedVersionRef.current) return;
    const timer = window.setTimeout(() => void persistCurrentState(persistVersion).catch(() => undefined), 600);
    return () => window.clearTimeout(timer);
  }, [persistCurrentState, persistVersion]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (persistVersionRef.current <= lastSavedVersionRef.current) return;
      void persistCurrentState(persistVersionRef.current).catch(() => undefined);
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [persistCurrentState]);

  const refreshWorkspace = async () => {
    try {
      if (persistVersionRef.current > lastSavedVersionRef.current) await persistCurrentState(persistVersionRef.current);
      await loadContext(activeShotSetId);
    } catch { /* persistCurrentState already exposes the actionable error */ }
  };

  const requestDraftChange = (draftId: string) => {
    if (draftId === scriptEditor.activeDraftId) return;
    const target = activeDrafts.find((draft) => draft.id === draftId);
    if (!target) return;
    if (scriptEditor.dirty) setPendingDraftId(draftId);
    else {
      setScriptEditor((current) => resolveScriptSwitch(current, { id: target.id, narrationText: target.narrationText }, 'preserve'));
      markPersistenceDirty();
    }
  };

  const resolveDraftChange = async (resolution: ScriptSwitchResolution) => {
    const target = activeDrafts.find((draft) => draft.id === pendingDraftId);
    if (!target || resolution === 'cancel') { setPendingDraftId(null); return; }
    if (resolution === 'preserve' && scriptEditor.dirty) {
      try { await persistCurrentState(persistVersionRef.current); }
      catch { return; }
    } else if (resolution === 'discard') {
      persistenceEpochRef.current += 1;
      saveAbortRef.current?.abort();
    }
    setPendingDraftId(null);
    setScriptEditor((current) => resolveScriptSwitch(current, { id: target.id, narrationText: target.narrationText }, resolution));
    markPersistenceDirty();
  };

  const requestSourceScriptSync = () => {
    if (!sourceScriptUpdate || submittingRef.current) return;
    if (scriptEditor.modified) {
      setPendingSyncDraftId(sourceScriptUpdate.id);
      return;
    }
    setScriptEditor((current) => syncScriptToRevision(current, { id: sourceScriptUpdate.id, narrationText: sourceScriptUpdate.narrationText }, 'discard'));
    markPersistenceDirty();
  };

  const resolveSourceScriptSync = (resolution: ScriptSwitchResolution) => {
    const target = activeDrafts.find((draft) => draft.id === pendingSyncDraftId);
    if (!target || resolution === 'cancel') { setPendingSyncDraftId(null); return; }
    if (resolution === 'discard') {
      persistenceEpochRef.current += 1;
      saveAbortRef.current?.abort();
    }
    setPendingSyncDraftId(null);
    setScriptEditor((current) => syncScriptToRevision(current, { id: target.id, narrationText: target.narrationText }, resolution));
    markPersistenceDirty();
  };

  const changeTtsProvider = (providerId: string) => {
    const provider = ttsProviders.find((item) => item.id === providerId);
    setTtsProviderId(providerId);
    setVoice((current) => provider?.voices.some((item) => item.id === current) ? current : provider?.voices[0]?.id ?? '');
    markPersistenceDirty();
  };

  const previewVoice = async () => {
    if (!ttsProviderId || !voice) return;
    setPreviewingVoice(true);
    try {
      const response = await fetch(`/api/providers/tts/${encodeURIComponent(ttsProviderId)}/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, speed }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || '音色试听失败');
      }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      const release = () => URL.revokeObjectURL(url);
      audio.addEventListener('ended', release, { once: true });
      audio.addEventListener('error', release, { once: true });
      await audio.play();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setPreviewingVoice(false); }
  };

  const startCreation = async () => {
    const requestShotSetId = activeShotSetId;
    const requestProviderId = ttsProviderId;
    const requestVoice = voice;
    const requestSpeed = speed;
    const requestScriptDraftId = scriptEditor.activeDraftId === MANUAL_SCRIPT_ID ? '' : scriptEditor.activeDraftId;
    const requestNarrationText = scriptEditor.editedNarrationText;
    const requestMaterialKeys = selectedIds;
    const requestOutputPreset = outputPreset;
    if (!requestShotSetId || !requestProviderId || !requestVoice || submittingRef.current) return;
    startRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const sequence = startSequenceRef.current + 1;
    startSequenceRef.current = sequence;
    startRequestRef.current = { sequence, shotSetId: requestShotSetId, controller };
    submittingRef.current = true;
    setSubmitting(true);
    setMessage('');
    try {
      if (persistVersionRef.current > lastSavedVersionRef.current) await persistCurrentState(persistVersionRef.current);
      const jobRef = await readJson<{ id: string; groupId: string; status: string }>(await fetch(`/api/projects/${projectId}/final-edit/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          shotSetId: requestShotSetId,
          scriptDraftId: requestScriptDraftId,
          editedNarrationText: requestNarrationText,
          selectedMaterialKeys: requestMaterialKeys,
          count: 1,
          outputPreset: requestOutputPreset,
          providerId: requestProviderId,
          voice: requestVoice,
          speed: requestSpeed,
          analysisProviderId: visionProviderId,
          draftGroupId: draftGroupRef.current?.shotSetId === requestShotSetId ? draftGroupRef.current.id : undefined,
        }),
      }));
      const job = await readJson<Omit<MixcutPrepareJobView, 'groupId'>>(await fetch(`/api/final-edit-jobs/${jobRef.id}`, { signal: controller.signal }));
      if (startRequestRef.current?.sequence !== sequence || startRequestRef.current.shotSetId !== requestShotSetId) return;
      setActiveJob({ ...job, groupId: jobRef.groupId });
      setPreparedGroup(null);
      if (isLegacyDurationReviewJob(job)) {
        const reviewGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${jobRef.groupId}`, { signal: controller.signal }));
        setDurationReviewGroup(reviewGroup);
        setMessage('正在按实际时长自动继续');
      } else {
        setDurationReviewGroup(null);
        setMessage('后台任务已创建，可以离开页面后再返回查看');
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && startRequestRef.current?.sequence === sequence) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (startRequestRef.current?.sequence === sequence) {
        startRequestRef.current = null;
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const syncResolvedGroupScript = useCallback((group: FinalEditGroupView) => {
    const resolvedEditor = createScriptEditorState(
      { id: group.script.sourceDraftId ?? MANUAL_SCRIPT_ID, narrationText: group.script.importedNarrationText },
      { editedNarrationText: group.script.editedNarrationText },
    );
    scriptEditorByShotSetRef.current[group.shotSetId] = resolvedEditor;
    setScriptEditor(resolvedEditor);
    setGroupScriptSource(scriptSourceFromGroup(group.script));
    setTtsProviderId(group.script.narrationConfig.providerId);
    setVoice(group.script.narrationConfig.voice);
    setSpeed(group.script.narrationConfig.speed);
  }, []);

  const continueLegacyDurationReview = useCallback(async () => {
    if (!isLegacyDurationReviewJob(activeJob) || !durationReviewGroup || submittingRef.current) return;
    const recoveryKey = `${activeJob.id}:${durationReviewGroup.id}:${durationReviewGroup.revision}`;
    if (durationAutoContinueRef.current === recoveryKey) return;
    durationAutoContinueRef.current = recoveryKey;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage('检测到旧版时长审核任务，正在按实际时长自动继续');
    try {
      const jobRef = await readJson<{ id: string; groupId: string; status: string }>(await fetch(`/api/final-edit-groups/${encodeURIComponent(durationReviewGroup.id)}/duration-resolution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: durationReviewGroup.revision,
          action: 'accept_actual',
        }),
      }));
      const job = await readJson<Omit<MixcutPrepareJobView, 'groupId'>>(await fetch(`/api/final-edit-jobs/${jobRef.id}`));
      setActiveJob({ ...job, groupId: jobRef.groupId });
      setDurationReviewGroup(null);
      if (isLegacyDurationReviewJob(job)) {
        const reviewGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${jobRef.groupId}`));
        syncResolvedGroupScript(reviewGroup);
        setDurationReviewGroup(reviewGroup);
        setPreparedGroup(null);
        durationAutoContinueRef.current = '';
        setMessage('旧版时长审核任务尚未恢复，请刷新后重试');
      } else if (job.status === 'succeeded') {
        const completedGroup = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${jobRef.groupId}`));
        syncResolvedGroupScript(completedGroup);
        setPreparedGroup(completedGroup);
        setRecentGroups((current) => [completedGroup, ...current.filter((group) => group.id !== completedGroup.id)]);
        setMessage('实际口播时长已记录，智能创作已继续完成');
      } else {
        setPreparedGroup(null);
        setMessage('实际口播时长已记录，任务正在继续处理');
      }
    } catch (error) {
      durationAutoContinueRef.current = '';
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [activeJob, durationReviewGroup, syncResolvedGroupScript]);

  useEffect(() => {
    if (!isLegacyDurationReviewJob(activeJob) || !durationReviewGroup) return;
    const timeoutId = window.setTimeout(() => {
      void continueLegacyDurationReview();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [activeJob, continueLegacyDurationReview, durationReviewGroup]);

  const startDisabledReason = !selectedIds.length
    ? '请先选择至少一个可用素材'
    : !scriptEditor.editedNarrationText.trim()
      ? '请先输入口播文案'
      : !activeProvider?.configured
        ? '请先配置口播配音供应商'
        : !visionProviderId
          ? '请先配置支持图像理解的脚本供应商'
          : undefined;

  return (
    <MixcutShell
      steps={STEPS}
      activeStep={activeStep}
      onStepSelect={(index) => setActiveStep(index as 0 | 1 | 2 | 3)}
      stepDisabled={(index) => (index === 1 && selectedIds.length === 0) || (index >= 2 && !preparedGroup)}
      stepsAriaLabel="智能混剪步骤"
      topbarLeft={(
        <div className={styles.projectContext}>
          <small>{projectInfo.productName || projectName}</small>
          <b>{projectInfo.name || projectName}</b>
        </div>
      )}
      topbarRight={(
        <>
          <button type="button" className={`${styles.btn} ${styles.small}`} onClick={() => setProjectInfoOpen(true)}>
            <Icon name="settings" size={14} />项目信息
          </button>
          <span className={styles.segLabel}>画幅</span>
          <span className={styles.seg} role="group" aria-label="全局画幅">
            {(['3x4', '9x16'] as const).map((preset) => (
              <button type="button" key={preset} className={outputPreset === preset ? styles.segOn : ''} disabled={submitting || ['queued', 'running'].includes(activeJobStatus)} onClick={() => setOutputPreset(preset)}>{preset.replace('x', ':')}</button>
            ))}
          </span>
        </>
      )}
      sidebar={(
        <MixcutSidebar
          shotSets={context?.shotSets ?? []}
          activeShotSetId={activeShotSetId}
          selectedCount={selectedIds.length}
          availableVideoCount={materials.filter((material) => material.status === 'ready').length}
          stepOverview={stepOverviews[activeStep]}
          sessions={sessions}
          activeSessionId={preparedGroup?.id ?? activeJob?.groupId ?? null}
          onSelectSession={(groupId) => void selectSession(groupId)}
          onSelectShotSet={selectShotSet}
          disabled={loading || submitting}
        />
      )}
      previewActive={activeStep === 2 && Boolean(preparedGroup)}
      dataAttributes={{ 'data-mixcut-shot-set-id': activeShotSetId ?? '' }}
      main={(controls) => (
        activeStep === 2 ? (
          preparedGroup ? (
            <PreviewStep
              group={preparedGroup}
              active
              onGroupChange={setPreparedGroup}
              onExport={(variantId) => { setExportVariantId(variantId); setActiveStep(3); }}
              onRepCollapse={controls.onRepCollapse}
              onRgtCollapse={controls.onRgtCollapse}
              onResizeStart={controls.onResizeStart}
            />
          ) : (
            <main className={styles.mainCol}>
              {message && <div className={styles.errorBanner}><Icon name="alert" size={15} />{message}</div>}
              <div className={styles.emptyState}><strong>预览草稿尚未准备完成</strong><span>完成四阶段智能创作后，第三步会自动开放。</span></div>
            </main>
          )
        ) : (
          <main className={styles.mainCol}>
            {message && <div className={styles.errorBanner}><Icon name="alert" size={15} />{message}</div>}
            {!context && loading ? (
              <div className={styles.loadingState}><span /><strong>正在读取真实分镜组和视频…</strong></div>
            ) : (
              <>
                <div className={activeStep === 0 ? styles.stepWrap : styles.stepHidden}>
                  <MaterialStep
                    shotSetName={activeShotSet?.name ?? ''}
                    materials={materials}
                    selectedMaterialKeys={selectedIds}
                    onToggle={toggleMaterial}
                    onSelectAll={() => {
                      if (!activeShotSetId) return;
                      setSelectionByShotSet({ [activeShotSetId]: materials.filter((material) => material.status === 'ready').map((material) => material.key) });
                      markPersistenceDirty();
                    }}
                    onRefresh={() => void refreshWorkspace()}
                    onImportFiles={activeShotSetId ? importFiles : undefined}
                    onContinue={() => setActiveStep(1)}
                    importDisabledReason={activeShotSetId ? undefined : '请先选择一个分镜组'}
                    loading={loading || Boolean(activeShotSetId && uploadingShotSetIds.includes(activeShotSetId))}
                  />
                </div>
                <div className={activeStep === 1 ? styles.stepWrap : styles.stepHidden}>
                  <CreationStep
                    drafts={activeDrafts}
                    activeDraftId={scriptEditor.activeDraftId}
                    editedNarrationText={scriptEditor.editedNarrationText}
                    importedNarrationText={scriptEditor.importedNarrationText}
                    dirty={scriptEditor.dirty}
                    modified={scriptEditor.modified}
                    pendingDraft={pendingDraft}
                    sourceScriptUpdate={sourceScriptUpdate}
                    pendingSyncDraft={pendingSyncDraft}
                    onRequestSourceSync={requestSourceScriptSync}
                    onResolveSourceSync={resolveSourceScriptSync}
                    onDraftChange={requestDraftChange}
                    onResolveDraftSwitch={(resolution) => void resolveDraftChange(resolution)}
                    onTextChange={(text) => {
                      setScriptEditor((current) => editActiveScript(current, text));
                      markPersistenceDirty();
                    }}
                    onRestoreImported={() => {
                      const draft = activeDrafts.find((item) => item.id === scriptEditor.activeDraftId);
                      if (draft) {
                        setScriptEditor((current) => restoreImportedScript(current, { id: draft.id, narrationText: draft.narrationText }));
                        markPersistenceDirty();
                      }
                    }}
                    providers={ttsProviders}
                    providerId={ttsProviderId}
                    voice={voice}
                    speed={speed}
                    onProviderChange={changeTtsProvider}
                    onVoiceChange={(nextVoice) => { setVoice(nextVoice); markPersistenceDirty(); }}
                    onSpeedChange={(nextSpeed) => { setSpeed(nextSpeed); markPersistenceDirty(); }}
                    onPreviewVoice={() => void previewVoice()}
                    previewingVoice={previewingVoice}
                    selectedMaterialCount={selectedIds.length}
                    job={activeJob}
                    elapsedSec={elapsedSec}
                    onStart={() => void startCreation()}
                    onBack={() => setActiveStep(0)}
                    submitting={submitting}
                    startDisabledReason={startDisabledReason}
                    previewReady={isPreviewGroupReady(preparedGroup)}
                    onPreview={() => setActiveStep(2)}
                  />
                </div>
                <div className={activeStep === 3 ? styles.stepWrap : styles.stepHidden}>
                  {preparedGroup && context
                    ? (
                      <ExportStep
                        key={`${preparedGroup.id}:${exportVariantId}`}
                        project={{ ...context.project, ...projectInfo }}
                        group={preparedGroup}
                        initialVariantId={exportVariantId}
                        active={activeStep === 3}
                        onGroupChange={setPreparedGroup}
                        onBack={() => setActiveStep(2)}
                        onProjectInfoChange={onProjectInfoChange}
                      />
                    )
                    : <div className={styles.emptyState}><strong>还没有可导出的成片草稿</strong><span>完成智能创作并检查预览后再导出。</span></div>}
                </div>
              </>
            )}
          </main>
        )
      )}
    >
      <ProjectInfoDialog
        open={projectInfoOpen}
        project={projectInfo}
        intent="edit"
        onClose={() => setProjectInfoOpen(false)}
        onSaved={onProjectInfoChange}
      />
      {pendingShotSetId && (
        <div className={styles.switchDialogBackdrop} role="presentation">
          <div className={styles.switchDialog} role="dialog" aria-modal="true" aria-labelledby="mixcut-shot-set-switch-title">
            <h2 id="mixcut-shot-set-switch-title">当前分镜组有未保存的创作设置</h2>
            <p>切换到「{context?.shotSets.find((shotSet) => shotSet.id === pendingShotSetId)?.name || '其他分镜组'}」前，请选择如何处理当前文案、素材和音色设置。</p>
            <div>
              <button type="button" className={styles.primaryButton} onClick={() => void resolveShotSetSwitch('preserve')}>保留修改并切换</button>
              <button type="button" className={styles.secondaryButton} onClick={() => void resolveShotSetSwitch('discard')}>放弃修改并切换</button>
              <button type="button" className={styles.textButton} onClick={() => void resolveShotSetSwitch('cancel')}>取消</button>
            </div>
          </div>
        </div>
      )}
    </MixcutShell>
  );
}
