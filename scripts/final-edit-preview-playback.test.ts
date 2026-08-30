import assert from 'node:assert/strict';
import { bgmGainAtTime, expectedVideoTimeSec, getVideoSlotPlan, narrationGainAtTime, paintDecodedVideoFrame, previewAudioLevelsAtTime, shouldIssueSeek } from '../components/final-edit/preview-playback.ts';

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
assert.equal(bgmGainAtTime({ bodyTimeSec: 0, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }), 0);
assert.ok(Math.abs(bgmGainAtTime({ bodyTimeSec: 1, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }) - 0.2505936168) < 1e-8);
assert.ok(Math.abs(bgmGainAtTime({ bodyTimeSec: 5, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }) - 0.5011872336) < 1e-8);
assert.ok(Math.abs(bgmGainAtTime({ bodyTimeSec: 8.5, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }) - 0.2505936168) < 1e-8);
assert.ok(
  Math.abs(bgmGainAtTime({ bodyTimeSec: 5, bodyDurationSec: 10, gainDb: 0, fadeInSec: 10, fadeOutSec: 10 }) - 0.25) < 1e-8,
  '重叠淡入淡出必须与 FFmpeg 串联 afade 的乘法增益一致',
);
assert.equal(bgmGainAtTime({ bodyTimeSec: 10, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }), 0, '时间轴结束时 BGM 必须静音');
assert.equal(narrationGainAtTime({ bodyTimeSec: -0.1, bodyDurationSec: 10, gainDb: -16 }), 0, '片头阶段口播必须静音');
assert.ok(
  Math.abs(narrationGainAtTime({ bodyTimeSec: 5, bodyDurationSec: 10, gainDb: -16 }) - 0.15848931924611143) < 1e-8,
  '口播 dB 增益必须换算成与最终渲染一致的线性增益',
);
assert.equal(narrationGainAtTime({ bodyTimeSec: 10, bodyDurationSec: 10, gainDb: -16 }), 0, '正文结束时口播必须静音');
assert.deepEqual(
  previewAudioLevelsAtTime({ playheadSec: 0.5, introSec: 1, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }),
  { narrationGain: 0, bgmGain: 0 },
  '封面阶段不能提前播放口播或 BGM',
);
assert.deepEqual(
  previewAudioLevelsAtTime({ playheadSec: 2, introSec: 1, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }),
  { narrationGain: 1, bgmGain: 0.2505936168136361 },
  '正文阶段口播使用默认 0dB 增益，BGM 使用同一播放头执行淡入',
);
assert.deepEqual(
  previewAudioLevelsAtTime({ playheadSec: 2, introSec: 1, bodyDurationSec: 10, narrationGainDb: -16, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }),
  { narrationGain: 0.15848931924611132, bgmGain: 0.2505936168136361 },
  '口播音量预览必须使用保存的 dB 增益，而不是固定满音量',
);
assert.deepEqual(
  previewAudioLevelsAtTime({ playheadSec: 11, introSec: 1, bodyDurationSec: 10, gainDb: -6, fadeInSec: 2, fadeOutSec: 3 }),
  { narrationGain: 0, bgmGain: 0 },
  '时间轴末尾必须同时静音口播与 BGM',
);

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

assert.equal(
  shouldIssueSeek({ seeking: true, currentTime: 1 }, 2, 1 / 24),
  false,
  'seek 在途时不得再写 currentTime,否则 seeked 永远不会触发',
);
assert.equal(
  shouldIssueSeek({ seeking: false, currentTime: 2 }, 2 + 0.5 / 24, 1 / 24),
  false,
  '目标与当前时间差在一帧容差内时无需 seek',
);
assert.equal(
  shouldIssueSeek({ seeking: false, currentTime: 2 }, 2.5, 1 / 24),
  true,
  '空闲且容差外必须真的写 currentTime',
);

console.log('final-edit preview playback tests passed');
