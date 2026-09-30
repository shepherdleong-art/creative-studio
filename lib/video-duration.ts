// Shared by the UI, job creation APIs and the gateway adapter.
// Tencent Kling 2.5 supports 5/10 seconds, with or without a tail frame.
const KLING_25_DURATIONS = [5, 10] as const;
const KLING_3_DURATIONS = Array.from({ length: 13 }, (_, index) => index + 3);
// Seedance 2.x generation starts at 4s. Keep the gateway's existing 15s ceiling;
// the newer official 2.5 30s capability has not been verified on this route.
const SEEDANCE_2_DURATIONS = Array.from({ length: 12 }, (_, index) => index + 4);
const DEFAULT_DURATIONS = Array.from({ length: 14 }, (_, index) => index + 2);

export function isGatewayKling3Model(providerType: string, model: string): boolean {
  return providerType === 'openai-video' && ['kling-3.0', 'qiniuyun/kling-3.0'].includes(model);
}

export function isGatewaySeedance2Model(providerType: string, model: string): boolean {
  return providerType === 'openai-video' && [
    'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-5-260628',
  ].includes(model);
}

export function videoDurationOptions(providerType: string, model: string): readonly number[] {
  if (isGatewayKling3Model(providerType, model)) return KLING_3_DURATIONS;
  if (isGatewaySeedance2Model(providerType, model)) return SEEDANCE_2_DURATIONS;
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
  if (isGatewayKling3Model(providerType, model)) return '可灵 3.0 视频时长必须为 3–15 秒的整数';
  if (isGatewaySeedance2Model(providerType, model)) return '当前 Seedance 公司通道支持 4–15 秒的整数时长';
  return providerType === 'openai-video' && model === 'kling-2.5'
    ? 'Kling 2.5 仅支持 5 秒或 10 秒视频，最长 10 秒'
    : '视频时长必须为 2–15 秒的整数';
}
