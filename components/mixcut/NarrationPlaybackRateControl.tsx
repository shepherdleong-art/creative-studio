'use client';

import { useEffect, useRef, useState } from 'react';
import {
  formatNarrationPlaybackRateInput,
  NARRATION_PLAYBACK_RATE_MAX,
  NARRATION_PLAYBACK_RATE_MIN,
  NARRATION_PLAYBACK_RATE_PRESETS,
  NARRATION_PLAYBACK_RATE_STEP,
  normalizeNarrationPlaybackRate,
} from './narration-playback-rate';
import styles from './mixcut-content.module.css';

export function NarrationPlaybackRateControl({
  idPrefix,
  value,
  disabled,
  showPresets = false,
  ariaLabelPrefix = '音频倍速',
  onPreview,
  onCommit,
  onPendingChange,
}: {
  idPrefix: string;
  value: number;
  disabled: boolean;
  showPresets?: boolean;
  ariaLabelPrefix?: string;
  onPreview: (playbackRate: number) => void;
  onCommit: (playbackRate: number) => void;
  onPendingChange?: (playbackRate: number | null) => void;
}) {
  const normalizedValue = normalizeNarrationPlaybackRate(value);
  const [draft, setDraft] = useState(normalizedValue);
  const [inputValue, setInputValue] = useState(() => formatNarrationPlaybackRateInput(normalizedValue));
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingRef.current !== null) return;
    const next = normalizeNarrationPlaybackRate(value);
    setDraft(next);
    setInputValue(formatNarrationPlaybackRateInput(next));
  }, [value]);

  const preview = (nextValue: number) => {
    const next = normalizeNarrationPlaybackRate(nextValue);
    pendingRef.current = next;
    setDraft(next);
    setInputValue(formatNarrationPlaybackRateInput(next));
    onPendingChange?.(next);
    onPreview(next);
  };

  const commit = (nextValue: number) => {
    const next = normalizeNarrationPlaybackRate(nextValue);
    pendingRef.current = null;
    setDraft(next);
    setInputValue(formatNarrationPlaybackRateInput(next));
    onPendingChange?.(null);
    onCommit(next);
  };

  return (
    <div className={styles.timelineSpeedControl} data-narration-speed-control>
      <label htmlFor={`${idPrefix}-range`}>倍速</label>
      <div className={styles.timelineSpeedRow}>
        <input
          id={`${idPrefix}-range`}
          type="range"
          aria-label={`${ariaLabelPrefix}拉条`}
          min={NARRATION_PLAYBACK_RATE_MIN}
          max={NARRATION_PLAYBACK_RATE_MAX}
          step={NARRATION_PLAYBACK_RATE_STEP}
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
        <input
          type="number"
          aria-label={`${ariaLabelPrefix}数值`}
          min={NARRATION_PLAYBACK_RATE_MIN}
          max={NARRATION_PLAYBACK_RATE_MAX}
          step={NARRATION_PLAYBACK_RATE_STEP}
          value={inputValue}
          disabled={disabled}
          onChange={(event) => {
            const rawValue = event.currentTarget.value;
            if (rawValue.trim() === '') {
              setInputValue(rawValue);
              return;
            }
            const next = Number(rawValue);
            if (Number.isFinite(next)) preview(next);
          }}
          onBlur={() => {
            if (pendingRef.current !== null) commit(pendingRef.current);
            else setInputValue(formatNarrationPlaybackRateInput(draft));
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || pendingRef.current === null) return;
            event.preventDefault();
            commit(pendingRef.current);
          }}
        />
      </div>
      <div className={styles.timelineSpeedScale} aria-hidden="true">
        <span>0.5x</span><span>1.0x</span><span>1.5x</span><span>2.0x</span>
      </div>
      {showPresets && (
        <div className={styles.narrationSpeedPresets} aria-label="口播倍速快捷值">
          {NARRATION_PLAYBACK_RATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={`设置口播倍速为 ${preset.toFixed(1)}x`}
              aria-pressed={Math.abs(draft - preset) < 1e-8}
              disabled={disabled}
              onClick={() => {
                preview(preset);
                commit(preset);
              }}
            >{preset.toFixed(1)}x</button>
          ))}
        </div>
      )}
    </div>
  );
}
