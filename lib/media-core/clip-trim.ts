import type { PositionedClip } from './clip-position.ts';

export interface TrimmableClip {
  clipId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
  playbackRate?: number;
}

export function clipTrimRate(clip: TrimmableClip): number {
  return clip.playbackRate ?? (clip.sourceEndUs - clip.sourceStartUs) / (clip.timelineEndUs - clip.timelineStartUs);
}

/** Keep untouched boundaries exact. Allocated clips need not start on a video frame. */
export function planClipTrim(clips: TrimmableClip[], clipId: string, sourceStartUs: number, sourceEndUs: number, ripple: boolean): PositionedClip[] {
  const index = clips.findIndex((clip) => clip.clipId === clipId);
  if (index < 0) return clips.map((clip) => ({ id: clip.clipId, startUs: clip.timelineStartUs, endUs: clip.timelineEndUs }));
  const clip = clips[index];
  const rate = clipTrimRate(clip);
  const slip = sourceEndUs - sourceStartUs === clip.sourceEndUs - clip.sourceStartUs;
  const startUs = ripple || slip ? clip.timelineStartUs : clip.timelineStartUs + Math.round((sourceStartUs - clip.sourceStartUs) / rate);
  const endUs = slip ? clip.timelineEndUs : ripple
    ? startUs + Math.round((sourceEndUs - sourceStartUs) / rate)
    : clip.timelineEndUs + Math.round((sourceEndUs - clip.sourceEndUs) / rate);
  const shift = ripple ? endUs - clip.timelineEndUs : 0;
  return clips.map((item, i) => i === index ? { id: item.clipId, startUs, endUs } : {
    id: item.clipId, startUs: item.timelineStartUs + (i > index ? shift : 0), endUs: item.timelineEndUs + (i > index ? shift : 0),
  });
}

/** Limits for the handle being dragged, expressed in source microseconds. */
export function clipTrimBounds(clips: TrimmableClip[], clip: TrimmableClip, sourceDurationUs: number, ripple: boolean) {
  const index = clips.findIndex((item) => item.clipId === clip.clipId);
  const rate = clipTrimRate(clip);
  return {
    minimumStartUs: ripple ? 0 : Math.max(0, Math.ceil(clip.sourceStartUs + ((clips[index - 1]?.timelineEndUs ?? 0) - clip.timelineStartUs) * rate)),
    maximumEndUs: ripple ? sourceDurationUs : Math.min(sourceDurationUs, Math.floor(clip.sourceEndUs + ((clips[index + 1]?.timelineStartUs ?? Infinity) - clip.timelineEndUs) * rate)),
    minimumDurationUs: Math.ceil(500_000 * rate),
  };
}

/** Pixel-sized attraction, independent of timeline zoom. Callers provide legal targets. */
export function snapTimelineTime(valueUs: number, targetsUs: number[], pxPerSecond: number, enabled = true): { timeUs: number; snappedUs: number | null } {
  let best = valueUs;
  let distance = 8 / pxPerSecond * 1e6;
  let snappedUs: number | null = null;
  if (enabled) for (const target of targetsUs) {
    const delta = Math.abs(target - valueUs);
    if (delta <= distance) { best = target; distance = delta; snappedUs = target; }
  }
  return { timeUs: Math.round(best), snappedUs };
}
