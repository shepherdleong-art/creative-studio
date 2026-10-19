'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './mixcut-content.module.css';

/** Keep dragging local; save once on release and restore the saved value on failure. */
export function VideoPlaybackRateControl({ value, disabled, onCommit }: {
  value: number;
  disabled: boolean;
  onCommit: (rate: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const committing = useRef(false);
  useEffect(() => {
    if (!pending.current) setDraft(String(value));
  }, [value]);

  const update = (next: string) => { pending.current = true; setDraft(next); };
  const commit = async (next = draft) => {
    if (disabled || committing.current) return;
    pending.current = false;
    const rate = Number(next);
    if (!next.trim() || !Number.isFinite(rate) || rate < 0.25 || rate > 4 || rate === value) {
      setDraft(String(value));
      return;
    }
    committing.current = true;
    setSaving(true);
    try {
      const accepted = await onCommit(rate);
      setDraft(String(accepted ? rate : value));
    } finally {
      committing.current = false;
      setSaving(false);
    }
  };
  const finish = () => { if (pending.current) void commit(); };
  const rate = Number(draft);
  const sliderValue = Number.isFinite(rate) ? Math.max(0.25, Math.min(4, rate)) : value;
  const locked = disabled || saving;

  return <section className={styles.rcard} aria-label="视频倍速调整">
    <h4>视频倍速</h4>
    <div className={styles.timelineSpeedControl}>
      <div className={styles.timelineSpeedRow}>
        <input type="range" aria-label="视频倍速拉条" min={0.25} max={4} step={0.05} value={sliderValue} disabled={locked}
          onChange={(event) => update(event.currentTarget.value)} onPointerUp={finish} onPointerCancel={finish} onKeyUp={finish} onBlur={finish} />
        <input type="number" aria-label="视频倍速数值" min={0.25} max={4} step={0.05} value={draft} disabled={locked}
          onChange={(event) => update(event.currentTarget.value)} onBlur={finish}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); finish(); } }} />
      </div>
      <div className={styles.timelineSpeedScale} aria-hidden="true"><span>0.25×</span><span>4×</span></div>
    </div>
    <p className={styles.timelineSpeedHint}>拖动调节，松手保存；后续片段位置不变。</p>
    <button type="button" className={styles.linkBtn} disabled={locked} onClick={() => void commit('1')}>恢复原速（1×）</button>
  </section>;
}
