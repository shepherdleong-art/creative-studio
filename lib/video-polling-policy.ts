export const JIMENG_2_LONG_VIDEO_MIN_POLLING_MS = 15 * 60_000;

interface VideoPollingTimeoutInput {
  requestedTimeoutMs: number;
  providerType: string;
  model: string;
  durationSec: number;
}

function isJimeng2Model(model: string): boolean {
  return /seedance-2[-.]/i.test(model);
}

export function resolveVideoPollingTimeoutMs(input: VideoPollingTimeoutInput): number {
  const requestedTimeoutMs = Math.max(1, Math.floor(input.requestedTimeoutMs));
  const isJimeng2LongVideo = input.providerType === 'jimeng'
    && isJimeng2Model(input.model)
    && input.durationSec >= 15;

  if (!isJimeng2LongVideo) return requestedTimeoutMs;
  return Math.max(requestedTimeoutMs, JIMENG_2_LONG_VIDEO_MIN_POLLING_MS);
}
