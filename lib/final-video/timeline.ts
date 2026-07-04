// lib/final-video/timeline.ts
import type { TimelineSegment } from './types.ts';

/** 口播结束后画面多停留的秒数，避免音频戛然而止 */
export const NARRATION_TAIL_PAD_SEC = 0.15;

export interface TimelineShotInput {
  shotId: string;
  shotIndex: number;
  voiceover: string;
  subtitle: string;
}

export interface TimelineClipInput {
  shotId: string;
  videoJobId: string;
  clipPath: string;
  clipDurationSec: number;
}

export interface TimelineIssue {
  shotIndex: number;
  shotId: string;
  reason: string;
}

export interface TimelineResult {
  segments: TimelineSegment[];
  issues: TimelineIssue[];
  totalDurationSec: number;
}

const round2 = (n: number) => Number(n.toFixed(2));

export function buildTimeline(input: {
  scriptShots: TimelineShotInput[];
  clips: TimelineClipInput[];
  narrationDurations?: Record<string, number>;
  introDurationSec?: number;
}): TimelineResult {
  const intro = input.introDurationSec ?? 0;
  const clipByShot = new Map(input.clips.map((c) => [c.shotId, c]));
  const segments: TimelineSegment[] = [];
  const issues: TimelineIssue[] = [];
  let cursor = intro;

  const ordered = [...input.scriptShots].sort((a, b) => a.shotIndex - b.shotIndex);
  for (const shot of ordered) {
    const clip = clipByShot.get(shot.shotId);
    if (!clip) {
      issues.push({ shotIndex: shot.shotIndex, shotId: shot.shotId, reason: '缺少已完成的视频片段' });
      continue;
    }
    const narration = input.narrationDurations?.[shot.shotId] ?? 0;
    const segmentDurationSec =
      narration > 0 ? Math.max(clip.clipDurationSec, narration + NARRATION_TAIL_PAD_SEC) : clip.clipDurationSec;
    segments.push({
      shotId: shot.shotId,
      shotIndex: shot.shotIndex,
      videoJobId: clip.videoJobId,
      clipPath: clip.clipPath,
      clipDurationSec: clip.clipDurationSec,
      voiceover: shot.voiceover,
      subtitle: shot.subtitle,
      narrationDurationSec: narration,
      segmentDurationSec: round2(segmentDurationSec),
      startSec: round2(cursor),
    });
    cursor += segmentDurationSec;
  }
  return { segments, issues, totalDurationSec: round2(cursor) };
}
