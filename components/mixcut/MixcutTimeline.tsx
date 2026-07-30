'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES, type FinalEditAssetView, type FinalEditVariantView, type SubtitleCue, type TimelineClip } from '@/lib/final-edit/types';
import type { GroupCommandInput, VariantCommandInput } from '@/components/final-edit/command-types';
import { planSubtitleCueSplit, type SubtitleCueSplitPlan } from '@/components/final-edit/subtitle-split';
import { constrainClipDrag, planClipReorder, timelineAbsoluteFrameFromPointer, timelineContentWidthPx, type ClipDragMode, type ClipDraft } from '@/components/final-edit/timeline-edit';
import { NarrationPlaybackRateControl } from './NarrationPlaybackRateControl';
import styles from './MixcutPanel.module.css';

const FPS = FINAL_EDIT_FPS;
const INTRO_FRAMES = FINAL_EDIT_INTRO_FRAMES;
const FRAME_US = Math.round(1_000_000 / FPS);
const PX_PER_SECOND = 60; // V2 固定缩放（规格 §6.4），内容超宽靠横向滚动
const WAVEFORM_BAR_PITCH_PX = 4.5; // 2.5px 柱宽 + 2px 间距，与 CSS 保持一致

type TimelineContextMenu =
  | { kind: 'video'; clipId: string; x: number; y: number }
  | { kind: 'narration'; x: number; y: number };

type TimelineTool = 'select' | 'split';

