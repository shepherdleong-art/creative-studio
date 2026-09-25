'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { BatchOutputClipEditView, BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import { audioClips } from '@/lib/media-core/audio-edit';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import type { MaterialDragItem, SelectionTarget, TimelineTool, UnifiedFilmState } from './types';
import styles from './batch-unified-review.module.css';
import BatchReviewSubtitleChip from './BatchReviewSubtitleChip';
import AudioWaveform from '@/components/audio/AudioWaveform';
import { subtitleSplitEdit } from './subtitle-edit';
import { videoTrimRange, type VideoTrimRange } from './video-trim';

const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
const FRAME_US = Math.round(1_000_000 / FINAL_EDIT_FPS);
const MIN_CLIP_US = 500_000;
const SNAP_THRESHOLD_PX = 9;

export type ReviewRowFilter = 'all' | 'pending' | 'approved' | 'overlap';

type Arrangement = BatchOutputClipEditView;

export interface BatchReviewTimelineDockProps {
  projectId: string;
  batchId: string;
  films: UnifiedFilmState[];
  selectedPlanId: string | null;
  onSelectFilm: (planId: string) => void;
  selection: SelectionTarget | null;
  onSelectTarget: (target: SelectionTarget | null) => void;
  focusedAssetId: string | null;
  onSelectFocusedAsset: (assetId: string | null) => void;
  playheadSec: number;
  onSeek: (sec: number) => void;
  tool: TimelineTool;
  onToolChange: (tool: TimelineTool) => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  poolAssets: BatchOutputPoolAssetView[];
  onToggleEye: (planId: string) => void;
  onTogglePlanSelect: (planId: string, selected: boolean) => void;
  selectedPlanIds: string[];
  onSelectAll: () => void;
  onReview: (decision: 'approved' | 'rework' | 'cancelled') => void;
  /** v14 行筛选:全部 / 待检查 / 已确认 / 区间重复(只影响行展示,不改数据与眼睛)。 */
  rowFilter: ReviewRowFilter;
  onRowFilterChange: (filter: ReviewRowFilter) => void;
  /** v14「显示全部轨道」:恢复所有眼睛可见性。 */
  onShowAll: () => void;
  /** 批次控制状态;stopped 时不再提供「换一批画面」。 */
  batchControlState: 'running' | 'paused' | 'stopped';
  /** Phase E 单条任务重试/重分配的进行中标记。 */
  phaseEBusy: string | null;
  onReallocate: (planId: string) => void;
  onRetryNarration: (taskId: string) => void;
  onRetryRender: (taskId: string) => void;
  onMediaEdit: (planId: string, edit: Record<string, unknown>) => Promise<boolean>;
  onRefreshFilm: (planId: string) => Promise<void>;
  onOpenCoverEditor: (planId: string) => void;
}

/** 取某成片指定音轨的片段列表与源音频总时长。 */
function audioTrackInfo(arrangement: Arrangement | null, track: 'narration' | 'bgm', fallbackDurationUs: number) {
  if (!arrangement) return { clips: [] as ReturnType<typeof audioClips>, sourceDurationUs: fallbackDurationUs };
  if (track === 'narration') {
    const durationUs = arrangement.narration?.durationUs ?? fallbackDurationUs;
    return { clips: audioClips({ audio: arrangement.audio }, 'narration', durationUs), sourceDurationUs: durationUs };
  }
  const bgmSourceUs = arrangement.musicLibrary?.find((t) => t.id === arrangement.music?.trackId)?.durationUs
    ?? arrangement.narration?.durationUs
    ?? fallbackDurationUs;
  const spanUs = arrangement.narration?.durationUs ?? fallbackDurationUs;
  return { clips: audioClips({ audio: arrangement.audio }, 'bgm', spanUs), sourceDurationUs: bgmSourceUs };
}

