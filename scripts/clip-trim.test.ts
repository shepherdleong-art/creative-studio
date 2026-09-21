import assert from 'node:assert/strict';
import { clipTrimBounds, planClipTrim, snapTimelineTime } from '../lib/media-core/clip-trim.ts';

const clips = [
  { clipId: 'a', timelineStartUs: 0, timelineEndUs: 2_735_000, sourceStartUs: 1_871_617, sourceEndUs: 4_606_617 },
  { clipId: 'b', timelineStartUs: 2_735_000, timelineEndUs: 5_470_000, sourceStartUs: 1_871_617, sourceEndUs: 4_606_617 },
];
for (const ripple of [true, false]) {
  for (const rate of [0.25, 1, 1.5, 2, 4]) {
    const input = clips.map((clip) => ({ ...clip, playbackRate: rate, sourceEndUs: clip.sourceStartUs + 2_735_000 * rate }));
    for (const index of [0, 1]) {
      const clip = input[index];
      const bounds = clipTrimBounds(input, clip, 20_000_000, ripple);
      // Model wildly overshooting either handle, as happens in a real drag.
      for (const edge of ['start', 'end']) for (const delta of [-20_000_000, -250_000, 250_000, 20_000_000]) {
        const start = edge === 'start' ? Math.max(bounds.minimumStartUs, Math.min(clip.sourceEndUs - bounds.minimumDurationUs, clip.sourceStartUs + delta)) : clip.sourceStartUs;
        const end = edge === 'end' ? Math.max(clip.sourceStartUs + bounds.minimumDurationUs, Math.min(bounds.maximumEndUs, clip.sourceEndUs + delta)) : clip.sourceEndUs;
        const positions = planClipTrim(input, clip.clipId, start, end, ripple);
        assert.ok(positions[0].startUs >= 0);
        assert.ok(positions[0].endUs <= positions[1].startUs);
        assert.ok(positions[index].endUs - positions[index].startUs >= 500_000);
        if (ripple) assert.equal(positions[0].endUs, positions[1].startUs);
        else if (edge === 'start') assert.equal(positions[index].endUs, clip.timelineEndUs);
        else assert.equal(positions[index].startUs, clip.timelineStartUs);
      }
    }
  }
}
assert.deepEqual(planClipTrim(clips, 'a', 2_121_617, 4_856_617, false), clips.map((clip) => ({ id: clip.clipId, startUs: clip.timelineStartUs, endUs: clip.timelineEndUs })), '等长平移不改变时间线');
const gapped = [{ ...clips[0] }, { ...clips[1], timelineStartUs: 3_735_000, timelineEndUs: 6_470_000 }];
const shifted = planClipTrim(gapped, 'a', 1_871_617, 4_106_617, true);
assert.equal(shifted[1].startUs - shifted[0].endUs, 1_000_000, '联动不能清除用户已有的其他空位');
for (const pxPerSecond of [30, 60, 120]) {
  const target = 2_735_000;
  assert.equal(snapTimelineTime(target - 7 / pxPerSecond * 1e6, [target], pxPerSecond).timeUs, target);
  assert.equal(snapTimelineTime(target - 9 / pxPerSecond * 1e6, [target], pxPerSecond).snappedUs, null);
  assert.equal(snapTimelineTime(target - 10_000, [target], pxPerSecond, false).timeUs, target - 10_000);
}
console.log('clip trim: exact edges, drag limits, ripple, gaps, rates and pixel snapping passed');
