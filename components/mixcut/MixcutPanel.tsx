'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  createScriptEditorState,
  editActiveScript,
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

type MixcutGroupView = FinalEditGroupView & {
  script?: {
    sourceDraftId: string | null;
    title: string;
    importedNarrationText: string;
    editedNarrationText: string;
    syncState: 'synced' | 'modified';
    sourceScriptUpdatedAt: string | null;
    narrationConfig: { providerId: string; voice: string; speed: number };
    selectedMaterialKeys: string[];
  };
  jobs: Array<FinalEditGroupView['jobs'][number] & { startedAt?: string | null; finishedAt?: string | null; createdAt?: string }>;
};

interface VisionProviderView { id: string; configured: boolean; supportsVision?: boolean }

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
  const [loading, setLoading] = useState(true);
  const [uploadingShotSetIds, setUploadingShotSetIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const requestRef = useRef<{ sequence: number; controller: AbortController } | null>(null);
  const jobPollRef = useRef<symbol | null>(null);
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
        readJson<{ groups: MixcutGroupView[] }>(await fetch(`/api/projects/${projectId}/final-edit/groups`, { signal: controller.signal })).catch(() => ({ groups: [] })),
        readJson<MixcutTtsProviderView[]>(await fetch('/api/providers/tts', { signal: controller.signal })).catch(() => []),
        readJson<VisionProviderView[]>(await fetch('/api/providers/script', { signal: controller.signal })).catch(() => []),
      ]);
      if (requestRef.current?.sequence !== sequence) return;
      setContext(next);
      setTtsProviders(providersResult);
      const configuredTts = providersResult.find((provider) => provider.configured) ?? providersResult[0] ?? null;
      setTtsProviderId((current) => providersResult.some((provider) => provider.id === current) ? current : configuredTts?.id ?? '');
      setVoice((current) => configuredTts?.voices.some((item) => item.id === current) ? current : configuredTts?.voices[0]?.id ?? '');
      setVisionProviderId(visionProviders.find((provider) => provider.configured && provider.supportsVision)?.id ?? '');
      if (next.currentShotSetId) {
        const currentShotSetId = next.currentShotSetId;
        setExternalByShotSet((current) => ({ ...current, [currentShotSetId]: external.assets }));
        const module4Keys = next.videoAssets.map((asset) => `module4:${asset.videoJobId}`);
        const readyExternalKeys = external.assets.filter((asset) => asset.status === 'ready').map((asset) => `external:${asset.id}`);
        const latestGroup = groupsResult.groups.find((group) => group.shotSetId === currentShotSetId);
        const persistedSelection = latestGroup?.script?.selectedMaterialKeys.filter((key) => [...module4Keys, ...readyExternalKeys].includes(key)) ?? [];
        setSelectionByShotSet((current) => persistedSelection.length > 0
          ? { [currentShotSetId]: persistedSelection }
          : initializeMaterialSelection(current, currentShotSetId, module4Keys, [...module4Keys, ...readyExternalKeys]));
        const groupScript = latestGroup?.script;
        const sourceDraftId = groupScript?.sourceDraftId ?? next.drafts.find((draft) => draft.shotSetId === currentShotSetId)?.id ?? MANUAL_SCRIPT_ID;
        const sourceDraft = next.drafts.find((draft) => draft.id === sourceDraftId);
        const importedText = groupScript?.importedNarrationText ?? sourceDraft?.narrationText ?? '';
        const editedText = groupScript?.editedNarrationText || importedText;
        const persistedEditor: ScriptEditorState = {
          activeDraftId: sourceDraftId,
          importedNarrationText: importedText,
          editedNarrationText: editedText,
          dirty: groupScript?.syncState === 'modified' || editedText !== importedText,
          textByDraftId: {},
        };
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
    setSelectionByShotSet({});
    setActiveStep(0);
    setPendingDraftId(null);
    setPendingShotSetId(null);
    setActiveJob(null);
    void loadContext(shotSetId);
  };

  const selectShotSet = (shotSetId: string) => {
    if (!shotSetId || shotSetId === activeShotSetId) return;
    if (activeStep === 1 && scriptEditor.dirty) {
      setPendingShotSetId(shotSetId);
      return;
    }
    performShotSetSwitch(shotSetId);
  };

  const resolveShotSetSwitch = (resolution: ScriptSwitchResolution) => {
    const targetShotSetId = pendingShotSetId;
    setPendingShotSetId(null);
    if (!targetShotSetId || resolution === 'cancel') return;
    if (activeShotSetId) {
      if (resolution === 'preserve') scriptEditorByShotSetRef.current[activeShotSetId] = scriptEditor;
      else delete scriptEditorByShotSetRef.current[activeShotSetId];
    }
    performShotSetSwitch(targetShotSetId);
  };

  const toggleMaterial = (materialKey: string) => {
    if (!activeShotSetId) return;
    setSelectionByShotSet((current) => toggleMaterialSelection(current, activeShotSetId, materialKey));
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

  const requestDraftChange = (draftId: string) => {
    if (draftId === scriptEditor.activeDraftId) return;
    const target = activeDrafts.find((draft) => draft.id === draftId);
    if (!target) return;
    if (scriptEditor.dirty) setPendingDraftId(draftId);
    else setScriptEditor((current) => resolveScriptSwitch(current, { id: target.id, narrationText: target.narrationText }, 'preserve'));
  };

  const resolveDraftChange = (resolution: ScriptSwitchResolution) => {
    const target = activeDrafts.find((draft) => draft.id === pendingDraftId);
    setPendingDraftId(null);
    if (!target) return;
    setScriptEditor((current) => resolveScriptSwitch(current, { id: target.id, narrationText: target.narrationText }, resolution));
  };

  const changeTtsProvider = (providerId: string) => {
    const provider = ttsProviders.find((item) => item.id === providerId);
    setTtsProviderId(providerId);
    setVoice((current) => provider?.voices.some((item) => item.id === current) ? current : provider?.voices[0]?.id ?? '');
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
    if (!activeShotSetId || !ttsProviderId || !voice) return;
    setMessage('');
    try {
      const jobRef = await readJson<{ id: string; groupId: string; status: string }>(await fetch(`/api/projects/${projectId}/final-edit/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotSetId: activeShotSetId,
          scriptDraftId: scriptEditor.activeDraftId === MANUAL_SCRIPT_ID ? '' : scriptEditor.activeDraftId,
          editedNarrationText: scriptEditor.editedNarrationText,
          selectedMaterialKeys: selectedIds,
          count: 1,
          outputPreset: '3x4',
          providerId: ttsProviderId,
          voice,
          speed,
          analysisProviderId: visionProviderId,
        }),
      }));
      const job = await readJson<Omit<MixcutPrepareJobView, 'groupId'>>(await fetch(`/api/final-edit-jobs/${jobRef.id}`));
      setActiveJob({ ...job, groupId: jobRef.groupId });
      setMessage('后台任务已创建，可以离开页面后再返回查看');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
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
          disabled={loading}
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
                  onSelectAll={() => activeShotSetId && setSelectionByShotSet({ [activeShotSetId]: materials.filter((material) => material.status === 'ready').map((material) => material.key) })}
                  onClear={() => activeShotSetId && setSelectionByShotSet({ [activeShotSetId]: [] })}
                  onRefresh={() => void loadContext(activeShotSetId)}
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
                  pendingDraft={pendingDraft}
                  onDraftChange={requestDraftChange}
                  onResolveDraftSwitch={resolveDraftChange}
                  onTextChange={(text) => setScriptEditor((current) => editActiveScript(current, text))}
                  onRestoreImported={() => {
                    const draft = activeDrafts.find((item) => item.id === scriptEditor.activeDraftId);
                    if (draft) setScriptEditor((current) => restoreImportedScript(current, { id: draft.id, narrationText: draft.narrationText }));
                  }}
                  providers={ttsProviders}
                  providerId={ttsProviderId}
                  voice={voice}
                  speed={speed}
                  onProviderChange={changeTtsProvider}
                  onVoiceChange={setVoice}
                  onSpeedChange={setSpeed}
                  onPreviewVoice={() => void previewVoice()}
                  previewingVoice={previewingVoice}
                  selectedMaterialCount={selectedIds.length}
                  job={activeJob}
                  elapsedSec={elapsedSec}
                  onStart={() => void startCreation()}
                  onBack={() => setActiveStep(0)}
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
            <h2 id="mixcut-shot-set-switch-title">当前分镜组的脚本有未保存修改</h2>
            <p>切换到「{context?.shotSets.find((shotSet) => shotSet.id === pendingShotSetId)?.name || '其他分镜组'}」前，请选择如何处理当前文案。</p>
            <div>
              <button type="button" className={styles.primaryButton} onClick={() => resolveShotSetSwitch('preserve')}>保留修改并切换</button>
              <button type="button" className={styles.secondaryButton} onClick={() => resolveShotSetSwitch('discard')}>放弃修改并切换</button>
              <button type="button" className={styles.textButton} onClick={() => resolveShotSetSwitch('cancel')}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
