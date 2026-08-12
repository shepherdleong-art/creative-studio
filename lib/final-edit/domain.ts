export { defaultTextStyle, normalizeTextStyle, splitCoverTitle } from '../media-core/cover-domain.ts';

export function timelineGaps(
  bodyFrames: number,
  clips: Array<{ timelineInFrame: number; timelineOutFrame: number }>,
): Array<{ startFrame: number; endFrame: number }> {
  const sorted = clips
    .map((clip) => ({ start: Math.max(0, clip.timelineInFrame), end: Math.min(bodyFrames, clip.timelineOutFrame) }))
    .filter((clip) => clip.end > clip.start)
    .sort((a, b) => a.start - b.start);
  const gaps: Array<{ startFrame: number; endFrame: number }> = [];
  let cursor = 0;
  for (const clip of sorted) {
    if (clip.start > cursor) gaps.push({ startFrame: cursor, endFrame: clip.start });
    cursor = Math.max(cursor, clip.end);
  }
  if (cursor < bodyFrames) gaps.push({ startFrame: cursor, endFrame: bodyFrames });
  return gaps;
}
