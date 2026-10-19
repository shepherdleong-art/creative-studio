import { FINAL_EDIT_MIN_CLIP_FRAMES, type TimelineClip } from './types.ts';

/** Body-relative frame; preserve the existing 1:1 source playback mapping. */
export function planVideoClipSplit(clip: TimelineClip, splitFrame: number) {
  if (!Number.isSafeInteger(splitFrame)) return null;
  const sourceSplitFrame = clip.sourceInFrame + splitFrame - clip.timelineInFrame;
  if ([
    splitFrame - clip.timelineInFrame,
    clip.timelineOutFrame - splitFrame,
    sourceSplitFrame - clip.sourceInFrame,
    clip.sourceOutFrame - sourceSplitFrame,
  ].some((duration) => !Number.isSafeInteger(duration) || duration < FINAL_EDIT_MIN_CLIP_FRAMES)) return null;
  return { splitFrame, sourceSplitFrame };
}
