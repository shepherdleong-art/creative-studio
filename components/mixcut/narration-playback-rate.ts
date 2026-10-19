export const NARRATION_PLAYBACK_RATE_MIN = 0.5;
export const NARRATION_PLAYBACK_RATE_MAX = 2;
export const NARRATION_PLAYBACK_RATE_STEP = 0.1;
export const NARRATION_PLAYBACK_RATE_PRESETS = [0.8, 1, 1.2, 1.5] as const;

export function normalizeNarrationPlaybackRate(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : 1;
  const stepped = Math.round(finiteValue / NARRATION_PLAYBACK_RATE_STEP) * NARRATION_PLAYBACK_RATE_STEP;
  return Number(Math.max(
    NARRATION_PLAYBACK_RATE_MIN,
    Math.min(NARRATION_PLAYBACK_RATE_MAX, stepped),
  ).toFixed(1));
}

export function formatNarrationPlaybackRateInput(value: number): string {
  const normalized = normalizeNarrationPlaybackRate(value);
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1);
}
