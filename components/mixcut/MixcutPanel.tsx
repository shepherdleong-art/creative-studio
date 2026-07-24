'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  createScriptEditorState,
  editActiveScript,
  markScriptSaved,
  resolveScriptSwitch,
  restoreImportedScript,
  type ScriptEditorState,
  type ScriptSwitchResolution,
} from '@/lib/final-edit/mixcut-creation-state';
import {
  initializeMaterialSelection,
  materialSelectionForShotSet,
  toggleMaterialSelection,
  type MaterialSelectionByShotSet,
} from '@/lib/final-edit/material-selection';
import type { FinalEditExternalAssetView, FinalEditGroupView, MixcutContextResponse } from '@/lib/final-edit/types';
import { CreationStep, type MixcutPrepareJobView, type MixcutTtsProviderView } from './CreationStep';
import { MaterialStep, type MaterialCardView } from './MaterialStep';
import { MixcutSidebar } from './MixcutSidebar';
import styles from './MixcutPanel.module.css';

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

const STEPS = [
  { label: '导入素材', hint: '选择当前分镜组', icon: 'folder' as const, enabled: true },
  { label: 'AI 智能创作', hint: '脚本·音色·真实进度', icon: 'sparkle' as const, enabled: true },
  { label: '预览调整', hint: 'Phase 4 接入', icon: 'play' as const, enabled: false },
  { label: '导出渲染', hint: 'Phase 6 接入', icon: 'download' as const, enabled: false },
];

interface VisionProviderView { id: string; configured: boolean; supportsVision?: boolean }
interface MixcutDraftRef { id: string; shotSetId: string; revision: number }

const MANUAL_SCRIPT_ID = '__manual__';

