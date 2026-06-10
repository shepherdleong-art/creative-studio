import type { VideoProviderAdapter } from './types';
import { klingAdapter } from './kling';
import { jimengAdapter } from './jimeng';

const adapters: Record<string, VideoProviderAdapter> = {
  kling: klingAdapter,
  jimeng: jimengAdapter,
};

/**
 * Get the video provider adapter for the given provider type.
 * Returns undefined if the type is not recognized.
 */
export function getVideoAdapter(type: string): VideoProviderAdapter | undefined {
  return adapters[type];
}

export { klingAdapter, jimengAdapter };
export type { VideoProviderAdapter, SubmitVideoRequest, SubmitVideoResult, PollVideoResult } from './types';
