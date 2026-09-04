export const BATCH_OUTPUT_PRESETS = {
  '3:4': { width: 1080, height: 1440 },
  '3x4': { width: 1080, height: 1440 },
  '9:16': { width: 1080, height: 1920 },
  '9x16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '16x9': { width: 1920, height: 1080 },
} as const;

export type BatchOutputPreset = keyof typeof BATCH_OUTPUT_PRESETS;
