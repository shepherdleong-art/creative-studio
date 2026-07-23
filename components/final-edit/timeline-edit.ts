import type { TimelineClip } from '@/lib/final-edit/types';

export type ClipDragMode = 'move' | 'start' | 'end';

export interface ClipDraft {
  sourceInFrame: number;
  sourceOutFrame: number;
  timelineInFrame: number;
  timelineOutFrame: number;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Keep a drag inside the free space bounded by adjacent clips and source media. */
export function constrainClipDrag({ clip, clips, bodyFrames, sourceFrames, mode, deltaFrames }: {
  clip: TimelineClip;
  clips: TimelineClip[];
  bodyFrames: number;
  sourceFrames: number;
  mode: ClipDragMode;
  deltaFrames: number;
}): ClipDraft {
  const initial: ClipDraft = {
    sourceInFrame: clip.sourceInFrame,
    sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame,
    timelineOutFrame: clip.timelineOutFrame,
  };
  const ordered = [...clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame || left.id.localeCompare(right.id));
  const index = ordered.findIndex((item) => item.id === clip.id);
  const previous = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;

  if (mode === 'move') {
    const duration = initial.timelineOutFrame - initial.timelineInFrame;
    const minimumStart = previous?.timelineOutFrame ?? 0;
    const maximumStart = (next?.timelineInFrame ?? bodyFrames) - duration;
    if (maximumStart < minimumStart) return initial;
    const timelineInFrame = clamp(initial.timelineInFrame + deltaFrames, minimumStart, maximumStart);
    return { ...initial, timelineInFrame, timelineOutFrame: timelineInFrame + duration };
  }

  if (mode === 'start') {
    const minimumDelta = Math.max((previous?.timelineOutFrame ?? 0) - initial.timelineInFrame, -initial.sourceInFrame);
    const maximumDelta = initial.timelineOutFrame - initial.timelineInFrame - 1;
    const delta = clamp(deltaFrames, minimumDelta, maximumDelta);
    return { ...initial, sourceInFrame: initial.sourceInFrame + delta, timelineInFrame: initial.timelineInFrame + delta };
  }

  const safeSourceFrames = Math.max(initial.sourceOutFrame, sourceFrames);
  const minimumDelta = -(initial.timelineOutFrame - initial.timelineInFrame - 1);
  const maximumDelta = Math.min(
    (next?.timelineInFrame ?? bodyFrames) - initial.timelineOutFrame,
    safeSourceFrames - initial.sourceOutFrame,
  );
  const delta = clamp(deltaFrames, minimumDelta, maximumDelta);
  return { ...initial, sourceOutFrame: initial.sourceOutFrame + delta, timelineOutFrame: initial.timelineOutFrame + delta };
}
