'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Tag } from '@/components/ui/Appearance';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import HoverZoomImage from '@/components/HoverZoomImage';
import ImagePreview from '@/components/media/ImagePreview';
import { MAX_SHOTS_PER_SET } from '@/lib/shot-set-domain';
import { parseRedoReferenceIds } from '@/lib/shot-redo-state';
import { UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY } from '@/lib/media-core/unified-media/catalog';
import type { SceneReferenceRecord } from '@/lib/result-gallery-jobs';
import {
  canMarkShotAvailable,
  canRegenerateShot,
  canRetryShot,
  canStepShotVersion,
  clampIndex,
  formatLatestShotVersionHint,
  formatShotVersionAriaLabel,
  formatShotVersionSummary,
  formatShotVersionTag,
  getOpeningShotId,
  isOpeningShot,
  movePickedToFront,
  removePickedId,
  resolveShotResultState,
  resolveShotVersion,
  stepIndex,
  stepShotVersion,
  togglePickedId,
  toggleSelectAll,
  type ShotResultState,
  type SceneViewMode,
} from '@/lib/workbench-shots';
import { MainHead, PaneHead, PaneList, SettingsHeading, StepFrame } from './Frame';
import { StepEmpty } from './StepEmpty';
import UploadDrop from './UploadDrop';
import s from './workbench.module.css';
import type { WorkbenchImage, WorkbenchProvider } from './types';

interface ShotCandidate {
  shotId: string;
  jobId: string;
  imageAssetId: string;
  createdAt: string;
  filename?: string;
  imageUrl?: string;
  jobStatus?: string;
  jobPrompt?: string;
  referenceImageIds?: string;
  providerId?: string;
  model?: string;
  unifiedModel?: string | null;
  size?: string;
  quality?: string;
}

interface Shot {
  id: string;
  indexNum: number;
  sourceImageId: string;
  sourceFilename: string;
  sourceImageUrl?: string;
  latestGeneratedImageId?: string;
  generatedFilename?: string;
  generatedImageUrl?: string;
  latestJobId?: string;
  jobStatus?: string;
  jobErrorMessage?: string | null;
  jobPrompt?: string;
  referenceImageIds?: string;
  providerId?: string;
  model?: string;
  unifiedModel?: string | null;
  size?: string;
  quality?: string;
  reviewMark?: string;
  resultCandidates?: ShotCandidate[];
}

interface ShotSet {
  id: string;
  name: string;
  productCode?: string;
  category?: string;
  shotCount: number;
  generatedCount: number;
  approvedCount: number;
  status: string;
  kind?: string;
  sceneReferenceId?: string;
  createdAt: string;
}

interface ShotSetDetail {
  status?: string;
  shots: Shot[];
  sceneRefName?: string | null;
  sceneRefImageUrl?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  generating: '生成中',
  completed: '已完成',
  reviewing: '审核中',
  approved: '已通过',
  video_ready: '待生成视频',
};

const MARK_LABELS: Record<string, string> = { available: '可用', rework: '待返工', discard: '废弃' };

const SHOT_STATE_LABELS: Record<ShotResultState, string> = {
  empty: '未生成',
  queued: '排队中',
  generating: '生成中',
  checking: '结果确认中',
  failed: '失败',
  succeeded: '未标记',
};

function markTone(state: ShotResultState): 'ok' | 'warn' | 'fail' | 'run' | 'idle' {
  if (state === 'succeeded') return 'ok';
  if (state === 'failed') return 'fail';
  if (state === 'queued' || state === 'generating' || state === 'checking') return 'run';
  return 'idle';
}

/**
 * 第 2 步 分镜（07 号票）。
 *
 * 左栏 = 分镜组列表 + 「上传原始分镜图」；中间默认**原图与结果并排**，
 * 显示「第 N 版（共 M 版）」并可切历史版本；右栏 = 这一组的设置与重做。
 *
 * 验收点都在这里：拖入/多选上传、全选再点取消、悬停「设为开场」、
 * 左右键切分镜、失败分镜写明原因且不能标可用、删除分镜组前确认。
 */
