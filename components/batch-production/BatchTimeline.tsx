'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioBlock } from '@/components/mixcut/MixcutTimeline';
import { planClipPosition, type PositionedClip } from '@/lib/media-core/clip-position';
import { audioClips, type AudioEdits } from '@/lib/media-core/audio-edit';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { timelineAbsoluteFrameFromPointer, timelineContentWidthPx } from '@/components/final-edit/timeline-edit';
import { planSubtitleCueSplit } from '@/components/final-edit/subtitle-split';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/final-edit/types';
import type { BatchOutputClipView, BatchOutputPoolAssetView, BatchOutputSubtitleCueView } from '@/lib/batch-production/output-arrangement';
import styles from '../mixcut/mixcut-content.module.css';

const FPS = FINAL_EDIT_FPS; // 24
const INTRO_FRAMES = FINAL_EDIT_INTRO_FRAMES; // 20
const INTRO_SEC = INTRO_FRAMES / FPS; // 片头封面静帧秒数
const PX_PER_SECOND = 60; // 与 MixcutTimeline 固定缩放一致
const MIN_FRAMES = 12; // 0.5s 最短片段

const usToFrame = (us: number) => Math.round((us / 1_000_000) * FPS);
const frameToUs = (frame: number) => Math.round((frame / FPS) * 1_000_000);
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

type TimelineTool = 'select' | 'split';
type TrimDragMode = 'start' | 'end' | 'move';

/** 拖拽中的本地修剪预览（帧），仅改变当前片段的显示边界。 */
interface ClipTrimDraft {
  clipId: string;
  sourceIn: number;
  sourceOut: number;
  positions?: PositionedClip[];
}

interface ClipContextMenuState {
  kind: 'clip';
  clipId: string;
  x: number;
  y: number;
}

interface SubtitleContextMenuState {
  kind: 'subtitle';
  cueId: string;
  x: number;
  y: number;
}

type TimelineContextMenuState = ClipContextMenuState | SubtitleContextMenuState | { kind: 'audio'; track: 'narration' | 'bgm'; clipId: string; x: number; y: number };

