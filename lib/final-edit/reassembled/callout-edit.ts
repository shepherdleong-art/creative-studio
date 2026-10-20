import type { Callout, Point } from '../../film-render/types.ts';

/** Move the complete tracking path, preserving its motion relative to the dot. */
export function moveCalloutPoint(callout: Callout, target: 'dot' | 'pill', axis: number, value: number): void {
  const delta = value - callout[target][axis];
  callout[target][axis] = value;
  if (target === 'dot') for (const keyframe of callout.dotKeyframes || []) keyframe.dot[axis] += delta;
}

/** Trim visibility against the existing path; new endpoints interpolate rather than speeding up tracking. */
export function trimCalloutTime(callout: Callout, key: 'startFrame' | 'endFrame', value: number): void {
  const track = callout.dotKeyframes;
  callout[key] = value;
  if (!track?.length || callout.endFrame - callout.startFrame < 2) return;
  const at = (frame: number): Point => {
    if (frame <= track[0].frame) return [...track[0].dot];
    const right = track.findIndex(k => k.frame >= frame);
    if (right < 0) return [...track.at(-1)!.dot];
    const a = track[right - 1], b = track[right], fraction = (frame - a.frame) / (b.frame - a.frame);
    return [a.dot[0] + fraction * (b.dot[0] - a.dot[0]), a.dot[1] + fraction * (b.dot[1] - a.dot[1])];
  };
  const start = callout.startFrame, end = callout.endFrame - 1;
  callout.dot = at(start);
  callout.dotKeyframes = [{ frame: start, dot: [...callout.dot] }, ...track.filter(k => k.frame > start && k.frame < end), { frame: end, dot: at(end) }];
}
