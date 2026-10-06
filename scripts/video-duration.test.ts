import assert from 'node:assert/strict';
import { describeVideoDurationOptions, normalizeVideoDraftDuration, parseVideoDuration, videoDurationError, videoDurationOptions } from '../lib/video-duration.ts';

for (const [type, model, min, max] of [
  ['openai-video', 'doubao-seedance-2-5-260628', 4, 30],
  ['jimeng', 'doubao-seedance-2-5-260628', 4, 30],
  ['openai-video', 'doubao-seedance-2-0-260128', 4, 15],
  ['openai-video', 'doubao-seedance-2-0-fast-260128', 4, 15],
  ['openai-video', 'kling-3.0', 3, 15], ['openai-video', 'qiniuyun/kling-3.0', 3, 15], ['kling', 'kling-v3', 3, 15],
  ['openai-video', 'sora-2', 2, 15],
] as const) {
  const options = videoDurationOptions(type, model);
  assert.deepEqual([options[0], options[options.length - 1]], [min, max]);
  for (let value = min; value <= max; value++) assert.equal(videoDurationError(type, model, value), null);
  for (const value of [min - 1, max + 1, 4.5, NaN, Infinity]) assert.ok(videoDurationError(type, model, value));
  assert.equal(normalizeVideoDraftDuration(30, options), max);
}
assert.equal(describeVideoDurationOptions(videoDurationOptions('openai-video', 'doubao-seedance-2-5-260628')), '4–30 秒');
assert.equal(describeVideoDurationOptions(videoDurationOptions('openai-video', 'kling-2.5')), '5 / 10 秒');
assert.equal(parseVideoDuration(undefined), 5);
assert.equal(parseVideoDuration('30'), 30);
for (const value of ['', ' ', null, true, [], {}, 'bad']) assert.ok(Number.isNaN(parseVideoDuration(value)));
console.log('video-duration tests passed');
