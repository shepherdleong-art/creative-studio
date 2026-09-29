// Shared by the UI, job creation APIs and the gateway adapter.
// Tencent Kling 2.5 supports 5/10 seconds, with or without a tail frame.
const KLING_25_DURATIONS = [5, 10] as const;
const DEFAULT_DURATIONS = Array.from({ length: 14 }, (_, index) => index + 2);

export function videoDurationOptions(providerType: string, model: string): readonly number[] {
  return providerType === 'openai-video' && model === 'kling-2.5'
    ? KLING_25_DURATIONS : DEFAULT_DURATIONS;
}

/** Adjust draft values when switching models; never use to accept an invalid API request. */
export function normalizeVideoDraftDuration(value: number, options: readonly number[]): number {
  const target = Number.isFinite(value) ? value : 5;
  return options.reduce((closest, option) => Math.abs(option - target) < Math.abs(closest - target) ? option : closest);
}

export function videoDurationError(providerType: string, model: string, durationSec: number): string | null {
  if (videoDurationOptions(providerType, model).includes(durationSec)) return null;
  return providerType === 'openai-video' && model === 'kling-2.5'
    ? 'Kling 2.5 仅支持 5 秒或 10 秒视频，最长 10 秒'
    : '视频时长必须为 2–15 秒的整数';
}
