import assert from 'node:assert/strict';
import {
  clampTimelineZoom,
  constrainClipDrag,
  planClipReorder,
  timelineAbsoluteFrameFromPointer,
  timelineContentWidthPx,
  timelineFrameFromPointer,
} from '../components/final-edit/timeline-edit.ts';
import type { TimelineClip } from '../lib/final-edit/types.ts';

const clip = (id: string, timelineInFrame: number, timelineOutFrame: number, sourceInFrame = 0): TimelineClip => ({
  id,
  videoJobId: `video-${id}`,
  sourceFingerprint: `fingerprint-${id}`,
  sourceInFrame,
  sourceOutFrame: sourceInFrame + timelineOutFrame - timelineInFrame,
  timelineInFrame,
  timelineOutFrame,
  boundSegmentId: null,
  framing: { scale: 1, offsetX: 0, offsetY: 0 },
  manualUseOverride: true,
});

const clips = [clip('left', 0, 40), clip('middle', 40, 80), clip('right', 80, 120)];

assert.equal(clampTimelineZoom(10), 40);
assert.equal(clampTimelineZoom(90), 90);
assert.equal(clampTimelineZoom(999), 240, '时间轴 zoom 必须固定在 40–240 px/s');
assert.equal(timelineContentWidthPx({ totalUs: 12_000_000, pxPerSecond: 80, viewportWidth: 640 }), 960);
assert.equal(timelineContentWidthPx({ totalUs: 3_000_000, pxPerSecond: 40, viewportWidth: 640 }), 640, '短时间轴不能窄于可视区');
assert.equal(
  timelineFrameFromPointer({ clientX: 310, contentLeft: 110, scrollLeft: 160, pxPerSecond: 80, introFrames: 20, bodyFrames: 240, fps: 24 }),
  88,
  '播放头坐标必须把横向滚动和 20 帧封面换算到正文整数帧',
);
assert.equal(
  timelineAbsoluteFrameFromPointer({ clientX: 110, contentLeft: 110, scrollLeft: 0, pxPerSecond: 80, totalFrames: 260, fps: 24 }),
  0,
  '时间轴点击必须能够定位封面起点 0 帧',
);
assert.equal(
  timelineAbsoluteFrameFromPointer({ clientX: 150, contentLeft: 110, scrollLeft: 0, pxPerSecond: 80, totalFrames: 260, fps: 24 }),
  12,
  '播放头使用完整时间轴坐标，不能强制跳过封面段',
);
assert.deepEqual(
  planClipReorder({ clips, clipId: 'left', pointerFrame: 110 }),
  ['middle', 'right', 'left'],
  '一次拖动必须可以跨多个片段得到确定的完整排序 command',
);
assert.deepEqual(
  planClipReorder({ clips, clipId: 'right', pointerFrame: 5 }),
  ['right', 'left', 'middle'],
);

assert.deepEqual(
  constrainClipDrag({ clip: clips[1], clips, bodyFrames: 120, sourceFrames: 120, mode: 'move', deltaFrames: 60 }),
  { sourceInFrame: 0, sourceOutFrame: 40, timelineInFrame: 40, timelineOutFrame: 80 },
  '整段向后拖动时必须停在后一片段之前，不能覆盖后面的素材',
);
assert.equal(
  constrainClipDrag({ clip: clips[1], clips, bodyFrames: 120, sourceFrames: 120, mode: 'end', deltaFrames: 60 }).timelineOutFrame,
  80,
  '向右拉片段边缘时必须停在后一片段的起点',
);
assert.equal(
  constrainClipDrag({ clip: clips[1], clips, bodyFrames: 120, sourceFrames: 120, mode: 'end', deltaFrames: -999 }).timelineOutFrame - clips[1].timelineInFrame,
  12,
  '片段裁剪不得短于领域最小时长 0.5 秒',
);
assert.equal(
  constrainClipDrag({ clip: clips[1], clips, bodyFrames: 120, sourceFrames: 120, mode: 'start', deltaFrames: -60 }).timelineInFrame,
  40,
  '向左拉片段边缘时必须停在前一片段的终点',
);

const withGaps = [clip('left', 0, 30), clip('middle', 40, 60), clip('right', 80, 100)];
assert.deepEqual(
  constrainClipDrag({ clip: withGaps[1], clips: withGaps, bodyFrames: 120, sourceFrames: 120, mode: 'move', deltaFrames: 50 }),
  { sourceInFrame: 0, sourceOutFrame: 20, timelineInFrame: 60, timelineOutFrame: 80 },
  '片段只能在前后空白区移动，最远吸附到后一片段边界',
);

const reported = clip('reported', 190, 227, 73);
const reportedClips = [clip('before', 117, 190), reported, clip('after', 242, 326)];
assert.deepEqual(
  constrainClipDrag({ clip: reported, clips: reportedClips, bodyFrames: 582, sourceFrames: 121, mode: 'end', deltaFrames: 100 }),
  { sourceInFrame: 73, sourceOutFrame: 121, timelineInFrame: 190, timelineOutFrame: 238 },
  '边缘拉伸必须同时受下一片段和源视频真实时长限制',
);

console.log('final-edit timeline edit tests passed');
