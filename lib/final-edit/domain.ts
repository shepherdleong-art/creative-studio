import type { TextStyle } from './types.ts';

export function splitCoverTitle(title: string): { primary: string; secondary: string } {
  const value = title.trim();
  if (!value) return { primary: '', secondary: '' };
  const graphemes = Array.from(value);
  const midpoint = graphemes.length / 2;
  const boundaries: number[] = [];
  graphemes.forEach((char, index) => {
    if (/[，。！？；、,.!?;\s]/u.test(char)) boundaries.push(index);
  });
  if (boundaries.length > 0) {
    const boundary = boundaries.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
    const primary = graphemes.slice(0, boundary).join('').trim();
    const secondary = graphemes.slice(boundary + 1).join('').trim();
    if (primary && secondary) return { primary, secondary };
  }
  const cut = Math.max(1, Math.min(graphemes.length - 1, Math.round(midpoint)));
  return { primary: graphemes.slice(0, cut).join(''), secondary: graphemes.slice(cut).join('') };
}

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

export function defaultTextStyle(kind: 'coverPrimary' | 'coverSecondary' | 'subtitle', width: number): TextStyle {
  const subtitle = kind === 'subtitle';
  return {
    fontFamily: 'PingFang SC',
    fontSizePx: subtitle ? 56 : kind === 'coverPrimary' ? 84 : 72,
    x: 0.5,
    y: subtitle ? 0.82 : kind === 'coverPrimary' ? 0.2 : 0.31,
    scale: 1,
    color: kind === 'coverSecondary' ? '#2f7cf6' : '#ffffff',
    align: 'center',
    boxWidthPx: Math.round(width * 0.8),
    lineHeight: 1.2,
    stroke: { enabled: true, color: '#101010', widthPx: subtitle ? 4 : 3 },
    shadow: { enabled: true, color: '#000000', opacity: 0.7, blurPx: subtitle ? 2 : 8, distancePx: subtitle ? 5 : 8, angleDeg: 45 },
  };
}
