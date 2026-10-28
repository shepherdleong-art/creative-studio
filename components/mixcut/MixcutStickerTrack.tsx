'use client';

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  STICKER_FPS,
  applyPackagingStickerEdit,
  resolveStickerStyle,
  type PackagingStickerInstance,
} from '@/lib/media-core/packaging-stickers';
import type { PackagingTemplateId } from '@/lib/final-edit/packaging-vars';
import {
  layoutPackagingStickerTracks,
  movePackagingStickerToTrack,
  normalizePackagingStickerTracks,
  planPackagingStickerFrames,
} from '@/lib/media-core/packaging-sticker-timeline';
import styles from './mixcut-content.module.css';

export const MIXCUT_STICKER_TRACK_HEIGHT = 28;

type DragMode = 'move' | 'start' | 'end';
type StickerDraft = {
  id: string;
  mode: DragMode;
  startFrame: number;
  endFrame: number;
  initialTrackIndex: number;
  targetTrackIndex: number;
  snapSec: number | null;
};

export function MixcutStickerTrack({
  stickers,
  template,
  expanded,
  trackCount,
  bodyEndFrame,
  pxPerSecond,
  snapEnabled,
  snapCandidates,
  selectedStickerId,
  disabled,
  onSelect,
  onCommit,
}: {
  stickers: PackagingStickerInstance[];
  template: string;
  expanded: boolean;
  trackCount: number;
  bodyEndFrame: number;
  pxPerSecond: number;
  snapEnabled: boolean;
  /** 最终时间线秒：播放头、镜头边界与卖点边界。其他贴纸起止点由本组件补齐。 */
  snapCandidates: number[];
  selectedStickerId: string;
  disabled: boolean;
  onSelect: (stickerId: string) => void;
  onCommit: (stickers: PackagingStickerInstance[]) => void;
}) {
  const [draft, setDraft] = useState<StickerDraft | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const hasStickers = stickers.length > 0;
  useEffect(() => {
    if (!hasStickers) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/packaging/stickers/catalog.json', { signal: controller.signal });
        if (!response.ok) return;
        const body = await response.json() as { assets?: Array<{ style?: string; id?: string; label?: string }> };
        const next: Record<string, string> = {};
        for (const asset of body.assets ?? []) {
          if (asset.style && asset.id && asset.label) next[`${asset.style}/${asset.id}`] = asset.label;
        }
        if (!controller.signal.aborted) setLabels(next);
      } catch { /* 目录暂不可用时保留功能 ID 兜底，不影响轨道编辑 */ }
    })();
    return () => controller.abort();
  }, [hasStickers]);
  const laidOut = useMemo(() => layoutPackagingStickerTracks(stickers), [stickers]);
  const lanes = useMemo(() => Array.from({ length: Math.max(1, trackCount) }, (_, trackIndex) => (
    laidOut.filter((sticker) => sticker.trackIndex === trackIndex)
  )), [laidOut, trackCount]);
  const labelFor = (sticker: PackagingStickerInstance) => labels[`${resolveStickerStyle(sticker, template as PackagingTemplateId)}/${sticker.assetId}`] ?? sticker.assetId;

  const begin = (mode: DragMode, sticker: PackagingStickerInstance, event: React.PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(sticker.id);
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const initialTrackIndex = sticker.trackIndex;
    let latest: StickerDraft = {
      id: sticker.id,
      mode,
      startFrame: sticker.startFrame,
      endFrame: sticker.endFrame,
      initialTrackIndex,
      targetTrackIndex: initialTrackIndex,
      snapSec: null,
    };
    setDraft(latest);
    target.setPointerCapture(pointerId);

    const swallowContext = (contextEvent: MouseEvent) => {
      contextEvent.preventDefault();
      contextEvent.stopPropagation();
    };
    const preventContext = (contextEvent: MouseEvent) => {
      swallowContext(contextEvent);
      cancel(true);
    };
    const cleanup = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('pointerdown', rightDown, true);
      window.removeEventListener('mousedown', rightDown, true);
      window.removeEventListener('contextmenu', preventContext, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', blur);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    };
    const cancel = (swallowContextMenu: boolean) => {
      cleanup();
      setDraft(null);
      if (!swallowContextMenu) return;
      window.addEventListener('contextmenu', swallowContext, true);
      window.setTimeout(() => window.removeEventListener('contextmenu', swallowContext, true), 600);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      pointer.preventDefault();
      const deltaFrames = Math.round((pointer.clientX - startX) / pxPerSecond * STICKER_FPS);
      const planned = planPackagingStickerFrames(sticker, {
        mode,
        deltaFrames,
        bodyEndFrame,
        candidates: snapCandidates,
        preferredCandidates: stickers.filter((item) => item.id !== sticker.id).flatMap((item) => [item.startFrame / STICKER_FPS, item.endFrame / STICKER_FPS]),
        pxPerSecond,
        snapEnabled,
      });
      const targetTrackIndex = mode === 'move'
        ? Math.max(0, Math.min(Math.max(1, trackCount) - 1, initialTrackIndex + Math.round((pointer.clientY - startY) / MIXCUT_STICKER_TRACK_HEIGHT)))
        : initialTrackIndex;
      latest = { ...latest, ...planned, targetTrackIndex };
      setDraft(latest);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId || pointer.button !== 0) return;
      pointer.preventDefault();
      cleanup();
      setDraft(null);
      const framesChanged = latest.startFrame !== sticker.startFrame || latest.endFrame !== sticker.endFrame;
      const trackChanged = latest.targetTrackIndex !== initialTrackIndex;
      if (!framesChanged && !trackChanged) return;
      let next = stickers.map((item) => item.id === sticker.id
        ? applyPackagingStickerEdit(item, { startFrame: latest.startFrame, endFrame: latest.endFrame })
        : item);
      next = trackChanged
        ? movePackagingStickerToTrack(next, sticker.id, latest.targetTrackIndex)
        : normalizePackagingStickerTracks(next);
      onCommit(next);
    };
    const pointerCancel = () => cancel(false);
    const rightDown = (mouseEvent: MouseEvent) => {
      if (mouseEvent.button !== 2) return;
      mouseEvent.preventDefault();
      mouseEvent.stopImmediatePropagation();
      cancel(true);
    };
    const keyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== 'Escape') return;
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
    };
    const blur = () => cancel(false);

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('pointerdown', rightDown, true);
    window.addEventListener('mousedown', rightDown, true);
    window.addEventListener('contextmenu', preventContext, true);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('blur', blur);
  };

  const reordering = draft?.mode === 'move' && draft.targetTrackIndex !== draft.initialTrackIndex;

  return (
    <div
      id="mixcut-sticker-tracks"
      className={styles.stickerTracks}
      data-track="sticker"
      data-expanded={expanded}
      style={{ height: (expanded ? Math.max(1, trackCount) : 1) * MIXCUT_STICKER_TRACK_HEIGHT }}
    >
      {expanded ? lanes.map((lane, trackIndex) => (
        <div
          key={trackIndex}
          className={`${styles.tlTrack} ${styles.stickerLane} ${reordering && draft?.targetTrackIndex === trackIndex ? styles.stickerLaneTarget : ''}`}
          data-sticker-lane={trackIndex}
          data-drop-target={reordering && draft?.targetTrackIndex === trackIndex ? 'true' : undefined}
        >
          {lane.map((sticker) => {
            const activeDraft = draft?.id === sticker.id ? draft : null;
            const isReordering = activeDraft?.mode === 'move' && activeDraft.targetTrackIndex !== activeDraft.initialTrackIndex;
            const shown = activeDraft && !isReordering ? activeDraft : sticker;
            const label = labelFor(sticker);
            return (
              <article
                key={sticker.id}
                className={`${styles.stickerBlock} ${selectedStickerId === sticker.id ? styles.stickerBlockSel : ''} ${activeDraft ? styles.stickerBlockDraft : ''}`}
                data-sticker-clip-id={sticker.id}
                data-sticker-track-index={trackIndex}
                data-start-frame={shown.startFrame}
                data-end-frame={shown.endFrame}
                data-selected={selectedStickerId === sticker.id ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`贴纸 ${label}`}
                aria-pressed={selectedStickerId === sticker.id}
                style={{
                  left: shown.startFrame / STICKER_FPS * pxPerSecond,
                  width: (shown.endFrame - shown.startFrame) / STICKER_FPS * pxPerSecond,
                  opacity: isReordering ? 0.35 : undefined,
                }}
                onPointerDown={(event) => begin('move', sticker, event)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  onSelect(sticker.id);
                }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
                title={`${label} · 拖动调时间或上下换轨 · 拖两侧修剪 · Delete 删除 · 拖动中右键取消`}
              >
                <Icon name="image" size={11} />
                <span className={styles.stickerBlockLabel}>{label}</span>
                <span className={styles.stickerBlockDuration}>{((shown.endFrame - shown.startFrame) / STICKER_FPS).toFixed(1)}s</span>
                <i className={`${styles.clipHandle} ${styles.clipHandleL}`} aria-label="修剪贴纸开头" onPointerDown={(event) => begin('start', sticker, event)} />
                <i className={`${styles.clipHandle} ${styles.clipHandleR}`} aria-label="修剪贴纸结尾" onPointerDown={(event) => begin('end', sticker, event)} />
              </article>
            );
          })}
          {reordering && draft?.targetTrackIndex === trackIndex && (
            <>
              <div
                className={`${styles.stickerBlock} ${styles.stickerBlockGhost}`}
                data-testid="sticker-track-placeholder"
                style={{ left: draft.startFrame / STICKER_FPS * pxPerSecond, width: (draft.endFrame - draft.startFrame) / STICKER_FPS * pxPerSecond }}
              >移动到此层</div>
              <i className={styles.stickerTrackInsertLine} data-testid="sticker-track-insert-line" aria-hidden="true" />
            </>
          )}
          {trackIndex === 0 && stickers.length === 0 && <span className={styles.stickerTrackEmpty}>从右侧素材库添加贴纸</span>}
        </div>
      )) : (
        <div className={`${styles.tlTrack} ${styles.stickerLane}`}>
          <span className={styles.stickerTrackEmpty}>{stickers.length} 张贴纸 · 点击左侧展开轨道</span>
        </div>
      )}
      {expanded && draft?.snapSec !== null && draft?.snapSec !== undefined && (
        <i className={styles.stickerSnapLine} data-testid="sticker-time-snap-line" style={{ left: draft.snapSec * pxPerSecond }} aria-hidden="true" />
      )}
    </div>
  );
}
