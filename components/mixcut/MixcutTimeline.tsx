'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES, type FinalEditAssetView, type FinalEditVariantView, type SubtitleCue, type TimelineClip } from '@/lib/final-edit/types';
import type { GroupCommandInput, VariantCommandInput } from '@/components/final-edit/command-types';
import { clampTimelineZoom, constrainClipDrag, planClipReorder, timelineAbsoluteFrameFromPointer, timelineContentWidthPx, type ClipDragMode, type ClipDraft } from '@/components/final-edit/timeline-edit';
import styles from './MixcutPanel.module.css';

const FPS = FINAL_EDIT_FPS;
const INTRO_FRAMES = FINAL_EDIT_INTRO_FRAMES;
const FRAME_US = Math.round(1_000_000 / FPS);
const LABEL_WIDTH = 88;

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${(safe % 60).toFixed(1).padStart(4, '0')}`;
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
}) {
  const [pxPerSecond, setPxPerSecond] = useState(80);
  const [viewportWidth, setViewportWidth] = useState(720);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodySec = variant.timeline.bodyFrames / FPS;
  const totalSec = (INTRO_FRAMES + variant.timeline.bodyFrames) / FPS;
  const totalUs = totalSec * 1_000_000;
  const contentWidth = timelineContentWidthPx({ totalUs, pxPerSecond, viewportWidth: Math.max(1, viewportWidth - LABEL_WIDTH) });
  const introPx = INTRO_FRAMES / FPS * pxPerSecond;
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.videoJobId, asset])), [assets]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewportWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const seekFromPointer = (clientX: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const absoluteFrame = timelineAbsoluteFrameFromPointer({
      clientX,
      contentLeft: scroll.getBoundingClientRect().left + LABEL_WIDTH,
      scrollLeft: scroll.scrollLeft,
      pxPerSecond,
      totalFrames: INTRO_FRAMES + variant.timeline.bodyFrames,
      fps: FPS,
    });
    onSeek(absoluteFrame / FPS);
  };
  const ticks = Array.from({ length: Math.floor(totalSec) + 1 }, (_, index) => index).filter((value) => value % (pxPerSecond >= 140 ? 1 : pxPerSecond >= 70 ? 2 : 5) === 0);

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
    <section className={styles.mixcutTimeline} aria-label="智能混剪时间轴" aria-busy={disabled} data-mutations-disabled={disabled || undefined}>
      <div className={styles.timelineToolbar}>
        <div><strong>精细时间轴</strong><span>{formatTime(playheadSec)} / {formatTime(totalSec)}</span></div>
        <label className={styles.zoomControl}>
          <span>缩放</span>
          <button type="button" onClick={() => setPxPerSecond((value) => clampTimelineZoom(value - 20))} aria-label="缩小时间轴">−</button>
          <input aria-label="时间轴缩放" type="range" min={40} max={240} step={10} value={pxPerSecond} onChange={(event) => setPxPerSecond(clampTimelineZoom(Number(event.target.value)))} />
          <button type="button" onClick={() => setPxPerSecond((value) => clampTimelineZoom(value + 20))} aria-label="放大时间轴">＋</button>
          <output>{pxPerSecond} px/s</output>
        </label>
      </div>
      <div ref={scrollRef} className={styles.timelineScroll} data-testid="mixcut-timeline-scroll">
        <div className={styles.timelineCanvas} style={{ width: contentWidth + LABEL_WIDTH }}>
          <div className={styles.timelineLabels}>
            <div className={styles.timelineRulerLabel}>轨道</div>
            {['视频', '字幕', '口播', 'BGM'].map((label) => <div className={styles.timelineLabel} key={label}>{label}</div>)}
          </div>
          <div className={styles.timelineContent} style={{ width: contentWidth }} onPointerDown={(event) => seekFromPointer(event.clientX)}>
            <div className={styles.timelineRuler}>
              {ticks.map((tick) => <span key={tick} style={{ left: tick * pxPerSecond }}>{tick}s</span>)}
            </div>
            <div className={styles.timelineTrack} data-track="video">
              <div className={styles.introBlock} style={{ left: 0, width: introPx }}>封面</div>
              {[...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame).map((clip) => (
                <VideoBlock
                  key={`${clip.id}-${clip.sourceInFrame}-${clip.sourceOutFrame}-${clip.timelineInFrame}-${clip.timelineOutFrame}`}
                  clip={clip}
                  clips={variant.timeline.clips}
                  sourceFrames={Math.floor((assetById.get(clip.videoJobId)?.durationUs || 0) / 1_000_000 * FPS)}
                  thumbnailUrl={assetById.get(clip.videoJobId)?.thumbnailUrl}
                  bodyFrames={variant.timeline.bodyFrames}
                  pxPerSecond={pxPerSecond}
                  selected={clip.id === selectedClipId}
                  disabled={disabled}
                  onSelect={onSelectClip}
                  onCommand={onVariantCommand}
                />
              ))}
            </div>
            <div className={styles.timelineTrack} data-track="subtitle">
              {cues.map((cue, index) => (
                <SubtitleBlock
                  key={`${cue.id}-${cue.startUs}-${cue.endUs}`}
                  cue={cue}
                  previousCue={index > 0 ? cues[index - 1] : null}
                  nextCue={index < cues.length - 1 ? cues[index + 1] : null}
                  bodyUs={bodySec * 1_000_000}
                  pxPerSecond={pxPerSecond}
                  selected={cue.id === selectedCueId}
                  disabled={disabled}
                  onSelect={onSelectCue}
                  onCommand={onGroupCommand}
                />
              ))}
            </div>
            <div className={styles.timelineTrack} data-track="narration">
              <div className={`${styles.audioTrackBlock} ${styles.narrationTrackBlock}`} style={{ left: introPx, width: bodySec * pxPerSecond }}><span className={styles.waveform} aria-label="口播波形" /><b>锁定口播 · {bodySec.toFixed(2)}s</b></div>
            </div>
            <div className={styles.timelineTrack} data-track="bgm">
              <div className={`${styles.audioTrackBlock} ${styles.bgmTrackBlock}`} style={{ left: introPx, width: bodySec * pxPerSecond }}><span className={styles.waveform} aria-label="BGM 波形" /><b>{variant.bgm.trackId ? `${variant.bgm.gainDb} dB · 淡入 ${variant.bgm.fadeInSec}s · 淡出 ${variant.bgm.fadeOutSec}s` : '无 BGM'}</b></div>
            </div>
            <button
              type="button"
              aria-label="拖动播放头"
              className={styles.timelinePlayhead}
              style={{ left: Math.max(0, Math.min(totalSec, playheadSec)) * pxPerSecond }}
              onPointerDown={beginPlayheadDrag}
            ><span /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function VideoBlock({ clip, clips, sourceFrames, thumbnailUrl, bodyFrames, pxPerSecond, selected, disabled, onSelect, onCommand }: {
  clip: TimelineClip;
  clips: TimelineClip[];
  sourceFrames: number;
  thumbnailUrl?: string;
  bodyFrames: number;
  pxPerSecond: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (clipId: string) => void;
  onCommand: (command: VariantCommandInput) => Promise<boolean>;
}) {
  const initial: ClipDraft = { sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame };
  const [draft, setDraft] = useState(initial);
  const [reorderIds, setReorderIds] = useState<string[] | null>(null);
  const left = (INTRO_FRAMES + draft.timelineInFrame) / FPS * pxPerSecond;
  const width = (draft.timelineOutFrame - draft.timelineInFrame) / FPS * pxPerSecond;

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
        latestOrder = planned.some((id, index) => id !== orderedIds[index]) ? planned : null;
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
      data-reorder-active={reorderIds ? 'true' : undefined}
      className={`${styles.timelineBlock} ${styles.videoTimelineBlock} ${selected ? styles.selectedTimelineBlock : ''}`}
      style={{ left, width, backgroundImage: thumbnailUrl ? `url(${JSON.stringify(thumbnailUrl).slice(1, -1)})` : undefined }}
      onPointerDown={(event) => begin('move', event)}
    >
      <i className={styles.timelineHandle} aria-label="裁剪片段开头" onPointerDown={(event) => begin('start', event)} />
      <b>{clip.videoJobId.replace('external-asset-', '外部 ').slice(0, 18)}</b>
      <i className={styles.timelineHandle} aria-label="裁剪片段结尾" onPointerDown={(event) => begin('end', event)} />
    </article>
  );
}

function SubtitleBlock({ cue, previousCue, nextCue, bodyUs, pxPerSecond, selected, disabled, onSelect, onCommand }: {
  cue: SubtitleCue;
  previousCue: SubtitleCue | null;
  nextCue: SubtitleCue | null;
  bodyUs: number;
  pxPerSecond: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (cueId: string) => void;
  onCommand: (command: GroupCommandInput) => Promise<boolean>;
}) {
  const initial = { startUs: cue.startUs, endUs: cue.endUs };
  const [draft, setDraft] = useState(initial);
  const begin = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(cue.id);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let latest = initial;
    let changed = false;
    const move = (pointer: PointerEvent) => {
      const deltaUs = Math.round((pointer.clientX - startX) / pxPerSecond * 1_000_000 / FRAME_US) * FRAME_US;
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
      className={`${styles.timelineBlock} ${styles.subtitleTimelineBlock} ${selected ? styles.selectedTimelineBlock : ''}`}
      style={{ left: (INTRO_FRAMES / FPS + draft.startUs / 1_000_000) * pxPerSecond, width: (draft.endUs - draft.startUs) / 1_000_000 * pxPerSecond }}
      onPointerDown={(event) => begin('move', event)}
    >
      <i className={styles.timelineHandle} aria-label="裁剪字幕开头" onPointerDown={(event) => begin('start', event)} />
      <b>{cue.text}</b>
      <i className={styles.timelineHandle} aria-label="裁剪字幕结尾" onPointerDown={(event) => begin('end', event)} />
    </article>
  );
}
