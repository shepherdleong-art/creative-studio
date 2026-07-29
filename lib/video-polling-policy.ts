import type { SubmitVideoRequest, VideoProviderAdapter } from './video-providers/types';

interface VideoPollingTimeoutInput {
  requestedTimeoutMs: number;
  adapter: VideoProviderAdapter;
  request: Pick<SubmitVideoRequest, 'model' | 'durationSec'>;
}

export function resolveVideoPollingTimeoutMs(input: VideoPollingTimeoutInput): number {
  const requestedTimeoutMs = Math.max(1, Math.floor(input.requestedTimeoutMs));
  const minimumTimeoutMs = input.adapter.minimumPollingTimeoutMs?.(input.request) ?? 0;
  return Math.max(requestedTimeoutMs, minimumTimeoutMs);
}
