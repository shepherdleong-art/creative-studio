import type { VideoProviderAdapter } from './types.ts';
import { klingAdapter } from './kling.ts';
import { jimengAdapter } from './jimeng.ts';
import { openaiVideoAdapter } from './openai-video.ts';

const adapters: Record<string, VideoProviderAdapter> = {
  kling: klingAdapter,
  jimeng: jimengAdapter,
  'openai-video': openaiVideoAdapter,
};

// 测试专用适配器覆盖(仅脚本测试使用;生产路径不调用)。
const testAdapters = new Map<string, VideoProviderAdapter>();

export function registerTestVideoAdapter(type: string, adapter: VideoProviderAdapter): void {
  testAdapters.set(type, adapter);
}

/**
 * Get the video provider adapter for the given provider type.
 * Returns undefined if the type is not recognized.
 */
export function getVideoAdapter(type: string): VideoProviderAdapter | undefined {
  return testAdapters.get(type) ?? adapters[type];
}

export { klingAdapter, jimengAdapter, openaiVideoAdapter };
export type {
  VideoProviderAdapter,
  SubmitVideoRequest,
  SubmitVideoResult,
  PollVideoResult,
  TailFrameCapability,
  TailFrameProtocol,
} from './types.ts';
