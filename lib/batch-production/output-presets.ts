export const BATCH_OUTPUT_PRESETS = {
  '3:4': { width: 1080, height: 1440 },
  '3x4': { width: 1080, height: 1440 },
  '9:16': { width: 1080, height: 1920 },
  '9x16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '16x9': { width: 1920, height: 1080 },
} as const;

export type BatchOutputPreset = keyof typeof BATCH_OUTPUT_PRESETS;

export function resolveBatchOutputSize(value: unknown): { width: number; height: number } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const candidate = typeof value === 'string' ? value : record?.id ?? record?.aspectRatio;
  if (typeof candidate === 'string' && candidate in BATCH_OUTPUT_PRESETS) {
    return { ...BATCH_OUTPUT_PRESETS[candidate as BatchOutputPreset] };
  }
  const width = Number(record?.width);
  const height = Number(record?.height);
  const matching = Object.entries(BATCH_OUTPUT_PRESETS).find(([, size]) => size.width === width && size.height === height);
  return { ...(matching?.[1] ?? BATCH_OUTPUT_PRESETS['3:4']) };
}
