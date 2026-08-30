'use client';

import { useEffect, useRef, useState } from 'react';
import {
  NARRATION_GAIN_DB_DEFAULT,
  NARRATION_GAIN_DB_MAX,
  NARRATION_GAIN_DB_MIN,
  normalizeNarrationGainDb,
} from '@/lib/media-core/audio-gain';
import styles from './mixcut-content.module.css';

export function NarrationGainControl({
  idPrefix,
  value,
  disabled,
  ariaLabelPrefix = '口播音量',
  onPreview,
  onCommit,
}: {
  idPrefix: string;
  value: number;
  disabled: boolean;
  ariaLabelPrefix?: string;
  onPreview: (gainDb: number) => void;
  onCommit: (gainDb: number) => void;
}) {
  const normalizedValue = normalizeNarrationGainDb(value);
  const [draft, setDraft] = useState(normalizedValue);
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingRef.current !== null) return;
    setDraft(normalizeNarrationGainDb(value));
  }, [value]);

  const preview = (nextValue: number) => {
    const next = normalizeNarrationGainDb(nextValue);
    pendingRef.current = next;
    setDraft(next);
    onPreview(next);
  };

  const commit = (nextValue: number) => {
    const next = normalizeNarrationGainDb(nextValue);
    pendingRef.current = null;
    setDraft(next);
    onCommit(next);
  };

  return (
    <div className={styles.timelineSpeedControl} data-narration-gain-control>
      <label htmlFor={`${idPrefix}-range`}>音量</label>
      <div className={styles.timelineSpeedRow}>
        <input
          id={`${idPrefix}-range`}
          type="range"
          aria-label={`${ariaLabelPrefix}拉条`}
          min={NARRATION_GAIN_DB_MIN}
          max={NARRATION_GAIN_DB_MAX}
          step={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => preview(Number(event.currentTarget.value))}
          onPointerUp={(event) => {
            if (pendingRef.current !== null) commit(Number(event.currentTarget.value));
          }}
          onKeyUp={() => {
            if (pendingRef.current !== null) commit(pendingRef.current);
          }}
        />
        <span className={styles.ctlVal}>{draft.toFixed(0)} dB</span>
      </div>
      <div className={styles.timelineSpeedScale} aria-hidden="true">
        <span>{NARRATION_GAIN_DB_MIN} dB</span><span>{NARRATION_GAIN_DB_MAX} dB</span>
      </div>
      <div className={styles.ctlRow} style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button
          type="button"
          className={styles.linkBtn}
          disabled={disabled || draft === NARRATION_GAIN_DB_DEFAULT}
          onClick={() => {
            preview(NARRATION_GAIN_DB_DEFAULT);
            commit(NARRATION_GAIN_DB_DEFAULT);
          }}
        >恢复默认</button>
      </div>
    </div>
  );
}
