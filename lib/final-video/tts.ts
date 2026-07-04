// lib/final-video/tts.ts —— Phase 6 (Task 14) 实现真实逻辑前的守卫占位
import type { TimelineSegment } from './types.ts';

export async function synthesizeNarrationSegments(_opts: {
  segments: Array<{ shotId: string; text: string }>;
  voice: string;
  speed: number;
  workDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ files: Record<string, string>; durations: Record<string, number> }> {
  throw new Error('口播（TTS）功能尚未启用');
}

export async function buildNarrationTrack(_opts: {
  timeline: TimelineSegment[];
  files: Record<string, string>;
  introDurationSec: number;
  workDir: string;
}): Promise<string> {
  throw new Error('口播（TTS）功能尚未启用');
}
