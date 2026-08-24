'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { timelineAbsoluteFrameFromPointer, timelineContentWidthPx } from '@/components/final-edit/timeline-edit';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/final-edit/types';
import type { BatchOutputClipView, BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import styles from '../mixcut/mixcut-content.module.css';

const FPS = FINAL_EDIT_FPS; // 24
const INTRO_FRAMES = FINAL_EDIT_INTRO_FRAMES; // 20
const INTRO_SEC = INTRO_FRAMES / FPS; // 片头封面静帧秒数
const PX_PER_SECOND = 60; // 与 MixcutTimeline 固定缩放一致
const MIN_FRAMES = 12; // 0.5s 最短片段
const WAVEFORM_BAR_PITCH_PX = 4.5; // 2.5px 柱宽 + 2px 间距，与 CSS 保持一致

const usToFrame = (us: number) => Math.round((us / 1_000_000) * FPS);
const frameToUs = (frame: number) => Math.round((frame / FPS) * 1_000_000);
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

type TimelineTool = 'select' | 'split';
type TrimDragMode = 'start' | 'end' | 'slip';

/** 拖拽中的本地修剪预览（帧），用于镜像服务端 ripple 的显示布局。 */
interface ClipTrimDraft {
  clipId: string;
  sourceIn: number;
  sourceOut: number;
}

interface ClipContextMenuState {
  clipId: string;
  x: number;
  y: number;
}

// 伪波形组件：原样复制自 components/mixcut/MixcutTimeline.tsx（那边没有 export）。
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

export interface BatchTimelineProps {
  /** 必须是对 fetched view 的稳定引用（如 useMemo([view])）；draft 实时预览靠 draftState.clips === clips 引用比较失效，每次 render 新建数组会让拖拽预览静默失效。 */
  clips: BatchOutputClipView[];
  assets: BatchOutputPoolAssetView[]; // 取 thumbnailUrl/displayName/durationSec
  subtitleCues: Array<{ startUs: number; endUs: number; text: string }>;
  narrationDurationUs: number | null;
  playheadSec: number; // 含片头绝对时间
  selectedClipId: string | null;
  disabled: boolean; // 只禁用变更手势，不禁用 seek/选中
  onSeek: (sec: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onTrimVariable: (clipId: string, sourceStartUs: number, sourceEndUs: number) => Promise<boolean>;
  onSplit: (clipId: string, offsetUs: number) => Promise<boolean>;
  onOpenFineTrim: (clipId: string) => void;
  onDeleteClip: (clipId: string) => void;
}

/**
 * 批量「检查成片」时间轴：画面轨（选中/拖边缘变长修剪/拖中段等长平移/分割/右键菜单）
 * + 字幕、口播只读对照轨。交互范式对齐 components/mixcut/MixcutTimeline.tsx。
 * 时间坐标：clips 与 subtitleCues 是正文（片头后）相对时间，playheadSec 是含片头绝对时间。
 */
export default function BatchTimeline({
  clips,
  assets,
  subtitleCues,
  narrationDurationUs,
  playheadSec,
  selectedClipId,
  disabled,
  onSeek,
  onSelectClip,
  onTrimVariable,
  onSplit,
  onOpenFineTrim,
  onDeleteClip,
}: BatchTimelineProps) {
  const pxPerSecond = PX_PER_SECOND;
  const [viewportWidth, setViewportWidth] = useState(720);
  const [tool, setTool] = useState<TimelineTool>('select');
  const [contextMenu, setContextMenu] = useState<ClipContextMenuState | null>(null);
  // 修剪预览锚定到产生它时的 clips 数组：clips 刷新后 draft 自动失效，无需 effect 清理
  const [draftState, setDraftState] = useState<{ clips: BatchOutputClipView[]; value: ClipTrimDraft } | null>(null);
  const draft = draftState && draftState.clips === clips ? draftState.value : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  const visualFrames = usToFrame(clips.at(-1)?.timelineEndUs ?? 0);
  const narrationFrames = narrationDurationUs != null ? usToFrame(narrationDurationUs) : null;
  const bodyFrames = Math.max(visualFrames, narrationFrames ?? 0);
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
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  };

  // 拖拽预览镜像服务端 ripple：draft 存在时显示布局从 0 起首尾相接重新累计
  const clipLayout = useMemo(() => {
    const entries = clips.map((clip) => {
      const timelineInFrame = usToFrame(clip.timelineStartUs);
      const timelineOutFrame = usToFrame(clip.timelineEndUs);
      const sourceIn = usToFrame(clip.sourceStartUs);
      const sourceOut = usToFrame(clip.sourceEndUs);
      const activeDraft = draft?.clipId === clip.clipId ? draft : null;
      const durFrames = activeDraft ? activeDraft.sourceOut - activeDraft.sourceIn : timelineOutFrame - timelineInFrame;
      return { clip, timelineInFrame, sourceIn, sourceOut, durFrames };
    });
    const laidOut: Array<(typeof entries)[number] & { displayInFrame: number }> = [];
    let cursorFrames = 0;
    for (const entry of entries) {
      const displayInFrame = draft ? cursorFrames : entry.timelineInFrame;
      cursorFrames = displayInFrame + entry.durFrames;
      laidOut.push({ ...entry, displayInFrame });
    }
    return laidOut;
  }, [clips, draft]);

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
        <span className={styles.tlToolHint}>{effectiveTool === 'split' ? '点击片段上的目标位置切开（两侧至少 0.5 秒）' : '单击选中 · 拖边缘变长修剪 · 拖中段等长平移 · 双击精细修剪 · 右键更多'}</span>
      </div>
      <section className={styles.tl} aria-label="成片时间轴" data-testid="batch-output-timeline" data-tool={effectiveTool}>
        <div className={styles.tlLabels}>
          <div className={styles.tlLab} style={{ height: 20 }} />
          <div className={styles.tlLab} style={{ height: 64 }}>视频</div>
          <div className={styles.tlLab} style={{ height: 28 }}>字幕</div>
          <div className={styles.tlLab} style={{ height: 60 }}>口播</div>
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
                      clipId,
                      x: Math.max(8, Math.min(clientX, window.innerWidth - 184)),
                      y: Math.max(8, Math.min(clientY, window.innerHeight - 96)),
                    })}
                  />
                );
              })}
              {narrationFrames != null && narrationFrames > visualFrames && (
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
                <div
                  key={`${cue.startUs}-${cue.endUs}-${index}`}
                  className={styles.subclip}
                  style={{
                    left: (INTRO_SEC + cue.startUs / 1e6) * pxPerSecond,
                    width: ((cue.endUs - cue.startUs) / 1e6) * pxPerSecond,
                    pointerEvents: 'none',
                  }}
                  title={cue.text}
                >{cue.text}</div>
              ))}
            </div>
            <div
              className={`${styles.tlTrack} ${styles.tlTrackAudio} ${styles.tlTrackNarration}`}
              data-track="narration"
              style={{ height: 60, borderBottom: 'none' }}
            >
              {narrationDurationUs != null ? (
                <>
                  <Waveform tone="tts" seed={3} playedWidthPx={playheadPx} />
                  <span className={styles.wfLabel} style={{ left: introPx + 8 }}>口播（锁定）· {(narrationDurationUs / 1e6).toFixed(1)}s</span>
                </>
              ) : (
                <span className={styles.wfLabel} style={{ left: introPx + 8 }}>无口播配音</span>
              )}
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
              role="menu"
              aria-label="片段操作"
              className={styles.timelineContextMenu}
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
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
              >删除片段</button>
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
    let changed = false;
    const move = (pointer: PointerEvent) => {
      const deltaFrames = Math.round(((pointer.clientX - startX) / pxPerSecond) * FPS);
      changed = changed || deltaFrames !== 0;
      if (mode === 'start') {
        latest = { sourceIn: clamp(sourceIn + deltaFrames, 0, sourceOut - MIN_FRAMES), sourceOut };
      } else if (mode === 'end') {
        latest = { sourceIn, sourceOut: clamp(sourceOut + deltaFrames, sourceIn + MIN_FRAMES, sourceTotalFrames) };
      } else {
        const shift = clamp(deltaFrames, -sourceIn, sourceTotalFrames - sourceOut);
        latest = { sourceIn: sourceIn + shift, sourceOut: sourceOut + shift };
      }
      onDraftChange({ clipId: clip.clipId, sourceIn: latest.sourceIn, sourceOut: latest.sourceOut });
    };
    const up = async (pointer: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId);
      if (!changed) {
        onDraftChange(null);
        return;
      }
      const accepted = await onTrimVariable(clip.clipId, frameToUs(latest.sourceIn), frameToUs(latest.sourceOut));
      if (!accepted) onDraftChange(null);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
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
        begin('slip', event);
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
      title="单击选中 · 拖边缘变长修剪 · 拖中段等长平移 · 双击精细修剪 · 右键更多"
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
      <span className={styles.clipCd}>{durationSec.toFixed(1)}s</span>
      <i className={`${styles.clipHandle} ${styles.clipHandleL}`} aria-label="修剪片段开头" onPointerDown={tool === 'select' ? (event) => begin('start', event) : undefined} />
      <i className={`${styles.clipHandle} ${styles.clipHandleR}`} aria-label="修剪片段结尾" onPointerDown={tool === 'select' ? (event) => begin('end', event) : undefined} />
    </article>
  );
}
