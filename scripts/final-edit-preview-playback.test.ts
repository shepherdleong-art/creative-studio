import assert from 'node:assert/strict';
import { expectedVideoTimeSec, getVideoSlotPlan, paintDecodedVideoFrame } from '../components/final-edit/preview-playback.ts';

assert.deepEqual(
  getVideoSlotPlan(-1, 4),
  { activeSlot: null, clipIndexes: [0, 1] },
  '封面播放期间必须把首片段预载到它真正使用的 A 槽',
);
assert.deepEqual(getVideoSlotPlan(0, 4), { activeSlot: 0, clipIndexes: [0, 1] });
assert.deepEqual(getVideoSlotPlan(1, 4), { activeSlot: 1, clipIndexes: [2, 1] });
assert.deepEqual(getVideoSlotPlan(2, 4), { activeSlot: 0, clipIndexes: [2, 3] });
assert.deepEqual(getVideoSlotPlan(3, 4), { activeSlot: 1, clipIndexes: [null, 3] });
assert.equal(expectedVideoTimeSec(48, 24, 36, 24), 2.5);

const paintCalls: string[] = [];
const context = {
  clearRect: () => paintCalls.push('clear'),
  drawImage: () => paintCalls.push('draw'),
  save: () => paintCalls.push('save'),
  restore: () => paintCalls.push('restore'),
  fillRect: () => paintCalls.push('fill'),
  set filter(_value: string) {},
  set fillStyle(_value: string) {},
} as unknown as CanvasRenderingContext2D;
const canvas = { width: 1080, height: 1440 } as HTMLCanvasElement;
const seekingVideo = { readyState: 4, seeking: true, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
assert.equal(
  paintDecodedVideoFrame(context, canvas, seekingVideo, '3x4', { scale: 1, offsetX: 0, offsetY: 0 }),
  false,
  '切片 seek 尚未完成时不能替换屏幕上的上一有效帧',
);
assert.equal(paintCalls.length, 0, '下一帧尚未解码时不能先清空画布，否则边界会闪黑');

const decodedVideo = { ...seekingVideo, seeking: false } as HTMLVideoElement;
assert.equal(paintDecodedVideoFrame(context, canvas, decodedVideo, '3x4', { scale: 1, offsetX: 0, offsetY: 0 }), true);
assert.ok(paintCalls.includes('clear'));
assert.ok(paintCalls.includes('draw'));

console.log('final-edit preview playback tests passed');
