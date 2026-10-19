export const NARRATION_GAIN_DB_MIN = -40;
export const NARRATION_GAIN_DB_MAX = 10;
export const NARRATION_GAIN_DB_DEFAULT = 0;

/** Normalize the user-facing narration gain shared by browser preview and render snapshots. */
export function normalizeNarrationGainDb(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return NARRATION_GAIN_DB_DEFAULT;
  return Math.min(NARRATION_GAIN_DB_MAX, Math.max(NARRATION_GAIN_DB_MIN, numeric));
}

export function narrationGainLinear(value: unknown): number {
  return Math.pow(10, normalizeNarrationGainDb(value) / 20);
}