function Waveform({ tone, seed, playedWidthPx }: { tone: 'tts' | 'bgm'; seed: number; playedWidthPx: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setCount(Math.floor(element.offsetWidth / WAVEFORM_BAR_PITCH_PX));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const bars = useMemo(() => Array.from({ length: Math.max(0, count) }, (_, index) => {
    const raw = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453;
    return 18 + (raw - Math.floor(raw)) * 74;
  }), [count, seed]);
  const playedCount = Math.round(Math.max(0, playedWidthPx) / WAVEFORM_BAR_PITCH_PX);
  return (
    <div ref={ref} className={`${styles.wf} ${tone === 'tts' ? styles.wfTts : styles.wfBgm}`} aria-hidden="true">
      {bars.map((height, index) => <span key={index} style={{ height: `${height}%` }} data-played={index < playedCount || undefined} />)}
    </div>
  );
}

export function MixcutTimeline({
  variant,
  cues,
  assets,
  selectedClipId,
  selectedCueId,
  playheadSec,
  disabled,
  onSeek,
  onSelectClip,
  onSelectCue,
  onVariantCommand,
  onGroupCommand,
  onTrimClip,
  onEditCueText,
  narrationPlaybackRate,
  narrationDurationSec,
  onNarrationPlaybackRatePreview,
  onNarrationPlaybackRateCommit,
  bgmTrackName,
}: {
  variant: FinalEditVariantView;
  cues: SubtitleCue[];
  assets: FinalEditAssetView[];
  selectedClipId: string;
  selectedCueId: string;
  playheadSec: number;
  disabled: boolean;
  onSeek: (seconds: number) => void;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onVariantCommand: (command: VariantCommandInput) => Promise<boolean>;
  onGroupCommand: (command: GroupCommandInput) => Promise<boolean>;
  onTrimClip: (clip: TimelineClip) => void;
  onEditCueText: (cueId: string, text: string) => void;
  narrationPlaybackRate: number;
  narrationDurationSec: number;
  onNarrationPlaybackRatePreview: (playbackRate: number) => void;
  onNarrationPlaybackRateCommit: (playbackRate: number) => void;
  bgmTrackName?: string | null;
}) {
  const pxPerSecond = PX_PER_SECOND;
  const [viewportWidth, setViewportWidth] = useState(720);
  const [contextMenu, setContextMenu] = useState<TimelineContextMenu | null>(null);
  const [tool, setTool] = useState<TimelineTool>('select');
  const narrationPlaybackRatePendingRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const videoBodySec = variant.timeline.bodyFrames / FPS;
  const bodySec = narrationDurationSec;
  const totalSec = INTRO_FRAMES / FPS + bodySec;
  const totalFrames = INTRO_FRAMES + Math.round(bodySec * FPS);
  const totalUs = totalSec * 1_000_000;
  const contentWidth = timelineContentWidthPx({ totalUs, pxPerSecond, viewportWidth: Math.max(1, viewportWidth) });
  const introPx = INTRO_FRAMES / FPS * pxPerSecond;
  const playheadPx = Math.max(0, Math.min(totalSec, playheadSec)) * pxPerSecond;
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.videoJobId, asset])), [assets]);
  const orderedClips = useMemo(() => [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame), [variant.timeline.clips]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewportWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const closeContextMenu = useCallback(() => {
    const pending = narrationPlaybackRatePendingRef.current;
    if (contextMenu?.kind === 'narration' && pending !== null) {
      narrationPlaybackRatePendingRef.current = null;
      onNarrationPlaybackRateCommit(pending);
    }
    setContextMenu(null);
  }, [contextMenu, onNarrationPlaybackRateCommit]);

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

  const seekFromPointer = (clientX: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const absoluteFrame = timelineAbsoluteFrameFromPointer({
      clientX,
      contentLeft: scroll.getBoundingClientRect().left,
      scrollLeft: scroll.scrollLeft,
      pxPerSecond,
      totalFrames,
      fps: FPS,
    });
    onSeek(absoluteFrame / FPS);
  };

  const ticks = Array.from({ length: Math.floor(totalSec) }, (_, index) => index * 0.5 + 0.5);
  const beginPlayheadDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
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
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  };

  return (
    <div className={styles.tlShell}>
      <div className={styles.tlToolbar} role="toolbar" aria-label="字幕时间轴工具">
        <button
          type="button"
          aria-label="选择工具"
          aria-pressed={tool === 'select'}
          className={[styles.tlToolButton, tool === 'select' ? styles.tlToolButtonActive : ''].filter(Boolean).join(' ')}
          disabled={disabled}
          onClick={() => setTool('select')}
        >
          <Icon name="check-circle" size={13} />选择
        </button>
        <button
          type="button"
          aria-label="分割工具"
          aria-pressed={tool === 'split'}
          className={[styles.tlToolButton, tool === 'split' ? styles.tlToolButtonActive : ''].filter(Boolean).join(' ')}
          disabled={disabled}
          onClick={() => setTool('split')}
        >
          <Icon name="scissors" size={13} />分割
        </button>
        <span className={styles.tlToolHint} data-testid="mixcut-timeline-tool-hint">{tool === 'split' ? '点击字幕块上的目标位置即可切开' : '拖动字幕块移动，拖两侧修剪，双击改字'}</span>
      </div>
      <section className={styles.tl} aria-label="智能混剪时间轴" aria-busy={disabled} data-mutations-disabled={disabled || undefined} data-tool={tool}>
      <div className={styles.tlLabels}>
        <div className={styles.tlLab} style={{ height: 20 }} />
        <div className={styles.tlLab} style={{ height: 64 }}>视频</div>
        <div className={styles.tlLab} style={{ height: 28 }}>字幕</div>
        <div className={styles.tlLab} style={{ height: 60 }}>音频</div>
      </div>
      <div ref={scrollRef} className={styles.tlScroll} data-testid="mixcut-timeline-scroll">
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
            {orderedClips.map((clip, index) => (
              <VideoBlock
                key={`${clip.id}-${clip.sourceInFrame}-${clip.sourceOutFrame}-${clip.timelineInFrame}-${clip.timelineOutFrame}`}
                clip={clip}
                index={index}
                clips={variant.timeline.clips}
                sourceFrames={Math.floor((assetById.get(clip.videoJobId)?.durationUs || 0) / 1_000_000 * FPS)}
                thumbnailUrl={assetById.get(clip.videoJobId)?.thumbnailUrl}
                bodyFrames={variant.timeline.bodyFrames}
                pxPerSecond={pxPerSecond}
                selected={clip.id === selectedClipId}
                disabled={disabled}
                onSelect={onSelectClip}
                onCommand={onVariantCommand}
                onTrimClip={onTrimClip}
                onOpenContextMenu={(clientX, clientY) => setContextMenu({
                  kind: 'video',
                  clipId: clip.id,
                  x: Math.max(8, Math.min(clientX, window.innerWidth - 184)),
                  y: Math.max(8, Math.min(clientY, window.innerHeight - 86)),
                })}
              />
            ))}
            {bodySec > videoBodySec && (
              <div
                className={styles.videoFreezeTail}
                style={{ left: (INTRO_FRAMES / FPS + videoBodySec) * pxPerSecond, width: (bodySec - videoBodySec) * pxPerSecond }}
              >末帧延长</div>
            )}
          </div>
          <div className={`${styles.tlTrack} ${styles.tlTrackSub}`} data-track="subtitle">
            {cues.map((cue, index) => (
              <SubtitleBlock
                key={`${cue.id}-${cue.startUs}-${cue.endUs}`}
                cue={cue}
                previousCue={index > 0 ? cues[index - 1] : null}
                nextCue={index < cues.length - 1 ? cues[index + 1] : null}
                bodyUs={narrationDurationSec * narrationPlaybackRate * 1_000_000}
                playbackRate={narrationPlaybackRate}
                pxPerSecond={pxPerSecond}
                selected={cue.id === selectedCueId}
                anySelected={Boolean(selectedCueId)}
                disabled={disabled}
                tool={tool}
                onSelect={onSelectCue}
                onCommand={onGroupCommand}
                onEditText={onEditCueText}
              />
            ))}
          </div>
          <div
            className={`${styles.tlTrack} ${styles.tlTrackAudio} ${styles.tlTrackNarration}`}
            data-track="narration"
            title="右键调整口播音频倍速"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (disabled) return;
              narrationPlaybackRatePendingRef.current = null;
              setContextMenu({
                kind: 'narration',
                x: Math.max(8, Math.min(event.clientX, window.innerWidth - 356)),
                y: Math.max(8, Math.min(event.clientY, window.innerHeight - 224)),
              });
            }}
          >
            <Waveform tone="tts" seed={3} playedWidthPx={playheadPx} />
            <span className={styles.wfLabel} style={{ left: introPx + 8 }}>锁定口播 · {narrationPlaybackRate.toFixed(1)}x · {narrationDurationSec.toFixed(1)}s</span>
          </div>
          <div className={`${styles.tlTrack} ${styles.tlTrackAudio}`} data-track="bgm" style={{ borderBottom: 'none' }}>
          <Waveform tone="bgm" seed={7} playedWidthPx={playheadPx} />
          <span className={styles.wfLabel} style={{ left: introPx + 8 }}>{variant.bgm.trackId && bgmTrackName ? `${bgmTrackName} · ${variant.bgm.gainDb} dB · 淡入 ${variant.bgm.fadeInSec}s · 淡出 ${variant.bgm.fadeOutSec}s` : '无 BGM'}</span>
          </div>
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
            role={contextMenu.kind === 'video' ? 'menu' : 'dialog'}
            aria-label={contextMenu.kind === 'video' ? '视频片段操作' : '口播音频变速'}
            className={`${styles.timelineContextMenu} ${contextMenu.kind === 'narration' ? styles.timelineSpeedMenu : ''}`}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {contextMenu.kind === 'video' ? (
              <button
                type="button"
                role="menuitem"
                className={styles.timelineContextDanger}
                disabled={disabled}
                onClick={() => {
                  const clipId = contextMenu.clipId;
                  setContextMenu(null);
                  void onVariantCommand({ type: 'delete_clip', clipId }).then((accepted) => {
                    if (accepted && selectedClipId === clipId) onSelectClip('');
                  });
                }}
              >删除片段</button>
            ) : (
              <>
                <div className={styles.timelineContextTitle}>调整音频倍速</div>
                <div className={styles.timelineSpeedHint} id="mixcut-narration-speed-help">拖动后立即作用于当前音轨，松手自动保存。</div>
                <NarrationPlaybackRateControl
                  idPrefix="mixcut-narration-context-speed"
                  value={narrationPlaybackRate}
                  disabled={disabled}
                  onPreview={onNarrationPlaybackRatePreview}
                  onCommit={onNarrationPlaybackRateCommit}
                  onPendingChange={(pending) => { narrationPlaybackRatePendingRef.current = pending; }}
                />
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
      </section>
    </div>
  );
}

