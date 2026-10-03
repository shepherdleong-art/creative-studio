'use client';

import { useRef } from 'react';
import type { TimelineClip } from '@/lib/final-edit/types';
import styles from './mixcut-content.module.css';

export function ClipFramingControl({ clip, disabled, onPreview, onCommit }: {
  clip: Pick<TimelineClip, 'framing'>;
  disabled: boolean;
  onPreview: (framing: TimelineClip['framing']) => void;
  onCommit: (framing: TimelineClip['framing']) => void;
}) {
  const pending = useRef<TimelineClip['framing'] | null>(null);
  const commit = () => {
    if (!pending.current) return;
    const framing = pending.current;
    pending.current = null;
    onCommit(framing);
  };
  return <section className={styles.rcard} aria-label="视频画面调整">
    <h4>视频画面</h4>
    {([
      ['scale', '画面缩放', 0.25, 3, 0.05],
      ['offsetX', '水平位移', -1, 1, 0.02],
      ['offsetY', '垂直位移', -1, 1, 0.02],
    ] as const).map(([key, label, min, max, step]) => <label key={key} className={styles.framingControl}>
      <span>{label}<output>{Math.round(clip.framing[key] * 100)}%</output></span>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={clip.framing[key]} disabled={disabled}
        onChange={(event) => { const framing = { ...clip.framing, [key]: Number(event.target.value) }; pending.current = framing; onPreview(framing); }}
        onPointerUp={commit} onPointerCancel={commit} onKeyUp={commit} onBlur={commit} />
    </label>)}
    <button type="button" className={styles.linkBtn} disabled={disabled} onClick={() => onCommit({ scale: 1, offsetX: 0, offsetY: 0 })}>重置画面</button>
  </section>;
}
