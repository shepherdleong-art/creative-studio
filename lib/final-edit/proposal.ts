export interface SourceFrameRange {
  startFrame: number;
  endFrame: number;
}

export function findAvailableSourceWindow(
  range: SourceFrameRange,
  occupied: SourceFrameRange[],
  requestedFrames: number,
): SourceFrameRange | null {
  if (requestedFrames < 1 || range.endFrame <= range.startFrame) return null;
  const blockers = occupied
    .map((item) => ({
      startFrame: Math.max(range.startFrame, item.startFrame),
      endFrame: Math.min(range.endFrame, item.endFrame),
    }))
    .filter((item) => item.endFrame > item.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame);

  let cursor = range.startFrame;
  let best: SourceFrameRange | null = null;

  for (const blocker of blockers) {
    if (blocker.startFrame > cursor) {
      const availableFrames = blocker.startFrame - cursor;
      const candidate = { startFrame: cursor, endFrame: cursor + Math.min(requestedFrames, availableFrames) };
      if (candidate.endFrame - candidate.startFrame === requestedFrames) return candidate;
      if (!best || candidate.endFrame - candidate.startFrame > best.endFrame - best.startFrame) best = candidate;
    }
    cursor = Math.max(cursor, blocker.endFrame);
  }
  if (cursor < range.endFrame) {
    const candidate = { startFrame: cursor, endFrame: cursor + Math.min(requestedFrames, range.endFrame - cursor) };
    if (!best || candidate.endFrame - candidate.startFrame > best.endFrame - best.startFrame) best = candidate;
  }
  return best;
}