function VideoBlock({ clip, index, clips, sourceFrames, thumbnailUrl, bodyFrames, pxPerSecond, selected, disabled, onSelect, onCommand, onTrimClip, onOpenContextMenu }: {
  clip: TimelineClip;
  index: number;
  clips: TimelineClip[];
  sourceFrames: number;
  thumbnailUrl?: string;
  bodyFrames: number;
  pxPerSecond: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (clipId: string) => void;
  onCommand: (command: VariantCommandInput) => Promise<boolean>;
  onTrimClip: (clip: TimelineClip) => void;
  onOpenContextMenu: (clientX: number, clientY: number) => void;
}) {
  const initial: ClipDraft = { sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame };
  const [draft, setDraft] = useState(initial);
  const [reorderIds, setReorderIds] = useState<string[] | null>(null);
  const left = (INTRO_FRAMES + draft.timelineInFrame) / FPS * pxPerSecond;
  const width = (draft.timelineOutFrame - draft.timelineInFrame) / FPS * pxPerSecond;
  const durationSec = (draft.timelineOutFrame - draft.timelineInFrame) / FPS;

  const begin = (mode: ClipDragMode, event: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(clip.id);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let latest = initial;
    let latestOrder: string[] | null = null;
    let changed = false;
    const orderedIds = [...clips].sort((a, b) => a.timelineInFrame - b.timelineInFrame).map((item) => item.id);
    const move = (pointer: PointerEvent) => {
      const deltaFrames = Math.round((pointer.clientX - startX) / pxPerSecond * FPS);
      changed = changed || deltaFrames !== 0;
      if (mode === 'move') {
        const pointerFrame = initial.timelineInFrame + (initial.timelineOutFrame - initial.timelineInFrame) / 2 + deltaFrames;
        const planned = planClipReorder({ clips, clipId: clip.id, pointerFrame });
        latestOrder = planned.some((id, idx) => id !== orderedIds[idx]) ? planned : null;
        setReorderIds(latestOrder);
      }
      latest = constrainClipDrag({ clip: { ...clip, ...initial }, clips, bodyFrames, sourceFrames, mode, deltaFrames });
      setDraft(latest);
    };
    const up = async (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      if (!changed) return;
      const accepted = latestOrder
        ? await onCommand({ type: 'reorder_clips', orderedClipIds: latestOrder })
        : mode === 'move'
          ? await onCommand({ type: 'move_clip', clipId: clip.id, timelineInFrame: latest.timelineInFrame })
          : await onCommand({ type: 'trim_clip', clipId: clip.id, sourceInFrame: latest.sourceInFrame, sourceOutFrame: latest.sourceOutFrame, timelineInFrame: latest.timelineInFrame, timelineOutFrame: latest.timelineOutFrame });
      if (!accepted) setDraft(initial);
      setReorderIds(null);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  };

  return (
    <article
      data-clip-id={clip.id}
      data-selected={selected ? 'true' : undefined}
      data-reorder-active={reorderIds ? 'true' : undefined}
      className={`${styles.clip} ${selected ? styles.clipSel : ''}`}
      style={{ left, width, background: 'linear-gradient(135deg,#3a3d46,#22242b)' }}
      onPointerDown={(event) => begin('move', event)}
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(clip.id);
        onOpenContextMenu(event.clientX, event.clientY);
      }}
      onDoubleClick={() => !disabled && onTrimClip(clip)}
      title="单击选中 · 拖拽排序 · 双击截取时段 · 右键更多操作"
    >
      {thumbnailUrl && <img src={thumbnailUrl} alt="" draggable={false} />}
      <span className={styles.clipNo}>#{index + 1}</span>
      <span className={styles.clipCd}>{durationSec.toFixed(1)}s</span>
      <i className={`${styles.clipHandle} ${styles.clipHandleL}`} aria-label="裁剪片段开头" onPointerDown={(event) => begin('start', event)} />
      <i className={`${styles.clipHandle} ${styles.clipHandleR}`} aria-label="裁剪片段结尾" onPointerDown={(event) => begin('end', event)} />
    </article>
  );
}

