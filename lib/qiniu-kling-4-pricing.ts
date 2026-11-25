/** Qiniu Modelink list prices in CNY micros per billing second. */
export const QINIU_KLING_4_PRICING_VERSION = 'qiniu-modelink-kling-4-2026-11-25';
export const QINIU_KLING_4_SECOND_PRICES = {
  '720p': { withoutVideo: 1_000_000, withVideo: 600_000 },
  '1080p': { withoutVideo: 1_500_000, withVideo: 900_000 },
} as const;
export const QINIU_KLING_4_LEGACY_FIVE_SECOND_PRICE = 5_000_000;

export interface QiniuKling4Pricing {
  resolution: unknown;
  hasInputVideo: boolean;
}

export function qiniuKling4BillingSeconds(outputSeconds: number, inputSeconds: number): number | null {
  if (!Number.isFinite(outputSeconds) || outputSeconds <= 0 || !Number.isFinite(inputSeconds) || inputSeconds < 0) return null;
  // A video reference adds at least another output-duration worth of seconds.
  const seconds = inputSeconds > 0 ? outputSeconds + Math.max(inputSeconds, outputSeconds) : outputSeconds;
  return Number.isFinite(seconds) ? seconds : null;
}
