'use client';

import { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FINAL_EDIT_FPS, type FinalEditAssetView, type TimelineClip } from '@/lib/final-edit/types';
import styles from './mixcut-content.module.css';

const FPS = FINAL_EDIT_FPS;

function formatSec(sec: number): string {
  return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
}

// V2 Trim 截取条（规格 §6.7）：双击片段打开，拖动蓝色选择框调整源素材入点，时长保持不变。
// 注：胶片条目前用片段代表帧平铺，逐帧缩略图待后端提供后替换。
export function TrimEditor({ clip, clipIndex, asset, disabled, onCommit, onClose, onPreview, compact = false }: {
  clip: Pick<TimelineClip, 'sourceInFrame' | 'sourceOutFrame'>;
  clipIndex: number;
  asset: Pick<FinalEditAssetView, 'durationUs' | 'thumbnailUrl'> | null;
  disabled: boolean;
  onCommit: (sourceInFrame: number, sourceOutFrame: number) => Promise<boolean>;
  onClose: () => void;
  onPreview?: (sourceInSec: number) => void;
  compact?: boolean;
}) {
  const sourceSec = Math.max(0.1, (asset?.durationUs ?? 0) / 1_000_000);
  const sourceFrames = Math.max(1, Math.floor(sourceSec * FPS));
  const clipFrames = clip.sourceOutFrame - clip.sourceInFrame;
  const [sourceInFrame, setSourceInFrame] = useState(clip.sourceInFrame);
  const [saving, setSaving] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  // 批量片段保留微秒级长度；只将新的入点对齐到帧，不能把时长舍入后挤入相邻片段。
  const maxIn = Math.max(0, Math.floor(sourceFrames - clipFrames + 1e-7));
  const offsetPercent = sourceInFrame / sourceFrames * 100;
  const windowPercent = Math.min(100, clipFrames / sourceFrames * 100);
  const sourceInSec = sourceInFrame / FPS;
  const selectStart = (frame: number) => {
    setSourceInFrame(frame);
    onPreview?.(frame / FPS);
  };

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || saving || !stripRef.current) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget;
    const bounds = stripRef.current.getBoundingClientRect();
    const original = sourceInFrame;
    const startX = event.clientX;
    const initial = target === stripRef.current
      ? Math.min(maxIn, Math.max(0, Math.round((startX - bounds.left) / bounds.width * sourceFrames - clipFrames / 2)))
      : original;
    target.focus();
    selectStart(initial);
    target.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => selectStart(Math.min(maxIn, Math.max(0, Math.round(initial + (pointer.clientX - startX) / bounds.width * sourceFrames))));
    const cleanup = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', cleanup);
      target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    };
    const cancel = () => { selectStart(original); cleanup(); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', cleanup);
    target.addEventListener('pointercancel', cancel);
  };

  const commit = async () => {
    if (disabled || saving) return;
    const sourceOutFrame = sourceInFrame + clipFrames;
    setSaving(true);
    try {
      if (await onCommit(sourceInFrame, sourceOutFrame)) onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className={`${styles.trim} ${compact ? styles.trimCompact : ''}`} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || disabled || saving) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); event.stopPropagation(); void commit(); }
    }}>
      <div className={styles.trimHead}>
        <span className={styles.trimTitle}><Icon name="scissors" size={14} />{compact ? `截取 #${clipIndex + 1}` : `截取片段 #${clipIndex + 1} · 源素材 ${formatSec(sourceSec)}`}</span>
        <span className={styles.trimDescription} title="拖动选框选取画面，片段时长保持不变">{!compact && '拖动选框选取画面，片段时长保持不变 · '}入点 {formatSec(sourceInSec)} → 出点 {formatSec((sourceInFrame + clipFrames) / FPS)}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} onClick={onClose} disabled={saving}>取消</button>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => void commit()} disabled={disabled || saving}>{saving ? '应用中…' : '完成'}</button>
      </div>
      <div className={styles.trimStrip} ref={stripRef} onPointerDown={beginDrag}>
        {Array.from({ length: 16 }).map((_, index) => (
          <div
            key={index}
            className={styles.trimFrame}
            style={asset?.thumbnailUrl ? { backgroundImage: `url(${JSON.stringify(asset.thumbnailUrl).slice(1, -1)})`, filter: `brightness(${index % 2 ? 0.85 : 1})` } : undefined}
          />
        ))}
        <div className={styles.trimDim} style={{ left: 0, width: `${offsetPercent}%` }} />
        <div className={styles.trimDim} style={{ left: `${offsetPercent + windowPercent}%`, right: 0 }} />
        <div className={styles.trimSel} role="slider" tabIndex={disabled || saving ? -1 : 0} aria-label="移动截取选框"
          aria-valuemin={0} aria-valuemax={Math.max(maxIn / FPS, sourceInSec)} aria-valuenow={sourceInSec}
          aria-valuetext={`入点 ${formatSec(sourceInSec)}，出点 ${formatSec((sourceInFrame + clipFrames) / FPS)}`}
          onKeyDown={event => {
            if (disabled || saving || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            selectStart(event.key === 'Home' ? 0 : event.key === 'End' ? maxIn : Math.min(maxIn, Math.max(0, Math.round(sourceInFrame) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1))));
          }}
          style={{ left: `${offsetPercent}%`, width: `${windowPercent}%` }} onPointerDown={beginDrag}>
          <span className={`${styles.trimHandle} ${styles.trimHandleL}`}>‹</span>
          <span className={`${styles.trimHandle} ${styles.trimHandleR}`}>›</span>
        </div>
      </div>
      <div className={styles.trimRuler}><span>0:00.0</span><span>素材结束 {formatSec(sourceSec)}</span></div>
    </div>
  );
}