export interface BatchTimelineProps {
  /** 必须是对 fetched view 的稳定引用（如 useMemo([view])）；draft 实时预览靠 draftState.clips === clips 引用比较失效，每次 render 新建数组会让拖拽预览静默失效。 */
  clips: BatchOutputClipView[];
  assets: BatchOutputPoolAssetView[]; // 取 thumbnailUrl/displayName/durationSec
  subtitleCues: BatchOutputSubtitleCueView[];
  narrationDurationUs: number | null;
  preserveGaps?: boolean;
  audio?: AudioEdits;
  musicLabel?: string | null;
  onMediaEdit: (edit: Record<string, unknown>) => Promise<boolean>;
  playheadSec: number; // 含片头绝对时间
  selectedClipId: string | null;
  selectedSubtitleCueId: string | null;
  disabled: boolean; // 只禁用变更手势，不禁用 seek/选中
  onSeek: (sec: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onSelectSubtitleCue: (cueId: string | null) => void;
  onTrimVariable: (clipId: string, sourceStartUs: number, sourceEndUs: number) => Promise<boolean>;
  onSplit: (clipId: string, offsetUs: number) => Promise<boolean>;
  onOpenFineTrim: (clipId: string) => void;
  onDeleteClip: (clipId: string) => void;
  onSubtitleEdit: (edit: Record<string, unknown>) => Promise<boolean>;
  onDeleteSubtitleCue: (cueId: string) => void;
}

/**
 * 批量「检查成片」时间轴：画面轨（选中/拖边缘变长修剪/拖中段移动或排序/分割/右键菜单）
 * + 字幕轨（文字编辑/拖动/拖边/分割/删除）+口播对照轨。交互范式对齐
 * components/mixcut/MixcutTimeline.tsx。
 * 时间坐标：clips 与 subtitleCues 是正文（片头后）相对时间，playheadSec 是含片头绝对时间。
 */
export default function BatchTimeline({
  clips,
  assets,
  subtitleCues,
  narrationDurationUs,
  preserveGaps, audio, musicLabel, onMediaEdit,
  playheadSec,
  selectedClipId,
  selectedSubtitleCueId,
  disabled,
  onSeek,
  onSelectClip,
  onSelectSubtitleCue,
  onTrimVariable,
  onSplit,
  onOpenFineTrim,
  onDeleteClip,
  onSubtitleEdit,
  onDeleteSubtitleCue,
}: BatchTimelineProps) {
  const pxPerSecond = PX_PER_SECOND;
  const [viewportWidth, setViewportWidth] = useState(720);
  const [tool, setTool] = useState<TimelineTool>('select');
  const [contextMenu, setContextMenu] = useState<TimelineContextMenuState | null>(null);
  // 修剪预览锚定到产生它时的 clips 数组：clips 刷新后 draft 自动失效，无需 effect 清理
  const [draftState, setDraftState] = useState<{ clips: BatchOutputClipView[]; value: ClipTrimDraft } | null>(null);
  const draft = draftState && draftState.clips === clips ? draftState.value : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  const visualFrames = usToFrame(clips.at(-1)?.timelineEndUs ?? 0);
  const narrationFrames = narrationDurationUs != null ? usToFrame(narrationDurationUs) : null;
  const bodyFrames = Math.max(visualFrames, narrationFrames ?? 0);
  const subtitleBodyFrames = narrationFrames ?? visualFrames;
  const totalFrames = INTRO_FRAMES + bodyFrames;
  const totalSec = totalFrames / FPS;
  const contentWidth = timelineContentWidthPx({ totalUs: (totalFrames / FPS) * 1e6, pxPerSecond, viewportWidth: Math.max(1, viewportWidth) });
  const introPx = INTRO_SEC * pxPerSecond;
  const playheadPx = clamp(playheadSec, 0, totalSec) * pxPerSecond;
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.assetId, asset])), [assets]);
  // disabled 时强制按选择模式行为
  const effectiveTool: TimelineTool = disabled ? 'select' : tool;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewportWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  useEffect(() => {
    if (!contextMenu) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeContextMenu(); };
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('keydown', keydown);
    };
  }, [closeContextMenu, contextMenu]);

  // disabled 翻为 true 时关掉可能还开着的右键菜单（如渲染中锁定），避免绕过锁定点删除；
  // 推迟到宏任务，避免 effect 内同步 setState（同 BatchOutputEditor 的模式）。
  useEffect(() => {
    if (!disabled) return;
    const timer = window.setTimeout(() => setContextMenu(null), 0);
    return () => window.clearTimeout(timer);
  }, [disabled]);

  const frameFromPointer = useCallback((clientX: number): number | null => {
    const scroll = scrollRef.current;
    if (!scroll) return null;
    return timelineAbsoluteFrameFromPointer({
      clientX,
      contentLeft: scroll.getBoundingClientRect().left,
      scrollLeft: scroll.scrollLeft,
      pxPerSecond,
      totalFrames,
      fps: FPS,
    });
  }, [pxPerSecond, totalFrames]);

  const seekFromPointer = (clientX: number) => {
    const frame = frameFromPointer(clientX);
    if (frame === null) return;
    onSeek(frame / FPS);
  };

  // 刻度覆盖整条时间轴；MixcutTimeline 同款写法只覆盖前一半，那边按红线不动。
  const ticks = useMemo(() => Array.from({ length: Math.floor(totalSec * 2) }, (_, index) => (index + 1) * 0.5), [totalSec]);

  const beginPlayheadDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    seekFromPointer(event.clientX);
    const move = (pointer: PointerEvent) => seekFromPointer(pointer.clientX);
    const up = (pointer: PointerEvent) => {
      seekFromPointer(pointer.clientX);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
    };
    const cancel = (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
    target.addEventListener('pointercancel', cancel, { once: true });
  };

  // 拖到空位只移动当前素材；跨过其他片段时预览排序后的全部位置。
  const clipLayout = useMemo(() => clips.map((clip) => {
    const timelineInFrame = usToFrame(clip.timelineStartUs);
    const timelineOutFrame = usToFrame(clip.timelineEndUs);
    const sourceIn = usToFrame(clip.sourceStartUs);
    const sourceOut = usToFrame(clip.sourceEndUs);
    const activeDraft = draft?.clipId === clip.clipId ? draft : null;
    const position = draft?.positions?.find((item) => item.id === clip.clipId);
    const rate = clip.playbackRate ?? 1;
    const slip = activeDraft && activeDraft.sourceOut - activeDraft.sourceIn === sourceOut - sourceIn;
    const displayInFrame = position ? usToFrame(position.startUs) : activeDraft && !slip ? timelineInFrame + Math.round((activeDraft.sourceIn - sourceIn) / rate) : timelineInFrame;
    const durFrames = position ? usToFrame(position.endUs) - usToFrame(position.startUs) : activeDraft ? Math.round((activeDraft.sourceOut - activeDraft.sourceIn) / rate) : timelineOutFrame - timelineInFrame;
    return { clip, timelineInFrame, sourceIn, sourceOut, durFrames, displayInFrame };
  }), [clips, draft]);

  const toolButtonsDisabled = disabled || clips.length === 0;

  return (
    <div className={styles.tlShell}>
      <div className={styles.tlToolbar} role="toolbar" aria-label="成片时间轴工具">
        <button
          type="button"
          aria-label="选择工具"
          aria-pressed={effectiveTool === 'select'}
          className={[styles.tlToolButton, effectiveTool === 'select' ? styles.tlToolButtonActive : ''].filter(Boolean).join(' ')}
          disabled={toolButtonsDisabled}
          onClick={() => setTool('select')}
        >
          <Icon name="check-circle" size={13} />选择
        </button>
        <button
          type="button"
          aria-label="分割工具"
          aria-pressed={effectiveTool === 'split'}
          className={[styles.tlToolButton, effectiveTool === 'split' ? styles.tlToolButtonActive : ''].filter(Boolean).join(' ')}
          disabled={toolButtonsDisabled}
          onClick={() => setTool('split')}
        >
          <Icon name="scissors" size={13} />分割
        </button>
        <span className={styles.tlToolHint}>{effectiveTool === 'split' ? '点击视频、音频或字幕上的目标位置切开，右键删除' : '选中视频，在右侧调整倍速和画面；音频用分割工具裁切；删除保留空位'}</span>
      </div>
      <section className={styles.tl} aria-label="成片时间轴" data-testid="batch-output-timeline" data-tool={effectiveTool}>
        <div className={styles.tlLabels}>
          <div className={styles.tlLab} style={{ height: 20 }} />
          <div className={styles.tlLab} style={{ height: 64 }}>视频</div>
          <div className={styles.tlLab} style={{ height: 28 }}>字幕</div>
          <div className={styles.tlLab} style={{ height: 60 }}>口播</div>
          {musicLabel && <div className={styles.tlLab} style={{ height: 30 }}>音乐</div>}
        </div>
        <div ref={scrollRef} className={styles.tlScroll} data-testid="batch-output-timeline-scroll">
          <div
            className={styles.tlInner}
            style={{ width: contentWidth }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              seekFromPointer(event.clientX);
            }}
          >
            <div className={styles.tlRuler}>
              {ticks.map((tick) => Number.isInteger(tick)
                ? <div key={tick} className={styles.tlTick} style={{ left: tick * pxPerSecond }}><span>{tick}s</span></div>
                : <div key={tick} className={`${styles.tlTick} ${styles.tlTickMinor}`} style={{ left: tick * pxPerSecond }} />)}
            </div>
            <div className={`${styles.tlTrack} ${styles.tlTrackVideo}`} data-track="video">
              {clipLayout.map((entry, index) => {
                const asset = assetById.get(entry.clip.assetId);
                const sourceTotalFrames = asset?.durationSec != null
                  ? Math.floor(asset.durationSec * FPS)
                  : usToFrame(entry.clip.sourceEndUs);
                return (
                  <BatchClipBlock
                    key={entry.clip.clipId}
                    clip={entry.clip}
                    clips={clips}
                    bodyEndUs={Math.max(clips.at(-1)?.timelineEndUs ?? 0, narrationDurationUs ?? 0)}
                    onMove={(clipId, startUs) => onMediaEdit({ type: 'move_clip', clipId, startUs })}
                    index={index}
                    timelineInFrame={entry.timelineInFrame}
                    displayInFrame={entry.displayInFrame}
                    durFrames={entry.durFrames}
                    sourceIn={entry.sourceIn}
                    sourceOut={entry.sourceOut}
                    sourceTotalFrames={sourceTotalFrames}
                    thumbnailUrl={asset?.thumbnailUrl || undefined}
                    pxPerSecond={pxPerSecond}
                    selected={entry.clip.clipId === selectedClipId}
                    disabled={disabled}
                    tool={effectiveTool}
                    frameFromPointer={frameFromPointer}
                    onSelect={onSelectClip}
                    onDraftChange={(value) => setDraftState(value ? { clips, value } : null)}
                    onTrimVariable={onTrimVariable}
                    onSplit={onSplit}
                    onOpenFineTrim={onOpenFineTrim}
                    onOpenContextMenu={(clipId, clientX, clientY) => setContextMenu({
                      kind: 'clip',
                      clipId,
                      x: Math.max(8, Math.min(clientX, window.innerWidth - 184)),
                      y: Math.max(8, Math.min(clientY, window.innerHeight - 300)),
                    })}
                  />
                );
              })}
              {!preserveGaps && narrationFrames != null && narrationFrames > visualFrames && (
                <div
                  className={styles.videoFreezeTail}
                  style={{ left: (INTRO_SEC + visualFrames / FPS) * pxPerSecond, width: ((narrationFrames - visualFrames) / FPS) * pxPerSecond }}
                >末帧延长</div>
              )}
              {narrationFrames != null && visualFrames > narrationFrames && (
                <div
                  className={styles.videoFreezeTail}
                  style={{
                    left: (INTRO_SEC + narrationFrames / FPS) * pxPerSecond,
                    width: ((visualFrames - narrationFrames) / FPS) * pxPerSecond,
                    background: 'color-mix(in srgb, var(--fail, #dc2626) 18%, transparent)',
                  }}
                >超出裁掉</div>
              )}
            </div>
            <div className={`${styles.tlTrack} ${styles.tlTrackSub}`} data-track="subtitle">
              {subtitleCues.map((cue, index) => (
                <BatchSubtitleBlock
                  key={cue.id || `${cue.startUs}-${cue.endUs}-${index}`}
                  cue={cue}
                  disabled={disabled}
                  tool={effectiveTool}
                  pxPerSecond={pxPerSecond}
                  frameFromPointer={frameFromPointer}
                  bodyDurationUs={subtitleBodyFrames > 0 ? frameToUs(subtitleBodyFrames) : Math.max(cue.endUs, 1)}
                  selected={cue.id === selectedSubtitleCueId}
                  onSelect={onSelectSubtitleCue}
                  onEdit={onSubtitleEdit}
                  onOpenContextMenu={(cueId, clientX, clientY) => setContextMenu({
                    kind: 'subtitle',
                    cueId,
                    x: Math.max(8, Math.min(clientX, window.innerWidth - 184)),
                    y: Math.max(8, Math.min(clientY, window.innerHeight - 96)),
                  })}
                />
              ))}
            </div>
            <div
              className={`${styles.tlTrack} ${styles.tlTrackAudio} ${styles.tlTrackNarration}`}
              data-track="narration"
              style={{ height: 60, borderBottom: 'none' }}
            >
              {narrationDurationUs != null ? audioClips({ audio }, 'narration', narrationDurationUs).map((clip) => <AudioBlock
                key={clip.id} clip={clip} track="narration" playbackRate={1} bodySec={narrationDurationUs / 1e6} pxPerSecond={pxPerSecond} playheadPx={playheadPx} tool={effectiveTool} disabled={disabled}
                label="口播" onSeek={onSeek} onCommand={onMediaEdit}
                onOpenContextMenu={(x, y) => setContextMenu({ kind: 'audio', track: 'narration', clipId: clip.id, x: Math.max(8, Math.min(x, window.innerWidth - 184)), y: Math.max(8, Math.min(y, window.innerHeight - 86)) })}
              />) : <span className={styles.wfLabel} style={{ left: introPx + 8 }}>无口播配音</span>}
            </div>
            {musicLabel && <div className={`${styles.tlTrack} ${styles.tlTrackAudio}`} data-track="bgm">
              {audioClips({ audio }, 'bgm', narrationDurationUs ?? bodyFrames / FPS * 1e6).map((clip) => <AudioBlock
                key={clip.id} clip={clip} track="bgm" playbackRate={1} bodySec={(narrationDurationUs ?? bodyFrames / FPS * 1e6) / 1e6} pxPerSecond={pxPerSecond} playheadPx={playheadPx} tool={effectiveTool} disabled={disabled}
                label={musicLabel} onSeek={onSeek} onCommand={onMediaEdit}
                onOpenContextMenu={(x, y) => setContextMenu({ kind: 'audio', track: 'bgm', clipId: clip.id, x: Math.max(8, Math.min(x, window.innerWidth - 184)), y: Math.max(8, Math.min(y, window.innerHeight - 86)) })}
              />)}
            </div>}
            <button
              type="button"
              aria-label="拖动播放头"
              className={styles.tlPlayhead}
              style={{ left: playheadPx }}
              onPointerDown={beginPlayheadDrag}
            />
          </div>
        </div>
        {contextMenu && typeof document !== 'undefined' && createPortal(
          <div className={styles.timelineContextLayer} onPointerDown={closeContextMenu}>
            <div
              role="menu"
              aria-label={contextMenu.kind === 'clip' ? '片段操作' : contextMenu.kind === 'audio' ? '音频片段操作' : '字幕操作'}
              className={styles.timelineContextMenu}
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {contextMenu.kind === 'clip' ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      const clipId = contextMenu.clipId;
                      setContextMenu(null);
                      onOpenFineTrim(clipId);
                    }}
                  >精细修剪…</button>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.timelineContextDanger}
                    disabled={disabled || clips.length === 1}
                    title={clips.length === 1 ? '至少保留一条片段' : undefined}
                    onClick={() => {
                      const clipId = contextMenu.clipId;
                      setContextMenu(null);
                      onDeleteClip(clipId);
                    }}
                  >删除片段（保留空位）</button>
                </>
              ) : contextMenu.kind === 'audio' ? (
                <button type="button" role="menuitem" className={styles.timelineContextDanger} disabled={disabled} onClick={() => { void onMediaEdit({ type: 'delete_audio_clip', track: contextMenu.track, clipId: contextMenu.clipId }); setContextMenu(null); }}>删除音频片段</button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.timelineContextDanger}
                  disabled={disabled}
                  onClick={() => {
                    const cueId = contextMenu.cueId;
                    setContextMenu(null);
                    onDeleteSubtitleCue(cueId);
                  }}
                >删除字幕</button>
              )}
            </div>
          </div>,
          document.body,
        )}
      </section>
    </div>
  );
}