export default function BatchReviewTimelineDock({
  projectId,
  batchId,
  films,
  selectedPlanId,
  onSelectFilm,
  selection,
  onSelectTarget,
  focusedAssetId,
  onSelectFocusedAsset,
  playheadSec,
  onSeek,
  tool,
  onToolChange,
  snapEnabled,
  onToggleSnap,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  poolAssets,
  onToggleEye,
  onTogglePlanSelect,
  selectedPlanIds,
  onSelectAll,
  onReview,
  rowFilter,
  onRowFilterChange,
  onShowAll,
  batchControlState,
  phaseEBusy,
  onReallocate,
  onRetryNarration,
  onRetryRender,
  onMediaEdit,
  onRefreshFilm,
  onOpenCoverEditor,
}: BatchReviewTimelineDockProps) {
  const [zoom, setZoom] = useState(60); // px per second
  const scrollRef = useRef<HTMLDivElement>(null);
  const [snapLinePx, setSnapLinePx] = useState<number | null>(null);
  const [snapLineLabel, setSnapLineLabel] = useState<string>('');

  // Drop target during material drag
  const [dropTarget, setDropTarget] = useState<{
    planId: string;
    type: 'replace' | 'insert' | 'append';
    clipId?: string;
    afterClipId?: string | null;
  } | null>(null);

  // 视频/音频主体移动的会话草稿:拖动中即时反馈,松手只持久化一次,Esc 取消不落数据。
  const [moveDraft, setMoveDraft] = useState<{
    planId: string;
    kind: 'clip' | 'audio';
    track?: 'narration' | 'bgm';
    clipId: string;
    startSec: number;
    originSec: number;
  } | null>(null);

  const [trimDraft, setTrimDraft] = useState<(VideoTrimRange & { planId: string; clipId: string }) | null>(null);
  const [trimHint, setTrimHint] = useState<string | null>(null);
  const cancelTrimRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelTrimRef.current?.(), [films]);

  // Keyboard shortcut dialog modal state
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Maximum duration across all films
  const maxFilmDurationSec = useMemo(() => {
    let maxSec = 15;
    for (const f of films) {
      if (f.durationSec > maxSec) maxSec = f.durationSec;
    }
    return maxSec;
  }, [films]);

  const totalTimelineSec = maxFilmDurationSec + 2; // extra padding at end
  const totalTrackPx = totalTimelineSec * zoom;

  // Assets lookup map
  const poolAssetsById = useMemo(() => new Map(poolAssets.map((a) => [a.assetId, a])), [poolAssets]);

  // 当前预览成片 = 从上往下第一条眼睛可见的成片(T-02)
  const previewPlanId = useMemo(() => films.find((f) => f.visible)?.planId ?? null, [films]);

  // v14 行筛选:pending/approved 只隐藏不匹配的行;overlap 保留全部行,仅调暗无区间重复的片段。
  const visibleRows = useMemo(() => {
    if (rowFilter === 'pending') return films.filter((f) => !f.approved);
    if (rowFilter === 'approved') return films.filter((f) => f.approved);
    return films;
  }, [films, rowFilter]);

  const pendingCount = useMemo(() => films.filter((f) => !f.approved).length, [films]);
  const approvedCount = useMemo(() => films.filter((f) => f.approved).length, [films]);
  const approvableCount = useMemo(() => films.filter((f) => f.approvable).length, [films]);

  // 区间重复:跨成片取用同一素材且源区间相交的片段集合(筛选激活时调暗其余片段)。
  const overlapClipIds = useMemo(() => {
    if (rowFilter !== 'overlap') return null;
    const byAsset = new Map<string, Array<{ planId: string; clipId: string; s: number; e: number }>>();
    for (const film of films) {
      for (const c of film.arrangement?.clips ?? []) {
        const list = byAsset.get(c.assetId) ?? [];
        list.push({ planId: film.planId, clipId: c.clipId, s: c.sourceStartUs, e: c.sourceEndUs });
        byAsset.set(c.assetId, list);
      }
    }
    const set = new Set<string>();
    for (const list of byAsset.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.planId === b.planId) continue;
          if (Math.min(a.e, b.e) > Math.max(a.s, b.s)) {
            set.add(a.clipId);
            set.add(b.clipId);
          }
        }
      }
    }
    return set;
  }, [films, rowFilter]);

  // Compute repeat statistics for the focused or selected clip's asset(全批次,含筛选隐藏行)
  const activeAssetId = useMemo(() => {
    if (focusedAssetId) return focusedAssetId;
    if (selection?.kind === 'clip' && selection.clipId && selectedPlanId) {
      const film = films.find((f) => f.planId === selectedPlanId);
      const clip = film?.arrangement?.clips?.find((c) => c.clipId === selection.clipId);
      return clip?.assetId ?? null;
    }
    return null;
  }, [focusedAssetId, selection, selectedPlanId, films]);

  const repeatStats = useMemo(() => {
    if (!activeAssetId) return null;
    const asset = poolAssetsById.get(activeAssetId);
    let totalUses = 0;
    const filmIds = new Set<string>();

    for (const film of films) {
      const clips = film.arrangement?.clips ?? [];
      for (const c of clips) {
        if (c.assetId === activeAssetId) {
          totalUses++;
          filmIds.add(film.planId);
        }
      }
    }

    return {
      assetId: activeAssetId,
      displayName: asset?.displayName || '选中素材',
      filmCount: filmIds.size,
      totalCount: totalUses,
    };
  }, [activeAssetId, films, poolAssetsById]);

  // 磁吸候选:0、共同播放头、所有可见成片的视频/字幕/音频边界(T-06)
  const snapCandidates = useMemo(() => {
    const secs: number[] = [0, playheadSec];
    for (const film of films) {
      if (!film.visible) continue;
      const arrangement = film.arrangement;
      if (!arrangement) continue;
      for (const c of arrangement.clips ?? []) {
        secs.push(c.timelineStartUs / 1e6, c.timelineEndUs / 1e6);
      }
      for (const cue of arrangement.subtitleCues ?? []) {
        secs.push(cue.startUs / 1e6, cue.endUs / 1e6);
      }
      const narration = audioTrackInfo(arrangement, 'narration', film.durationSec * 1e6);
      for (const ac of narration.clips) secs.push(ac.timelineStartUs / 1e6, ac.timelineEndUs / 1e6);
      if (arrangement.music?.trackId) {
        const bgm = audioTrackInfo(arrangement, 'bgm', film.durationSec * 1e6);
        for (const ac of bgm.clips) secs.push(ac.timelineStartUs / 1e6, ac.timelineEndUs / 1e6);
      }
    }
    return secs;
  }, [films, playheadSec]);

  /** 邻近磁吸:返回吸附后的时间与标签;Alt 按下时临时关闭(T-06)。 */
  const findSnap = useCallback(
    (targetSec: number, altKey = false): { sec: number; label: string } | null => {
      if (!snapEnabled || altKey) return null;
      const threshold = SNAP_THRESHOLD_PX / zoom;
      let best: number | null = null;
      let bestDiff = threshold;
      for (const s of snapCandidates) {
        const diff = Math.abs(s - targetSec);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = s;
        }
      }
      return best == null ? null : { sec: best, label: `${best.toFixed(2)}s` };
    },
    [snapCandidates, snapEnabled, zoom]
  );

  // Playhead dragging
  const handleSeekPointer = useCallback(
    (clientX: number, altKey = false) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      // Account for ruler label (220px) + cover label (64px) = 284px
      const trackLeft = rect.left + 284 - scroll.scrollLeft;
      const pointerOffset = clientX - trackLeft;
      const targetSec = Math.max(0, pointerOffset / zoom);

      const snapped = findSnap(targetSec, altKey);
      if (snapped) {
        setSnapLinePx(snapped.sec * zoom);
        setSnapLineLabel(snapped.label);
        onSeek(snapped.sec);
        return;
      }

      setSnapLinePx(null);
      onSeek(targetSec);
    },
    [findSnap, onSeek, zoom]
  );

  const beginPlayheadDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    handleSeekPointer(e.clientX, e.altKey);

    const onMove = (moveEvent: Event) => {
      const pointer = moveEvent as PointerEvent;
      handleSeekPointer(pointer.clientX, pointer.altKey);
    };
    const onUp = (upEvent: Event) => {
      setSnapLinePx(null);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      const pId = (upEvent as PointerEvent).pointerId;
      if (pId !== undefined && target.hasPointerCapture(pId)) {
        target.releasePointerCapture(pId);
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp, { once: true });
  };

  // Trim drafts obey source, neighbour and minimum-duration bounds before saving.
  const beginTrimDrag = (
    e: React.PointerEvent,
    film: UnifiedFilmState,
    clipId: string,
    edge: 'start' | 'end'
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const arrangement = film.arrangement;
    const clip = arrangement?.clips.find(c => c.clipId === clipId);
    if (!clip || !arrangement?.editable || tool !== 'select') return;
    cancelTrimRef.current?.();
    const asset = poolAssetsById.get(clip.assetId);
    const durationUs = asset?.durationSec ? Math.round(asset.durationSec * 1e6) : null;
    if (durationUs === null) { setTrimHint('素材时长尚未就绪，暂时无法修剪'); return; }
    const startX = e.clientX;
    const originUs = edge === 'start' ? clip.timelineStartUs : clip.timelineEndUs;
    let latest: VideoTrimRange = clip;
    let moved = false;
    setTrimHint(null);
    const move = (pointer: PointerEvent) => {
      if (!moved && Math.abs(pointer.clientX - startX) < 2) return;
      moved = true;
      const rawSec = originUs / 1e6 + (pointer.clientX - startX) / zoom;
      const snap = findSnap(rawSec, pointer.altKey);
      const requestedUs = (snap?.sec ?? rawSec) * 1e6;
      latest = videoTrimRange(clip, arrangement.clips, edge, requestedUs, durationUs);
      const actualUs = edge === 'start' ? latest.timelineStartUs : latest.timelineEndUs;
      const limited = Math.abs(actualUs - requestedUs) > 1e6 / FINAL_EDIT_FPS;
      setTrimHint(limited ? '已到修剪边界：不能覆盖相邻片段、超出素材或短于 0.5 秒' : `修剪时长 ${((latest.timelineEndUs - latest.timelineStartUs) / 1e6).toFixed(2)} 秒`);
      setSnapLinePx(snap && !limited ? actualUs / 1e6 * zoom : null);
      setSnapLineLabel(snap?.label ?? '');
      setTrimDraft({ ...latest, planId: film.planId, clipId });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      cancelTrimRef.current = null;
      setSnapLinePx(null);
    };
    const cancel = () => { cleanup(); setTrimDraft(null); setTrimHint(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    const up = async (pointer: PointerEvent) => {
      move(pointer);
      cleanup();
      try {
        if (moved && (latest.sourceStartUs !== clip.sourceStartUs || latest.sourceEndUs !== clip.sourceEndUs)) {
          await onMediaEdit(film.planId, { type: 'trim_variable', clipId, sourceStartUs: latest.sourceStartUs, sourceEndUs: latest.sourceEndUs });
        }
      } finally { setTrimDraft(null); }
    };
    cancelTrimRef.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
    window.addEventListener('blur', cancel, { once: true });
    window.addEventListener('keydown', key, true);
  };

  // 视频主体移动:拖动中草稿即时反馈,跨过相邻片段中心换序由后端 planClipPosition 落定;
  // 松手持久化一次,Esc/取消拖动不落数据(T-04、A18)。
  const beginClipBodyPointer = (
    e: React.PointerEvent,
    film: UnifiedFilmState,
    clipId: string
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const clip = film.arrangement?.clips.find((c) => c.clipId === clipId);
    if (!clip) return;

    const originStartSec = clip.timelineStartUs / 1e6;
    const startX = e.clientX;
    let dragged = false;
    let finalStartSec = originStartSec;

    const computeStartSec = (clientX: number, altKey: boolean): number => {
      const rawSec = Math.max(0, originStartSec + (clientX - startX) / zoom);
      const snapped = findSnap(rawSec, altKey);
      if (snapped) {
        setSnapLinePx(snapped.sec * zoom);
        setSnapLineLabel(snapped.label);
        return snapped.sec;
      }
      setSnapLinePx(null);
      return rawSec;
    };

    const finishClick = (clickX: number) => {
      onSelectFilm(film.planId);
      onSelectTarget({ planId: film.planId, kind: 'clip', clipId });
      if (tool === 'split') {
        const scroll = scrollRef.current;
        if (!scroll) return;
        const trackRect = scroll.getBoundingClientRect();
        const trackLeft = trackRect.left + 284 - scroll.scrollLeft;
        const clickTimelineSec = (clickX - trackLeft) / zoom;
        const clipStartSec = clip.timelineStartUs / 1e6;
        const offsetUs = Math.round((clickTimelineSec - clipStartSec) * 1e6);
        if (offsetUs >= MIN_CLIP_US && clip.sourceEndUs - clip.sourceStartUs - offsetUs >= MIN_CLIP_US) {
          void onMediaEdit(film.planId, { type: 'split', clipId, offsetUs }).then(() => onRefreshFilm(film.planId));
        }
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!dragged && Math.abs(moveEvent.clientX - startX) < 4) return;
      if (!dragged && tool !== 'select') return; // 分割工具下不进入移动
      dragged = true;
      finalStartSec = computeStartSec(moveEvent.clientX, moveEvent.altKey);
      setMoveDraft({ planId: film.planId, kind: 'clip', clipId, startSec: finalStartSec, originSec: originStartSec });
    };

    const cleanup = () => {
      setSnapLinePx(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyCancel, true);
    };

    const onUp = async (upEvent: PointerEvent) => {
      cleanup();
      if (!dragged) {
        finishClick(upEvent.clientX);
        return;
      }
      setMoveDraft(null);
      const snappedUs = Math.round(finalStartSec * 1e6 / FRAME_US) * FRAME_US;
      if (snappedUs !== clip.timelineStartUs) {
        await onMediaEdit(film.planId, { type: 'move_clip', clipId, startUs: snappedUs });
        await onRefreshFilm(film.planId);
      }
    };

    const onKeyCancel = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || !dragged) return;
      keyEvent.stopPropagation();
      cleanup();
      setMoveDraft(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('keydown', onKeyCancel, true);
  };

  // 音频边缘修剪:源区间与时间轴同步伸缩,受源时长/邻接/0.5 秒限制(T-05)
  const beginAudioTrimDrag = (
    e: React.PointerEvent,
    film: UnifiedFilmState,
    track: 'narration' | 'bgm',
    clipId: string,
    edge: 'start' | 'end'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const arrangement = film.arrangement;
    if (!arrangement) return;
    const { clips: trackClips, sourceDurationUs } = audioTrackInfo(arrangement, track, film.durationSec * 1e6);
    const index = trackClips.findIndex((c) => c.id === clipId);
    if (index < 0) return;
    const clip = trackClips[index];
    const prev = index > 0 ? trackClips[index - 1] : null;
    const next = index + 1 < trackClips.length ? trackClips[index + 1] : null;

    const startX = e.clientX;
    const edgeTimelineSec = (edge === 'start' ? clip.timelineStartUs : clip.timelineEndUs) / 1e6;

    const computeDeltaUs = (clientX: number, altKey: boolean): number => {
      const rawTimelineSec = edgeTimelineSec + (clientX - startX) / zoom;
      const snapped = findSnap(rawTimelineSec, altKey);
      if (snapped) {
        setSnapLinePx(snapped.sec * zoom);
        setSnapLineLabel(snapped.label);
        return Math.round((snapped.sec - edgeTimelineSec) * 1e6);
      }
      setSnapLinePx(null);
      return Math.round(((clientX - startX) / zoom) * 1e6);
    };

    const onMove = (moveEvent: PointerEvent) => {
      computeDeltaUs(moveEvent.clientX, moveEvent.altKey);
    };

    const cleanup = () => {
      setSnapLinePx(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyCancel, true);
    };

    const onUp = async (upEvent: PointerEvent) => {
      cleanup();
      const deltaUs = computeDeltaUs(upEvent.clientX, upEvent.altKey);
      if (deltaUs === 0) return;

      let newSourceStart = clip.sourceStartUs;
      let newSourceEnd = clip.sourceEndUs;
      let newTimelineStart = clip.timelineStartUs;
      let newTimelineEnd = clip.timelineEndUs;

      if (edge === 'start') {
        const minTimeline = prev ? prev.timelineEndUs : 0;
        const delta = clamp(deltaUs, Math.max(-clip.sourceStartUs, minTimeline - clip.timelineStartUs), clip.sourceEndUs - MIN_CLIP_US - clip.sourceStartUs);
        newSourceStart = clip.sourceStartUs + delta;
        newTimelineStart = clip.timelineStartUs + delta;
      } else {
        const maxTimeline = next ? next.timelineStartUs : Infinity;
        const delta = clamp(
          deltaUs,
          clip.sourceStartUs + MIN_CLIP_US - clip.sourceEndUs,
          Math.min(sourceDurationUs - clip.sourceEndUs, maxTimeline - clip.timelineEndUs)
        );
        newSourceEnd = clip.sourceEndUs + delta;
        newTimelineEnd = clip.timelineEndUs + delta;
      }

      if (newSourceStart === clip.sourceStartUs && newSourceEnd === clip.sourceEndUs) return;
      await onMediaEdit(film.planId, {
        type: 'trim_audio_clip',
        track,
        clipId,
        sourceStartUs: newSourceStart,
        sourceEndUs: newSourceEnd,
        timelineStartUs: newTimelineStart,
        timelineEndUs: newTimelineEnd,
      });
      await onRefreshFilm(film.planId);
    };

    const onKeyCancel = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.stopPropagation();
      cleanup();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('keydown', onKeyCancel, true);
  };

  // 音频主体移动:只改时间轴播放位置,不改源区间(T-05)
  const beginAudioBodyPointer = (
    e: React.PointerEvent,
    film: UnifiedFilmState,
    track: 'narration' | 'bgm',
    clipId: string
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const arrangement = film.arrangement;
    if (!arrangement) return;
    const { clips: trackClips } = audioTrackInfo(arrangement, track, film.durationSec * 1e6);
    const index = trackClips.findIndex((c) => c.id === clipId);
    if (index < 0) return;
    const clip = trackClips[index];
    const prev = index > 0 ? trackClips[index - 1] : null;
    const next = index + 1 < trackClips.length ? trackClips[index + 1] : null;
    const lengthUs = clip.timelineEndUs - clip.timelineStartUs;
    const minSec = (prev ? prev.timelineEndUs : 0) / 1e6;
    const maxSec = (next ? next.timelineStartUs : totalTimelineSec * 1e6) / 1e6 - lengthUs / 1e6;

    const originStartSec = clip.timelineStartUs / 1e6;
    const startX = e.clientX;
    let dragged = false;
    let finalStartSec = originStartSec;

    const computeStartSec = (clientX: number, altKey: boolean): number => {
      const rawSec = clamp(originStartSec + (clientX - startX) / zoom, minSec, Math.max(minSec, maxSec));
      const snapped = findSnap(rawSec, altKey);
      if (snapped) {
        const snappedSec = clamp(snapped.sec, minSec, Math.max(minSec, maxSec));
        setSnapLinePx(snappedSec * zoom);
        setSnapLineLabel(snapped.label);
        return snappedSec;
      }
      setSnapLinePx(null);
      return rawSec;
    };

    const splitAudioAt = (targetFilm: UnifiedFilmState, targetTrack: 'narration' | 'bgm', targetClipId: string, timelineSec: number) => {
      const atUs = Math.round(timelineSec * 1e6);
      if (atUs - clip.timelineStartUs < MIN_CLIP_US || clip.timelineEndUs - atUs < MIN_CLIP_US) return;
      void onMediaEdit(targetFilm.planId, { type: 'split_audio_clip', track: targetTrack, clipId: targetClipId, atUs }).then(() =>
        onRefreshFilm(targetFilm.planId)
      );
    };

    const finishClick = (clickX: number) => {
      onSelectFilm(film.planId);
      onSelectTarget({ planId: film.planId, kind: 'audio', track, clipId });
      if (tool === 'split') {
        const scroll = scrollRef.current;
        if (!scroll) return;
        const trackRect = scroll.getBoundingClientRect();
        const trackLeft = trackRect.left + 284 - scroll.scrollLeft;
        const clickTimelineSec = (clickX - trackLeft) / zoom;
        splitAudioAt(film, track, clipId, clickTimelineSec);
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!dragged && Math.abs(moveEvent.clientX - startX) < 4) return;
      if (!dragged && tool !== 'select') return;
      dragged = true;
      finalStartSec = computeStartSec(moveEvent.clientX, moveEvent.altKey);
      setMoveDraft({ planId: film.planId, kind: 'audio', track, clipId, startSec: finalStartSec, originSec: originStartSec });
    };

    const cleanup = () => {
      setSnapLinePx(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyCancel, true);
    };

    const onUp = async (upEvent: PointerEvent) => {
      cleanup();
      if (!dragged) {
        finishClick(upEvent.clientX);
        return;
      }
      setMoveDraft(null);
      const startUs = Math.round(finalStartSec * 1e6);
      if (startUs !== clip.timelineStartUs) {
        await onMediaEdit(film.planId, { type: 'move_audio_clip', track, clipId, timelineStartUs: startUs });
        await onRefreshFilm(film.planId);
      }
    };

    const onKeyCancel = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || !dragged) return;
      keyEvent.stopPropagation();
      cleanup();
      setMoveDraft(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('keydown', onKeyCancel, true);
  };

  // 「分割当前」:在播放头切开选中的视频或音频片段(⌘/Ctrl+B 同效)
  const splitSelectedAtPlayhead = useCallback(() => {
    if (!selectedPlanId || !selection) return;
    const film = films.find((f) => f.planId === selectedPlanId);
    if (!film?.arrangement) return;
    const playheadUs = Math.round(playheadSec * 1e6);

    if (selection.kind === 'clip' && selection.clipId) {
      const clip = film.arrangement.clips.find((c) => c.clipId === selection.clipId);
      if (!clip) return;
      const offsetUs = playheadUs - clip.timelineStartUs;
      if (offsetUs >= MIN_CLIP_US && clip.sourceEndUs - clip.sourceStartUs - offsetUs >= MIN_CLIP_US) {
        void onMediaEdit(selectedPlanId, { type: 'split', clipId: clip.clipId, offsetUs }).then(() => onRefreshFilm(selectedPlanId));
      }
    } else if (selection.kind === 'subtitle' && selection.cueId) {
      const cue = film.arrangement.subtitleCues.find(c => c.id === selection.cueId);
      const edit = cue ? subtitleSplitEdit(cue, playheadUs) : null;
      if (edit && film.arrangement.editable) void onMediaEdit(selectedPlanId, edit);
    } else if (selection.kind === 'audio' && selection.track && selection.clipId) {
      const { clips: trackClips } = audioTrackInfo(film.arrangement, selection.track, film.durationSec * 1e6);
      const clip = trackClips.find((c) => c.id === selection.clipId);
      if (!clip) return;
      if (playheadUs - clip.timelineStartUs >= MIN_CLIP_US && clip.timelineEndUs - playheadUs >= MIN_CLIP_US) {
        void onMediaEdit(selectedPlanId, { type: 'split_audio_clip', track: selection.track, clipId: clip.id, atUs: playheadUs }).then(() =>
          onRefreshFilm(selectedPlanId)
        );
      }
    }
  }, [films, onMediaEdit, onRefreshFilm, playheadSec, selectedPlanId, selection]);

  // 「删除」:删除选中视频/字幕/音频片段,保留空位(Delete 同效)
  const deleteSelection = useCallback(() => {
    if (!selectedPlanId || !selection) return;
    if (selection.kind === 'clip' && selection.clipId) {
      void onMediaEdit(selectedPlanId, { type: 'delete', clipId: selection.clipId });
      onSelectTarget(null);
    } else if (selection.kind === 'subtitle' && selection.cueId) {
      void onMediaEdit(selectedPlanId, { type: 'delete_subtitle_cue', cueId: selection.cueId });
      onSelectTarget(null);
    } else if (selection.kind === 'audio' && selection.track && selection.clipId) {
      void onMediaEdit(selectedPlanId, { type: 'delete_audio_clip', track: selection.track, clipId: selection.clipId });
      onSelectTarget(null);
    }
  }, [onMediaEdit, onSelectTarget, selectedPlanId, selection]);

  const canSplitSelection = useMemo(() => {
    if (!selection || !selectedPlanId) return false;
    const film = films.find((f) => f.planId === selectedPlanId);
    if (!film?.arrangement) return false;
    const playheadUs = Math.round(playheadSec * 1e6);
    if (selection.kind === 'clip' && selection.clipId) {
      const clip = film.arrangement.clips.find((c) => c.clipId === selection.clipId);
      if (!clip) return false;
      const offsetUs = playheadUs - clip.timelineStartUs;
      return offsetUs >= MIN_CLIP_US && clip.sourceEndUs - clip.sourceStartUs - offsetUs >= MIN_CLIP_US;
    }
    if (selection.kind === 'subtitle' && selection.cueId) {
      const cue = film.arrangement.subtitleCues.find(c => c.id === selection.cueId);
      return film.arrangement.editable && !!(cue && subtitleSplitEdit(cue, playheadUs));
    }
    if (selection.kind === 'audio' && selection.track && selection.clipId) {
      const { clips: trackClips } = audioTrackInfo(film.arrangement, selection.track, film.durationSec * 1e6);
      const clip = trackClips.find((c) => c.id === selection.clipId);
      if (!clip) return false;
      return playheadUs - clip.timelineStartUs >= MIN_CLIP_US && clip.timelineEndUs - playheadUs >= MIN_CLIP_US;
    }
    return false;
  }, [films, playheadSec, selectedPlanId, selection]);

  const canDeleteSelection = Boolean(
    selection && (selection.kind === 'clip' || selection.kind === 'subtitle' || selection.kind === 'audio')
  );

  // Drag and Drop Material Handling
  const handleDragOver = (e: React.DragEvent, target: typeof dropTarget) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(target);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!dropTarget) return;
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const item: MaterialDragItem = JSON.parse(json);
      const target = dropTarget;
      setDropTarget(null);

      if (target.type === 'replace' && target.clipId) {
        await onMediaEdit(target.planId, {
          type: 'replace',
          clipId: target.clipId,
          assetId: item.assetId,
        });
      } else if (target.type === 'insert') {
        await onMediaEdit(target.planId, {
          type: 'insert',
          assetId: item.assetId,
          afterClipId: target.afterClipId ?? null,
          durationUs: 3_000_000,
        });
      } else if (target.type === 'append') {
        const film = films.find((f) => f.planId === target.planId);
        const lastClip = film?.arrangement?.clips.at(-1);
        await onMediaEdit(target.planId, {
          type: 'insert',
          assetId: item.assetId,
          afterClipId: lastClip?.clipId ?? null,
          durationUs: 3_000_000,
        });
      }
      await onRefreshFilm(target.planId);
    } catch {
      setDropTarget(null);
    }
  };

  // Generate ruler ticks every 0.5s or 1.0s
  const ticks = useMemo(() => {
    const list: number[] = [];
    const step = zoom >= 60 ? 0.5 : 1.0;
    for (let sec = 0; sec <= totalTimelineSec; sec += step) {
      list.push(sec);
    }
    return list;
  }, [totalTimelineSec, zoom]);

  const renderAudioTrack = (film: UnifiedFilmState, track: 'narration' | 'bgm') => {
    const arrangement = film.arrangement;
    if (!arrangement) {
      return <div className={styles.trackAudio} key={track} />;
    }
    const { clips: trackClips } = audioTrackInfo(arrangement, track, film.durationSec * 1e6);
    const hasNarration = arrangement.narration?.durationUs != null;
    const audioUrl = track === 'narration'
      ? arrangement.narration?.audioRelativePath
        ? `/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(film.planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=narration&source=candidate`
        : null
      : arrangement.music?.trackId ? `/api/final-edit-bgm/${encodeURIComponent(arrangement.music.trackId)}/file` : null;
    const sourceKey = track === 'narration'
      ? `${arrangement.outputVersionId}:${arrangement.narration?.audioRelativePath}`
      : arrangement.music?.trackId ?? '';
    const hasBgm = Boolean(arrangement.music?.trackId);

    return (
      <div className={styles.trackAudio} key={track}>
        {track === 'narration' && !hasNarration ? (
          <span className="text-[10px] text-ink-tertiary px-2 py-1">无口播音频</span>
        ) : track === 'bgm' && !hasBgm ? (
          <button
            type="button"
            className={`${styles.audioBlock} ${styles.audioEmpty}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelectFilm(film.planId);
              onSelectTarget({ planId: film.planId, kind: 'audio', track: 'bgm' });
            }}
          >
            未选择背景音乐 · 点击设置
          </button>
        ) : (
          trackClips.map((ac) => {
            const isDraft = moveDraft?.kind === 'audio' && moveDraft.planId === film.planId && moveDraft.clipId === ac.id;
            const startSec = isDraft ? moveDraft.startSec : ac.timelineStartUs / 1e6;
            const durSec = (ac.timelineEndUs - ac.timelineStartUs) / 1e6;
            const isSelected =
              selection?.kind === 'audio' && selection.track === track && selection.clipId === ac.id;

            return (
              <div
                key={ac.id}
                data-audio-clip-id={ac.id}
                data-audio-track={track}
                className={`${styles.audioBlock} ${track === 'narration' ? styles.audioTts : styles.audioBgm} ${
                  isSelected ? styles.audioSelected : ''
                } ${isDraft ? styles.blockMoving : ''}`}
                style={{
                  left: startSec * zoom,
                  width: Math.max(24, durSec * zoom),
                }}
                onPointerDown={(e) => beginAudioBodyPointer(e, film, track, ac.id)}
                title={`${track === 'narration' ? '口播TTS' : 'BGM'} · 源 ${(ac.sourceStartUs / 1e6).toFixed(1)}s–${(
                  ac.sourceEndUs / 1e6
                ).toFixed(1)}s · 拖动两端修剪,中间移动`}
              >
                {/* 左修剪手柄 */}
                <div
                  className={`${styles.trimHandle} ${styles.trimHandleLeft}`}
                  onPointerDown={(e) => beginAudioTrimDrag(e, film, track, ac.id, 'start')}
                  title="拖动修剪入点"
                />
                <AudioWaveform url={audioUrl} sourceKey={sourceKey} sourceStartUs={ac.sourceStartUs} sourceEndUs={ac.sourceEndUs} widthPx={Math.max(24, durSec * zoom)} loop={track === 'bgm'} />
                <span className={styles.audioLabel}>
                  {track === 'narration'
                    ? `◖ 口播 ${(ac.sourceStartUs / 1e6).toFixed(1)}s–${(ac.sourceEndUs / 1e6).toFixed(1)}s`
                    : '♫ 背景音乐'}
                </span>
                {/* 右修剪手柄 */}
                <div
                  className={`${styles.trimHandle} ${styles.trimHandleRight}`}
                  onPointerDown={(e) => beginAudioTrimDrag(e, film, track, ac.id, 'end')}
                  title="拖动修剪出点"
                />
              </div>
            );
          })
        )}
      </div>
    );
  };

  return (
    <section className={`${styles.dock} h-full`} aria-label="统一时间轴">
      {/* 1. Filter Bar (v14 W-01:全部/待检查/已确认/区间重复 + 显示全部轨道 + 缩放) */}
      <div className={styles.timelineToolbar}>
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="group" aria-label="成片筛选">
          {(
            [
              ['all', `全部 ${films.length}`],
              ['pending', `待检查 ${pendingCount}`],
              ['approved', `已确认 ${approvedCount}`],
              ['overlap', '区间重复'],
            ] as Array<[ReviewRowFilter, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`${styles.filterTab} shrink-0 whitespace-nowrap ${rowFilter === id ? styles.filterTabActive : ''}`}
              aria-pressed={rowFilter === id}
              onClick={() => onRowFilterChange(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-ink-tertiary whitespace-nowrap hidden xl:inline">统一播放头 · 独立成片</span>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs"
            onClick={onShowAll}
            title="恢复所有成片的眼睛可见性"
          >
            显示全部轨道
          </button>
          <label className={styles.zoomControl}>
            <span>缩放</span>
            <input
              type="range"
              className={styles.zoomSlider}
              min={30}
              max={180}
              step={1}
              value={zoom}
              onChange={(event) => setZoom(Number(event.currentTarget.value))}
              aria-label="时间轴缩放"
              aria-valuetext={`${Math.round((zoom / 60) * 100)}%`}
              title="向左缩小，向右放大时间轴"
            />
          </label>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs text-ink-secondary"
            onClick={() => setShortcutsOpen(true)}
          >
            快捷键说明
          </button>
        </div>
      </div>

      {/* 2. Edit Toolbar (v14:选择/分割/分割当前/删除/撤销/重做/磁吸 + 审核操作) */}
      <div className={styles.editToolbar} role="toolbar" aria-label="时间轴编辑工具">
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            className={`btn-secondary flex h-7 items-center gap-1 px-2 text-xs ${
              tool === 'select' ? 'bg-accent/15 text-accent border-accent/40 font-medium' : ''
            }`}
            aria-pressed={tool === 'select'}
            onClick={() => onToolChange('select')}
            title="选择工具 (V)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="3 3 10 21 14 14 21 10 3 3" /></svg>
            <span>选择 (V)</span>
          </button>
          <button
            type="button"
            className={`btn-secondary flex h-7 items-center gap-1 px-2 text-xs ${
              tool === 'split' ? 'bg-accent/15 text-accent border-accent/40 font-medium' : ''
            }`}
            aria-pressed={tool === 'split'}
            onClick={() => onToolChange('split')}
            title="分割工具 (B):点击视频、字幕或音频内部切开"
          >
            <Icon name="scissors" size={12} />
            <span>分割 (B)</span>
          </button>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs disabled:opacity-30"
            disabled={!canSplitSelection}
            onClick={splitSelectedAtPlayhead}
            title="在播放头分割选中片段 (⌘/Ctrl+B)"
          >
            分割当前
          </button>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs disabled:opacity-30"
            disabled={!canDeleteSelection}
            onClick={deleteSelection}
            title="删除选中片段,保留空位 (Delete)"
          >
            删除
          </button>
          <div className="mx-1 h-4 w-px bg-hairline" />
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs disabled:opacity-30"
            disabled={!canUndo}
            onClick={onUndo}
            title="撤销 (⌘Z)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" /></svg>
          </button>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs disabled:opacity-30"
            disabled={!canRedo}
            onClick={onRedo}
            title="重做 (⌘⇧Z)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
          </button>
          <div className="mx-1 h-4 w-px bg-hairline" />
          <button
            type="button"
            className={`btn-secondary flex h-7 items-center gap-1 px-2 text-xs ${
              snapEnabled ? 'bg-accent/15 text-accent border-accent/40 font-medium' : ''
            }`}
            aria-pressed={snapEnabled}
            onClick={onToggleSnap}
            title="磁吸对齐 (N);按住 Alt 临时关闭"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v7a6 6 0 0012 0V3m-12 0h4m4 0h4m-12 5h4m4 0h4" /></svg>
            <span>磁吸 (N)</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs"
            onClick={onSelectAll}
          >
            全选 ({approvableCount})
          </button>
          <button
            type="button"
            className="btn-primary h-7 px-2.5 text-xs"
            disabled={selectedPlanIds.length === 0}
            onClick={() => onReview('approved')}
          >
            通过已选 ({selectedPlanIds.length})
          </button>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs"
            disabled={selectedPlanIds.length === 0}
            onClick={() => onReview('rework')}
          >
            返工
          </button>
          <button
            type="button"
            className="btn-secondary h-7 px-2 text-xs"
            disabled={selectedPlanIds.length === 0}
            onClick={() => onReview('cancelled')}
          >
            撤销审核
          </button>
        </div>
      </div>

      {/* 3. Focusbar with Repeat Highlight Message (PRD T-03) */}
      <div className={styles.focusbar}>
        {repeatStats ? (
          <div className="flex items-center gap-2 text-xs text-ink">
            <span className="inline-flex h-2 w-2 rounded-full bg-[#eb9a32]" />
            <span>
              已定位素材：<strong className="text-ink">{repeatStats.displayName}</strong> · 在{' '}
              <strong className="text-[#99570f]">{repeatStats.filmCount}</strong> 条成片中被使用{' '}
              <strong className="text-[#99570f]">{repeatStats.totalCount}</strong> 次
            </span>
            <button
              type="button"
              className="text-xs text-accent underline ml-2 cursor-pointer"
              onClick={() => onSelectFocusedAsset(null)}
            >
              取消定位
            </button>
          </div>
        ) : (
          <span className="text-xs text-ink-tertiary">
            {trimHint ?? '提示：拖动片段两端修剪，遇相邻片段会停住；拖入素材可替换或插入。'}
          </span>
        )}
      </div>

      {/* 4. Multi-film Timeline Scrollable Container */}
      <div ref={scrollRef} className={styles.timelineScroll}>
        <div className={styles.timelineInner} style={{ width: Math.max(800, totalTrackPx + 300) }}>
          {/* Shared Ruler Row */}
          <div className={styles.rulerRow}>
            <div className={styles.rulerLabel}>成片列表 ({films.length})</div>
            <div className={styles.rulerCoverLabel}>封面</div>
            <div
              className={styles.rulerTrack}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const targetSec = Math.max(0, (e.clientX - rect.left) / zoom);
                onSeek(targetSec);
              }}
            >
              {ticks.map((sec) => (
                <div
                  key={sec}
                  className={styles.rulerTick}
                  style={{ left: sec * zoom }}
                >
                  {sec % 1 === 0 ? `${sec}s` : ''}
                </div>
              ))}
            </div>
          </div>

          {/* Film Rows */}
          {visibleRows.map((film) => {
            const arrangement = film.arrangement;
            const isEditing = selectedPlanId === film.planId;
            const isVisible = film.visible;
            const isPreviewing = previewPlanId === film.planId;
            const clips = arrangement?.clips ?? [];
            const subtitleCues = arrangement?.subtitleCues ?? [];

            return (
              <div
                key={film.planId}
                className={`${styles.filmRow} ${isEditing ? styles.filmRowEditing : ''} ${
                  !isVisible ? styles.filmRowHidden : ''
                }`}
                onClick={() => {
                  if (selectedPlanId !== film.planId) {
                    onSelectFilm(film.planId);
                  }
                }}
              >
                {/* 1. Sticky Film Info */}
                <div className={styles.filmInfo}>
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button
                        type="button"
                        aria-label={isVisible ? '隐藏此成片' : '显示此成片'}
                        className={`p-1 rounded hover:bg-surface-subtle transition ${
                          isVisible ? 'text-accent' : 'text-ink-tertiary opacity-50'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleEye(film.planId);
                        }}
                      >
                        {isVisible ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        )}
                      </button>
                      <input
                        type="checkbox"
                        aria-label={`选择成片 ${film.seq}`}
                        checked={selectedPlanIds.includes(film.planId)}
                        disabled={!film.approvable}
                        onChange={(e) => {
                          e.stopPropagation();
                          onTogglePlanSelect(film.planId, e.target.checked);
                        }}
                        className="rounded"
                        title={
                          film.approvable
                            ? '勾选用于统一导出/审核'
                            : film.coverStatus === 'failed'
                              ? '封面生成失败，请先重试封面'
                              : film.coverStatus === 'queued' || film.coverStatus === 'running'
                                ? '封面还在生成中'
                                : '这条成片还没有配音，暂时无法导出'
                        }
                      />
                      <span className="truncate text-xs font-semibold text-ink" title={film.scriptTitle}>
                        {String(film.seq).padStart(2, '0')} · {film.scriptTitle || '未命名'}
                      </span>
                    </div>

                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.2 text-[9px] font-medium ${
                        film.approved
                          ? 'bg-ok/15 text-ok'
                          : film.approvable
                          ? 'bg-accent/10 text-accent'
                          : 'bg-warn/20 text-warn'
                      }`}
                    >
                      {film.approved ? '已通过' : film.approvable ? '待审核' : '处理中'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-ink-tertiary pt-2 border-t border-hairline/60">
                    <span>时长 {(film.durationSec).toFixed(1)}s</span>
                    {isPreviewing && (
                      <span className="flex items-center gap-1 text-accent text-[9px] font-medium">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                        正在预览
                      </span>
                    )}
                    {!isPreviewing && !isVisible && <span className="text-[9px]">已隐藏</span>}
                    {film.formalOutdated && (
                      <span className="text-warn text-[9px]">已修改未导出</span>
                    )}
                  </div>

                  {/* 重试入口在上(时间轴区域较矮时也能直接点到),失败明细在下。
                      对齐旧卡片:重试配音 / 重试封面 / 换一批画面。 */}
                  {(film.narrationTask?.status === 'failed'
                    || (film.coverStatus === 'failed' && film.coverTask)
                    || batchControlState !== 'stopped') && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {film.narrationTask?.status === 'failed' && (
                        <button
                          type="button"
                          className="btn-secondary h-6 px-2 text-[10px] text-fail"
                          disabled={phaseEBusy !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              film.subtitleOverride
                              && !window.confirm('重试配音会清除这条成片的手动字幕覆盖，并按新口播重新生成自动字幕。确定继续吗？')
                            ) return;
                            onRetryNarration(film.narrationTask!.id);
                          }}
                        >
                          {phaseEBusy === `narration:${film.narrationTask.id}` ? '重试中…' : '重试配音'}
                        </button>
                      )}
                      {film.coverStatus === 'failed' && film.coverTask && (
                        <button
                          type="button"
                          className="btn-secondary h-6 px-2 text-[10px] text-fail"
                          disabled={phaseEBusy !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRetryRender(film.coverTask!.id);
                          }}
                        >
                          {phaseEBusy === `render:${film.coverTask.id}` ? '重试中…' : '重试封面'}
                        </button>
                      )}
                      {batchControlState !== 'stopped' && (
                        <button
                          type="button"
                          className="btn-secondary h-6 px-2 text-[10px]"
                          disabled={phaseEBusy !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            onReallocate(film.planId);
                          }}
                        >
                          {phaseEBusy === film.planId ? '处理中…' : '换一批画面'}
                        </button>
                      )}
                    </div>
                  )}

                  {(film.narrationTask?.status === 'failed'
                    || (film.coverStatus === 'failed' && film.coverTask)
                    || film.fullRenderTask?.errorMessage
                    || film.blockers.length > 0) && (
                    <ul className="mt-1 space-y-0.5 text-[9px] leading-snug text-warn">
                      {film.narrationTask?.status === 'failed' && (
                        <li className="truncate" title={`配音失败：${film.narrationTask.errorMessage || '未知原因'}`}>
                          配音失败：{film.narrationTask.errorMessage || '未知原因'}
                        </li>
                      )}
                      {film.coverStatus === 'failed' && film.coverTask && (
                        <li className="truncate" title={`封面任务失败：${film.coverTask.errorMessage || '未知原因'}`}>
                          封面任务失败：{film.coverTask.errorMessage || '未知原因'}
                        </li>
                      )}
                      {film.fullRenderTask?.errorMessage && (
                        <li className="truncate" title={`渲染任务失败：${film.fullRenderTask.errorMessage}`}>
                          渲染任务失败：{film.fullRenderTask.errorMessage}
                        </li>
                      )}
                      {film.blockers.map((message) => (
                        <li key={`b-${message}`} className="truncate" title={`无法继续：${message}`}>
                          无法继续：{message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 2. Cover Cell */}
                <div
                  className={styles.filmCoverCell}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectFilm(film.planId);
                    onOpenCoverEditor(film.planId);
                  }}
                  title="点击精调封面"
                >
                  <div className={styles.filmCoverThumb}>
                    {film.coverAttemptId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/batch-production/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(
                          film.planId
                        )}/media?projectId=${encodeURIComponent(projectId)}&kind=cover&source=candidate&renderAttemptId=${encodeURIComponent(
                          film.coverAttemptId
                        )}`}
                        alt={`成片 ${film.seq} 封面`}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[8px] text-white/50">
                        封面
                      </div>
                    )}
                  </div>
                  <span className="text-[9px] text-ink-tertiary">精调 ›</span>
                </div>

                {/* 3. Track Area */}
                <div
                  className={styles.filmTrackArea}
                  onDragOver={(e) => {
                    // Check if dropping on empty track space -> append
                    handleDragOver(e, { planId: film.planId, type: 'append' });
                  }}
                  onDrop={handleDrop}
                >
                  {/* Track 1: Subtitles */}
                  <div className={styles.trackSubtitle}>
                    {subtitleCues.map(cue => (
                      <BatchReviewSubtitleChip
                        key={`${arrangement?.outputVersionId}:${cue.id}`}
                        cue={cue}
                        cues={subtitleCues}
                        bodyDurationUs={arrangement?.narration.durationUs ?? Math.round(film.durationSec * 1e6)}
                        revision={arrangement?.editRevision ?? 0}
                        zoom={zoom}
                        selected={selection?.planId === film.planId && selection.kind === 'subtitle' && selection.cueId === cue.id}
                        disabled={!arrangement?.editable}
                        tool={tool}
                        onSelect={() => {
                          onSelectFilm(film.planId);
                          onSelectTarget({ planId: film.planId, kind: 'subtitle', cueId: cue.id });
                        }}
                        onEdit={edit => onMediaEdit(film.planId, edit)}
                        findSnap={findSnap}
                        onSnap={snap => {
                          setSnapLinePx(snap ? snap.sec * zoom : null);
                          setSnapLineLabel(snap?.label ?? '');
                        }}
                      />
                    ))}
                  </div>

                  {/* Track 2: Video Clips */}
                  <div className={styles.trackVideo}>
                    {clips.map((clip, idx) => {
                      const isDraftClip = moveDraft?.kind === 'clip' && moveDraft.planId === film.planId && moveDraft.clipId === clip.clipId;
                      const range = trimDraft?.planId === film.planId && trimDraft.clipId === clip.clipId ? trimDraft : clip;
                      const startSec = isDraftClip ? moveDraft.startSec : range.timelineStartUs / 1e6;
                      const widthPx = Math.max(16, (range.timelineEndUs - range.timelineStartUs) / 1e6 * zoom);
                      const isSelected = selection?.kind === 'clip' && selection.clipId === clip.clipId;
                      const isRepeat = activeAssetId != null && clip.assetId === activeAssetId && !isSelected;
                      const isDimmedByOverlapFilter = overlapClipIds != null && !overlapClipIds.has(clip.clipId);
                      const asset = poolAssetsById.get(clip.assetId);

                      // Check source overlap with other clips using same asset in other films
                      let hasOverlap = false;
                      if (isRepeat) {
                        for (const otherFilm of films) {
                          if (otherFilm.planId === film.planId) continue;
                          const otherClips = otherFilm.arrangement?.clips ?? [];
                          for (const oc of otherClips) {
                            if (oc.assetId === clip.assetId) {
                              const overlapStart = Math.max(clip.sourceStartUs, oc.sourceStartUs);
                              const overlapEnd = Math.min(clip.sourceEndUs, oc.sourceEndUs);
                              if (overlapEnd > overlapStart) {
                                hasOverlap = true;
                                break;
                              }
                            }
                          }
                          if (hasOverlap) break;
                        }
                      }

                      const isDropTarget = dropTarget?.planId === film.planId && dropTarget.clipId === clip.clipId;

                      return (
                        <Fragment key={clip.clipId}>
                          {/* 间隙插入落点(M-02):拖到片段左缘 12px 内即在该片段前插入;
                              纯视觉指示,命中判定在片段的 dragOver 里(避免与修剪手柄抢占)。 */}
                          <div
                            className={`${styles.insertZone} ${
                              dropTarget?.planId === film.planId && dropTarget.type === 'insert' && dropTarget.afterClipId === (clips[idx - 1]?.clipId ?? null)
                                ? styles.insertZoneActive
                                : ''
                            }`}
                            style={{ left: (clip.timelineStartUs / 1e6) * zoom - 5 }}
                          />
                          <div
                            className={`${styles.clipBlock} ${isSelected ? styles.clipBlockSelected : ''} ${
                              isRepeat ? styles.clipRepeat : ''
                            } ${isDropTarget ? styles.dropTargetActive : ''} ${isDraftClip ? styles.blockMoving : ''} ${
                              isDimmedByOverlapFilter ? styles.clipDim : ''
                            }`}
                            style={{
                              left: startSec * zoom,
                              width: widthPx,
                            }}
                            onPointerDown={(e) => beginClipBodyPointer(e, film, clip.clipId)}
                            onDragOver={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              // 靠近左缘 = 在此片段前插入;其余主体区域 = 替换该片段(M-02)
                              if (e.clientX - rect.left <= 12) {
                                handleDragOver(e, { planId: film.planId, type: 'insert', afterClipId: clips[idx - 1]?.clipId ?? null });
                              } else {
                                handleDragOver(e, { planId: film.planId, type: 'replace', clipId: clip.clipId });
                              }
                            }}
                            onDrop={handleDrop}
                          >
                            {/* Trim left edge handle */}
                            <div
                              className={`${styles.trimHandle} ${styles.trimHandleLeft}`}
                              onPointerDown={(e) => beginTrimDrag(e, film, clip.clipId, 'start')}
                              title="拖动修剪入点"
                            />

                            {/* Thumbnail */}
                            {asset?.thumbnailUrl && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={asset.thumbnailUrl}
                                alt=""
                                className="h-full w-10 shrink-0 object-cover opacity-75"
                              />
                            )}

                            {/* Text label */}
                            <div className="flex-1 min-w-0 px-1.5 py-1 text-[10px] leading-tight">
                              <span className="block truncate font-medium text-ink">
                                {asset?.displayName || `镜头 ${idx + 1}`}
                              </span>
                              <span className="block text-[9px] text-ink-tertiary">
                                {((range.timelineEndUs - range.timelineStartUs) / 1e6).toFixed(1)}s
                              </span>
                            </div>

                            {/* Repeat badge if matching (PRD T-03) */}
                            {isRepeat && (
                              <span className={styles.clipRepeatBadge}>同一素材</span>
                            )}

                            {/* Overlap diagonal stripe */}
                            {hasOverlap && <div className={styles.clipOverlap} />}

                            {/* Trim right edge handle */}
                            <div
                              className={`${styles.trimHandle} ${styles.trimHandleRight}`}
                              onPointerDown={(e) => beginTrimDrag(e, film, clip.clipId, 'end')}
                              title="拖动修剪出点"
                            />
                          </div>
                        </Fragment>
                      );
                    })}

                    {/* Append zone at the end */}
                    <div
                      className={`${styles.appendZone} ${
                        dropTarget?.planId === film.planId && dropTarget.type === 'append' ? styles.dropTargetActive : ''
                      }`}
                      style={{
                        left: (clips.at(-1)?.timelineEndUs ?? 0) / 1e6 * zoom,
                        width: 48,
                      }}
                      onDragOver={(e) => {
                        e.stopPropagation();
                        handleDragOver(e, { planId: film.planId, type: 'append' });
                      }}
                      onDrop={handleDrop}
                    >
                      +追加
                    </div>
                  </div>

                  {/* Track 3: Narration TTS Audio */}
                  {renderAudioTrack(film, 'narration')}

                  {/* Track 4: BGM Audio */}
                  {renderAudioTrack(film, 'bgm')}
                </div>
              </div>
            );
          })}

          {visibleRows.length === 0 && (
            <div className="py-10 text-center text-xs text-ink-tertiary">
              {rowFilter === 'pending' ? '没有待检查的成片' : rowFilter === 'approved' ? '还没有已确认的成片' : '这个筛选下暂时没有成片'}
            </div>
          )}

          {/* 4. Global Playhead Line across all rows */}
          <div
            className={styles.globalPlayhead}
            style={{ left: 284 + Math.max(0, playheadSec) * zoom }}
          >
            <div
              className={styles.globalPlayheadHandle}
              onPointerDown={beginPlayheadDrag}
            >
              <span className={styles.playheadTimeTag}>
                {Math.floor(Math.max(0, playheadSec) / 60)}:{(Math.max(0, playheadSec) % 60).toFixed(1).padStart(4, '0')}
              </span>
            </div>
          </div>

          {/* 5. Snap Guide Line */}
          {snapLinePx !== null && (
            <div
              className={styles.snapLine}
              style={{ left: 284 + snapLinePx }}
            >
              {snapLineLabel && (
                <span className={styles.snapLineTag}>{snapLineLabel}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 6. Legend (v14) */}
      <div className={styles.legend}>
        <span><i className={styles.legendSwatch} />同色 = 同一素材</span>
        <span><i className={styles.legendStripe} />源区间重叠</span>
        <span>字幕 → 视频 → 口播 TTS → BGM</span>
        <span>主视频秒尺 · 封面独立，不计复用</span>
      </div>

      {/* Shortcuts modal dialog */}
      {shortcutsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <h3 className="font-semibold text-ink">时间轴快捷键</h3>
              <button
                type="button"
                className="btn-secondary h-7 w-7 p-0"
                onClick={() => setShortcutsOpen(false)}
              >
                ×
              </button>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <dt className="text-ink-secondary">空格 (Space)</dt>
              <dd className="font-medium text-ink">播放 / 暂停</dd>
              <dt className="text-ink-secondary">V / B</dt>
              <dd className="font-medium text-ink">选择工具 / 分割工具</dd>
              <dt className="text-ink-secondary">⌘B / Ctrl+B</dt>
              <dd className="font-medium text-ink">在播放头分割选中片段</dd>
              <dt className="text-ink-secondary">Delete / Backspace</dt>
              <dd className="font-medium text-ink">删除选中片段</dd>
              <dt className="text-ink-secondary">⌘Z / ⌘⇧Z</dt>
              <dd className="font-medium text-ink">撤销 / 重做</dd>
              <dt className="text-ink-secondary">← / →</dt>
              <dd className="font-medium text-ink">后退 / 前进 1 帧</dd>
              <dt className="text-ink-secondary">⇧+← / ⇧+→</dt>
              <dd className="font-medium text-ink">后退 / 前进 10 帧</dd>
              <dt className="text-ink-secondary">N</dt>
              <dd className="font-medium text-ink">开启 / 关闭磁吸</dd>
              <dt className="text-ink-secondary">Alt(按住)</dt>
              <dd className="font-medium text-ink">临时关闭磁吸</dd>
              <dt className="text-ink-secondary">+ / -</dt>
              <dd className="font-medium text-ink">时间轴缩放</dd>
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}