function SubtitleBlock({ cue, previousCue, nextCue, bodyUs, playbackRate, pxPerSecond, selected, anySelected, disabled, tool, onSelect, onCommand, onEditText }: {
  cue: SubtitleCue;
  previousCue: SubtitleCue | null;
  nextCue: SubtitleCue | null;
  bodyUs: number;
  playbackRate: number;
  pxPerSecond: number;
  selected: boolean;
  anySelected: boolean;
  disabled: boolean;
  tool: TimelineTool;
  onSelect: (cueId: string) => void;
  onCommand: (command: GroupCommandInput) => Promise<boolean>;
  onEditText: (cueId: string, text: string) => void;
}) {
  const initial = { startUs: cue.startUs, endUs: cue.endUs };
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [splitPlan, setSplitPlan] = useState<SubtitleCueSplitPlan | null>(null);
  const splitPlanFromPointer = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return planSubtitleCueSplit({
      cue: { ...cue, startUs: draft.startUs, endUs: draft.endUs },
      requestedSplitUs: draft.startUs + (draft.endUs - draft.startUs) * ratio,
      fps: FPS,
    });
  };
  const begin = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLElement>) => {
    if (disabled || tool !== 'select') return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(cue.id);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let latest = initial;
    let changed = false;
    const move = (pointer: PointerEvent) => {
      const deltaUs = Math.round((pointer.clientX - startX) / pxPerSecond * 1_000_000 * playbackRate / FRAME_US) * FRAME_US;
      changed = changed || deltaUs !== 0;
      if (mode === 'move') {
        const duration = initial.endUs - initial.startUs;
        const startUs = Math.max(previousCue?.endUs ?? 0, Math.min((nextCue?.startUs ?? bodyUs) - duration, initial.startUs + deltaUs));
        latest = { startUs, endUs: startUs + duration };
      } else if (mode === 'start') {
        latest = { startUs: Math.max(previousCue?.endUs ?? 0, Math.min(initial.endUs - FRAME_US, initial.startUs + deltaUs)), endUs: initial.endUs };
      } else {
        latest = { startUs: initial.startUs, endUs: Math.min(nextCue?.startUs ?? bodyUs, Math.max(initial.startUs + FRAME_US, initial.endUs + deltaUs)) };
      }
      setDraft(latest);
    };
    const up = async (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      if (!changed) return;
      const accepted = await onCommand(mode === 'move'
        ? { type: 'move_subtitle_cue', cueId: cue.id, startUs: latest.startUs, endUs: latest.endUs }
        : { type: 'trim_subtitle_cue', cueId: cue.id, startUs: latest.startUs, endUs: latest.endUs });
      if (!accepted) setDraft(initial);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  };
  return (
    <article
      data-cue-id={cue.id}
      className={`${styles.subclip} ${selected ? styles.subclipSel : anySelected ? styles.subclipDim : ''}`}
      style={{ left: (INTRO_FRAMES / FPS + draft.startUs / 1_000_000 / playbackRate) * pxPerSecond, width: (draft.endUs - draft.startUs) / 1_000_000 / playbackRate * pxPerSecond }}
      onPointerMove={(event) => {
        if (tool === 'split' && !disabled) setSplitPlan(splitPlanFromPointer(event.clientX, event.currentTarget));
      }}
      onPointerLeave={() => setSplitPlan(null)}
      onPointerDown={(event) => {
        if (tool === 'select') {
          begin('move', event);
          return;
        }
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        const plan = splitPlanFromPointer(event.clientX, event.currentTarget);
        if (!plan) return;
        onSelect(cue.id);
        setSplitPlan(null);
        void onCommand({ type: 'split_subtitle_cue', cueId: cue.id, ...plan });
      }}
      onDoubleClick={() => { if (!disabled && tool === 'select') { onSelect(cue.id); setEditing(true); } }}
      title={tool === 'split' ? '点击此处切开字幕' : '双击编辑文案'}
    >
      {editing ? (
        <input
          type="text"
          defaultValue={cue.text}
          autoFocus
          style={{ width: '100%', padding: '1px 4px', fontSize: 11 }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => { onEditText(cue.id, event.target.value); setEditing(false); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <>
          {tool === 'split' && splitPlan && (
            <i
              className={styles.subtitleSplitPreview}
              style={{ left: String((splitPlan.splitUs - draft.startUs) / Math.max(1, draft.endUs - draft.startUs) * 100) + '%' }}
              aria-hidden="true"
            />
          )}
          <i className={`${styles.clipHandle} ${styles.clipHandleL}`} aria-label="裁剪字幕开头" onPointerDown={tool === 'select' ? (event) => begin('start', event) : undefined} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{cue.text}</span>
          <i className={`${styles.clipHandle} ${styles.clipHandleR}`} aria-label="裁剪字幕结尾" onPointerDown={tool === 'select' ? (event) => begin('end', event) : undefined} />
        </>
      )}
    </article>
  );
}
