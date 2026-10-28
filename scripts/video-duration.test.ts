import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeVideoDurationOptions, normalizeVideoDraftDuration, parseVideoDuration, videoDurationError, videoDurationOptions } from '../lib/video-duration.ts';

for (const [type, model, min, max] of [
  ['openai-video', 'doubao-seedance-2-5-260628', 4, 30],
  ['jimeng', 'doubao-seedance-2-5-260628', 4, 30],
  ['openai-video', 'doubao-seedance-2-0-260128', 4, 15],
  ['openai-video', 'doubao-seedance-2-0-fast-260128', 4, 15],
  ['openai-video', 'kling-3.0', 3, 15], ['openai-video', 'qiniuyun/kling-3.0', 3, 15], ['kling', 'kling-v3', 3, 15],
  ['openai-video', 'sora-2', 2, 15],
  ['openai-video', 'minimax-h3', 4, 15],
  ['openai-video', 'wan-3.0', 2, 30],
  ['openai-video', 'minimax-h3-max', 2, 15],
  ['openai-video', 'wan-3.0-prime', 2, 15],
  ['kling', 'wan-3.0', 2, 15],
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

const discrete = videoDurationOptions('openai-video', 'kling-2.5');
assert.deepEqual(discrete, [5, 10]);
for (const [input, expected] of [[15, 10], [2, 5], [10, 10]]) assert.equal(normalizeVideoDraftDuration(input, discrete), expected);
for (const model of ['kling-2.5-fast', 'KLING-2.5']) assert.ok(videoDurationOptions('openai-video', model).includes(15));
assert.ok(videoDurationOptions('kling', 'kling-2.5').includes(15), '公司通道限制不得扩散到其他供应商');
assert.equal(videoDurationOptions('openai-video', 'kling-3.0-unknown')[0], 2);
for (const [model, min, max] of [
  ['kling-3.0', 3, 15], ['qiniuyun/kling-3.0', 3, 15],
  ['doubao-seedance-2-0-260128', 4, 15], ['doubao-seedance-2-0-fast-260128', 4, 15],
  ['doubao-seedance-2-5-260628', 4, 30],
] as const) {
  const choices = videoDurationOptions('openai-video', model);
  assert.deepEqual(choices, Array.from({ length: max - min + 1 }, (_, i) => i + min));
  assert.equal(normalizeVideoDraftDuration(2, choices), min);
  assert.equal(normalizeVideoDraftDuration(5, choices), 5);
}

const panel = fs.readFileSync(new URL('../components/VideoGenerationPanel.tsx', import.meta.url), 'utf8');
assert.equal((panel.match(/getRowDurationOptions\(row\)\.map/g) || []).length, 2, '逐行时长选项必须来自模型能力');
assert.match(panel, /getBulkDurationOptions\(\)\.map/, '批量时长选项必须来自模型能力');
assert.doesNotMatch(panel, /max=\{15\}/, '视频时长不得写死为最多 15 秒；Seedance 2.5 支持 30 秒');
console.log('video-duration tests passed');