function BatchClipBlock({
  clip,
  clips,
  bodyEndUs,
  onMove,
  index,
  timelineInFrame,
  displayInFrame,
  durFrames,
  sourceIn,
  sourceOut,
  sourceTotalFrames,
  thumbnailUrl,
  pxPerSecond,
  selected,
  disabled,
  tool,
  frameFromPointer,
  onSelect,
  onDraftChange,
  onTrimVariable,
  onSplit,
  onOpenFineTrim,
  onOpenContextMenu,
}: {
  clip: BatchOutputClipView;
  clips: BatchOutputClipView[];
  bodyEndUs: number;
  onMove: (clipId: string, startUs: number) => Promise<boolean>;
  index: number;
  timelineInFrame: number;
  displayInFrame: number;
  durFrames: number;
  sourceIn: number;
  sourceOut: number;
  sourceTotalFrames: number;
  thumbnailUrl?: string;
  pxPerSecond: number;
  selected: boolean;
  disabled: boolean;
  tool: TimelineTool;
  frameFromPointer: (clientX: number) => number | null;
  onSelect: (clipId: string | null) => void;
  onDraftChange: (draft: ClipTrimDraft | null) => void;
  onTrimVariable: (clipId: string, sourceStartUs: number, sourceEndUs: number) => Promise<boolean>;
  onSplit: (clipId: string, offsetUs: number) => Promise<boolean>;
  onOpenFineTrim: (clipId: string) => void;
  onOpenContextMenu: (clipId: string, clientX: number, clientY: number) => void;
}) {
  const [splitOffsetFrames, setSplitOffsetFrames] = useState<number | null>(null);
  const left = ((INTRO_FRAMES + displayInFrame) / FPS) * pxPerSecond;
  const width = (durFrames / FPS) * pxPerSecond;
  const durationSec = durFrames / FPS;

  const splitOffsetFromPointer = (clientX: number): number | null => {
    const absoluteFrame = frameFromPointer(clientX);
    if (absoluteFrame === null) return null;
    const bodyFrame = absoluteFrame - INTRO_FRAMES;
    const offsetFrames = bodyFrame - timelineInFrame;
    if (offsetFrames < MIN_FRAMES || durFrames - offsetFrames < MIN_FRAMES) return null;
    return offsetFrames;
  };

  const begin = (mode: TrimDragMode, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(clip.clipId);
    if (disabled) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let latest = { sourceIn, sourceOut };
    let requestedStartUs = clip.timelineStartUs;
    let changed = false;
    const move = (pointer: PointerEvent) => {
      const timelineDelta = Math.round(((pointer.clientX - startX) / pxPerSecond) * FPS);
      if (mode === 'move') {
        requestedStartUs = Math.max(0, clip.timelineStartUs + frameToUs(timelineDelta));
        const positions = planClipPosition(clips.map((item) => ({ id: item.clipId, startUs: item.timelineStartUs, endUs: item.timelineEndUs })), clip.clipId, requestedStartUs, bodyEndUs);
        changed = positions.some((position) => { const original = clips.find((item) => item.clipId === position.id)!; return position.startUs !== original.timelineStartUs; });
        onDraftChange({ clipId: clip.clipId, sourceIn, sourceOut, positions });
        return;
      }
      const deltaFrames = Math.round(timelineDelta * (clip.playbackRate ?? 1));
      changed = changed || deltaFrames !== 0;
      if (mode === 'start') {
        latest = { sourceIn: clamp(sourceIn + deltaFrames, 0, sourceOut - Math.ceil(MIN_FRAMES * (clip.playbackRate ?? 1))), sourceOut };
      } else if (mode === 'end') {
        latest = { sourceIn, sourceOut: clamp(sourceOut + deltaFrames, sourceIn + Math.ceil(MIN_FRAMES * (clip.playbackRate ?? 1)), sourceTotalFrames) };
      }
      onDraftChange({ clipId: clip.clipId, sourceIn: latest.sourceIn, sourceOut: latest.sourceOut });
    };
    const up = async (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      if (!changed) {
        onDraftChange(null);
        return;
      }
      const accepted = mode === 'move'
        ? await onMove(clip.clipId, requestedStartUs)
        : await onTrimVariable(clip.clipId, frameToUs(latest.sourceIn), frameToUs(latest.sourceOut));
      if (!accepted) onDraftChange(null);
    };
    const cancel = (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      onDraftChange(null);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
    target.addEventListener('pointercancel', cancel, { once: true });
  };

  return (
    <article
      data-clip-id={clip.clipId}
      data-selected={selected ? 'true' : undefined}
      className={`${styles.clip} ${selected ? styles.clipSel : ''}`}
      style={{ left, width, background: 'linear-gradient(135deg,#3a3d46,#22242b)' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (tool === 'split') {
          event.preventDefault();
          event.stopPropagation();
          const offsetFrames = splitOffsetFromPointer(event.clientX);
          if (offsetFrames === null) return;
          onSelect(clip.clipId);
          setSplitOffsetFrames(null);
          void onSplit(clip.clipId, frameToUs(offsetFrames));
          return;
        }
        begin('move', event);
      }}
      onPointerMove={(event) => {
        if (tool === 'split') setSplitOffsetFrames(splitOffsetFromPointer(event.clientX));
      }}
      onPointerLeave={() => setSplitOffsetFrames(null)}
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(clip.clipId);
        onOpenContextMenu(clip.clipId, event.clientX, event.clientY);
      }}
      onDoubleClick={() => {
        onSelect(clip.clipId);
        if (!disabled) onOpenFineTrim(clip.clipId);
      }}
      title="单击选中 · 拖边缘变长修剪 · 拖中段移动或排序 · 双击精细修剪 · 右键更多"
    >
      {tool === 'split' && splitOffsetFrames !== null && (
        <i
          className={styles.subtitleSplitPreview}
          style={{ left: `${(splitOffsetFrames / durFrames) * 100}%` }}
          aria-hidden="true"
        />
      )}
      {thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbnailUrl} alt="" draggable={false} />
      )}
      <span className={styles.clipNo}>#{index + 1}</span>
      <span className={styles.clipCd}>{durationSec.toFixed(1)}s · {(clip.playbackRate ?? 1).toFixed(2)}x</span>
      <i className={`${styles.clipHandle} ${styles.clipHandleL}`} aria-label="修剪片段开头" onPointerDown={tool === 'select' ? (event) => begin('start', event) : undefined} />
      <i className={`${styles.clipHandle} ${styles.clipHandleR}`} aria-label="修剪片段结尾" onPointerDown={tool === 'select' ? (event) => begin('end', event) : undefined} />
    </article>
  );
}

