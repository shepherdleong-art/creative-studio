import { FINAL_EDIT_FPS } from './render-contract.ts';

export interface VideoTrimRange {
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
}

const align = (us: number) => Math.round(Math.round(us * FINAL_EDIT_FPS / 1e6) * 1e6 / FINAL_EDIT_FPS);

/** Only edited endpoints are frame-aligned. Allocation/insert boundaries can be
 * fractional frames; moving an untouched edge can overlap a neighbour. Shared
 * by the drag preview and persisted trim_variable command. Bounds stay with callers. */
export function resolveVideoTrimRange(
  clip: VideoTrimRange,
  sourceStartUs: number,
  sourceEndUs: number,
  rate: number,
): VideoTrimRange {
  const startChanged = sourceStartUs !== clip.sourceStartUs;
  const endChanged = sourceEndUs !== clip.sourceEndUs;
  const start = startChanged ? align(sourceStartUs) : clip.sourceStartUs;
  const end = endChanged ? align(sourceEndUs) : clip.sourceEndUs;
  const length = end - start;
  const slip = length === clip.sourceEndUs - clip.sourceStartUs;
  let timelineStartUs = clip.timelineStartUs;
  let timelineEndUs = clip.timelineEndUs;
  if (!slip) {
    if (!startChanged) {
      timelineEndUs = align(timelineStartUs + length / rate);
    } else if (!endChanged) {
      timelineStartUs = align(timelineEndUs - length / rate);
    } else {
      timelineStartUs = align(timelineStartUs + (start - clip.sourceStartUs) / rate);
      timelineEndUs = align(timelineStartUs + length / rate);
    }
  }
  return { sourceStartUs: start, sourceEndUs: end, timelineStartUs, timelineEndUs };
}
