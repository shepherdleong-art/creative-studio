import assert from 'node:assert/strict';
import { audioFirstPlanToVideoTimeline } from '../lib/final-edit/audio-first-timeline.ts';

const converted = audioFirstPlanToVideoTimeline({
  plan: { segments: [
    { sentenceId: 's1', assetKey: 'a', startUs: 0, endUs: 333_333, sourceStartUs: 1_000_000, sourceEndUs: 1_333_333 },
    { sentenceId: 's2', assetKey: 'b', startUs: 333_333, endUs: 1_000_001, sourceStartUs: 2_000_000, sourceEndUs: 2_666_668 },
  ] },
  assetsByKey: new Map([
    ['a', { videoJobId: 'video-a', fingerprint: 'fp-a', durationUs: 5_000_000 }],
    ['b', { videoJobId: 'video-b', fingerprint: 'fp-b', durationUs: 5_000_000 }],
  ]),
  narrationDurationUs: 1_000_001,
});
assert.equal(converted.timeline.bodyFrames, 25);
assert.equal(converted.timeline.clips.at(-1)?.timelineOutFrame, 25, '最后边界必须钉到口播总帧数');
assert.ok(converted.timeline.clips.every((clip) => clip.sourceOutFrame - clip.sourceInFrame === clip.timelineOutFrame - clip.timelineInFrame));
assert.deepEqual(audioFirstPlanToVideoTimeline({
  plan: { segments: [{ sentenceId: 'missing', assetKey: 'x', startUs: 0, endUs: 1_000_000, sourceStartUs: 0, sourceEndUs: 1_000_000 }] },
  assetsByKey: new Map(), narrationDurationUs: 1_000_000,
}).timeline.clips, [], '缺少素材时不得捏造 clip');
assert.deepEqual(converted, audioFirstPlanToVideoTimeline({
  plan: { segments: [
    { sentenceId: 's1', assetKey: 'a', startUs: 0, endUs: 333_333, sourceStartUs: 1_000_000, sourceEndUs: 1_333_333 },
    { sentenceId: 's2', assetKey: 'b', startUs: 333_333, endUs: 1_000_001, sourceStartUs: 2_000_000, sourceEndUs: 2_666_668 },
  ] },
  assetsByKey: new Map([
    ['a', { videoJobId: 'video-a', fingerprint: 'fp-a', durationUs: 5_000_000 }],
    ['b', { videoJobId: 'video-b', fingerprint: 'fp-b', durationUs: 5_000_000 }],
  ]), narrationDurationUs: 1_000_001,
}), '转换和 clip ID 必须确定');

// M1：统一 ceil/floor 边界。durationUs=3_020_000 时 floor=72 / ceil=73，生成侧
// 必须按 floor 收紧，不得产出 sourceOutFrame === 73 的 clip（否则编辑期校验会把它
// 判超限，整个时间线从此锁死）。
const boundary = audioFirstPlanToVideoTimeline({
  plan: { segments: [
    { sentenceId: 's1', assetKey: 'a', startUs: 0, endUs: 41_667, sourceStartUs: 3_000_000, sourceEndUs: 3_041_667 },
  ] },
  assetsByKey: new Map([['a', { videoJobId: 'video-a', fingerprint: 'fp-a', durationUs: 3_020_000 }]]),
  narrationDurationUs: 2_000_000,
});
assert.equal(boundary.timeline.clips.some((clip) => clip.sourceOutFrame === 73), false, '不得产出贴死 ceil 边界的 clip');
assert.ok(boundary.issues.some((issue) => issue.code === 'material_gap'), '贴死 ceil 的匹配必须转为 material_gap issue');
assert.ok(boundary.timeline.clips.every((clip) => clip.sourceOutFrame <= 72), '所有 clip 的出点帧必须不超过 floor 边界');

console.log('final-edit audio-first timeline tests passed');
