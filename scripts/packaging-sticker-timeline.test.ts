// 运行：node scripts/packaging-sticker-timeline.test.ts
import assert from 'node:assert/strict';
import {
  insertPackagingStickerAtTop,
  layoutPackagingStickerTracks,
  movePackagingStickerToTrack,
  normalizePackagingStickerTracks,
  planPackagingStickerFrames,
} from '../lib/media-core/packaging-sticker-timeline.ts';
import type { PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';

function sticker(id: string, overrides: Partial<PackagingStickerInstance> = {}): PackagingStickerInstance {
  return {
    id, assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null,
    startFrame: 20, endFrame: 68, centerXPct: 50, centerYPct: 50, visualWidthPct: 30,
    rotationDeg: 0, trackIndex: 0, animation: 'none', origin: { kind: 'manual' }, ...overrides,
  };
}

const first = sticker('first');
const second = sticker('second');
const layered = layoutPackagingStickerTracks([first, second]);
assert.equal(layered[0].id, 'second', '旧同轨重叠数据应由后添加者位于上层');
assert.equal(layered[0].trackIndex, 0);
assert.equal(layered[1].trackIndex, 1);
const shared = layoutPackagingStickerTracks([first, sticker('later', { startFrame: 68, endFrame: 116 })]);
assert.deepEqual(shared.map((item) => item.trackIndex), [0, 0], '时间不重叠时允许共享显示行');
const inserted = insertPackagingStickerAtTop([first, second], sticker('new', { startFrame: 30, endFrame: 78 }));
assert.equal(inserted[0].id, 'new');
assert.equal(inserted[0].trackIndex, 0);
assert.ok(inserted.slice(1).every((item) => item.trackIndex > 0), '新贴纸插入后必须位于最上方轨道');
const normalized = normalizePackagingStickerTracks([first, second]);
assert.deepEqual(normalized.map((item) => item.trackIndex), [1, 0], '归一化保持原数组顺序，只重写轨道值');
const raised = movePackagingStickerToTrack([first, second], 'first', 0);
assert.equal(raised.find((item) => item.id === 'first')?.trackIndex, 0, '向上换轨后目标实例位于最上层');
assert.equal(raised.find((item) => item.id === 'second')?.trackIndex, 1);
assert.deepEqual(
  raised.map(({ id, startFrame, endFrame }) => ({ id, startFrame, endFrame })),
  [first, second].map(({ id, startFrame, endFrame }) => ({ id, startFrame, endFrame })),
  '换轨不得改变数组顺序或起止帧',
);
const lowered = movePackagingStickerToTrack(raised, 'first', 1);
assert.equal(lowered.find((item) => item.id === 'first')?.trackIndex, 1, '向下换轨必须恢复原有层级');
assert.equal(lowered.find((item) => item.id === 'second')?.trackIndex, 0);

assert.deepEqual(planPackagingStickerFrames(first, { mode: 'move', deltaFrames: -50, bodyEndFrame: 260 }), { startFrame: 20, endFrame: 68, snapSec: null });
assert.deepEqual(planPackagingStickerFrames(first, { mode: 'move', deltaFrames: 500, bodyEndFrame: 260 }), { startFrame: 212, endFrame: 260, snapSec: null });
assert.deepEqual(planPackagingStickerFrames(first, { mode: 'start', deltaFrames: 100, bodyEndFrame: 260 }), { startFrame: 49, endFrame: 68, snapSec: null });
assert.deepEqual(planPackagingStickerFrames(first, { mode: 'end', deltaFrames: -100, bodyEndFrame: 260 }), { startFrame: 20, endFrame: 39, snapSec: null });
assert.deepEqual(planPackagingStickerFrames(first, { mode: 'end', deltaFrames: 500, bodyEndFrame: 260 }), { startFrame: 20, endFrame: 260, snapSec: null });
assert.deepEqual(planPackagingStickerFrames(first, { mode: 'move', deltaFrames: 0, bodyEndFrame: 260, candidates: [21 / 24], pxPerSecond: 120, snapEnabled: true }), { startFrame: 21, endFrame: 69, snapSec: 21 / 24 });
assert.deepEqual(planPackagingStickerFrames(first, { mode: 'move', deltaFrames: 0, bodyEndFrame: 260, candidates: [21 / 24], pxPerSecond: 120, snapEnabled: false }), { startFrame: 20, endFrame: 68, snapSec: null });

console.log('贴纸时间轴纯逻辑测试通过：轨道归一化、共享行、整帧边界与磁吸。');
