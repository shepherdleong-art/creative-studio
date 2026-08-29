'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { OutputPresetId } from '@/lib/final-edit/types';
import type {
  BatchOutputClipEditResult,
  BatchOutputClipEditView,
} from '@/lib/batch-production/output-arrangement';
import BatchClipTrimEditor from './BatchClipTrimEditor';
import BatchCoverDraftPreview from './BatchCoverDraftPreview';
import BatchTimeline from './BatchTimeline';
import BatchTimelinePreview from './BatchTimelinePreview';

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
  /** 从成片编辑器跳回批量脚本步骤,供暂不支持的口播变速能力使用。 */
  onJumpToScripts?: () => void;
}

interface EditFeedback {
  kind: 'success' | 'error';
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
  onJumpToScripts,
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
  const [editFeedback, setEditFeedback] = useState<EditFeedback | null>(null);
  const [editWarnings, setEditWarnings] = useState<string[]>([]);
  // 这一轮调整里有画面变化尚未提交渲染。卸载兜底要读最新值,但 effect 不能依赖它
  // (依赖它就会在编辑中途重跑、提前提交),所以 state 与 ref 并存。
  const [pendingRender, setPendingRender] = useState(false);
  const [musicParamsDraft, setMusicParamsDraft] = useState({ gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 });
  const [coverDraftAssetId, setCoverDraftAssetId] = useState<string | null>(null);
  const [coverDraftTimeUs, setCoverDraftTimeUs] = useState(0);
  const [auditioningTrackId, setAuditioningTrackId] = useState<string | null>(null);
  const pendingRenderRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { onChangedRef.current = onChanged; });

  const clipsUrl = `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`;

  const markRenderPending = useCallback((pending: boolean) => {
    pendingRenderRef.current = pending;
    setPendingRender(pending);
  }, []);

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

  useEffect(() => {
    // 换片段计划时重置交互态并重新拉取;统一推迟到宏任务,避免 effect 内同步 setState。
    const timer = window.setTimeout(() => {
      setSelectedClipId(null);
      setSelectedSubtitleCueId(null);
      setPlayheadSec(0);
      setFreeformClipId(null);
      setReplaceCandidateId(null);
      setEditFeedback(null);
      setEditWarnings([]);
      void loadView();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadView]);

  useEffect(() => {
    // 退出这一轮调整(关闭弹窗/换成片/切步骤)时才把欠着的重渲染一次性提交。
    // url 按当次的 projectId/batchId/planId 固化:换成片时提交的必须是上一条的渲染。
    const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(planId)}/clips?projectId=${encodeURIComponent(projectId)}`;
    return () => {
      if (!pendingRenderRef.current) return;
      pendingRenderRef.current = false;
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'commit_render' }),
        keepalive: true,
      }).then(() => onChangedRef.current?.()).catch(() => undefined);
    };
  }, [projectId, batchId, planId]);

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

  const usedHere = poolAssets.filter((asset) => asset.usedByPlanIds.includes(planId)).length;
  const coverHere = poolAssets.filter((asset) => asset.coverUsedByPlanIds.includes(planId)).length;
  const neverUsed = poolAssets.filter((asset) => asset.usedByPlanIds.length === 0 && asset.coverUsedByPlanIds.length === 0).length;
  const visualSec = (view?.visualDurationUs ?? 0) / 1_000_000;
  const narrationSec = view?.narration.durationUs != null ? view.narration.durationUs / 1_000_000 : null;
  const durationDeltaSec = narrationSec == null ? 0 : visualSec - narrationSec;

  const editLocked = !view?.editable || renderBusy || submitting;
  const syncedMusicGain = view?.music.gainDb;
  const syncedMusicFadeIn = view?.music.fadeInSec;
  const syncedMusicFadeOut = view?.music.fadeOutSec;
  const syncedCoverAssetId = view?.coverAssetId;
  const syncedCoverTimeUs = view?.coverTimeUs;

  useEffect(() => {
    if (syncedMusicGain === undefined || syncedMusicFadeIn === undefined || syncedMusicFadeOut === undefined || syncedCoverTimeUs === undefined) return;
    const timer = window.setTimeout(() => {
      setMusicParamsDraft({
        gainDb: syncedMusicGain,
        fadeInSec: syncedMusicFadeIn,
        fadeOutSec: syncedMusicFadeOut,
      });
      setCoverDraftAssetId(syncedCoverAssetId ?? null);
      setCoverDraftTimeUs(syncedCoverTimeUs);
    }, 0);
  // editRevision changes only after a command is accepted, so local slider drafts
  // are not overwritten while the user is moving a control.
    return () => window.clearTimeout(timer);
  }, [syncedCoverAssetId, syncedCoverTimeUs, syncedMusicFadeIn, syncedMusicFadeOut, syncedMusicGain]);

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
  const previewBgm = useMemo(() => (view?.music.trackId
    ? {
      fileUrl: `/api/final-edit-bgm/${encodeURIComponent(view.music.trackId)}/file`,
      gainDb: view.music.gainDb,
      fadeInSec: view.music.fadeInSec,
      fadeOutSec: view.music.fadeOutSec,
    }
    : null), [view]);

  async function submitEdit(payload: Record<string, unknown>): Promise<boolean> {
    setSubmitting(true);
    setEditFeedback(null);
    setEditWarnings([]);
    try {
      const response = await fetch(clipsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, deferRender: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof result.message === 'string' ? result.message : `HTTP ${response.status}`);
      }
      const editResult = result as BatchOutputClipEditResult & { renderTaskId?: string | null };
      setEditWarnings(Array.isArray(editResult.warnings) ? editResult.warnings : []);
      if (editResult.changed && !editResult.visualChanged) {
        setEditFeedback({ kind: 'success', message: '修改已保存，片段已分割，画面总长不变，无需重新渲染。' });
      } else if (editResult.changed) {
        markRenderPending(true);
        const editKind = payload.type === 'set_cover' ? '封面' : payload.type?.toString().startsWith('set_music') ? '音乐' : payload.type?.toString().includes('subtitle') ? '字幕' : '画面';
        setEditFeedback({ kind: 'success', message: `${editKind}修改已保存。退出本轮调整后会自动重新渲染，期间可以接着调。` });
      } else {
        setEditFeedback({ kind: 'success', message: '这次修改没有变化，已保持当前安排。' });
      }
      // 静默重拉:预览立即吃到新 arrangement(即改即看),不打断当前交互。
      await loadView(true);
      return true;
    } catch (error) {
      setEditFeedback({ kind: 'error', message: error instanceof Error ? error.message : '保存片段修改失败' });
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /** 手动提交这一轮调整的重渲染(不必等退出)。幂等:同一 editRevision 不会重复排队。 */
  async function commitPendingRender(): Promise<void> {
    if (!pendingRenderRef.current) return;
    markRenderPending(false);
    try {
      const response = await fetch(clipsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'commit_render' }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setEditFeedback({ kind: 'success', message: '已排队重新渲染，完成后以新成片为准。' });
      onChangedRef.current?.();
    } catch {
      markRenderPending(true);
      setEditFeedback({ kind: 'error', message: '提交重新渲染失败，请重试。' });
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

  const coverAsset = coverDraftAssetId ? poolAssets.find(({ assetId }) => assetId === coverDraftAssetId) ?? null : null;
  const coverDurationUs = coverAsset?.durationSec != null ? Math.max(1, Math.round(coverAsset.durationSec * 1_000_000)) : null;

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

  const coverChanged = coverDraftAssetId !== view.coverAssetId || coverDraftTimeUs !== view.coverTimeUs;
  const musicParamsChanged = musicParamsDraft.gainDb !== view.music.gainDb
    || musicParamsDraft.fadeInSec !== view.music.fadeInSec
    || musicParamsDraft.fadeOutSec !== view.music.fadeOutSec;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid={`batch-output-editor-${planId}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline pb-2">
        <span className="text-sm font-semibold text-ink">预览调整</span>
        <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-[11px] text-ink-secondary">{clips.length} 个片段</span>
        <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-[11px] text-ink-secondary">画面 {visualSec.toFixed(1)} 秒</span>
        {narrationSec != null && <span className={`rounded-full px-2.5 py-1 text-[11px] ${Math.abs(durationDeltaSec) < 0.05 ? 'bg-ok/10 text-ok' : 'bg-warn/15 text-warn'}`}>口播 {narrationSec.toFixed(1)} 秒{Math.abs(durationDeltaSec) < 0.05 ? ' ✓' : ' ⚠'}</span>}
        <span className="ml-auto text-[11px] text-ink-tertiary">
          本片使用 {usedHere}/{poolAssets.length} 条素材{coverHere > 0 ? ` · 封面 ${coverHere} 条` : ''} · 未使用 {neverUsed} 条
          {view.versionNumber != null && ` · 当前 v${view.versionNumber}`}
        </span>
        {pendingRender && (
          <span className="flex w-full items-center justify-end gap-2 text-[11px] text-warn sm:w-auto">
            修改已保存，退出本轮调整后会自动重新渲染
            <button
              type="button"
              className="btn-secondary h-7 shrink-0 whitespace-nowrap px-2 text-[11px]"
              onClick={() => void commitPendingRender()}
            >立即渲染</button>
          </span>
        )}
      </div>

      {!view.outputVersionId && <p className="shrink-0 tile p-3 text-xs text-warn">还没有可编辑的成片版本，请先完成首次渲染。</p>}
      {view.outputVersionId && !view.editable && <p className="shrink-0 tile p-3 text-xs text-warn">批次已停止或输入尚未冻结，当前只能查看，不能调整片段。</p>}
      {renderBusy && <p className="shrink-0 tile p-3 text-xs text-accent">正在按最新画面重新渲染，期间片段编辑暂时锁定。</p>}
      {editFeedback && (
        <p
          role={editFeedback.kind === 'error' ? 'alert' : 'status'}
          className={`shrink-0 tile p-3 text-xs ${editFeedback.kind === 'error' ? 'text-fail' : 'text-ok'}`}
        >{editFeedback.message}</p>
      )}
      {editWarnings.length > 0 && (
        <ul className="shrink-0 tile space-y-1 p-3 text-xs text-warn" role="status">
          {editWarnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {narrationSec != null && Math.abs(durationDeltaSec) >= 0.05 && (
        <p className="shrink-0 tile p-3 text-xs text-warn" role="status">
          {durationDeltaSec > 0
            ? `画面比口播长 ${durationDeltaSec.toFixed(1)} 秒，超出部分渲染时会被裁掉。`
            : `画面比口播短 ${Math.abs(durationDeltaSec).toFixed(1)} 秒，结尾会定格最后一帧补齐。`}
        </p>
      )}

      <div className="grid min-h-0 min-w-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(190px,220px)_minmax(0,1fr)_minmax(250px,300px)] lg:overflow-hidden">
        <aside className="flex min-h-[280px] min-w-0 flex-col rounded-2xl bg-surface-subtle p-3 lg:min-h-0" aria-label="素材调整">
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
          <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {poolAssets.map((asset) => {
              const usedByThis = asset.usedByPlanIds.includes(planId);
              const usedByOthers = !usedByThis && asset.usedByPlanIds.length > 0;
              const coverUsedByThis = asset.coverUsedByPlanIds.includes(planId);
              const selectable = !asset.excluded && !editLocked && clips.length > 0;
              const pending = replaceCandidateId === asset.assetId;
              return (
                <button
                  key={asset.assetId}
                  type="button"
                  disabled={!selectable}
                  aria-pressed={pending}
                  title={asset.excluded ? '该素材已被排除出本批次分配，不可用于替换' : `选择素材「${asset.displayName}」`}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-xl p-1.5 text-left transition ${asset.excluded ? 'opacity-45' : 'hover:bg-surface'} ${pending ? 'bg-accent/10 ring-2 ring-accent' : ''}`}
                  onClick={() => setReplaceCandidateId(pending ? null : asset.assetId)}
                >
                  <span className="relative h-14 w-10 shrink-0 overflow-hidden rounded-lg bg-ink/10">
                    {asset.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={asset.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : <span className="flex h-full items-center justify-center text-[9px] text-ink-tertiary">无图</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[11px] font-medium ${pending ? 'text-accent' : 'text-ink'}`} title={asset.displayName}>{asset.displayName}</span>
                    <span className="mt-0.5 block text-[10px] tabular-nums text-ink-tertiary">{asset.durationSec != null ? `${asset.durationSec.toFixed(1)} 秒` : '时长未知'}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {usedByThis && <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-[9px] text-ok">本片已用</span>}
                      {coverUsedByThis && <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent">本片封面</span>}
                      {usedByOthers && <span className="rounded-full bg-surface px-1.5 py-0.5 text-[9px] text-ink-secondary">其他成片已用</span>}
                      {asset.excluded && <span className="rounded-full bg-fail/10 px-1.5 py-0.5 text-[9px] text-fail">已排除</span>}
                    </span>
                  </span>
                  {pending && <Icon name="check" size={13} />}
                </button>
              );
            })}
            {poolAssets.length === 0 && <p className="py-6 text-center text-xs text-ink-tertiary">冻结素材池为空</p>}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 overflow-y-auto rounded-2xl bg-surface-subtle p-3" aria-label="预览调整">
          <div className="tile space-y-3 p-3">
            <BatchTimelinePreview
              clips={clips}
              assetsById={previewAssetsById}
              coverUrl={coverUrl}
              subtitleCues={view.subtitleCues}
              subtitleStyle={view.subtitleStyle}
              narrationUrl={narrationUrl}
              bgm={previewBgm}
              outputPreset={outputPreset}
              playheadSec={playheadSec}
              onSeek={setPlayheadSec}
              active={active}
            />
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
          </div>
        </main>

        <aside className="min-h-0 min-w-0 space-y-3 overflow-y-auto pr-1" aria-label="成片设置">
          <div className="tile space-y-3 p-3" aria-label="字幕编辑说明">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">字幕样式</p>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${view.subtitleOverride ? 'bg-warn/20 text-warn' : 'bg-ok/10 text-ok'}`}>{view.subtitleOverride ? '手动覆盖' : '自动字幕'}</span>
            </div>
            <p className="text-[11px] leading-5 text-ink-tertiary">字幕样式在脚本步骤统一设置；在中间时间轴可拖动、修剪或双击编辑字幕。改字幕不改口播音频。</p>
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
                value={view.music.trackId ?? ''}
                disabled={editLocked}
                onChange={(event) => void submitEdit({ type: 'set_music_track', trackId: event.target.value || null })}
                className="h-9 min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink"
              >
                <option value="">关闭 BGM</option>
                {view.musicLibrary.map((track) => <option key={track.id} value={track.id}>{track.filename} · {(track.durationUs / 1_000_000).toFixed(1)} 秒</option>)}
              </select>
              {view.music.trackId && <button type="button" className="btn-secondary h-9 shrink-0 px-3 text-xs" disabled={editLocked} onClick={() => auditionMusic(view.music.trackId!)}>{auditioningTrackId === view.music.trackId ? '停止试听' : '试听'}</button>}
            </div>
            <label className="block text-[11px] text-ink-secondary">音量 {musicParamsDraft.gainDb.toFixed(0)} dB
              <input type="range" min={-60} max={0} step={1} value={musicParamsDraft.gainDb} disabled={editLocked || !view.music.trackId} onChange={(event) => setMusicParamsDraft((current) => ({ ...current, gainDb: Number(event.target.value) }))} className="mt-1 w-full" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-ink-secondary">淡入 {musicParamsDraft.fadeInSec.toFixed(1)} 秒
                <input type="range" min={0} max={30} step={0.1} value={musicParamsDraft.fadeInSec} disabled={editLocked || !view.music.trackId} onChange={(event) => setMusicParamsDraft((current) => ({ ...current, fadeInSec: Number(event.target.value) }))} className="mt-1 w-full" />
              </label>
              <label className="text-[11px] text-ink-secondary">淡出 {musicParamsDraft.fadeOutSec.toFixed(1)} 秒
                <input type="range" min={0} max={30} step={0.1} value={musicParamsDraft.fadeOutSec} disabled={editLocked || !view.music.trackId} onChange={(event) => setMusicParamsDraft((current) => ({ ...current, fadeOutSec: Number(event.target.value) }))} className="mt-1 w-full" />
              </label>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={editLocked || !musicParamsChanged} onClick={() => { setMusicParamsDraft(view.batchMusicDefaults); void submitEdit({ type: 'set_music_params', ...view.batchMusicDefaults }); }}>恢复批次默认</button>
              <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={editLocked || !musicParamsChanged} onClick={() => void submitEdit({ type: 'set_music_params', ...musicParamsDraft })}>应用 BGM 参数</button>
            </div>
          </div>

          <div className="tile space-y-3 p-3" aria-label="口播变速">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">口播变速</p>
              <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] text-ink-tertiary">暂不支持</span>
            </div>
            <p className="text-[11px] leading-5 text-ink-tertiary">批量模式下口播速度属于脚本与口播设置，当前成片编辑器不会改变音频时长或音画对位。</p>
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onJumpToScripts}>跳转到脚本步骤</button>
          </div>

          <div className="tile space-y-3 p-3" aria-label="封面设置">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">视频封面设置</p>
              <span className="text-[11px] text-ink-tertiary">独立于画面轨</span>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-20 shrink-0">
                <BatchCoverDraftPreview asset={coverAsset} timeUs={coverDraftTimeUs} title={view.coverTitle} outputPreset={outputPreset} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <select
                  aria-label="编辑器封面素材"
                  value={coverDraftAssetId ?? ''}
                  onChange={(event) => { setCoverDraftAssetId(event.target.value || null); setCoverDraftTimeUs(0); }}
                  disabled={editLocked || poolAssets.length === 0}
                  className="h-9 w-full rounded-lg border border-hairline bg-surface px-2 text-xs text-ink"
                >
                  <option value="">选择封面素材</option>
                  {poolAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.displayName}{asset.durationSec != null ? ` · ${asset.durationSec.toFixed(1)} 秒` : ' · 时长未知'}</option>)}
                </select>
                <p className="truncate text-[10px] text-ink-tertiary" title={coverAsset?.displayName}>{coverAsset ? `${coverAsset.displayName} · ${(coverDraftTimeUs / 1_000_000).toFixed(2)} 秒` : '封面素材不可用'}</p>
              </div>
            </div>
            <input
              type="range"
              aria-label="编辑器封面抽帧时间"
              min={0}
              max={Math.max(0, (coverDurationUs ?? 1) - 1)}
              step={100_000}
              value={coverDraftTimeUs}
              disabled={editLocked || !coverAsset || coverDurationUs == null}
              onChange={(event) => setCoverDraftTimeUs(Number(event.target.value))}
              className="w-full"
            />
            <div className="flex justify-end">
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={editLocked || !coverAsset || coverDurationUs == null || !coverChanged} onClick={() => void submitEdit({ type: 'set_cover', assetId: coverAsset!.assetId, timeUs: Math.min(coverDraftTimeUs, coverDurationUs! - 1) })}>应用封面</button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