export default function MixcutPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [context, setContext] = useState<MixcutContextResponse | null>(null);
  const [activeStep, setActiveStep] = useState<0 | 1>(0);
  const [selectionByShotSet, setSelectionByShotSet] = useState<MaterialSelectionByShotSet>({});
  const [externalByShotSet, setExternalByShotSet] = useState<Record<string, FinalEditExternalAssetView[]>>({});
  const [scriptEditor, setScriptEditor] = useState<ScriptEditorState>(() => createScriptEditorState({ id: MANUAL_SCRIPT_ID, narrationText: '' }));
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);
  const [pendingShotSetId, setPendingShotSetId] = useState<string | null>(null);
  const [ttsProviders, setTtsProviders] = useState<MixcutTtsProviderView[]>([]);
  const [ttsProviderId, setTtsProviderId] = useState('');
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [visionProviderId, setVisionProviderId] = useState('');
  const [activeJob, setActiveJob] = useState<MixcutPrepareJobView | null>(null);
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

  const loadContext = useCallback(async (shotSetId?: string | null) => {
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
        const latestGroup = groupsResult.groups.find((group) => group.shotSetId === currentShotSetId);
        const editingGroup = groupsResult.groups.find((group) => group.shotSetId === currentShotSetId && group.status === 'editing');
        draftGroupRef.current = editingGroup
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
        const sourceDraftId = groupScript
          ? groupScript.sourceDraftId ?? MANUAL_SCRIPT_ID
          : next.drafts.find((draft) => draft.shotSetId === currentShotSetId)?.id ?? MANUAL_SCRIPT_ID;
        const sourceDraft = next.drafts.find((draft) => draft.id === sourceDraftId);
        const importedText = groupScript?.importedNarrationText ?? sourceDraft?.narrationText ?? '';
        const editedText = groupScript ? groupScript.editedNarrationText : importedText;
        const persistedEditor = createScriptEditorState(
          { id: sourceDraftId, narrationText: importedText },
          { editedNarrationText: editedText },
        );
        const cachedEditor = scriptEditorByShotSetRef.current[currentShotSetId];
        const cachedSourceStillExists = cachedEditor?.activeDraftId === MANUAL_SCRIPT_ID || next.drafts.some((draft) => draft.id === cachedEditor?.activeDraftId && draft.shotSetId === currentShotSetId);
        setScriptEditor(cachedEditor && cachedSourceStillExists ? cachedEditor : persistedEditor);
        if (groupScript?.narrationConfig) {
          setTtsProviderId(groupScript.narrationConfig.providerId);
          setVoice(groupScript.narrationConfig.voice);
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
          if (['queued', 'running'].includes(latestPrepare.status)) setActiveStep(1);
        } else setActiveJob(null);
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
        setActiveJob(job);
        if (job.status === 'failed') setMessage(job.errorMessage || '智能创作任务失败');
        if (job.status === 'succeeded') setMessage('智能创作任务已完成，脚本与进度已保存');
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
  const materials: MaterialCardView[] = [
    ...(context?.videoAssets ?? []).map((asset) => ({
      key: `module4:${asset.videoJobId}`,
      filename: asset.filename,
      durationUs: asset.durationUs,
      width: asset.width,
      height: asset.height,
      thumbnailUrl: asset.thumbnailUrl,
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
    setPendingShotSetId(null);
    setActiveJob(null);
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

  const activeDrafts = (context?.drafts ?? []).filter((draft) => draft.shotSetId === activeShotSetId);
  const pendingDraft = activeDrafts.find((draft) => draft.id === pendingDraftId) ?? null;
  const activeProvider = ttsProviders.find((provider) => provider.id === ttsProviderId) ?? null;

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
    if (!activeShotSetId || !ttsProviderId || !voice || submittingRef.current) return;
    startRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const sequence = startSequenceRef.current + 1;
    startSequenceRef.current = sequence;
    const requestShotSetId = activeShotSetId;
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
          scriptDraftId: scriptEditor.activeDraftId === MANUAL_SCRIPT_ID ? '' : scriptEditor.activeDraftId,
          editedNarrationText: scriptEditor.editedNarrationText,
          selectedMaterialKeys: selectedIds,
          count: 1,
          outputPreset: '3x4',
          providerId: ttsProviderId,
          voice,
          speed,
          analysisProviderId: visionProviderId,
          draftGroupId: draftGroupRef.current?.shotSetId === requestShotSetId ? draftGroupRef.current.id : undefined,
        }),
      }));
      const job = await readJson<Omit<MixcutPrepareJobView, 'groupId'>>(await fetch(`/api/final-edit-jobs/${jobRef.id}`, { signal: controller.signal }));
      if (startRequestRef.current?.sequence !== sequence || startRequestRef.current.shotSetId !== requestShotSetId) return;
      setActiveJob({ ...job, groupId: jobRef.groupId });
      setMessage('后台任务已创建，可以离开页面后再返回查看');
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
    <div className={styles.shell} data-mixcut-shot-set-id={activeShotSetId ?? ''}>
      <header className={styles.topbar}>
        <div>
          <span className={styles.brandMark}>CS</span>
          <span><strong>智能混剪</strong><small>Creative Studio · V1</small></span>
        </div>
        <div className={styles.projectContext}>
          <small>{context?.project.productName || projectName}</small>
          <strong>{context?.project.name || projectName}</strong>
        </div>
      </header>

      <div className={styles.body}>
        <nav className={styles.stepNav} aria-label="智能混剪步骤">
          <p className={styles.eyebrow}>创作步骤</p>
          {STEPS.map((step, index) => (
            <button type="button" key={step.label} className={index === activeStep ? styles.activeStep : ''} disabled={!step.enabled || (index === 1 && selectedIds.length === 0)} onClick={() => index < 2 && setActiveStep(index as 0 | 1)}>
              <span><Icon name={step.icon} size={16} /></span>
              <span><strong>{step.label}</strong><small>{step.hint}</small></span>
            </button>
          ))}
          <p className={styles.localOnly}><Icon name="lock" size={14} />本地保存</p>
        </nav>

        <MixcutSidebar
          shotSets={context?.shotSets ?? []}
          activeShotSetId={activeShotSetId}
          selectedCount={selectedIds.length}
          availableVideoCount={materials.filter((material) => material.status === 'ready').length}
          onSelectShotSet={selectShotSet}
          disabled={loading || submitting}
        />

        <main className={styles.main}>
          {message && <div className={styles.errorBanner}><Icon name="alert" size={15} />{message}</div>}
          {!context && loading ? (
            <div className={styles.loadingState}><span /><strong>正在读取真实分镜组和视频…</strong></div>
          ) : (
            <>
              <div className={activeStep === 0 ? undefined : styles.stepHidden}>
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
                  onClear={() => {
                    if (!activeShotSetId) return;
                    setSelectionByShotSet({ [activeShotSetId]: [] });
                    markPersistenceDirty();
                  }}
                  onRefresh={() => void refreshWorkspace()}
                  onImportFiles={activeShotSetId ? importFiles : undefined}
                  onContinue={() => setActiveStep(1)}
                  importDisabledReason={activeShotSetId ? undefined : '请先选择一个分镜组'}
                  loading={loading || Boolean(activeShotSetId && uploadingShotSetIds.includes(activeShotSetId))}
                />
              </div>
              <div className={activeStep === 1 ? undefined : styles.stepHidden}>
                <CreationStep
                  drafts={activeDrafts}
                  activeDraftId={scriptEditor.activeDraftId}
                  editedNarrationText={scriptEditor.editedNarrationText}
                  importedNarrationText={scriptEditor.importedNarrationText}
                  dirty={scriptEditor.dirty}
                  modified={scriptEditor.modified}
                  pendingDraft={pendingDraft}
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
                />
              </div>
            </>
          )}
        </main>
      </div>
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
    </div>
  );
}