const MIN_SUBTITLE_FRAMES = 1;

function BatchSubtitleBlock({
  cue,
  disabled,
  tool,
  pxPerSecond,
  frameFromPointer,
  bodyDurationUs,
  selected,
  onSelect,
  onEdit,
  onOpenContextMenu,
}: {
  cue: BatchOutputSubtitleCueView;
  disabled: boolean;
  tool: TimelineTool;
  pxPerSecond: number;
  frameFromPointer: (clientX: number) => number | null;
  bodyDurationUs: number;
  selected: boolean;
  onSelect: (cueId: string | null) => void;
  onEdit: (edit: Record<string, unknown>) => Promise<boolean>;
  onOpenContextMenu: (cueId: string, clientX: number, clientY: number) => void;
}) {
  const cueId = cue.id;
  const startFrame = usToFrame(cue.startUs);
  const endFrame = usToFrame(cue.endUs);
  const bodyFrames = Math.max(1, usToFrame(bodyDurationUs));
  const [draft, setDraft] = useState<{ startFrame: number; endFrame: number } | null>(null);
  const [splitOffsetFrames, setSplitOffsetFrames] = useState<number | null>(null);
  const [editingText, setEditingText] = useState(false);
  const [textDraft, setTextDraft] = useState(cue.text);
  const textDraftRef = useRef(cue.text);
  const activeStartFrame = draft?.startFrame ?? startFrame;
  const activeEndFrame = draft?.endFrame ?? endFrame;
  const left = ((INTRO_FRAMES + activeStartFrame) / FPS) * pxPerSecond;
  const width = Math.max(4, ((activeEndFrame - activeStartFrame) / FPS) * pxPerSecond);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTextDraft(cue.text);
      textDraftRef.current = cue.text;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cue.text]);

  const commitText = async () => {
    setEditingText(false);
    const text = textDraftRef.current;
    if (text === cue.text) return;
    await onEdit({ type: 'set_subtitle_cue_text', cueId, text });
  };

  const beginDrag = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(cueId);
    if (disabled) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let latest = { startFrame, endFrame };
    let changed = false;
    const move = (pointer: PointerEvent) => {
      const deltaFrames = Math.round(((pointer.clientX - startX) / pxPerSecond) * FPS);
      let next: { startFrame: number; endFrame: number };
      if (mode === 'move') {
        const shift = clamp(deltaFrames, -startFrame, Math.max(-startFrame, bodyFrames - endFrame));
        next = { startFrame: startFrame + shift, endFrame: endFrame + shift };
      } else if (mode === 'start') {
        next = { startFrame: clamp(startFrame + deltaFrames, 0, endFrame - MIN_SUBTITLE_FRAMES), endFrame };
      } else {
        next = { startFrame, endFrame: clamp(endFrame + deltaFrames, startFrame + MIN_SUBTITLE_FRAMES, bodyFrames) };
      }
      changed = changed || next.startFrame !== startFrame || next.endFrame !== endFrame;
      latest = next;
      setDraft(next);
    };
    const up = async (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      setDraft(null);
      if (!changed) return;
      await onEdit({
        type: mode === 'move' ? 'move_subtitle_cue' : 'trim_subtitle_cue',
        cueId,
        startUs: frameToUs(latest.startFrame),
        endUs: frameToUs(latest.endFrame),
      });
    };
    const cancel = (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      setDraft(null);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
    target.addEventListener('pointercancel', cancel, { once: true });
  };

  const splitFromPointer = (clientX: number): number | null => {
    const absoluteFrame = frameFromPointer(clientX);
    if (absoluteFrame === null) return null;
    const splitFrame = absoluteFrame - INTRO_FRAMES;
    if (splitFrame <= startFrame || splitFrame >= endFrame) return null;
    return splitFrame;
  };

  return (
    <article
      data-subtitle-cue-id={cueId}
      data-selected={selected ? 'true' : undefined}
      className={`${styles.subclip} ${selected ? styles.subclipSel : ''}`}
      style={{ left, width }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(cueId);
        if (tool === 'split') {
          if (disabled) return;
          const splitFrame = splitFromPointer(event.clientX);
          if (splitFrame === null) return;
          const splitPlan = planSubtitleCueSplit({
            cue: {
              id: cueId,
              segmentId: cue.sourceSegmentId,
              text: cue.text,
              startUs: frameToUs(activeStartFrame),
              endUs: frameToUs(activeEndFrame),
              textSource: cue.timingSource === 'manual' ? 'manual' : 'script',
              timingSource: cue.timingSource === 'aligned' ? 'aligned' : cue.timingSource === 'estimated' ? 'proportional' : 'manual',
            },
            requestedSplitUs: frameToUs(splitFrame),
            fps: FPS,
          });
          if (!splitPlan) return;
          setSplitOffsetFrames(null);
          void onEdit({
            type: 'split_subtitle_cue',
            cueId,
            ...splitPlan,
          });
          return;
        }
        beginDrag('move', event);
      }}
      onPointerMove={(event) => {
        if (tool === 'split') setSplitOffsetFrames(splitFromPointer(event.clientX));
      }}
      onPointerLeave={() => setSplitOffsetFrames(null)}
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(cueId);
        onOpenContextMenu(cueId, event.clientX, event.clientY);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) setEditingText(true);
      }}
      title="拖动调整时间 · 拖边缘修剪 · 双击编辑文字 · 右键删除"
    >
      {tool === 'split' && splitOffsetFrames !== null && (
        <i
          className={styles.subtitleSplitPreview}
          style={{ left: `${((splitOffsetFrames - activeStartFrame) / Math.max(1, activeEndFrame - activeStartFrame)) * 100}%` }}
          aria-hidden="true"
        />
      )}
      {editingText ? (
        <input
          autoFocus
          aria-label="编辑字幕文字"
          value={textDraft}
          onChange={(event) => {
            setTextDraft(event.target.value);
            textDraftRef.current = event.target.value;
          }}
          onBlur={() => void commitText()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commitText();
            } else if (event.key === 'Escape') {
              setTextDraft(cue.text);
              textDraftRef.current = cue.text;
              setEditingText(false);
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="min-w-0 w-full bg-transparent text-[11px] text-inherit outline-none"
        />
      ) : (
        <span className="truncate">{cue.text || '（空字幕）'}</span>
      )}
      <i className={`${styles.subclipHandle} ${styles.subclipHandleL}`} aria-label="修剪字幕开头" onPointerDown={tool === 'select' ? (event) => beginDrag('start', event) : undefined} />
      <i className={`${styles.subclipHandle} ${styles.subclipHandleR}`} aria-label="修剪字幕结尾" onPointerDown={tool === 'select' ? (event) => beginDrag('end', event) : undefined} />
    </article>
  );
}
