// scripts/final-video-timeline.test.ts
import assert from 'node:assert/strict';
import { buildTimeline, NARRATION_TAIL_PAD_SEC } from '../lib/final-video/timeline.ts';

const scriptShots = [
  { shotId: 's2', shotIndex: 2, voiceover: '第二句', subtitle: '字幕二' },
  { shotId: 's1', shotIndex: 1, voiceover: '第一句', subtitle: '字幕一' },
  { shotId: 's3', shotIndex: 3, voiceover: '第三句', subtitle: '字幕三' },
];
const clips = [
  { shotId: 's1', videoJobId: 'vj1', clipPath: '/a/1.mp4', clipDurationSec: 5.0 },
  { shotId: 's2', videoJobId: 'vj2', clipPath: '/a/2.mp4', clipDurationSec: 4.96 },
];

// 按 shotIndex 排序；缺片段的镜头产出 issue 并跳过
const r1 = buildTimeline({ scriptShots, clips });
assert.equal(r1.segments.length, 2);
assert.deepEqual(r1.segments.map((s) => s.shotIndex), [1, 2]);
assert.equal(r1.issues.length, 1);
assert.equal(r1.issues[0].shotId, 's3');
assert.equal(r1.segments[0].startSec, 0);
assert.equal(r1.segments[1].startSec, 5.0);
assert.equal(r1.totalDurationSec, 9.96);
assert.equal(r1.segments[0].segmentDurationSec, 5.0);

// 口播长于片段 → 该段拉长到口播 + 尾部余量；片头偏移全部 startSec
const r2 = buildTimeline({
  scriptShots, clips,
  narrationDurations: { s1: 6.0 },
  introDurationSec: 1,
});
assert.equal(r2.segments[0].segmentDurationSec, Number((6.0 + NARRATION_TAIL_PAD_SEC).toFixed(2)));
assert.equal(r2.segments[0].startSec, 1);
assert.equal(r2.segments[1].startSec, Number((1 + 6.0 + NARRATION_TAIL_PAD_SEC).toFixed(2)));
assert.equal(r2.segments[0].narrationDurationSec, 6.0);

// 全部缺片段 → segments 为空
const r3 = buildTimeline({ scriptShots, clips: [] });
assert.equal(r3.segments.length, 0);
assert.equal(r3.issues.length, 3);

console.log('final-video-timeline tests passed');
