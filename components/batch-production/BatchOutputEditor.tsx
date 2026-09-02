'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { OutputPresetId } from '@/lib/final-edit/types';
import type { TextStyle } from '@/lib/media-core/cover-types';
import { NARRATION_GAIN_DB_DEFAULT, NARRATION_GAIN_DB_MAX, NARRATION_GAIN_DB_MIN } from '@/lib/media-core/audio-gain';
import type {
  BatchOutputClipEditResult,
  BatchOutputClipEditView,
} from '@/lib/batch-production/output-arrangement';
import { resolveBgmDraftAfterViewLoad, type BatchBgmDraft } from './bgm-draft';
import BatchClipTrimEditor from './BatchClipTrimEditor';
import BatchCoverDraftPreview from './BatchCoverDraftPreview';
import BatchCoverEditorDrawer, { type BatchCoverEditorDraft } from './BatchCoverEditorDrawer';
import BatchTimeline from './BatchTimeline';
import BatchTimelinePreview from './BatchTimelinePreview';
import BatchTextStyleEditor from './BatchTextStyleEditor';

export interface BatchOutputEditorProps {
  projectId: string;
  batchId: string;
  planId: string;
  outputPreset: OutputPresetId;
  /** 外层卡片正在重渲染时传入,编辑控件暂时锁定 */
  renderBusy?: boolean;
  active?: boolean;
  /** 编辑生效后回调,外层据此刷新 workspace(卡片进入渲染中) */
  onChanged?: () => void;
}

interface EditFeedback {
  kind: 'error';
  message: string;
}

/**
 * 「检查成片」片段编辑面板:左侧冻结素材池,中间实时预览与时间轴,右侧成片设置。
 * 自身拉取 arrangement 视图;编辑生效后静默重拉本视图。
 *
 * 渲染时机:编辑期一次都不排渲染(POST 带 deferRender),退出这一轮调整时再
 * commit_render 一次性提交。本面板的预览是客户端实时合成的,不看渲染产物,
 * 而每次微调排一次整片重渲染要 4~7 秒,还会经 renderBusy 把编辑器整个锁死——
 * 用户实测「调一下等一下」就是这么来的。commit 幂等,重复提交不会多排任务。
 */