export default function ShotSetStep({
  projectId,
  providerOptions,
  shotSourceImages,
  images,
  sceneReferences,
  jobs,
  onUploaded,
  onApplyScene,
  onShotChanged,
  onDeleteAsset,
}: {
  projectId: string;
  providerOptions: WorkbenchProvider[];
  shotSourceImages: WorkbenchImage[];
  images: WorkbenchImage[];
  sceneReferences: SceneReferenceRecord[];
  jobs: Array<{ id: string; status: string; outputImageId?: string }>;
  onUploaded: () => void | Promise<void>;
  onApplyScene: (shotSetId: string) => void;
  onShotChanged: () => void | Promise<void>;
  onDeleteAsset: (assetId: string) => void | Promise<void>;
}) {
  const [sets, setSets] = useState<ShotSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShotSetDetail | null>(null);
  const [detailSetId, setDetailSetId] = useState<string | null>(null);
  const [loadingShots, setLoadingShots] = useState(false);
  const [shotIndex, setShotIndex] = useState(0);
  const [view, setView] = useState<SceneViewMode>('compare');
  const [versionBusy, setVersionBusy] = useState(false);
  // 错误按分镜记：切到别的分镜时旧错误自动失效，不用 effect 回写 state。
  const [versionError, setVersionError] = useState<{ shotId: string; message: string } | null>(null);
  const [redoPrompt, setRedoPrompt] = useState('');
  const [redoProviderId, setRedoProviderId] = useState('');
  // null 表示未改动，提交时沿用原任务；[] 表示用户明确取消所有参考图。
  const [redoReferenceIds, setRedoReferenceIds] = useState<string[] | null>(null);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ShotSet | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const redoInitKeyRef = useRef('');

  const selectableProviders = useMemo(
    () => providerOptions.filter((provider) => provider.enabled && provider.hasApiKey),
    [providerOptions],
  );
  const effectiveProviderId = selectableProviders.some((provider) => provider.id === redoProviderId)
    ? redoProviderId
    : selectableProviders[0]?.id ?? '';
  const selectedProvider = selectableProviders.find((provider) => provider.id === effectiveProviderId);
  const unifiedSelection = selectedProvider?.type === 'unified-image'
    && selectedProvider.model === UNIFIED_IMAGE_MODEL_KEY;

  const loadSets = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/shot-sets`);
      const data = await response.json();
      if (Array.isArray(data)) setSets((data as ShotSet[]).filter((set) => set.kind !== 'free'));
    } catch { /* 列表读不到就保持现状，等下一次刷新 */ }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadSets();
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [loadSets]);

  // 当前分镜组是**派生**的：用户点过哪个就记哪个，它被删掉时自动回到第一组。
  const selectSet = (id: string | null) => { setSelectedSetId(id); setShotIndex(0); };
  const activeSetId = sets.some((set) => set.id === selectedSetId)
    ? selectedSetId
    : (sets[0]?.id ?? null);

  const loadShots = useCallback(async (setId: string) => {
    setLoadingShots(true);
    try {
      const response = await fetch(`/api/shot-sets/${setId}`);
      const data = (await response.json()) as ShotSetDetail & { error?: string };
      if (!response.ok) {
        setError(data.error || '分镜组读取失败');
        return;
      }
      setDetail({ status: data.status, shots: data.shots || [], sceneRefName: data.sceneRefName, sceneRefImageUrl: data.sceneRefImageUrl });
      setDetailSetId(setId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '分镜组读取失败');
    } finally {
      setLoadingShots(false);
    }
  }, []);

  // 换组时才清空并重新取分镜；detail 还没对上当前组时按「加载中」处理。
  // 用 setTimeout(0) 推迟首帧同步 setState（与页面里 loadProject 的写法一致）。
  useEffect(() => {
    if (!activeSetId) return;
    const timer = window.setTimeout(() => { void loadShots(activeSetId); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSetId, loadShots]);

  const currentDetail = detailSetId === activeSetId ? detail : null;

  // 任务完成/失败时刷新组列表与当前组，生成图会自己出现。
  const jobsFingerprint = useMemo(
    () => jobs.map((job) => `${job.id}:${job.status}:${job.outputImageId || ''}`).join(','),
    [jobs],
  );
  useEffect(() => {
    (async () => {
      await loadSets();
      if (activeSetId) await loadShots(activeSetId);
    })();
  }, [jobsFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  // 生成中的分镜自动轮询，直到全部出结果。
  const hasActiveShot = (currentDetail?.shots || []).some((shot) => ['pending', 'running', 'retrying', 'needs_check'].includes(shot.jobStatus || ''));
  useEffect(() => {
    if (!activeSetId || !hasActiveShot) return;
    const timer = window.setInterval(() => { void loadShots(activeSetId); void loadSets(); }, 2500);
    return () => window.clearInterval(timer);
  }, [activeSetId, hasActiveShot, loadShots, loadSets]);

  const shots = currentDetail?.shots || [];
  const activeSet = sets.find((set) => set.id === activeSetId) ?? null;
  const currentShot = shots[clampIndex(shotIndex, shots.length)] as Shot | undefined;
  const currentIndex = shots.length > 0 ? clampIndex(shotIndex, shots.length) : 0;
  const selectedReferenceIds = [...new Set(redoReferenceIds ?? parseRedoReferenceIds(currentShot?.referenceImageIds))]
    .filter((id) => id !== currentShot?.sourceImageId);
  const referenceCandidates = (() => {
    const candidates = new Map<string, { id: string; label: string; imageUrl?: string }>();
    const add = (id: string, label: string, imageUrl?: string) => {
      if (id === currentShot?.sourceImageId || candidates.has(id)) return;
      candidates.set(id, { id, label, imageUrl: imageUrl || images.find((image) => image.id === id)?.imageUrl });
    };
    sceneReferences.forEach((ref) => add(ref.imageAssetId, ref.name));
    images.filter((image) => image.role === 'reference' || image.role === 'output')
      .forEach((image) => add(image.id, image.filename, image.imageUrl));
    currentShot?.resultCandidates?.forEach((candidate, index) => add(candidate.imageAssetId, `结果 ${index + 1}`, candidate.imageUrl));
    selectedReferenceIds.forEach((id, index) => add(id, `参考图 ${index + 1}`));
    return [...candidates.values()];
  })();

  // 版本 = 可展示候选 + 服务端选用 asset ID 的纯计算，缩略图 / 网格 / 大图共用同一份。
  // 没有结果时 current=0（不显示 V0）；旧数据没有 candidates 时回退成 V1。
  const version = useMemo(() => resolveShotVersion(currentShot), [currentShot]);
  const resultUrl = version.imageUrl || currentShot?.generatedImageUrl || '';
  const visibleVersionError = versionError && currentShot && versionError.shotId === currentShot.id
    ? versionError.message
    : '';
  const shotState = resolveShotResultState(currentShot?.jobStatus, Boolean(resultUrl));
  const canMark = canMarkShotAvailable(shotState);
  const canRetry = canRetryShot(shotState);
  const canRegenerate = canRegenerateShot(shotState);
  const generating = shotState === 'queued' || shotState === 'generating' || shotState === 'checking';
  // 右栏「供应商」是重做用的选择。原任务的供应商冻结在 job 行里，换了供应商后
  // 原地重试不会生效，必须走「重新生成」新建一个任务（多出一版）。
  const jobProviderId = currentShot?.providerId || '';
  const currentJobUnified = currentShot?.unifiedModel === UNIFIED_IMAGE_MODEL_KEY
    || jobProviderId === UNIFIED_IMAGE_ANCHOR_ID;
  const providerSelectionChanged = Boolean(jobProviderId)
    && Boolean(effectiveProviderId)
    && effectiveProviderId !== jobProviderId;

  // 切分镜时按「这一张的提示词/供应商」重置重做表单，同一个分镜不覆盖用户输入。
  const redoKey = currentShot ? `${currentShot.id}:${currentShot.latestJobId || ''}` : '';
  useEffect(() => {
    if (!redoKey || redoInitKeyRef.current === redoKey) return;
    redoInitKeyRef.current = redoKey;
    setRedoPrompt(currentShot?.jobPrompt || '');
    setRedoProviderId(currentShot?.providerId || '');
    setRedoReferenceIds(null);
    setReferencePickerOpen(false);
  }, [redoKey, currentShot]);

  // 左右键切分镜、不翻页。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (document.querySelector('.dialog-scrim')) return;
      if (shots.length < 2) return;
      event.preventDefault();
      setShotIndex((index) => stepIndex(index, event.key === 'ArrowRight' ? 1 : -1, shots.length));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shots.length]);

  /** 切历史版本：服务端记住选中，刷新后仍以服务端选用为准；失败不假装切换。 */
  const selectVersion = async (imageAssetId: string) => {
    if (!activeSetId || !currentShot || versionBusy) return;
    if (imageAssetId === currentShot.latestGeneratedImageId) return;
    setVersionBusy(true);
    setVersionError(null);
    try {
      const response = await fetch(`/api/shot-sets/${activeSetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: currentShot.id, selectedImageAssetId: imageAssetId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setVersionError({ shotId: currentShot.id, message: body.error || '切换版本失败，仍显示服务端原先选用的版本' });
        return;
      }
      // 只有服务端确认成功后才重新读取，不用本地临时选中冒充切换成功。
      await loadShots(activeSetId);
      await loadSets();
    } catch (cause) {
      setVersionError({
        shotId: currentShot.id,
        message: cause instanceof Error ? cause.message : '切换版本失败，仍显示服务端原先选用的版本',
      });
    } finally {
      setVersionBusy(false);
    }
  };

  const stepVersion = (delta: number) => {
    const target = stepShotVersion(version, delta);
    if (!target?.imageAssetId) return;
    void selectVersion(target.imageAssetId);
  };

  const markShot = async (mark: string) => {
    if (!activeSetId || !currentShot || !canMark) return;
    await fetch(`/api/shot-sets/${activeSetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: currentShot.id, reviewMark: mark }),
    });
    await loadShots(activeSetId);
    await loadSets();
  };

  /** 重做的唯一提交口：新建一个任务（会多出一版，旧版保留）。 */
  const submitRedo = async (promptOverride?: string) => {
    if (redoing) return;
    if (!activeSetId || !currentShot?.latestJobId) return;
    const prompt = (promptOverride ?? redoPrompt).trim();
    if (!prompt) {
      setError('请填写提示词');
      return;
    }
    setRedoing(true);
    setError('');
    try {
      const response = await fetch(`/api/jobs/${currentShot.latestJobId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          markOriginal: true,
          inputSource: 'original',
          referenceImageIds: redoReferenceIds === null ? undefined : selectedReferenceIds,
          providerId: effectiveProviderId || undefined,
          requestKey: crypto.randomUUID(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { newJobId?: string; error?: string };
      if (!response.ok || !body.newJobId) {
        setError(body.error || '重做失败');
        return;
      }
      const patch = await fetch(`/api/shot-sets/${activeSetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: currentShot.id, latestJobId: body.newJobId }),
      });
      if (!patch.ok) {
        setError('更新分镜任务关联失败');
        return;
      }
      await onShotChanged();
      await loadShots(activeSetId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重做失败');
    } finally {
      setRedoing(false);
    }
  };

  const redoShot = async () => {
    await submitRedo();
  };

  const retryShot = async () => {
    if (!currentShot?.latestJobId) return;
    // 右栏换了供应商：原任务的供应商/模型是冻结的，原地重试不会采用新选择，
    // 直接按新供应商重新生成一版，避免「重试看上去成功、实际还是老供应商」。
    if (currentShot.jobStatus === 'needs_check') {
      const response = await fetch(`/api/jobs/${currentShot.latestJobId}/resume-poll`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error || '续查失败');
        return;
      }
      await onShotChanged();
      if (activeSetId) await loadShots(activeSetId);
      return;
    }
    if (currentJobUnified || providerSelectionChanged) {
      await submitRedo(redoPrompt.trim() || currentShot.jobPrompt || '');
      return;
    }
    const response = await fetch(`/api/jobs/${currentShot.latestJobId}/retry`, { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error || '重试失败');
      return;
    }
    await onShotChanged();
    if (activeSetId) await loadShots(activeSetId);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/shot-sets/${deleteTarget.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error || '删除失败');
        return;
      }
      setDeleteTarget(null);
      selectSet(null);
      setDetail(null);
      await loadSets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const groupCounts = (set: ShotSet) => `${set.shotCount} 张 · ${set.generatedCount} 已生成 · ${set.approvedCount} 可用`;

  return (
    <div className={`${s.page} ${s.storyboardPage}`} data-testid="workbench-storyboard" data-view={view} data-empty={activeSet ? 'false' : 'true'}>
      <StepFrame
        left={<>
          <PaneHead action={
            <button type="button" className={s.paneIcon} aria-label="新建分镜组" title="新建分镜组" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={14} />
            </button>
          }>分镜组</PaneHead>
          <PaneList>
            {sets.map((set) => (
              <div key={set.id} className={s.itemWrap}>
                <button
                  type="button"
                  className={s.item}
                  aria-current={set.id === activeSetId}
                  onClick={() => selectSet(set.id)}
                >
                  <span className={s.itemThumb}><Icon name="film" size={15} /></span>
                  <span className={s.itemBody}>
                    <b title={set.name}>{set.name}</b>
                    <small>{groupCounts(set)}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={s.itemDelete}
                  aria-label={`删除分镜组 ${set.name}`}
                  title="删除分镜组"
                  onClick={() => setDeleteTarget(set)}
                ><Icon name="trash" size={12} /></button>
              </div>
            ))}
            {!loading && sets.length === 0 ? <p className={s.note}>还没有分镜组。上传原始分镜图后按顺序选，再建组。</p> : null}
          </PaneList>

          {activeSet?.sceneReferenceId ? (
            <div className={s.referenceCard}>
              {currentDetail?.sceneRefImageUrl
                ? <HoverZoomImage src={currentDetail.sceneRefImageUrl} alt={currentDetail.sceneRefName || '参考场景'} className={s.referenceThumb} />
                : <span className={s.itemThumb}><Icon name="image" size={15} /></span>}
              <div>
                <b>{currentDetail?.sceneRefName || '场景参考图'}</b>
                <small>来自第 1 步选定的参考图</small>
              </div>
            </div>
          ) : null}

          <UploadDrop
            projectId={projectId}
            usage="shot_source"
            label="上传原始分镜图"
            hint="拖入或点击，可多选"
            maxFiles={MAX_SHOTS_PER_SET}
            onUploaded={async () => { await onUploaded(); await loadSets(); }}
          />
          <button type="button" className={`${s.drop} ${s.dropSolid}`} onClick={() => setCreateOpen(true)}>
            新建分镜组
            <small>{`已传 ${shotSourceImages.length} 张原始分镜图`}</small>
          </button>
        </>}
        main={<>
          <MainHead
            title={activeSet?.name || '分镜'}
            note={activeSet
              ? (view === 'grid'
                ? `${activeSet.shotCount} 张 · ${activeSet.generatedCount} 已生成 · ${activeSet.approvedCount} 可用`
                : `分镜 ${currentShot?.indexNum ?? 0}，${activeSet.shotCount} 张里 ${activeSet.approvedCount} 张可用`)
              : undefined}
          >
            <Segmented<SceneViewMode>
              value={view}
              onChange={(next) => setView(next === 'grid' ? 'grid' : 'compare')}
              options={[{ value: 'compare', label: '对照原图' }, { value: 'grid', label: '全部' }]}
              label="分镜视图"
              size="small"
              semantics="toggle"
            />
          </MainHead>

          {!activeSet ? (
            <div className={s.emptyWrap}>
              <StepEmpty
                title="还没有分镜组"
                description={`先上传原始分镜图，再按顺序选 1 到 ${MAX_SHOTS_PER_SET} 张创建分镜组，配合场景参考图批量生成。`}
                icon="film"
                action={<UploadDrop projectId={projectId} usage="shot_source" label="上传原始分镜图" hint="支持多选" onUploaded={async () => { await onUploaded(); await loadSets(); }} solid />}
              />
            </div>
          ) : loadingShots && shots.length === 0 ? (
            <div className={s.emptyWrap}><StepEmpty title="正在读取分镜" description="稍等一下，正在取这一组的分镜列表。" icon="logs" /></div>
          ) : shots.length === 0 ? (
            <div className={s.emptyWrap}>
              <StepEmpty title="这一组还没有分镜" description="回到左栏重新建组，或检查原始分镜图是否已经上传。" icon="film" />
            </div>
          ) : view === 'grid' ? (
            <div className={s.pairs}>
              {shots.map((shot, index) => {
                const shotVersion = resolveShotVersion(shot);
                const url = shotVersion.imageUrl || shot.generatedImageUrl || '';
                const state = resolveShotResultState(shot.jobStatus, Boolean(url));
                return (
                  <button
                    key={shot.id}
                    type="button"
                    className={s.pair}
                    aria-current={index === currentIndex}
                    aria-label={formatShotVersionAriaLabel(shot.indexNum, shotVersion)}
                    onClick={() => { setShotIndex(index); setView('compare'); }}
                  >
                    <span className={s.pairImgs}>
                      <span className={s.pairBox}>
                        {shot.sourceImageUrl ? <img src={shot.sourceImageUrl} alt={`分镜 ${shot.indexNum} 原图`} loading="lazy" /> : null}
                      </span>
                      <span className={s.pairBox}>
                        {url
                          ? <img src={url} alt={`分镜 ${shot.indexNum} 结果`} loading="lazy" />
                          : <span className={`${s.placeholder} ${state === 'failed' ? s.placeholderFail : ''}`}>
                              {state === 'empty'
                                ? <><Icon name="image" size={22} /><span>未生成</span></>
                                : state === 'failed' ? '失败' : <span className={s.spin} />}
                            </span>}
                      </span>
                    </span>
                    <span className={s.pairMeta}>
                      <b>分镜 {shot.indexNum}</b>
                      {shotVersion.current > 0 ? (
                        <span
                          className={`${s.versionTag} ${shotVersion.hasMultiple ? s.versionTagMulti : s.versionTagSingle}`}
                          data-testid="shot-grid-version"
                          data-total={shotVersion.total}
                        >{formatShotVersionTag(shotVersion)}</span>
                      ) : null}
                      {isOpeningShot(shots.map((item) => item.id), shot.id) ? <em>开场</em> : null}
                      <small>
                        <i className={`status-dot-${markTone(state)}`} />
                        {state === 'succeeded' && shot.reviewMark ? MARK_LABELS[shot.reviewMark] : SHOT_STATE_LABELS[state]}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : currentShot ? (
            <>
              <div className={s.compare}>
                <figure className={s.figure}>
                  <div className={s.frameBox}>
                    {currentShot.sourceImageUrl
                      ? <ImagePreview src={currentShot.sourceImageUrl} alt="原图" />
                      : <span className={s.placeholder}><Icon name="image" size={22} /><span>原图不可用</span></span>}
                  </div>
                  <figcaption className={s.caption}>
                    <b>原图</b>
                    <span title={currentShot.sourceFilename}>{currentShot.sourceFilename}</span>
                  </figcaption>
                </figure>
                <figure className={s.figure}>
                  <div className={s.frameBox}>
                    {resultUrl ? (
                      <>
                        <ImagePreview src={resultUrl} alt="结果" />
                        {currentShot.indexNum === 1 ? <span className={s.refBadge} title="这张产品全景图将用于视频开头">开场：产品全景图</span> : null}
                      </>
                    ) : (
                      <span className={`${s.placeholder} ${shotState === 'failed' ? s.placeholderFail : ''}`}>
                        {shotState === 'failed' ? (
                          <>
                            <b>这张没生成出来</b>
                            <span>{currentShot.jobStatus === 'failed' ? '生成失败，可以重新生成' : '结果文件缺失，可以重试'}</span>
                            {canRetry ? (
                              <button
                                type="button"
                                className="cap"
                                title={currentJobUnified
                                  ? '按统一 Image 2 新建一版重新生成（旧版保留）'
                                  : providerSelectionChanged
                                    ? '按右栏选中的供应商重新生成一版（旧版保留）'
                                    : '用原供应商重新执行这个任务'}
                                onClick={() => void retryShot()}
                              >重试</button>
                            ) : null}
                          </>
                        ) : shotState === 'empty' ? (
                          <>
                            <Icon name="image" size={22} />
                            <b>还没有生成</b>
                            <span>在右栏「生成分镜」里用场景参考图生成这一组。</span>
                          </>
                        ) : (
                          <><span className={s.spin} /><span>{SHOT_STATE_LABELS[shotState]}</span></>
                        )}
                      </span>
                    )}
                  </div>
                  <figcaption className={s.caption}>
                    <b>结果</b>
                  </figcaption>
                </figure>
              </div>

              {/* 版本条独占一行：窄主栏里也不挤掉底部操作栏；大图区域的版本信息与切版按钮都在这。 */}
              <div className={s.versionRow} data-testid="shot-version">
                {version.total > 0 ? (
                  <>
                    {canStepShotVersion(version) ? (
                      <button
                        type="button"
                        className={s.versionBtn}
                        aria-label="使用上一版"
                        title="使用上一版"
                        disabled={versionBusy}
                        onClick={() => stepVersion(-1)}
                      ><Icon name="chevron-left" size={12} /></button>
                    ) : null}
                    <span className={s.versionSummary} data-testid="shot-version-summary">
                      {formatShotVersionSummary(version)}
                    </span>
                    {canStepShotVersion(version) ? (
                      <>
                        <button
                          type="button"
                          className={s.versionBtn}
                          aria-label="使用下一版"
                          title="使用下一版"
                          disabled={versionBusy}
                          onClick={() => stepVersion(1)}
                        ><Icon name="chevron-right" size={12} /></button>
                        <span className={s.versionHint}>切换即用于后续制作</span>
                      </>
                    ) : null}
                    {formatLatestShotVersionHint(version) ? (
                      <span className={s.versionLatest} data-testid="shot-version-latest">
                        {formatLatestShotVersionHint(version)}
                      </span>
                    ) : null}
                  </>
                ) : <span className={s.versionSummary}>还没有结果</span>}
                {visibleVersionError ? <span className={s.versionError} role="alert">{visibleVersionError}</span> : null}
              </div>

              <div className={s.strip} aria-label="分镜缩略图">
                {shots.map((shot, index) => {
                  const shotVersion = resolveShotVersion(shot);
                  const url = shotVersion.imageUrl || shot.generatedImageUrl || '';
                  const state = resolveShotResultState(shot.jobStatus, Boolean(url));
                  return (
                    <button
                      key={shot.id}
                      type="button"
                      className={s.thumb}
                      aria-current={index === currentIndex}
                      aria-label={formatShotVersionAriaLabel(shot.indexNum, shotVersion)}
                      onClick={() => setShotIndex(index)}
                    >
                      {url
                        ? <HoverZoomImage src={url} alt={`分镜 ${shot.indexNum}`} className={s.thumbImage} />
                        : <span className={s.thumbBox} />}
                      <figcaption>
                        <b>{shot.indexNum}</b>
                        {shotVersion.current > 0 ? (
                          <>
                            <span className={s.thumbVersionSep} aria-hidden="true">·</span>
                            <span
                              className={`${s.versionTag} ${shotVersion.hasMultiple ? s.versionTagMulti : s.versionTagSingle}`}
                              data-testid="shot-thumb-version"
                              data-total={shotVersion.total}
                            >{formatShotVersionTag(shotVersion)}</span>
                          </>
                        ) : null}
                        <i className={`status-dot-${markTone(state)}`} />
                      </figcaption>
                      {shot.indexNum === 1 ? <span className={s.thumbBadge}>开场</span> : null}
                    </button>
                  );
                })}
              </div>

              <div className={s.actions}>
                <button
                  type="button"
                  className="cap"
                  aria-pressed={currentShot.reviewMark === 'available'}
                  disabled={!canMark}
                  title={canMark ? undefined : '没生成出来的分镜不能标可用'}
                  onClick={() => void markShot('available')}
                ><Icon name="check" size={14} />可用</button>
                <button
                  type="button"
                  className="cap"
                  aria-pressed={currentShot.reviewMark === 'rework'}
                  disabled={!canMark}
                  onClick={() => void markShot('rework')}
                ><Icon name="retry" size={14} />待返工</button>
                <button
                  type="button"
                  className="cap"
                  aria-pressed={currentShot.reviewMark === 'discard'}
                  disabled={!canMark}
                  onClick={() => void markShot('discard')}
                ><Icon name="trash" size={14} />废弃</button>
                <hr />
                <button type="button" className="cap" disabled={!canRegenerate || redoing} onClick={() => void redoShot()}>
                  <Icon name="retry" size={14} />{redoing ? '提交中…' : '重新生成'}
                </button>
                {resultUrl ? <a className="cap" href={resultUrl} download><Icon name="download" size={14} />下载</a> : null}
                <span className={s.stretch} />
                <span className={s.note}>{shots.length > 1 ? `左右键切分镜（${currentIndex + 1}/${shots.length}）` : null}</span>
              </div>
            </>
          ) : null}
        </>}
        right={<>
          <SettingsHeading>这一组</SettingsHeading>
          {activeSet ? (
            <div className={s.settingsBody}>
              <div className={s.groupList}>
                <div className={s.groupRow}>
                  <span>状态</span>
                  <Tag tone={(currentDetail?.status ?? activeSet.status) === 'approved' ? 'ok' : 'idle'}>{STATUS_LABELS[currentDetail?.status ?? activeSet.status] || currentDetail?.status || activeSet.status}</Tag>
                </div>
                <div className={s.groupRow}>
                  <span>分镜</span>
                  <span>{`${activeSet.shotCount} 张`}</span>
                </div>
                <div className={s.groupRow}>
                  <span>可用</span>
                  <span>{`${activeSet.approvedCount} 张`}</span>
                </div>
              </div>
              <button type="button" className="cap" onClick={() => onApplyScene(activeSet.id)}>
                <Icon name="image" size={14} />{activeSet.sceneReferenceId ? '更换整组场景参考图' : '选择场景参考图'}
              </button>
              <p className={s.note}>{currentDetail?.sceneRefName ? `整组场景参考：${currentDetail.sceneRefName}` : '先选择场景参考图，再生成这一组分镜。'}</p>
              <div className={s.rowButtons}>
                <a className="cap" href={`/api/shot-sets/${activeSet.id}/download`}><Icon name="download" size={14} />下载 ZIP</a>
                <button type="button" className="cap" onClick={() => onApplyScene(activeSet.id)}>生成分镜</button>
                <button type="button" className="cap" onClick={() => setDeleteTarget(activeSet)}>删除</button>
              </div>
            </div>
          ) : <p className={s.note}>先建一个分镜组。</p>}

          {currentShot ? (
            <>
              <SettingsHeading>{`分镜 ${currentShot.indexNum}`}</SettingsHeading>
              <div className={s.settingsBody}>
                <div className={s.contextRow}>
                  <figure>
                    {currentShot.sourceImageUrl ? <HoverZoomImage src={currentShot.sourceImageUrl} alt="图1 底图" className={s.contextImage} /> : null}
                    <figcaption>图1 底图</figcaption>
                  </figure>
                  {selectedReferenceIds.map((id, index) => {
                    const reference = referenceCandidates.find((candidate) => candidate.id === id);
                    const label = `图${index + 2} ${reference?.label || '参考图'}`;
                    return <figure key={id}>
                      {reference?.imageUrl
                        ? <HoverZoomImage src={reference.imageUrl} alt={label} className={s.contextImage} />
                        : <span className={s.contextImageEmpty}>暂无预览</span>}
                      <figcaption title={label}>{label}</figcaption>
                    </figure>;
                  })}
                </div>
                {currentShot.latestJobId ? <>
                  <button type="button" className="cap" disabled={redoing || generating} onClick={() => setReferencePickerOpen(true)}>
                    <Icon name="image" size={14} />{`选择本张参考图（${selectedReferenceIds.length}）`}
                  </button>
                  <p className={s.note}>仅用于本张重做；图1是底图，参考图按选择顺序作为图2起发送。</p>
                </> : null}
                {selectableProviders.length > 0 ? (
                  <label className={s.field}>
                    <span>{unifiedSelection ? '模型' : '供应商'}</span>
                    <select className={s.select} aria-label={unifiedSelection ? '模型' : '供应商'} value={effectiveProviderId} onChange={(event) => setRedoProviderId(event.target.value)}>
                      {selectableProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.type === 'unified-image' ? provider.name : `${provider.name}（${provider.model}）`}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {unifiedSelection ? (
                  <p className={s.note}>统一 Image 2 的失败重试和重新生成都会新建一版；确认中任务只续查，不重复提交。</p>
                ) : null}
                {providerSelectionChanged ? (
                  <p className={s.note} data-testid="shot-provider-note">已换供应商：重试和重新生成都会按新供应商多出一版，旧版保留。</p>
                ) : null}
                <label className={s.field}>
                  <span>重做提示词</span>
                  <textarea
                    className={s.textarea}
                    rows={5}
                    value={redoPrompt}
                    onChange={(event) => setRedoPrompt(event.target.value)}
                    placeholder="编辑提示词后点重新生成"
                  />
                </label>
                <p className={s.note}>重新生成会多出一版，旧版保留，可以切回去。</p>
                {shotState === 'failed' && currentShot.jobErrorMessage ? <p className={s.errorText} role="alert">{currentShot.jobErrorMessage}</p> : null}
                {error ? <p className={s.errorText} role="alert">{error}</p> : null}
              </div>
              <button
                type="button"
                className={s.go}
                disabled={redoing || !redoPrompt.trim() || !canRegenerate}
                onClick={() => void redoShot()}
              >{redoing ? '提交中…' : generating ? '生成中…' : '重新生成这一张'}</button>
            </>
          ) : null}
        </>}
      />

      {referencePickerOpen && currentShot ? (
        <Dialog open title="选择本张参考图" description="可多选，再点一次取消；关闭后保留选择，重新生成时生效。" onClose={() => setReferencePickerOpen(false)}
          footer={<>
            <button type="button" className="cap" onClick={() => setRedoReferenceIds([])}>清空参考图</button>
            <button type="button" className="cap" onClick={() => setRedoReferenceIds(null)}>恢复原任务参考图</button>
            <button type="button" className="cap primary" onClick={() => setReferencePickerOpen(false)}>完成选择</button>
          </>}>
          <div className={s.picks}>
            {referenceCandidates.map((candidate) => {
              const index = selectedReferenceIds.indexOf(candidate.id);
              return <div key={candidate.id} className={s.pickWrap}>
                <button type="button" className={s.pick} aria-label={candidate.label} aria-pressed={index >= 0}
                  onClick={() => setRedoReferenceIds(togglePickedId(selectedReferenceIds, candidate.id, referenceCandidates.length))}>
                  {candidate.imageUrl ? <img src={candidate.imageUrl} alt={candidate.label} /> : <span className={s.pickEmpty}>暂无预览</span>}
                  {index >= 0 ? <span className={s.pickNumber}>{`图${index + 2}`}</span> : null}
                </button>
                <p className={s.note}>{candidate.label}</p>
              </div>;
            })}
          </div>
          {referenceCandidates.length === 0 ? <p className={s.note}>当前项目暂无参考图，请先在场景图步骤生成并设为场景参考图。</p> : null}
        </Dialog>
      ) : null}

      {createOpen ? (
        <CreateShotSetDialog
          projectId={projectId}
          assets={shotSourceImages}
          onClose={() => setCreateOpen(false)}
          onUploaded={async () => { await onUploaded(); await loadSets(); }}
          onDeleteAsset={onDeleteAsset}
          onCreated={async (setId) => {
            setCreateOpen(false);
            await loadSets();
            selectSet(setId);
            await onShotChanged();
          }}
        />
      ) : null}

      <Dialog
        open={Boolean(deleteTarget)}
        title="删除这个分镜组？"
        description="分镜、结果版本和它们对应的任务关联会一起删掉，删除后不能恢复。"
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        footer={<>
          <span className={s.dialogFootNote}>{deleteTarget?.name}</span>
          <button type="button" className="cap" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button>
          <button type="button" className="cap cap-primary" disabled={deleting} onClick={() => void confirmDelete()}>
            {deleting ? '删除中…' : '删除分镜组'}
          </button>
        </>}
      >
        <p className={s.note}>这一组有 {deleteTarget?.shotCount ?? 0} 张分镜，其中 {deleteTarget?.approvedCount ?? 0} 张已标可用。</p>
      </Dialog>
    </div>
  );
}

/**
 * 新建分镜组窗口：能继续上传/删图、全选再点取消、点选顺序=镜头顺序、
 * 悬停「设为开场」把任意一张移到第一位。规则实现全在 `lib/workbench-shots.ts`。
 */
function CreateShotSetDialog({
  projectId,
  assets,
  onClose,
  onUploaded,
  onDeleteAsset,
  onCreated,
}: {
  projectId: string;
  assets: WorkbenchImage[];
  onClose: () => void;
  onUploaded: () => void | Promise<void>;
  onDeleteAsset: (assetId: string) => void | Promise<void>;
  onCreated: (setId: string) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [picks, setPicks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 图片被删掉后不能还留在已选里 —— 直接在渲染期派生，避免 effect 回写 state。
  const availableIds = new Set(assets.map((asset) => asset.id));
  const effectivePicks = picks.filter((id) => availableIds.has(id));

  const libraryIds = assets.map((asset) => asset.id);
  const openingId = getOpeningShotId(effectivePicks);

  const updatePicks = (next: (current: string[]) => string[]) => {
    setPicks((current) => next(current.filter((id) => availableIds.has(id))));
  };

  const submit = async () => {
    if (!name.trim() || effectivePicks.length === 0 || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/shot-sets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), shotImageIds: effectivePicks }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !body.id) {
        setError(body.error || '创建失败');
        return;
      }
      await onCreated(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      title="新建分镜组"
      description={`按点选顺序排镜头；第 1 张是开场图，对应视频优先用于单条混剪和批量生产的开头（最多 ${MAX_SHOTS_PER_SET} 张）。`}
      width="wide"
      onClose={() => { if (!saving) onClose(); }}
      footer={<>
        <span className={s.dialogFootNote}>
          已选 {effectivePicks.length}/{MAX_SHOTS_PER_SET} 张{openingId ? '，第 1 张用作开场' : ''}
        </span>
        <button type="button" className="cap" disabled={saving} onClick={onClose}>取消</button>
        <button type="button" className="cap cap-primary" disabled={saving || !name.trim() || effectivePicks.length === 0} onClick={() => void submit()}>
          {saving ? '创建中…' : `创建分镜组（${effectivePicks.length}）`}
        </button>
      </>}
    >
      <div className={s.dialogGrid}>
        <label className={s.field}>
          <span>分镜组名称</span>
          <input
            className={s.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：卧室场景分镜 1-6"
            autoFocus
          />
        </label>

        <div className={s.dialogRow}>
          <span className={s.note}>点一下选中，再点取消；顺序就是镜头顺序。</span>
          <button
            type="button"
            className="cap"
            aria-pressed={effectivePicks.length > 0 && effectivePicks.length === Math.min(libraryIds.length, MAX_SHOTS_PER_SET)}
            onClick={() => updatePicks((current) => toggleSelectAll(current, libraryIds, MAX_SHOTS_PER_SET))}
            disabled={assets.length === 0}
          >{effectivePicks.length > 0 && effectivePicks.length === Math.min(libraryIds.length, MAX_SHOTS_PER_SET) ? '取消全选' : '全选'}</button>
          <UploadDrop
            projectId={projectId}
            usage="shot_source"
            label="继续上传"
            hint="拖入或点击，可多选"
            maxFiles={MAX_SHOTS_PER_SET}
            onUploaded={onUploaded}
            solid
          />
        </div>

        {assets.length === 0 ? (
          <p className={s.note}>还没有原始分镜图。先在上面的投放区传几张，这里会出现可选的图。</p>
        ) : (
          <div className={s.picks}>
            {assets.map((asset) => {
              const index = effectivePicks.indexOf(asset.id);
              const selected = index >= 0;
              return (
                <div key={asset.id} className={s.pickWrap}>
                  <button
                    type="button"
                    className={s.pick}
                    aria-pressed={selected}
                    data-testid="shot-pick"
                    data-picked={selected ? 'true' : 'false'}
                    aria-label={
                      isOpeningShot(effectivePicks, asset.id)
                        ? `${asset.filename}，开场图，第 1 张`
                        : selected ? `${asset.filename}，第 ${index + 1} 张` : asset.filename
                    }
                    onClick={() => updatePicks((current) => togglePickedId(current, asset.id, MAX_SHOTS_PER_SET))}
                  >
                    {asset.imageUrl
                      ? <HoverZoomImage src={asset.imageUrl} alt={asset.filename} className={s.pickImage} />
                      : <span className={s.pickEmpty}><Icon name="image" size={16} /></span>}
                    {selected ? <span className={s.pickNumber}>{index + 1}</span> : null}
                    {isOpeningShot(effectivePicks, asset.id) ? <span className={s.openingBadge}>开场图</span> : null}
                  </button>
                  {selected && !isOpeningShot(effectivePicks, asset.id) ? (
                    <button
                      type="button"
                      className={s.setOpening}
                      data-testid="set-opening"
                      onClick={() => updatePicks((current) => movePickedToFront(current, asset.id))}
                    >设为开场</button>
                  ) : null}
                  <button
                    type="button"
                    className={s.pickDelete}
                    aria-label={`删除 ${asset.filename}`}
                    title="从素材里删掉这张"
                    onClick={async () => {
                      updatePicks((current) => removePickedId(current, asset.id));
                      await onDeleteAsset(asset.id);
                    }}
                  ><Icon name="close" size={11} /></button>
                </div>
              );
            })}
          </div>
        )}

        {effectivePicks.length > 0 ? (
          <p className={s.note}>
            镜头顺序：{effectivePicks.map((id) => assets.find((asset) => asset.id === id)?.filename || id).join(' → ')}
          </p>
        ) : null}
        {error ? <p className={s.errorText} role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
