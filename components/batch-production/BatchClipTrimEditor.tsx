'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FINAL_EDIT_FPS } from '@/lib/final-edit/types';
import type { BatchOutputClipView, BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import styles from '../mixcut/mixcut-content.module.css';

const FPS = FINAL_EDIT_FPS;
const PX_PER_SEC = 90;
const MIN_DURATION_US = 500_000;
const MIN_WIDTH_PX = (MIN_DURATION_US / 1_000_000) * PX_PER_SEC;

function formatSec(sec: number): string {
  return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

function usToPx(us: number): number {
  return (us / 1_000_000) * PX_PER_SEC;
}

function pxToUs(px: number): number {
  return (px / PX_PER_SEC) * 1_000_000;
}

function usToFrame(us: number): number {
  return Math.round((us / 1_000_000) * FPS);
}

function frameToUs(frame: number): number {
  return Math.round((frame / FPS) * 1_000_000);
}

function clampUs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface BatchClipTrimEditorProps {
  clip: BatchOutputClipView;
  asset: BatchOutputPoolAssetView | null;
  disabled: boolean;
  onTrimCommit: (sourceStartUs: number, sourceEndUs: number) => Promise<boolean>;
  onSplitCommit: (offsetUs: number) => Promise<boolean>;
  onClose: () => void;
}

/**
 * 批量专用变长修剪面板：双手柄改入点/出点、选窗中间等长平移，
 * 选窗内叠加分割标记。分割与修剪是两个独立按钮。
 */
export default function BatchClipTrimEditor({
  clip,
  asset,
  disabled,
  onTrimCommit,
  onSplitCommit,
  onClose,
}: BatchClipTrimEditorProps) {
  const sourceSec = Math.max(0.1, (asset?.durationSec ?? 0) || clip.sourceEndUs / 1_000_000);
  const sourceDurationUs = Math.round(sourceSec * 1_000_000);
  const contentWidth = sourceSec * PX_PER_SEC;
  const [leftUs, setLeftUs] = useState(() => clip.sourceStartUs);
  const [rightUs, setRightUs] = useState(() => clip.sourceEndUs);
  const [splitUs, setSplitUs] = useState(() => Math.round((clip.sourceStartUs + clip.sourceEndUs) / 2));
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<null | {
    kind: 'left' | 'right' | 'move' | 'split';
    startX: number;
    startLeftUs: number;
    startRightUs: number;
    startSplitUs: number;
  }>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const frames = useMemo(() => Array.from({ length: Math.max(1, Math.ceil(contentWidth / 45)) }), [contentWidth]);
  const leftPx = usToPx(leftUs);
  const rightPx = usToPx(rightUs);
  const windowWidthPx = Math.max(MIN_WIDTH_PX, rightPx - leftPx);
  const safeSplitUs = clampUs(splitUs, leftUs + MIN_DURATION_US, rightUs - MIN_DURATION_US);
  const splitPx = usToPx(safeSplitUs);
  const splitInWindowPx = splitPx - leftPx;
  const splitValid = safeSplitUs - leftUs >= MIN_DURATION_US && rightUs - safeSplitUs >= MIN_DURATION_US;

  const beginDrag = (kind: 'left' | 'right' | 'move' | 'split') => (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || saving) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDrag({
      kind,
      startX: event.clientX,
      startLeftUs: leftUs,
      startRightUs: rightUs,
      startSplitUs: splitUs,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const handleMove = (event: PointerEvent) => {
      const deltaUs = pxToUs(event.clientX - drag.startX);
      if (drag.kind === 'left') {
        const next = clampUs(drag.startLeftUs + deltaUs, 0, drag.startRightUs - MIN_DURATION_US);
        setLeftUs(next);
      } else if (drag.kind === 'right') {
        const next = clampUs(drag.startRightUs + deltaUs, drag.startLeftUs + MIN_DURATION_US, sourceDurationUs);
        setRightUs(next);
      } else if (drag.kind === 'move') {
        const shift = clampUs(deltaUs, -drag.startLeftUs, sourceDurationUs - drag.startRightUs);
        setLeftUs(drag.startLeftUs + shift);
        setRightUs(drag.startRightUs + shift);
      } else {
        const next = clampUs(
          drag.startSplitUs + deltaUs,
          drag.startLeftUs + MIN_DURATION_US,
          drag.startRightUs - MIN_DURATION_US,
        );
        setSplitUs(next);
      }
    };
    const handleUp = () => setDrag(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [drag, sourceDurationUs]);

  const commitTrim = async (): Promise<void> => {
    const alignedStartUs = frameToUs(usToFrame(leftUs));
    const alignedEndUs = frameToUs(usToFrame(rightUs));
    setSaving(true);
    const accepted = await onTrimCommit(alignedStartUs, alignedEndUs);
    setSaving(false);
    if (accepted) onClose();
  };

  const commitSplit = async (): Promise<void> => {
    const offsetUs = frameToUs(usToFrame(safeSplitUs - clip.sourceStartUs));
    setSaving(true);
    const accepted = await onSplitCommit(offsetUs);
    setSaving(false);
    if (accepted) onClose();
  };

  return (
    <div className={styles.trim}>
      <div className={styles.trimHead}>
        <span className={styles.trimTitle}>修剪片段 · 源素材 {formatSec(sourceSec)}</span>
        <span>左右手柄改入点/出点，拖动窗口整体平移；最短 0.5 秒</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.btn}
          disabled={saving}
          onClick={onClose}
        >取消</button>
        <button
          type="button"
          className={`${styles.btn} ${styles.primary}`}
          disabled={disabled || saving || rightUs - leftUs < MIN_DURATION_US}
          onClick={() => void commitTrim()}
        >{saving ? '应用中…' : '完成修剪'}</button>
      </div>
      <div className={styles.trimStrip} ref={stripRef}>
        {frames.map((_, index) => (
          <div
            key={index}
            className={styles.trimFrame}
            style={asset?.thumbnailUrl
              ? { backgroundImage: `url(${JSON.stringify(asset.thumbnailUrl).slice(1, -1)})`, filter: `brightness(${index % 2 ? 0.85 : 1})` }
              : undefined}
          />
        ))}
        <div className={styles.trimDim} style={{ left: 0, width: leftPx }} />
        <div className={styles.trimDim} style={{ left: rightPx, width: Math.max(0, contentWidth - rightPx) }} />
        <div
          className={styles.trimSel}
          style={{ left: leftPx, width: windowWidthPx, touchAction: 'none' }}
          onPointerDown={beginDrag('move')}
        >
          <span
            className={styles.trimHandleL}
            style={{ touchAction: 'none' }}
            onPointerDown={beginDrag('left')}
            title="拖动左手柄改变入点"
          >‹</span>
          <span
            className={styles.trimHandleR}
            style={{ touchAction: 'none' }}
            onPointerDown={beginDrag('right')}
            title="拖动右手柄改变出点"
          >›</span>
          <span
            className={styles.trimHandle}
            style={{ left: splitInWindowPx, touchAction: 'none', cursor: 'ew-resize' }}
            onPointerDown={beginDrag('split')}
            title={splitValid ? '拖动分割标记' : '分割点两侧必须至少 0.5 秒'}
          >|</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <span>选窗 {((rightUs - leftUs) / 1_000_000).toFixed(1)} 秒 · 起点 {(leftUs / 1_000_000).toFixed(1)} 秒</span>
        <span>分割点 {((splitUs - clip.sourceStartUs) / 1_000_000).toFixed(1)} 秒</span>
        <button
          type="button"
          className="btn-secondary h-8 px-3 text-xs"
          disabled={disabled || saving || !splitValid}
          onClick={() => void commitSplit()}
        >在标记处分割</button>
      </div>
    </div>
  );
}