export default function BatchOutputEditor({
  projectId,
  batchId,
  planId,
  outputPreset,
  renderBusy = false,
  active = true,
  onChanged,
}: BatchOutputEditorProps) {
  const [view, setView] = useState<BatchOutputClipEditView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedSubtitleCueId, setSelectedSubtitleCueId] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [freeformClipId, setFreeformClipId] = useState<string | null>(null);
  const [replaceCandidateId, setReplaceCandidateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [renderPending, setRenderPending] = useState(false);
  const [editFeedback, setEditFeedback] = useState<EditFeedback | null>(null);
  /** BGM 本地草稿：曲目 + 音量 + 淡入 + 淡出共同组成一份 musicDraft，任一字段都可独立弄脏。 */
  const [musicDraft, setMusicDraft] = useState<BatchBgmDraft>({ trackId: null, gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 });
  const [narrationGainDraft, setNarrationGainDraft] = useState(NARRATION_GAIN_DB_DEFAULT);
  const [coverEditorOpen, setCoverEditorOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<'output' | 'material'>('output');
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [subtitleStyleDraft, setSubtitleStyleDraft] = useState<TextStyle | null>(null);
  const [auditioningTrackId, setAuditioningTrackId] = useState<string | null>(null);
  const previewTabRefs = useRef<Record<'output' | 'material', HTMLButtonElement | null>>({ output: null, material: null });
  const pendingRenderRef = useRef(false);
  const inFlightEditRef = useRef<Promise<void> | null>(null);
  const musicDraftRef = useRef<BatchBgmDraft>(musicDraft);
  // React 编译器红线：渲染期不得写 ref。与下方 onChangedRef 同款：在 effect
  // 中同步最新值；读取方（BGM 草稿同步 effect）声明在其后，执行顺序有保证。
  useEffect(() => { musicDraftRef.current = musicDraft; });
  const syncedBgmRef = useRef<{ planId: string | null; music: BatchBgmDraft | null }>({ planId: null, music: null });
  const onChangedRef = useRef(onChanged);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { onChangedRef.current = onChanged; });

  const clipsUrl = `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`;

  const loadView = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const response = await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/arrangement?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.message === 'string' ? body.message : `HTTP ${response.status}`);
      }
      setView(body as BatchOutputClipEditView);
    } catch (error) {
      if (!silent) setLoadError(error instanceof Error ? error.message : '读取成片安排失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [batchId, planId, projectId]);

  /**
   * 提交这一轮欠着的重渲染。keepalive 让卸载/关标签页时请求仍能发出;
   * 只有服务端确认收下才清欠账——失败就留着,让 pagehide 或下一次卸载再补一次。
   * commit_render 按 requestKey 幂等(phase-e.ts:39-50),多提交一次只会拿回同一个任务。
   */
  const commitRender = useCallback((url: string) => {
    if (!pendingRenderRef.current) return;
    const send = () => {
      if (!pendingRenderRef.current) return;
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'commit_render' }),
        keepalive: true,
      }).then((response) => {
        if (!response.ok) return;
        pendingRenderRef.current = false;
        setRenderPending(false);
        onChangedRef.current?.();
      }).catch(() => undefined);
    };
    // 编辑请求与 commit_render 必须保持顺序:组件在请求返回前卸载时,如果
    // commit 先到服务端,它会按旧 arrangement 排任务,随后编辑反而没有新任务。
    const inFlightEdit = inFlightEditRef.current;
    if (inFlightEdit) void inFlightEdit.then(send, send);
    else send();
  }, []);

  useEffect(() => {
    // 换片段计划时重置交互态并重新拉取;统一推迟到宏任务,避免 effect 内同步 setState。
    const timer = window.setTimeout(() => {
      setSelectedClipId(null);
      setSelectedSubtitleCueId(null);
      setPlayheadSec(0);
      setFreeformClipId(null);
      setReplaceCandidateId(null);
      setEditFeedback(null);
      setCoverEditorOpen(false);
      setPreviewMode('output');
      setPreviewAssetId(null);
      setSubtitleStyleDraft(null);
      void loadView();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadView]);

  useEffect(() => {
    // 退出这一轮调整(关闭弹窗/换成片/切步骤)时把欠着的重渲染一次性提交。
    // url 按当次的 projectId/batchId/planId 固化:换成片时提交的必须是上一条的渲染。
    // 关标签页/刷新不会走 React 卸载,只有 pagehide 能兜住(单条走的是 beforeunload)。
    const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`;
    const flush = () => commitRender(url);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [projectId, batchId, planId, commitRender]);

  const clips = useMemo(() => view?.clips ?? [], [view]);
  const poolAssets = useMemo(() => view?.poolAssets ?? [], [view]);
  const assetsById = useMemo(() => new Map(poolAssets.map((asset) => [asset.assetId, asset])), [poolAssets]);
  const previewAssetsById = useMemo(
    () => Object.fromEntries(poolAssets.map((asset) => [asset.assetId, { previewUrl: asset.previewUrl }])),
    [poolAssets],
  );
  const selectedClip = clips.find((clip) => clip.clipId === selectedClipId) ?? null;
  const freeformClip = clips.find((clip) => clip.clipId === freeformClipId) ?? null;
  const pendingReplaceAsset = replaceCandidateId ? assetsById.get(replaceCandidateId) ?? null : null;
  const previewMaterial = previewAssetId ? assetsById.get(previewAssetId) ?? null : null;

  const usedHere = poolAssets.filter((asset) => asset.usedByPlanIds.includes(planId)).length;
  const coverHere = poolAssets.filter((asset) => asset.coverUsedByPlanIds.includes(planId)).length;
  const neverUsed = poolAssets.filter((asset) => asset.usedByPlanIds.length === 0 && asset.coverUsedByPlanIds.length === 0).length;
  const visualSec = (view?.visualDurationUs ?? 0) / 1_000_000;
  const narrationSec = view?.narration.durationUs != null ? view.narration.durationUs / 1_000_000 : null;
  const editLocked = !view?.editable || renderBusy || submitting;
  const syncedNarrationGain = view?.narration.gainDb;
  // BGM 草稿同步决策（纯函数，见 bgm-draft.ts）：换 plan 或服务端真值变化才对齐；
  // 其他编辑命令触发的静默 loadView(true) 一律保留未应用的草稿。
  useEffect(() => {
    if (!view) return;
    const serverMusic: BatchBgmDraft = {
      trackId: view.music.trackId,
      gainDb: view.music.gainDb,
      fadeInSec: view.music.fadeInSec,
      fadeOutSec: view.music.fadeOutSec,
    };
    const resolution = resolveBgmDraftAfterViewLoad({
      planId: view.planId,
      syncedPlanId: syncedBgmRef.current.planId,
      syncedServerMusic: syncedBgmRef.current.music,
      serverMusic,
      currentDraft: musicDraftRef.current,
    });
    syncedBgmRef.current = { planId: resolution.syncedPlanId, music: resolution.syncedServerMusic };
    if (resolution.resync) setMusicDraft(resolution.draft);
  }, [view]);

  useEffect(() => {
    if (syncedNarrationGain === undefined) return;
    const timer = window.setTimeout(() => setNarrationGainDraft(syncedNarrationGain), 0);
    return () => window.clearTimeout(timer);
  }, [syncedNarrationGain]);

  useEffect(() => () => {
    auditionAudioRef.current?.pause();
    auditionAudioRef.current = null;
  }, []);

  const narrationUrl = view?.narration.audioRelativePath
    ? `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/media?kind=narration&projectId=${encodeURIComponent(projectId)}`
    : null;
  const coverUrl = view?.coverAssetId
    ? `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=cover&source=candidate`
    : null;
  const previewBgmTrackId = musicDraft.trackId;
  const previewBgm = useMemo(() => (previewBgmTrackId
    ? {
      fileUrl: `/api/final-edit-bgm/${encodeURIComponent(previewBgmTrackId)}/file`,
      gainDb: musicDraft.gainDb,
      fadeInSec: musicDraft.fadeInSec,
      fadeOutSec: musicDraft.fadeOutSec,
    }
    : null), [previewBgmTrackId, musicDraft.gainDb, musicDraft.fadeInSec, musicDraft.fadeOutSec]);

  async function submitEdit(payload: Record<string, unknown>): Promise<boolean> {
    // split 是纯结构操作(不改像素,不递增 editRevision),其余命令都可能改画面。
    // 响应回来前组件就被卸载时(改完立刻关弹窗),响应里的 visualChanged 没人接得到,
    // 所以先记欠账再发请求;命令实际没生效时最多多发一次幂等的 commit。
    if (payload.type !== 'split') {
      pendingRenderRef.current = true;
    }
    setSubmitting(true);
    setEditFeedback(null);
    let editRequestDone: Promise<void> | null = null;
    try {
      const editRequest = fetch(clipsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, deferRender: true }),
        keepalive: true,
      });
      editRequestDone = editRequest.then(() => undefined, () => undefined);
      inFlightEditRef.current = editRequestDone;
      const response = await editRequest;
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`);
      }
      const editResult = result as BatchOutputClipEditResult;
      if (editResult.changed && editResult.visualChanged) {
        pendingRenderRef.current = true;
        setRenderPending(true);
      }
      // 静默重拉:预览立即吃到新 arrangement(即改即看),不打断当前交互。
      await loadView(true);
      return true;
    } catch (error) {
      setEditFeedback({ kind: 'error', message: error instanceof Error ? error.message : '保存片段修改失败' });
      return false;
    } finally {
      if (inFlightEditRef.current === editRequestDone) inFlightEditRef.current = null;
      setSubmitting(false);
    }
  }


  const handleVariableTrimCommit = async (sourceStartUs: number, sourceEndUs: number): Promise<boolean> => {
    if (!freeformClip) return false;
    return submitEdit({
      type: 'trim_variable',
      clipId: freeformClip.clipId,
      sourceStartUs,
      sourceEndUs,
    });
  };

  const handleSplitCommit = async (offsetUs: number): Promise<boolean> => {
    if (!freeformClip) return false;
    return submitEdit({ type: 'split', clipId: freeformClip.clipId, offsetUs });
  };

  const confirmReplace = async (): Promise<void> => {
    if (!selectedClip || !pendingReplaceAsset) return;
    const accepted = await submitEdit({ type: 'replace', clipId: selectedClip.clipId, assetId: pendingReplaceAsset.assetId });
    if (accepted) setReplaceCandidateId(null);
  };

  const confirmInsertAfter = async (): Promise<void> => {
    if (!selectedClip || !pendingReplaceAsset) return;
    const accepted = await submitEdit({
      type: 'insert',
      assetId: pendingReplaceAsset.assetId,
      afterClipId: selectedClip.clipId,
    });
    if (accepted) setReplaceCandidateId(null);
  };

  const confirmAppendToEnd = async (): Promise<void> => {
    if (!pendingReplaceAsset || clips.length === 0) return;
    const accepted = await submitEdit({
      type: 'insert',
      assetId: pendingReplaceAsset.assetId,
      afterClipId: clips[clips.length - 1].clipId,
    });
    if (accepted) setReplaceCandidateId(null);
  };

  const confirmDelete = async (targetClipId: string): Promise<void> => {
    const target = clips.find((clip) => clip.clipId === targetClipId);
    if (!target || clips.length === 1) return;
    const accepted = window.confirm(
      '删除后后续片段会自动前移，口播仍按原时间播放，需要注意声画对位。确定删除这段吗？',
    );
    if (!accepted) return;
    const result = await submitEdit({ type: 'delete', clipId: target.clipId });
    if (result) {
      setSelectedClipId(null);
      setReplaceCandidateId(null);
    }
  };

  const confirmDeleteSubtitle = (cueId: string): void => {
    if (!window.confirm('删除这条字幕后，口播音频不会改变。确定删除吗？')) return;
    void submitEdit({ type: 'delete_subtitle_cue', cueId }).then((accepted) => {
      if (accepted) setSelectedSubtitleCueId(null);
    });
  };

  const auditionMusic = (trackId: string): void => {
    if (auditioningTrackId === trackId) {
      auditionAudioRef.current?.pause();
      auditionAudioRef.current = null;
      setAuditioningTrackId(null);
      return;
    }
    const audio = new Audio(`/api/final-edit-bgm/${encodeURIComponent(trackId)}/file`);
    audio.onended = () => setAuditioningTrackId(null);
    auditionAudioRef.current?.pause();
    auditionAudioRef.current = audio;
    setAuditioningTrackId(trackId);
    void audio.play().catch(() => setAuditioningTrackId(null));
  };

  const coverAsset = view?.coverAssetId ? assetsById.get(view.coverAssetId) ?? null : null;

  const openCoverEditor = () => {
    if (editLocked) return;
    setCoverEditorOpen(true);
  };

  const applyCover = async (draft: BatchCoverEditorDraft): Promise<boolean> => {
    if (!draft.assetId) return false;
    return submitEdit({
      type: 'set_cover',
      assetId: draft.assetId,
      timeUs: draft.timeUs,
      framing: draft.framing,
      title: draft.title,
    });
  };

  if (loading && !view) {
    return <div className="tile p-6 text-center text-sm text-ink-secondary">正在读取成片安排…</div>;
  }
  if (loadError && !view) {
    return (
      <div className="tile space-y-3 p-6 text-sm">
        <p className="text-fail">读取成片安排失败：{loadError}</p>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void loadView()}>重试</button>
      </div>
    );
  }
  if (!view) return null;

  // BGM 草稿与服务端真值的比较覆盖全部四个字段：曲目、音量、淡入、淡出。
  const musicDraftChanged = musicDraft.trackId !== view.music.trackId
    || musicDraft.gainDb !== view.music.gainDb
    || musicDraft.fadeInSec !== view.music.fadeInSec
    || musicDraft.fadeOutSec !== view.music.fadeOutSec;
  const musicParamsMatchDefaults = musicDraft.gainDb === view.batchMusicDefaults.gainDb
    && musicDraft.fadeInSec === view.batchMusicDefaults.fadeInSec
    && musicDraft.fadeOutSec === view.batchMusicDefaults.fadeOutSec;
  const narrationGainChanged = narrationGainDraft !== view.narration.gainDb;
  const effectiveSubtitleStyleDraft = subtitleStyleDraft ?? view.subtitleStyle;
  const subtitleStyleChanged = JSON.stringify(effectiveSubtitleStyleDraft) !== JSON.stringify(view.subtitleStyle);
  const canResetSubtitleStyle = view.subtitleStyleOverride || subtitleStyleChanged;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3" data-testid={`batch-output-editor-${planId}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline pb-2">
        <span className="text-sm font-semibold text-ink">预览调整</span>
        <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-[11px] text-ink-secondary">{clips.length} 个片段</span>
        <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-[11px] text-ink-secondary">画面 {visualSec.toFixed(1)} 秒</span>
        {narrationSec != null && <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-[11px] text-ink-secondary">口播 {narrationSec.toFixed(1)} 秒</span>}
        <span className="ml-auto text-[11px] text-ink-tertiary">
          本片使用 {usedHere}/{poolAssets.length} 条素材{coverHere > 0 ? ` · 封面 ${coverHere} 条` : ''} · 未使用 {neverUsed} 条
          {view.versionNumber != null && ` · 当前 v${view.versionNumber}`}
        </span>
      </div>

      {!view.outputVersionId && <p className="shrink-0 tile p-3 text-xs text-warn">还没有可编辑的成片版本，请先完成首次渲染。</p>}
      {view.outputVersionId && !view.editable && <p className="shrink-0 tile p-3 text-xs text-warn">批次已停止或输入尚未冻结，当前只能查看，不能调整片段。</p>}
      {renderPending && view.editable && (
        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-hairline bg-surface-subtle p-3 text-xs text-ink-secondary">
          <span className="min-w-0 flex-1">修改已保存，退出本轮调整后会自动重新渲染</span>
          <button
            type="button"
            className="btn-secondary h-8 shrink-0 px-3 text-xs"
            disabled={renderBusy || submitting}
            onClick={() => commitRender(clipsUrl)}
          >
            立即渲染
          </button>
        </div>
      )}
      {editFeedback && (
        <p
          role="alert"
          className="shrink-0 tile p-3 text-xs text-fail"
        >{editFeedback.message}</p>
      )}

      <div className="grid min-h-0 min-w-0 flex-1 gap-3 overflow-y-auto xl:overflow-visible xl:grid-cols-[minmax(254px,280px)_minmax(420px,1fr)_minmax(300px,340px)]">
        <aside className="flex min-h-[320px] min-w-0 flex-col rounded-2xl bg-surface-subtle p-3 xl:min-h-0" aria-label="素材调整">
          <div className="flex shrink-0 items-center gap-2">
            <Icon name="retry" size={15} />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">素材调整</h3>
              <p className="mt-0.5 text-[11px] text-ink-tertiary">冻结素材池 · {poolAssets.length} 条</p>
            </div>
          </div>
          <p className="mt-2 shrink-0 text-[11px] leading-5 text-warn">
            {selectedClip
              ? '先选素材，再替换当前片段或插入到它之后。'
              : '先在中间时间轴选中片段；没有选中时可把素材追加到末尾。'}
          </p>
          <div className="mt-3 shrink-0 rounded-xl border border-hairline bg-surface p-2.5" aria-live="polite">
            <p className="truncate text-[11px] font-medium text-ink" title={pendingReplaceAsset?.displayName}>
              {pendingReplaceAsset ? `已选素材：${pendingReplaceAsset.displayName}` : '尚未选择素材'}
            </p>
            <p className="mt-1 truncate text-[10px] text-ink-tertiary">
              {selectedClip ? `目标：片段 #${clips.findIndex((clip) => clip.clipId === selectedClip.clipId) + 1}` : '目标：追加到末尾'}
            </p>
            {pendingReplaceAsset && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedClip && (
                  <>
                    <button type="button" className="btn-primary h-8 shrink-0 whitespace-nowrap px-2.5 text-[11px]" disabled={editLocked} onClick={() => void confirmReplace()}>{submitting ? '处理中…' : '替换当前'}</button>
                    <button type="button" className="btn-secondary h-8 shrink-0 whitespace-nowrap px-2.5 text-[11px]" disabled={editLocked} onClick={() => void confirmInsertAfter()}>{submitting ? '处理中…' : '插入之后'}</button>
                  </>
                )}
                <button type="button" className="btn-secondary h-8 shrink-0 whitespace-nowrap px-2.5 text-[11px]" disabled={editLocked || clips.length === 0} onClick={() => void confirmAppendToEnd()}>{submitting ? '处理中…' : '追加末尾'}</button>
                <button type="button" className="btn-secondary h-8 shrink-0 whitespace-nowrap px-2.5 text-[11px]" disabled={submitting} onClick={() => setReplaceCandidateId(null)}>取消</button>
              </div>
            )}
          </div>
          <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink">素材列表</p>
            <span className="text-[11px] text-ink-tertiary">已用 {usedHere} · 未用 {neverUsed}</span>
          </div>
          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {poolAssets.map((asset) => {
              // 本片次数 = useCountByPlanId[planId]，其他次数 = 其余计划计数之和；
              // 两数独立计算，同一素材同时用于本片和其他成片时两个徽标并存。
              const thisCount = asset.useCountByPlanId[planId] ?? 0;
              const otherCount = Object.entries(asset.useCountByPlanId)
                .filter(([id]) => id !== planId)
                .reduce((sum, [, count]) => sum + count, 0);
              const usedByThis = thisCount > 0;
              const usedByOthers = otherCount > 0;
              const coverUsedByThis = asset.coverUsedByPlanIds.includes(planId);
              const selectable = !asset.excluded && !editLocked && clips.length > 0;
              const pending = replaceCandidateId === asset.assetId;
              return (
                <div
                  key={asset.assetId}
                  className={'flex min-h-[72px] min-w-0 items-center gap-1 rounded-xl p-1.5 transition ' + (asset.excluded ? 'opacity-45' : 'hover:bg-surface') + (pending ? ' bg-accent/10 ring-2 ring-accent' : '')}
                >
                  <button
                    type="button"
                    disabled={!selectable}
                    aria-pressed={pending}
                    title={asset.excluded ? '该素材已被排除出本批次分配，不可用于替换' : '选择素材「' + asset.displayName + '」'}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-0.5 text-left"
                    onClick={() => setReplaceCandidateId(pending ? null : asset.assetId)}
                  >
                    <span className="relative h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-ink/10">
                      {asset.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={asset.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : <span className="flex h-full items-center justify-center text-[9px] text-ink-tertiary">无图</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={(pending ? 'block truncate text-[11px] font-medium text-accent' : 'block truncate text-[11px] font-medium text-ink')} title={asset.displayName}>{asset.displayName}</span>
                      <span className="mt-0.5 block text-[10px] tabular-nums text-ink-tertiary">{asset.durationSec != null ? asset.durationSec.toFixed(1) + ' 秒' : '时长未知'}</span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {usedByThis && <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-[9px] text-ok">本片已用{thisCount > 1 ? ` ×${thisCount}` : ''}</span>}
                        {coverUsedByThis && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent">本片封面</span>}
                        {usedByOthers && <span className="rounded-full bg-surface px-1.5 py-0.5 text-[9px] text-ink-secondary">其他成片已用{otherCount > 1 ? ` ×${otherCount}` : ''}</span>}
                        {asset.excluded && <span className="rounded-full bg-fail/10 px-1.5 py-0.5 text-[9px] text-fail">已排除</span>}
                      </span>
                    </span>
                    {pending && <Icon name="check" size={13} />}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary h-7 shrink-0 px-2 text-[10px]"
                    aria-label={'预览素材 ' + asset.displayName}
                    disabled={!asset.previewUrl && !asset.thumbnailUrl}
                    onClick={() => {
                      setPreviewAssetId(asset.assetId);
                      setPreviewMode('material');
                    }}
                  >预览</button>
                </div>
              );
            })}
            {poolAssets.length === 0 && <p className="py-6 text-center text-xs text-ink-tertiary">冻结素材池为空</p>}
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-2xl bg-surface-subtle p-3" data-testid="batch-output-middle-scroll-area" aria-label="预览调整">
          <div className="flex flex-col gap-3">
            <section className="flex h-[clamp(360px,58vh,560px)] min-h-[360px] flex-none flex-col overflow-hidden rounded-xl bg-surface p-3" data-testid="batch-output-preview-pane">
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <div
                    className="flex rounded-lg bg-surface-subtle p-1"
                    role="tablist"
                    aria-label="预览内容"
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      const nextMode = previewMode === 'output' ? 'material' : 'output';
                      setPreviewMode(nextMode);
                      previewTabRefs.current[nextMode]?.focus();
                    }}
                  >
                    <button
                      type="button"
                      role="tab"
                      id="batch-output-preview-tab"
                      aria-controls="batch-preview-panel"
                      aria-selected={previewMode === 'output'}
                      tabIndex={previewMode === 'output' ? 0 : -1}
                      ref={(element) => { previewTabRefs.current.output = element; }}
                      className={'rounded-md px-2.5 py-1 text-[11px] ' + (previewMode === 'output' ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary')}
                      onClick={() => setPreviewMode('output')}
                    >成片预览</button>
                    <button
                      type="button"
                      role="tab"
                      id="batch-material-preview-tab"
                      aria-controls="batch-preview-panel"
                      aria-selected={previewMode === 'material'}
                      tabIndex={previewMode === 'material' ? 0 : -1}
                      ref={(element) => { previewTabRefs.current.material = element; }}
                      className={'rounded-md px-2.5 py-1 text-[11px] ' + (previewMode === 'material' ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary')}
                      onClick={() => setPreviewMode('material')}
                    >素材预览</button>
                  </div>
                  <span className="min-w-0 truncate text-[11px] text-ink-tertiary" title={previewMaterial?.displayName}>
                    {previewMode === 'material' ? (previewMaterial?.displayName ?? '请从左侧点击预览') : '实时合成预览'}
                  </span>
                </div>
                <div
                  id="batch-preview-panel"
                  role="tabpanel"
                  aria-labelledby={previewMode === 'output' ? 'batch-output-preview-tab' : 'batch-material-preview-tab'}
                  className="min-h-0 flex-1"
                >
                  {previewMode === 'material' ? (
                    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-xl bg-ink/[.04] p-2" data-testid="batch-output-material-preview">
                      {previewMaterial?.previewUrl ? (
                        <video
                          key={'material-preview-' + previewMaterial.assetId}
                          className="max-h-full max-w-full rounded-lg bg-black object-contain"
                          controls
                          muted
                          playsInline
                          preload="metadata"
                          poster={previewMaterial.thumbnailUrl}
                          aria-label={'素材预览：' + previewMaterial.displayName}
                        >
                          <source src={previewMaterial.previewUrl} type="video/mp4" />
                        </video>
                      ) : previewMaterial?.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={previewMaterial.thumbnailUrl} alt={previewMaterial.displayName} className="max-h-full max-w-full rounded-lg object-contain" />
                      ) : (
                        <p className="text-xs text-ink-tertiary">请从左侧素材列表点击“预览”</p>
                      )}
                      {previewMaterial && <p className="max-w-full truncate text-[11px] text-ink-tertiary" title={previewMaterial.displayName}>{previewMaterial.displayName}</p>}
                    </div>
                  ) : (
                    <BatchTimelinePreview
                      clips={clips}
                      assetsById={previewAssetsById}
                      coverUrl={coverUrl}
                      coverDraft={{ asset: coverAsset, timeUs: view.coverTimeUs, title: view.coverTitle, framing: view.coverFraming }}
                      subtitleCues={view.subtitleCues}
                      subtitleStyle={effectiveSubtitleStyleDraft}
                      narrationUrl={narrationUrl}
                      narrationGainDb={narrationGainDraft}
                      bgm={previewBgm}
                      outputPreset={outputPreset}
                      playheadSec={playheadSec}
                      onSeek={setPlayheadSec}
                      active={active}
                      compact
                    />
                  )}
                </div>
              </div>
            </section>
            <section className="flex-none rounded-xl bg-surface p-3" data-testid="batch-output-timeline-pane">
              <BatchTimeline
                clips={clips}
                assets={poolAssets}
                subtitleCues={view.subtitleCues}
                narrationDurationUs={view.narration.durationUs}
                playheadSec={playheadSec}
                selectedClipId={selectedClipId}
                selectedSubtitleCueId={selectedSubtitleCueId}
                disabled={editLocked}
                onSeek={setPlayheadSec}
                onSelectClip={setSelectedClipId}
                onSelectSubtitleCue={setSelectedSubtitleCueId}
                onTrimVariable={async (clipId, sourceStartUs, sourceEndUs) =>
                  submitEdit({ type: 'trim_variable', clipId, sourceStartUs, sourceEndUs })}
                onSplit={async (clipId, offsetUs) => submitEdit({ type: 'split', clipId, offsetUs })}
                onOpenFineTrim={(clipId) => { setSelectedClipId(clipId); setFreeformClipId(clipId); }}
                onDeleteClip={(clipId) => void confirmDelete(clipId)}
                onSubtitleEdit={submitEdit}
                onDeleteSubtitleCue={confirmDeleteSubtitle}
              />
              {freeformClip && (
                <BatchClipTrimEditor
                  key={freeformClip.clipId}
                  clip={freeformClip}
                  asset={assetsById.get(freeformClip.assetId) ?? null}
                  disabled={editLocked}
                  onTrimCommit={handleVariableTrimCommit}
                  onSplitCommit={handleSplitCommit}
                  onClose={() => setFreeformClipId(null)}
                />
              )}
            </section>
          </div>
        </main>

        <aside className="min-h-0 min-w-0 space-y-3 overflow-y-auto pr-1" data-testid="batch-output-settings-scroll-area" aria-label="成片设置">
          <div className="tile space-y-3 p-3" aria-label="字幕样式">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">字幕样式</p>
              <span className={'rounded-full px-2 py-0.5 text-[11px] ' + (view.subtitleStyleOverride ? 'bg-warn/20 text-warn' : 'bg-ok/10 text-ok')}>{view.subtitleStyleOverride ? '本片覆盖' : '批次默认'}</span>
            </div>
            <p className="text-[11px] leading-5 text-ink-tertiary">这里的样式只覆盖当前成片；字幕文字仍可在下方时间轴拖动、修剪或双击编辑，改字幕不改口播音频。</p>
            <BatchTextStyleEditor
              key={'batch-subtitle-style-' + view.planId}
              label="字幕样式"
              value={effectiveSubtitleStyleDraft}
              outputWidth={outputPreset === '16x9' ? 1920 : 1080}
              disabled={editLocked}
              onChange={setSubtitleStyleDraft}
            />
            <div className="flex flex-wrap justify-end gap-2 border-t border-hairline pt-3">
              <button
                type="button"
                className="btn-secondary h-8 px-3 text-xs"
                disabled={editLocked || !canResetSubtitleStyle}
                onClick={() => {
                  void submitEdit({ type: 'set_subtitle_style', style: null })
                    .then((accepted) => { if (accepted) setSubtitleStyleDraft(null); });
                }}
              >恢复批次默认</button>
              <button
                type="button"
                className="btn-primary h-8 px-3 text-xs"
                disabled={editLocked || !subtitleStyleChanged}
                onClick={() => {
                  void submitEdit({ type: 'set_subtitle_style', style: effectiveSubtitleStyleDraft })
                    .then((accepted) => { if (accepted) setSubtitleStyleDraft(null); });
                }}
              >应用字幕样式</button>
            </div>
            {view.subtitleOverride && <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={editLocked} onClick={() => void submitEdit({ type: 'restore_automatic_subtitles' })}>恢复自动字幕</button>}
          </div>

          <div className="tile space-y-3 p-3" aria-label="成片背景音乐">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">成片背景音乐</p>
              <span className="text-[11px] text-ink-tertiary">每条成片可单独覆盖</span>
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label="成片背景音乐曲目"
                value={musicDraft.trackId ?? ''}
                disabled={editLocked}
                onChange={(event) => setMusicDraft((current) => ({ ...current, trackId: event.target.value || null }))}
                className="h-9 min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink"
              >
                <option value="">关闭 BGM</option>
                {view.musicLibrary.map((track) => <option key={track.id} value={track.id}>{track.filename} · {(track.durationUs / 1_000_000).toFixed(1)} 秒</option>)}
              </select>
              {musicDraft.trackId && <button type="button" className="btn-secondary h-9 shrink-0 px-3 text-xs" disabled={editLocked} onClick={() => auditionMusic(musicDraft.trackId!)}>{auditioningTrackId === musicDraft.trackId ? '停止试听' : '试听'}</button>}
            </div>
            <label className="block text-[11px] text-ink-secondary">音量 {musicDraft.gainDb.toFixed(0)} dB
              <input type="range" min={-60} max={0} step={1} value={musicDraft.gainDb} disabled={editLocked || !musicDraft.trackId} onChange={(event) => setMusicDraft((current) => ({ ...current, gainDb: Number(event.target.value) }))} className="mt-1 w-full" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-ink-secondary">淡入 {musicDraft.fadeInSec.toFixed(1)} 秒
                <input type="range" min={0} max={30} step={0.1} value={musicDraft.fadeInSec} disabled={editLocked || !musicDraft.trackId} onChange={(event) => setMusicDraft((current) => ({ ...current, fadeInSec: Number(event.target.value) }))} className="mt-1 w-full" />
              </label>
              <label className="text-[11px] text-ink-secondary">淡出 {musicDraft.fadeOutSec.toFixed(1)} 秒
                <input type="range" min={0} max={30} step={0.1} value={musicDraft.fadeOutSec} disabled={editLocked || !musicDraft.trackId} onChange={(event) => setMusicDraft((current) => ({ ...current, fadeOutSec: Number(event.target.value) }))} className="mt-1 w-full" />
              </label>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={editLocked || musicParamsMatchDefaults} onClick={() => setMusicDraft((current) => ({ ...current, ...view.batchMusicDefaults }))}>恢复批次默认</button>
              <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={editLocked || !musicDraftChanged} onClick={() => void submitEdit({ type: 'set_music', trackId: musicDraft.trackId, gainDb: musicDraft.gainDb, fadeInSec: musicDraft.fadeInSec, fadeOutSec: musicDraft.fadeOutSec })}>应用 BGM 更改</button>
            </div>
          </div>

          <div className="tile space-y-3 p-3" aria-label="成片口播音量" data-testid="batch-output-narration-volume-card">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">成片口播音量</p>
              <span className="text-[11px] text-ink-tertiary">每条成片可单独覆盖</span>
            </div>
            <p className="text-[11px] leading-5 text-ink-tertiary">只调整当前成片的口播响度，不改变口播内容与时长。</p>
            <label className="block text-[11px] text-ink-secondary">音量 {narrationGainDraft.toFixed(0)} dB
              <input
                aria-label="成片口播音量"
                type="range"
                min={NARRATION_GAIN_DB_MIN}
                max={NARRATION_GAIN_DB_MAX}
                step={1}
                value={narrationGainDraft}
                disabled={editLocked || !narrationUrl}
                onChange={(event) => setNarrationGainDraft(Number(event.target.value))}
                className="mt-1 w-full"
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={editLocked || !narrationGainChanged} onClick={() => { setNarrationGainDraft(NARRATION_GAIN_DB_DEFAULT); void submitEdit({ type: 'set_narration_gain', gainDb: NARRATION_GAIN_DB_DEFAULT }); }}>恢复默认</button>
              <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={editLocked || !narrationGainChanged || !narrationUrl} onClick={() => void submitEdit({ type: 'set_narration_gain', gainDb: narrationGainDraft })}>应用口播音量</button>
            </div>
          </div>

          <div className="tile space-y-3 p-3" aria-label="封面设置">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">视频封面设置</p>
              <span className="text-[11px] text-ink-tertiary">点击进入精调</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <BatchCoverDraftPreview asset={coverAsset} timeUs={view.coverTimeUs} title={view.coverTitle} framing={view.coverFraming} outputPreset={outputPreset} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-ink" title={coverAsset?.displayName}>{coverAsset?.displayName || '尚未设置封面素材'}</p>
                <p className="mt-1 text-[10px] text-ink-tertiary">{coverAsset ? `截帧 ${(view.coverTimeUs / 1_000_000).toFixed(2)} 秒` : '选择视频片段作为封面'}</p>
                <button
                  type="button"
                  className="btn-secondary mt-2 inline-flex h-8 items-center gap-1.5 px-3 text-xs"
                  aria-label="打开视频封面设置"
                  disabled={editLocked || poolAssets.length === 0}
                  onClick={openCoverEditor}
                >
                  封面精调 <span aria-hidden="true">›</span>
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
      <BatchCoverEditorDrawer
        active={coverEditorOpen}
        assets={poolAssets}
        initialAssetId={view.coverAssetId}
        initialTimeUs={view.coverTimeUs}
        title={view.coverTitle}
        framing={view.coverFraming}
        outputPreset={outputPreset}
        busy={editLocked}
        onClose={() => setCoverEditorOpen(false)}
        onApply={applyCover}
      />
    </div>
  );
}
