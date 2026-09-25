import assert from 'node:assert/strict';
import { subtitleSplitEdit, subtitleTrimRange } from '../components/batch-production/review/subtitle-edit.ts';

const cue = { id: 'current', sourceSegmentId: 'segment', startUs: 1_000_000, endUs: 3_000_000, text: '清洁省心舒适安心' };
const cues = [
  { ...cue, id: 'previous', startUs: 0, endUs: 750_000 },
  cue,
  { ...cue, id: 'next', startUs: 3_500_000, endUs: 4_000_000 },
];
const original = JSON.stringify(cues);
assert.deepEqual(subtitleTrimRange(cue, cues, 'start', -1e6, 5e6), { startUs: 750_000, endUs: 3_000_000 });
assert.deepEqual(subtitleTrimRange(cue, cues, 'end', 9e6, 5e6), { startUs: 1_000_000, endUs: 3_500_000 });
assert.deepEqual(subtitleTrimRange(cue, [cue], 'end', 9e6, 5e6), { startUs: 1_000_000, endUs: 5_000_000 });
assert.equal(subtitleTrimRange(cue, cues, 'start', 1_508_000, 5e6).startUs, 1_500_000, '24fps 精确按帧取整，不累计 41667us 的误差');
assert.ok(subtitleTrimRange(cue, cues, 'start', 4e6, 5e6).startUs < cue.endUs, '不可倒置/清空字幕');
const short = { ...cue, endUs: cue.startUs + 20_000 };
assert.equal(subtitleTrimRange(short, [short], 'end', cue.startUs, 5e6).endUs, short.endUs, '原有短字幕不会被强制延长');
const split = subtitleSplitEdit(cue, 2e6);
assert.deepEqual(split, { type: 'split_subtitle_cue', cueId: cue.id, splitUs: 2e6, leftText: '清洁省心', rightText: '舒适安心' });
assert.equal(subtitleSplitEdit(cue, cue.startUs), null);
assert.equal(subtitleSplitEdit(cue, 10e6), null);
assert.equal(subtitleSplitEdit({ ...cue, text: '字' }, 2e6), null, '不能产生空文字的分割');
assert.equal(JSON.stringify(cues), original, '字幕手势计算不改邻接字幕或输入对象');
console.log('batch review subtitle edit tests passed');
