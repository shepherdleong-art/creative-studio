import assert from 'node:assert/strict';
import { FinalEditError, planTimeline, validateNarrationAlignment } from '../lib/final-edit/workspace.ts';
import { clipFilter } from '../lib/final-edit/renderer.ts';

const assets = [
  {
    videoJobId: 'direct', shotSetId: 'set', shotId: 'shot-1', filename: 'direct.mp4', localVideoPath: '/storage/direct.mp4', durationSec: 10,
    durationUs: 10_000_000, fingerprint: 'direct-fingerprint', autoUseDisabled: false, existingUsageCount: 0,
    analysis: { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 2_000_000, endUs: 6_000_000, qualityScore: 0.8 }], qualityIssues: [], coverFrameTimesUs: [] },
  },
  {
    videoJobId: 'disabled', shotSetId: 'set', shotId: 'shot-1', filename: 'disabled.mp4', localVideoPath: '/storage/disabled.mp4', durationSec: 10,
    durationUs: 10_000_000, fingerprint: 'disabled-fingerprint', autoUseDisabled: true, existingUsageCount: 0,
    analysis: { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 10_000_000, qualityScore: 1 }], qualityIssues: [], coverFrameTimesUs: [] },
  },
  {
    videoJobId: 'limited', shotSetId: 'set', shotId: 'shot-2', filename: 'limited.mp4', localVideoPath: '/storage/limited.mp4', durationSec: 10,
    durationUs: 10_000_000, fingerprint: 'limited-fingerprint', autoUseDisabled: false, existingUsageCount: 2,
    analysis: { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 10_000_000, qualityScore: 1 }], qualityIssues: [], coverFrameTimesUs: [] },
  },
];

const timeline = planTimeline(assets, 72, 0, [{ id: 'segment-1', shotId: 'shot-1', narration: '这是口播', subtitle: '这是字幕' }], 2);
assert.ok(timeline.clips.length > 0);
assert.ok(timeline.clips.every((clip) => clip.videoJobId === 'direct'));
assert.ok(timeline.clips.every((clip) => clip.sourceInFrame >= 48 && clip.sourceOutFrame <= 144));

validateNarrationAlignment({
  relativePath: 'narration.wav', durationUs: 1_000_000,
  segmentTimings: [{ segmentId: 'segment-1', startUs: 0, endUs: 1_000_000 }],
  wordTimings: [{ text: '这是', startUs: 0, endUs: 400_000 }, { text: '口播', startUs: 400_000, endUs: 1_000_000 }],
}, '这是口播');
assert.throws(() => validateNarrationAlignment({
  relativePath: 'narration.wav', durationUs: 1_000_000,
  segmentTimings: [{ segmentId: 'segment-1', startUs: 0, endUs: 1_000_000 }],
  wordTimings: [{ text: '完全不同', startUs: 0, endUs: 1_000_000 }],
}, '这是口播'), (error: unknown) => error instanceof FinalEditError && error.code === 'alignment_failed');

const framingFilter = clipFilter(1, '3x4', { scale: 1.5, offsetX: 0.25, offsetY: -0.5 });
assert.match(framingFilter, /scale=iw\*1\.5000:ih\*1\.5000/);
assert.match(framingFilter, /0\.2500/);
assert.match(framingFilter, /-0\.5000/);

console.log('final-edit planner, alignment, and framing tests passed');
