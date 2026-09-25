import { FINAL_EDIT_FPS } from '../../../lib/media-core/render-contract.ts';

type Clip = {
  clipId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
  playbackRate?: number;
};
export type VideoTrimRange = Pick<Clip, 'sourceStartUs' | 'sourceEndUs' | 'timelineStartUs' | 'timelineEndUs'>;
const toFrame = (us: number) => us * FINAL_EDIT_FPS / 1e6;
const fromFrame = (frame: number) => Math.round(frame * 1e6 / FINAL_EDIT_FPS);
const align = (us: number) => fromFrame(Math.round(toFrame(us)));

/** Plan the same source-frame/timeline rounding used by trim_variable before sending it. */
export function videoTrimRange(clip: Clip, clips: Clip[], edge: 'start' | 'end', requestedTimelineUs: number, assetDurationUs: number | null): VideoTrimRange {
  const original: VideoTrimRange = { sourceStartUs: clip.sourceStartUs, sourceEndUs: clip.sourceEndUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs };
  if (!Number.isFinite(requestedTimelineUs) || assetDurationUs === null || assetDurationUs <= 0) return original;
  const ordered = [...clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  const index = ordered.findIndex(c => c.clipId === clip.clipId);
  if (index < 0) return original;
  const previousEnd = ordered[index - 1]?.timelineEndUs ?? 0;
  const nextStart = ordered[index + 1]?.timelineStartUs ?? Infinity;
  const rate = clip.playbackRate ?? (clip.sourceEndUs - clip.sourceStartUs) / (clip.timelineEndUs - clip.timelineStartUs);
  if (!(rate > 0)) return original;
  const start = align(clip.sourceStartUs);
  const end = Math.min(align(clip.sourceEndUs), fromFrame(Math.floor(toFrame(assetDurationUs))));
  const origin = edge === 'start' ? clip.timelineStartUs : clip.timelineEndUs;
  const sourceOrigin = edge === 'start' ? clip.sourceStartUs : clip.sourceEndUs;
  const min = edge === 'start' ? Math.max(0, clip.sourceStartUs + (previousEnd - clip.timelineStartUs) * rate) : start + 500_000 * rate;
  const max = edge === 'start' ? end - 500_000 * rate : Math.min(assetDurationUs, clip.sourceEndUs + (nextStart - clip.timelineEndUs) * rate);
  // Round inward: rounding a clamped boundary outward can still overlap a neighbour.
  const minFrame = Math.ceil(toFrame(min) - 0.0001);
  const maxFrame = Math.floor(toFrame(max) + 0.0001);
  if (minFrame > maxFrame) return original;
  const requested = Math.round(toFrame(sourceOrigin + (requestedTimelineUs - origin) * rate));
  const frame = Math.max(minFrame, Math.min(maxFrame, requested));
  const candidate = (sourceFrame: number): VideoTrimRange | null => {
    const sourceStartUs = edge === 'start' ? fromFrame(sourceFrame) : start;
    const sourceEndUs = edge === 'end' ? fromFrame(sourceFrame) : end;
    if (sourceStartUs === clip.sourceStartUs && sourceEndUs === clip.sourceEndUs) return original;
    const length = sourceEndUs - sourceStartUs;
    const slip = length === clip.sourceEndUs - clip.sourceStartUs;
    const timelineStartUs = slip ? clip.timelineStartUs : align(clip.timelineStartUs + (sourceStartUs - clip.sourceStartUs) / rate);
    const timelineEndUs = align(timelineStartUs + length / rate);
    if (length / rate < 500_000 || sourceStartUs < 0 || sourceEndUs > assetDurationUs || timelineStartUs < previousEnd || timelineEndUs > nextStart) return null;
    return { sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs };
  };
  // Fractional playback rates can put double-rounded endpoints one frame outside
  // a gap. Try nearby source frames, then safely retain the existing range.
  for (let distance = 0; distance <= Math.ceil(rate * 2) + 2; distance++) {
    for (const f of distance === 0 ? [frame] : [frame - distance, frame + distance]) {
      if (f < minFrame || f > maxFrame) continue;
      const result = candidate(f);
      if (result) return result;
    }
  }
  return original;
}
