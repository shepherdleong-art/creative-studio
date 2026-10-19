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

console.log('final-edit audio-first timeline tests passed');
