import assert from 'node:assert/strict';
import { videoTrimRange } from '../components/batch-production/review/video-trim.ts';

// A manually inserted 3s clip following an automatically allocated, fractional
// timeline boundary. Its right edge must shrink without moving its left edge.
for (const sourceStartUs of [0, 489849]) {
  const clip = { clipId: 'middle', sourceStartUs, sourceEndUs: sourceStartUs + 3000000,
    timelineStartUs: 13433667, timelineEndUs: 16433667, playbackRate: 1 };
  const previous = { ...clip, clipId: 'previous', timelineStartUs: 10433667, timelineEndUs: clip.timelineStartUs };
  const next = { ...clip, clipId: 'next', timelineStartUs: clip.timelineEndUs, timelineEndUs: 19433667 };
  const clips = [previous, clip, next];
  const right = videoTrimRange(clip, clips, 'end', clip.timelineEndUs - 500000, 5040000);
  assert.ok(right.timelineEndUs < clip.timelineEndUs, '非整帧边界紧贴前片段时，右端仍必须能向左缩短');
  assert.equal(right.timelineStartUs, clip.timelineStartUs, '修剪右端不得移动左端');
  assert.equal(right.sourceStartUs, clip.sourceStartUs, '保留未编辑的源入点');
  const left = videoTrimRange(clip, clips, 'start', clip.timelineStartUs + 500000, 5040000);
  assert.ok(left.timelineStartUs > clip.timelineStartUs);
  assert.equal(left.timelineEndUs, clip.timelineEndUs, '修剪左端不得移动右端');
  assert.equal(left.sourceEndUs, clip.sourceEndUs);
}
console.log('fractional-boundary video trim tests passed');
