import assert from 'node:assert/strict';
import { planClipPosition } from '../lib/media-core/clip-position.ts';

const clips = [{ id: 'a', startUs: 0, endUs: 2_000_000 }, { id: 'b', startUs: 3_000_000, endUs: 6_000_000 }];
assert.deepEqual(planClipPosition(clips, 'a', 500_000, 8_000_000), [
  { id: 'a', startUs: 500_000, endUs: 2_500_000 }, clips[1],
]);
assert.deepEqual(planClipPosition(clips, 'a', 1_500_000, 8_000_000), [
  { id: 'a', startUs: 1_000_000, endUs: 3_000_000 }, clips[1],
]);
assert.deepEqual(planClipPosition(clips, 'a', 4_500_000, 8_000_000), [
  { id: 'b', startUs: 0, endUs: 3_000_000 }, { id: 'a', startUs: 4_000_000, endUs: 6_000_000 },
]);
assert.deepEqual(planClipPosition(clips, 'a', 6_000_000, 8_000_000), [
  clips[1], { id: 'a', startUs: 6_000_000, endUs: 8_000_000 },
]);
const packed = [{ id: 'long', startUs: 0, endUs: 5_000_000 }, { id: 'short', startUs: 5_000_000, endUs: 7_000_000 }];
assert.deepEqual(planClipPosition(packed, 'long', 5_000_000, 7_000_000), [
  { id: 'short', startUs: 0, endUs: 2_000_000 }, { id: 'long', startUs: 2_000_000, endUs: 7_000_000 },
]);
assert.deepEqual(clips, [{ id: 'a', startUs: 0, endUs: 2_000_000 }, { id: 'b', startUs: 3_000_000, endUs: 6_000_000 }], '拖动规划不得改写持久化快照');
console.log('clip position: gap movement, bounds and reordering passed');
