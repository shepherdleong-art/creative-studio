import assert from 'node:assert/strict';
import {
  MATERIAL_DROP_MAX_US,
  MATERIAL_DROP_MIN_US,
  materialDragCount,
  materialDropInGap,
  materialInsertAnchor,
  materialInsertDurationUs,
} from '../components/live-mixcut/review/material-drop.ts';

// 空白间隙落点:片段内部不接、末尾追加、按 24fps 取整。
assert.deepEqual(materialDropInGap([], 0, 60), { type: 'append', afterClipId: null, timelineStartUs: 0 });
assert.equal(materialDropInGap([{ clipId: 'c', timelineStartUs: 0, timelineEndUs: 2_000_000 }], 60, 60), null);
assert.equal(materialDropInGap([], 61, 60)?.timelineStartUs, 1_000_000);

const clips = [
  { clipId: 'a', timelineStartUs: 0, timelineEndUs: 1_000_000 },
  { clipId: 'b', timelineStartUs: 1_500_000, timelineEndUs: 2_500_000 },
];

// 单条拖到片段上 = 替换;多条落到片段上时改用该片段前的插入锚点。
assert.deepEqual(materialInsertAnchor(clips, { planId: 'p', type: 'replace', clipId: 'b' }),
  { afterClipId: 'a', timelineStartUs: 1_500_000 });
assert.deepEqual(materialInsertAnchor(clips, { planId: 'p', type: 'insert', afterClipId: 'a', timelineStartUs: 1_200_000 }),
  { afterClipId: 'a', timelineStartUs: 1_200_000 });
assert.deepEqual(materialInsertAnchor(clips, { planId: 'p', type: 'append' }),
  { afterClipId: 'b', timelineStartUs: undefined });
assert.deepEqual(materialInsertAnchor(clips, { planId: 'p', type: 'append', afterClipId: 'b', timelineStartUs: 3_000_000 }),
  { afterClipId: 'b', timelineStartUs: 3_000_000 });
assert.equal(materialInsertAnchor(clips, { planId: 'p', type: 'replace', clipId: 'missing' }), null);

// 拖拽条数:悬停阶段只能从自定义 MIME 类型名读取。
assert.equal(materialDragCount([]), 1);
assert.equal(materialDragCount(['application/json']), 1);
assert.equal(materialDragCount(['application/json', 'application/x-live-mixcut-count-3']), 3);
assert.equal(materialDragCount(['application/x-live-mixcut-count-999']), 50);
assert.equal(materialDragCount(['application/x-live-mixcut-count-0']), 1);

// 插入时长:默认 3 秒、不超过素材本身、按 24fps 对齐。
assert.equal(materialInsertDurationUs(10), MATERIAL_DROP_MAX_US);
assert.equal(materialInsertDurationUs(null), MATERIAL_DROP_MAX_US);
const onePointTwo = materialInsertDurationUs(1.2);
assert.equal(Math.round(onePointTwo * 24 / 1_000_000), 28, '1.2 秒向下取整到 28 帧');
assert.equal(Math.round(Math.round(onePointTwo * 24 / 1_000_000) * 1_000_000 / 24), onePointTwo, '结果落在 24fps 帧边界');
assert.ok(onePointTwo <= 1_200_000 && onePointTwo > 1_100_000);
assert.ok(materialInsertDurationUs(0.6) >= MATERIAL_DROP_MIN_US);
assert.ok(materialInsertDurationUs(0.3) < MATERIAL_DROP_MIN_US, '不足 0.5 秒由调用方拒绝');

console.log('live-mixcut material drop: gap anchor, multi-drag count, duration alignment passed');
