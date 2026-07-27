'use client';

import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FINAL_EDIT_FPS, type FinalEditAssetView, type TimelineClip } from '@/lib/final-edit/types';
import styles from './MixcutPanel.module.css';

const FPS = FINAL_EDIT_FPS;
const TRIM_PX_PER_SEC = 90; // 对标 AI-remix TrimEditor 的胶片密度

function formatSec(sec: number): string {
  return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

// V2 Trim 截取条（规格 §6.7）：双击片段打开，拖动蓝色选择框调整源素材入点，时长保持不变。
// 注：胶片条目前用片段代表帧平铺，逐帧缩略图待后端提供后替换。
export function TrimEditor({ clip, clipIndex, asset, disabled, onCommit, onClose }: {
  clip: TimelineClip;
  clipIndex: number;
  asset: FinalEditAssetView | null;
  disabled: boolean;
  onCommit: (sourceInFrame: number, sourceOutFrame: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const sourceSec = Math.max(0.1, (asset?.durationUs ?? 0) / 1_000_000);
  const sourceFrames = Math.max(1, Math.round(sourceSec * FPS));
  const clipFrames = clip.sourceOutFrame - clip.sourceInFrame;
  const clipSec = clipFrames / FPS;
  const contentWidth = sourceSec * TRIM_PX_PER_SEC;
  const windowWidth = Math.min(contentWidth, clipSec * TRIM_PX_PER_SEC);
  const [offsetPx, setOffsetPx] = useState(() => Math.min(Math.max(0, clip.sourceInFrame / FPS * TRIM_PX_PER_SEC), Math.max(0, contentWidth - windowWidth)));
  const [saving, setSaving] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const frames = useMemo(() => Array.from({ length: Math.max(1, Math.ceil(contentWidth / 45)) }), [contentWidth]);
  const sourceInSec = offsetPx / TRIM_PX_PER_SEC;

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || saving) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startOffset = offsetPx;
    const maxOffset = Math.max(0, contentWidth - windowWidth);
    const move = (pointer: PointerEvent) => {
      setOffsetPx(Math.min(maxOffset, Math.max(0, startOffset + pointer.clientX - startX)));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up, { once: true });
  };

  const commit = async () => {
    const maxIn = Math.max(0, sourceFrames - clipFrames);
    const sourceInFrame = Math.min(maxIn, Math.max(0, Math.round(sourceInSec * FPS)));
    const sourceOutFrame = sourceInFrame + clipFrames;
    setSaving(true);
    const accepted = await onCommit(sourceInFrame, sourceOutFrame);
    setSaving(false);
    if (accepted) onClose();
  };

  return (
    <div className={styles.trim}>
      <div className={styles.trimHead}>
        <span className={styles.trimTitle}><Icon name="scissors" size={14} />截取片段 #{clipIndex + 1} · 源素材 {formatSec(sourceSec)}</span>
        <span>拖动蓝色选择框调整入点（当前 {formatSec(sourceInSec)} 起），框外画面不会进入成片</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} onClick={onClose} disabled={saving}>取消</button>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => void commit()} disabled={disabled || saving}>{saving ? '应用中…' : '完成'}</button>
      </div>
      <div className={styles.trimStrip} ref={stripRef}>
        {frames.map((_, index) => (
          <div
            key={index}
            className={styles.trimFrame}
            style={asset?.thumbnailUrl ? { backgroundImage: `url(${JSON.stringify(asset.thumbnailUrl).slice(1, -1)})`, filter: `brightness(${index % 2 ? 0.85 : 1})` } : undefined}
          />
        ))}
        <div className={styles.trimDim} style={{ left: 0, width: offsetPx }} />
        <div className={styles.trimDim} style={{ left: offsetPx + windowWidth, width: Math.max(0, contentWidth - offsetPx - windowWidth) }} />
        <div className={styles.trimSel} style={{ left: offsetPx, width: windowWidth }} onPointerDown={beginDrag}>
          <span className={`${styles.trimHandle} ${styles.trimHandleL}`}>‹</span>
          <span className={`${styles.trimHandle} ${styles.trimHandleR}`}>›</span>
        </div>
      </div>
    </div>
  );
}
