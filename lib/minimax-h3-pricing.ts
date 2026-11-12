/** Tencent VOD H3 native-resolution prices, CNY micros per second. */
export const MINIMAX_H3_PRICING_VERSION = 'tencent-vod-minimax-h3-2026-11-12';
export const MINIMAX_H3_SECOND_PRICES = Object.freeze({
  '768P': Object.freeze({ input: 500_000, output: 500_000 }),
  '2K': Object.freeze({ input: 800_000, output: 800_000 }),
});
export type MiniMaxH3Resolution = keyof typeof MINIMAX_H3_SECOND_PRICES;
export interface MiniMaxH3Pricing { resolution: unknown }
export interface MiniMaxH3VideoUsage {
  resolution: MiniMaxH3Resolution;
  inputVideoDurationSec: number;
  outputVideoDurationSec: number;
}

/** Null/omitted resolution uses the adapter's native 2K default. */
export function minimaxH3Resolution(value: unknown): MiniMaxH3Resolution | null {
  if (value === null || value === undefined) return '2K';
  return value === '768P' || value === '2K' ? value : null;
}

/** Sum original video durations once; images/audio never add input-video seconds. */
export function referenceVideoDurationSec(media: readonly { kind: string | null; durationSec: number | null }[]): number | null {
  let total = 0;
  for (const item of media) {
    if (!item.kind) return null;
    if (item.kind !== 'video') continue;
    if (typeof item.durationSec !== 'number' || !Number.isFinite(item.durationSec) || item.durationSec <= 0) return null;
    total += item.durationSec;
  }
  return Number.isFinite(total) ? total : null;
}

export function parseMiniMaxH3VideoUsage(value: unknown): MiniMaxH3VideoUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  if (usage.resolution !== '768P' && usage.resolution !== '2K') return null;
  const input = usage.inputVideoDurationSec;
  const output = usage.outputVideoDurationSec;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
    || typeof output !== 'number' || !Number.isFinite(output) || output <= 0) return null;
  return { resolution: usage.resolution, inputVideoDurationSec: input, outputVideoDurationSec: output };
}

export function minimaxH3Quantities(usage: MiniMaxH3VideoUsage): Record<string, number> {
  return { input_second: usage.inputVideoDurationSec, output_second: usage.outputVideoDurationSec };
}

export function minimaxH3UsageDetail(usage: MiniMaxH3VideoUsage): Record<string, unknown> {
  return { ...usage, estimated: true, measurementSource: 'task_snapshot' };
}
