import assert from 'node:assert/strict';
import { videoDurationRange, videoDurationError, clampVideoDuration, parseVideoDuration, sharedVideoDurationRange } from '../lib/video-duration.ts';

for (const [model, min, max] of [
  ['doubao-seedance-2-5-260628', 4, 30],
  ['doubao-seedance-2-0-260128', 4, 15],
  ['doubao-seedance-2-0-fast-260128', 4, 15],
  ['kling-3.0', 3, 15], ['qiniuyun/kling-3.0', 3, 15], ['kling-v3', 3, 15],
  ['sora-2', 2, 15],
] as const) {
  assert.deepEqual(videoDurationRange(model), { min, max });
  for (let value = min; value <= max; value++) assert.equal(videoDurationError(model, value), null);
  for (const value of [min - 1, max + 1, 4.5, NaN, Infinity]) assert.ok(videoDurationError(model, value));
  assert.equal(clampVideoDuration(30, videoDurationRange(model)), max);
}
assert.equal(parseVideoDuration(undefined), 5);
assert.equal(parseVideoDuration('30'), 30);
for (const value of ['', ' ', null, true, [], {}, 'bad']) assert.ok(Number.isNaN(parseVideoDuration(value)));
assert.deepEqual(sharedVideoDurationRange(['doubao-seedance-2-5-260628', 'kling-3.0']), { min: 4, max: 15 });
assert.deepEqual(sharedVideoDurationRange(['doubao-seedance-2-5-260628']), { min: 4, max: 30 });
console.log('video-duration tests passed');
