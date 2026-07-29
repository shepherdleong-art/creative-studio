import { FINAL_EDIT_FPS } from './types.ts';

export function frameToUs(frame: number, fps: number = FINAL_EDIT_FPS): number {
  return Math.round(frame * 1_000_000 / fps);
}

export function minimumFrameDurationUs(fps: number = FINAL_EDIT_FPS): number {
  return Math.floor(1_000_000 / fps);
}

export function nearestFrameTimeUs(timeUs: number, fps: number = FINAL_EDIT_FPS): number {
  return frameToUs(Math.round(timeUs * fps / 1_000_000), fps);
}

export function splitTimeAtNearestFrame(startUs: number, endUs: number, requestedUs: number, fps: number = FINAL_EDIT_FPS): number | null {
  if (![startUs, endUs, requestedUs, fps].every(Number.isFinite) || fps <= 0 || endUs <= startUs) return null;
  const splitUs = nearestFrameTimeUs(requestedUs, fps);
  const minimumUs = minimumFrameDurationUs(fps);
  return splitUs - startUs >= minimumUs && endUs - splitUs >= minimumUs ? splitUs : null;
}

export function firstFrameAtOrAfter(timeUs: number, fps: number = FINAL_EDIT_FPS): number {
  let frame = Math.floor(timeUs * fps / 1_000_000) - 1;
  while (frameToUs(frame, fps) < timeUs) frame += 1;
  return frame;
}

export function lastFrameAtOrBefore(timeUs: number, fps: number = FINAL_EDIT_FPS): number {
  let frame = Math.ceil(timeUs * fps / 1_000_000) + 1;
  while (frameToUs(frame, fps) > timeUs) frame -= 1;
  return frame;
}
