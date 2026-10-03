import assert from 'node:assert/strict';
import { changeVideoPlaybackRate, editAudioClip, audioAudibleAt } from '../lib/final-edit/clip-edit.ts';
import { constrainClipDrag } from '../components/final-edit/timeline-edit.ts';
import { expectedVideoTimeSec } from '../components/final-edit/preview-playback.ts';
import type { VideoTimeline } from '../lib/final-edit/types.ts';

const timeline: VideoTimeline = { fps: 24, introFrames: 20, bodyFrames: 144, clips: [
  { id: 'a', videoJobId: 'a', sourceFingerprint: 'a', sourceInFrame: 24, sourceOutFrame: 120, timelineInFrame: 0, timelineOutFrame: 96, framing: { scale: 1, offsetX: 0, offsetY: 0 }, boundSegmentId: null, manualUseOverride: false },
  { id: 'b', videoJobId: 'b', sourceFingerprint: 'b', sourceInFrame: 0, sourceOutFrame: 48, timelineInFrame: 96, timelineOutFrame: 144, framing: { scale: 1, offsetX: 0, offsetY: 0 }, boundSegmentId: null, manualUseOverride: false },
] };
const next = structuredClone(timeline.clips[1]);
for (const rate of [1.5, 1, 2, 1]) {
  changeVideoPlaybackRate(timeline, 'a', rate);
  assert.equal(timeline.clips[0].timelineOutFrame, Math.round(96 / rate));
  assert.deepEqual(timeline.clips[1], next);
}
changeVideoPlaybackRate(timeline, 'a', 2);
assert.equal(timeline.clips[0].timelineOutFrame, 48);
assert.deepEqual(timeline.clips[1], next);
assert.equal(expectedVideoTimeSec(24, 0, 24, 24, 2), 3);
assert.throws(() => changeVideoPlaybackRate(timeline, 'a', 0.5), /空位不足/);
for (const invalid of [NaN, Infinity, 0, 5]) assert.throws(() => changeVideoPlaybackRate(timeline, 'a', invalid));
const trimmed = constrainClipDrag({ clip: timeline.clips[0], clips: timeline.clips, bodyFrames: 144, sourceFrames: 240, mode: 'start', deltaFrames: 12 });
assert.equal(trimmed.sourceInFrame, 48);
assert.equal(trimmed.timelineInFrame, 12);
editAudioClip(timeline, 'narration', 6e6, 'narration-full', 2e6);
editAudioClip(timeline, 'narration', 6e6, 'narration-full');
assert.equal(audioAudibleAt(timeline.audio?.narration, 1e6), false);
assert.equal(audioAudibleAt(timeline.audio?.narration, 2e6), true);
assert.deepEqual(timeline.clips[1], next);
editAudioClip(timeline, 'bgm', 6e6, 'bgm-full');
assert.deepEqual(timeline.audio?.bgm, []);
assert.equal(audioAudibleAt(timeline.audio?.bgm, 3e6), false);
console.log('clip speed, non-ripple trim and audio cut tests passed');
