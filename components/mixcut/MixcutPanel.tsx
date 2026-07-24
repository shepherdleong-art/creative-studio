'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  initializeMaterialSelection,
  materialSelectionForShotSet,
  toggleMaterialSelection,
  type MaterialSelectionByShotSet,
} from '@/lib/final-edit/material-selection';
import type { FinalEditExternalAssetView, MixcutContextResponse } from '@/lib/final-edit/types';
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
  { label: 'AI 智能创作', hint: 'Phase 2 接入', icon: 'sparkle' as const, enabled: false },
  { label: '预览调整', hint: 'Phase 4 接入', icon: 'play' as const, enabled: false },
  { label: '导出渲染', hint: 'Phase 6 接入', icon: 'download' as const, enabled: false },
];

export default function MixcutPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [context, setContext] = useState<MixcutContextResponse | null>(null);
  const [selectionByShotSet, setSelectionByShotSet] = useState<MaterialSelectionByShotSet>({});
  const [externalByShotSet, setExternalByShotSet] = useState<Record<string, FinalEditExternalAssetView[]>>({});
  const [loading, setLoading] = useState(true);
  const [uploadingShotSetIds, setUploadingShotSetIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const requestRef = useRef<{ sequence: number; controller: AbortController } | null>(null);

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
      const external = next.currentShotSetId
        ? await readJson<{ assets: FinalEditExternalAssetView[] }>(
          await fetch(`/api/projects/${projectId}/final-edit/shot-sets/${encodeURIComponent(next.currentShotSetId)}/external-assets`, { signal: controller.signal }),
        )
        : { assets: [] };
      if (requestRef.current?.sequence !== sequence) return;
      setContext(next);
      if (next.currentShotSetId) {
        const currentShotSetId = next.currentShotSetId;
        setExternalByShotSet((current) => ({ ...current, [currentShotSetId]: external.assets }));
        const module4Keys = next.videoAssets.map((asset) => `module4:${asset.videoJobId}`);
        const readyExternalKeys = external.assets.filter((asset) => asset.status === 'ready').map((asset) => `external:${asset.id}`);
        setSelectionByShotSet((current) => initializeMaterialSelection(current, currentShotSetId, module4Keys, [...module4Keys, ...readyExternalKeys]));
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

  const selectShotSet = (shotSetId: string) => {
    if (!shotSetId || shotSetId === activeShotSetId) return;
    setSelectionByShotSet({});
    void loadContext(shotSetId);
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
            <button type="button" key={step.label} className={index === 0 ? styles.activeStep : ''} disabled={!step.enabled}>
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
            <MaterialStep
              shotSetName={activeShotSet?.name ?? ''}
              materials={materials}
              selectedMaterialKeys={selectedIds}
              onToggle={toggleMaterial}
              onSelectAll={() => activeShotSetId && setSelectionByShotSet({ [activeShotSetId]: materials.filter((material) => material.status === 'ready').map((material) => material.key) })}
              onClear={() => activeShotSetId && setSelectionByShotSet({ [activeShotSetId]: [] })}
              onRefresh={() => void loadContext(activeShotSetId)}
              onImportFiles={activeShotSetId ? importFiles : undefined}
              importDisabledReason={activeShotSetId ? undefined : '请先选择一个分镜组'}
              loading={loading || Boolean(activeShotSetId && uploadingShotSetIds.includes(activeShotSetId))}
            />
          )}
        </main>
      </div>
    </div>
  );
}
