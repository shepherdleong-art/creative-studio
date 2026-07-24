import { FINAL_EDIT_MIN_CLIP_FRAMES, type TimelineClip } from '../../lib/final-edit/types.ts';

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

export function clampTimelineZoom(pxPerSecond: number): number {
  return clamp(Math.round(pxPerSecond), 40, 240);
}

export function timelineContentWidthPx({ totalUs, pxPerSecond, viewportWidth }: {
  totalUs: number;
  pxPerSecond: number;
  viewportWidth: number;
}): number {
  const durationWidth = Math.ceil(Math.max(0, totalUs) / 1_000_000 * clampTimelineZoom(pxPerSecond));
  return Math.max(1, Math.ceil(viewportWidth), durationWidth);
}

export function timelineFrameFromPointer({ clientX, contentLeft, scrollLeft, pxPerSecond, introFrames, bodyFrames, fps }: {
  clientX: number;
  contentLeft: number;
  scrollLeft: number;
  pxPerSecond: number;
  introFrames: number;
  bodyFrames: number;
  fps: number;
}): number {
  return clamp(timelineAbsoluteFrameFromPointer({ clientX, contentLeft, scrollLeft, pxPerSecond, totalFrames: introFrames + bodyFrames, fps }) - introFrames, 0, bodyFrames);
}

export function timelineAbsoluteFrameFromPointer({ clientX, contentLeft, scrollLeft, pxPerSecond, totalFrames, fps }: {
  clientX: number;
  contentLeft: number;
  scrollLeft: number;
  pxPerSecond: number;
  totalFrames: number;
  fps: number;
}): number {
  const absoluteSeconds = Math.max(0, clientX - contentLeft + scrollLeft) / clampTimelineZoom(pxPerSecond);
  return clamp(Math.round(absoluteSeconds * fps), 0, totalFrames);
}

export function planClipReorder({ clips, clipId, pointerFrame }: {
  clips: TimelineClip[];
  clipId: string;
  pointerFrame: number;
}): string[] {
  const ordered = [...clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame || left.id.localeCompare(right.id));
  if (!ordered.some((clip) => clip.id === clipId)) return ordered.map((clip) => clip.id);
  const remaining = ordered.filter((clip) => clip.id !== clipId);
  const insertionIndex = remaining.findIndex((clip) => pointerFrame < (clip.timelineInFrame + clip.timelineOutFrame) / 2);
  const next = insertionIndex < 0 ? [...remaining, ordered.find((clip) => clip.id === clipId)!] : [
    ...remaining.slice(0, insertionIndex),
    ordered.find((clip) => clip.id === clipId)!,
    ...remaining.slice(insertionIndex),
  ];
  return next.map((clip) => clip.id);
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
    const maximumDelta = initial.timelineOutFrame - initial.timelineInFrame - FINAL_EDIT_MIN_CLIP_FRAMES;
    const delta = clamp(deltaFrames, minimumDelta, maximumDelta);
    return { ...initial, sourceInFrame: initial.sourceInFrame + delta, timelineInFrame: initial.timelineInFrame + delta };
  }

  const safeSourceFrames = Math.max(initial.sourceOutFrame, sourceFrames);
  const minimumDelta = -(initial.timelineOutFrame - initial.timelineInFrame - FINAL_EDIT_MIN_CLIP_FRAMES);
  const maximumDelta = Math.min(
    (next?.timelineInFrame ?? bodyFrames) - initial.timelineOutFrame,
    safeSourceFrames - initial.sourceOutFrame,
  );
  const delta = clamp(deltaFrames, minimumDelta, maximumDelta);
  return { ...initial, sourceOutFrame: initial.sourceOutFrame + delta, timelineOutFrame: initial.timelineOutFrame + delta };
}
