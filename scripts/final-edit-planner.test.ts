import assert from 'node:assert/strict';
import { FinalEditError, planTimeline, validateNarrationAlignment } from '../lib/final-edit/workspace.ts';
import { clipFilter, subtitleOverlayEnableExpression } from '../lib/final-edit/renderer.ts';

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

const fiveSecondAssets = Array.from({ length: 7 }, (_, index) => ({
  videoJobId: `five-second-${index + 1}`,
  shotSetId: 'set',
  shotId: `shot-${index + 1}`,
  filename: `five-second-${index + 1}.mp4`,
  localVideoPath: `/storage/five-second-${index + 1}.mp4`,
  durationSec: 5.05,
  durationUs: 5_050_000,
  fingerprint: `five-second-fingerprint-${index + 1}`,
  autoUseDisabled: false,
  existingUsageCount: 0,
  analysis: {
    summary: '', sellingPoints: [], semanticTags: [], qualityIssues: [], coverFrameTimesUs: [],
    usableRanges: index === 0
      ? [
          { startUs: 0, endUs: 5_050_000, qualityScore: 1 },
          { startUs: 0, endUs: 5_050_000, qualityScore: 0.9 },
        ]
      : [{ startUs: 0, endUs: 5_050_000, qualityScore: 0.9 }],
  },
}));
const longTimeline = planTimeline(fiveSecondAssets, 25 * 24, 0, [
  { id: 'segment-1', shotId: 'shot-1', narration: '第一段', subtitle: '第一段' },
  { id: 'segment-2', shotId: 'shot-2', narration: '第二段', subtitle: '第二段' },
  { id: 'segment-3', shotId: 'shot-3', narration: '第三段', subtitle: '第三段' },
], 2);
assert.equal(longTimeline.clips.reduce((sum, clip) => sum + clip.timelineOutFrame - clip.timelineInFrame, 0), 25 * 24, '7 条 5 秒素材必须完整覆盖 25 秒正文');
assert.equal(new Set(longTimeline.clips.slice(0, 7).map((clip) => clip.sourceFingerprint)).size, 7, '自动剪辑必须先轮换不同素材，再复用同一文件的后段');
assert.ok(longTimeline.clips.every((clip) => clip.timelineOutFrame - clip.timelineInFrame >= 24), '自动剪辑不得制造不足 1 秒的黑闪片段');
for (let index = 0; index < longTimeline.clips.length; index += 1) {
  const clip = longTimeline.clips[index];
  const overlapsSameSource = longTimeline.clips.slice(index + 1).some((other) => other.sourceFingerprint === clip.sourceFingerprint && clip.sourceInFrame < other.sourceOutFrame && clip.sourceOutFrame > other.sourceInFrame);
  assert.equal(overlapsSameSource, false, '同一素材的自动截取区间不得重叠或复制前段');
}
const fiveUsableTimeline = planTimeline(fiveSecondAssets.slice(0, 5), 582, 0, [
  { id: 'segment-1', shotId: 'shot-1', narration: '第一段', subtitle: '第一段' },
  { id: 'segment-2', shotId: 'shot-2', narration: '第二段', subtitle: '第二段' },
  { id: 'segment-3', shotId: 'shot-3', narration: '第三段', subtitle: '第三段' },
], 2);
assert.equal(fiveUsableTimeline.clips.reduce((sum, clip) => sum + clip.timelineOutFrame - clip.timelineInFrame, 0), 582, '5 条 5.05 秒有效素材也必须完整覆盖 24.25 秒正文');
assert.ok(fiveUsableTimeline.clips.every((clip) => clip.timelineOutFrame - clip.timelineInFrame >= 24), '接近容量上限时也不能用超短片段硬补尾部');

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
assert.equal(
  subtitleOverlayEnableExpression(1, 2),
  'gte(t,1.000000)*lt(t,2.000000)',
  '字幕渲染必须使用结束时间不包含的区间，避免相邻 Cue 在边界帧重叠',
);

console.log('final-edit planner, alignment, and framing tests passed');
