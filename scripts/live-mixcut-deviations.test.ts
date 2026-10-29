/**
 * 新规矩成片的审片偏差：人工改动要和排时间的原始结果比。
 * 只用编造的数据，不起数据库、不调媒体。
 */
import assert from 'node:assert/strict';
import { describeScheduleFormulaDeviations, scheduleClipSlotIds, type ScheduleDeviationSource } from '../lib/live-mixcut/formula/deviations.ts';
import type { FormulaSelection } from '../lib/live-mixcut/formula/selection.ts';

const slot = (slotId: string, clipId: number, logicalCode: string, assetId: string | null, contentFingerprint: string | null) => ({
  slotId, clipId, logicalCode, assetId, candidate: contentFingerprint === null ? null : { assetId, contentFingerprint },
  media: null, rangeStatus: 'confirmed', reason: 'exact_code',
});

const selection = {
  algorithmVersion: 'formula-selection/6', status: 'selected', executionReady: false,
  slots: [slot('slot-a', 0, 'S1', 'a', 'fp-a'), slot('slot-b', 1, 'S2', 'b', 'fp-b'),
    slot('slot-c', 2, 'VO1', 'v', 'fp-v')],
} as unknown as FormulaSelection;

const schedule: ScheduleDeviationSource = {
  plan: { items: [{ kind: 'shot', slotIndex: 0 }, { kind: 'shot', slotIndex: 1 }, { kind: 'vo', slotIndex: 2 },
    { kind: 'ending' }] },
  timeline: { clips: [
    { id: 'clip:0', kind: 'shot', assetId: 'a', contentFingerprint: 'fp-a', sourceInUs: 0, sourceOutUs: 1_000_000 },
    { id: 'clip:1', kind: 'shot', assetId: 'b', contentFingerprint: 'fp-b', sourceInUs: 0, sourceOutUs: 1_000_000 },
    { id: 'clip:2', kind: 'vo', slotIndex: 2, assetId: 'v', contentFingerprint: 'fp-v', sourceInUs: 0, sourceOutUs: 1_000_000 },
    { id: 'clip:3', kind: 'filler', assetId: 'x', contentFingerprint: 'fp-x', sourceInUs: 0, sourceOutUs: 500_000 },
  ] },
};

type Clip = { clipId: string; segmentId: string; assetId: string; contentFingerprint: string;
  timelineStartUs: number; timelineEndUs: number; sourceStartUs: number; sourceEndUs: number };
const clip = (clipId: string, segmentId: string, assetId: string, contentFingerprint: string,
  timelineStartUs: number, sourceStartUs = 0, sourceEndUs = 1_000_000): Clip =>
  ({ clipId, segmentId, assetId, contentFingerprint, timelineStartUs, timelineEndUs: timelineStartUs + (sourceEndUs - sourceStartUs),
    sourceStartUs, sourceEndUs });

// 成片版本按排时间物化：口播的 segmentId 是槽位，非口播是排时间片段 id。
const unchanged: Clip[] = [
  clip('clip:0', 'clip:0', 'a', 'fp-a', 0),
  clip('clip:1', 'clip:1', 'b', 'fp-b', 1_000_000),
  clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000),
  clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000),
];

const none = describeScheduleFormulaDeviations(selection, schedule, unchanged);
assert.deepEqual({ replaced: none.replacedClips.length, inserted: none.insertedClips.length,
  deleted: none.deletedSlots.length, ranges: none.sourceRangeChanges.length, reordered: none.reordered },
  { replaced: 0, inserted: 0, deleted: 0, ranges: 0, reordered: false }, '没人工改动就什么问题都不报');
assert.deepEqual(none.originalOrder, ['slot-a', 'slot-b', 'slot-c']);

// 1. 非口播镜头换素材：要报人工换片。
{
  const changes = describeScheduleFormulaDeviations(selection, schedule,
    [clip('clip:0', 'clip:0', 'a', 'fp-a', 0), clip('clip:1', 'clip:1', 'z', 'fp-z', 1_000_000),
      clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000), clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000)]);
  assert.equal(changes.replacedClips.length, 1, '非口播镜头换了素材必须报出来');
  assert.equal(changes.replacedClips[0].slotId, 'slot-b');
  assert.equal(changes.replacedClips[0].originalCode, 'S2');
}

// 2. 非口播镜头裁切取用区间：要报人工裁切。
{
  const changes = describeScheduleFormulaDeviations(selection, schedule,
    [clip('clip:0', 'clip:0', 'a', 'fp-a', 0, 200_000, 1_000_000), clip('clip:1', 'clip:1', 'b', 'fp-b', 1_000_000),
      clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000), clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000)]);
  assert.equal(changes.sourceRangeChanges.length, 1);
  assert.equal(changes.sourceRangeChanges[0].slotId, 'slot-a');
  assert.deepEqual(changes.sourceRangeChanges[0].actualRanges, [{ sourceInUs: 200_000, sourceOutUs: 1_000_000 }]);
}

// 3. 非口播镜头被删：要报人工删除。
{
  const changes = describeScheduleFormulaDeviations(selection, schedule,
    [clip('clip:0', 'clip:0', 'a', 'fp-a', 0), clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000),
      clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000)]);
  assert.deepEqual(changes.deletedSlots.map(item => item.slotId), ['slot-b']);
}

// 4. 非口播镜头换序：要报人工换序。
{
  const changes = describeScheduleFormulaDeviations(selection, schedule,
    [clip('clip:1', 'clip:1', 'b', 'fp-b', 0), clip('clip:0', 'clip:0', 'a', 'fp-a', 1_000_000),
      clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000), clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000)]);
  assert.equal(changes.reordered, true);
}

// 5. 人工插入：要报人工插入；排时间自己的补镜不算。
{
  const changes = describeScheduleFormulaDeviations(selection, schedule,
    [...unchanged, clip('manual:1', '', 'm', 'fp-m', 4_000_000, 0, 500_000)]);
  assert.equal(changes.insertedClips.length, 1);
  assert.equal(changes.insertedClips[0].clipId, 'manual:1');
}

// 6. 同一编号轮换来另一份文件：不是人工改动。
{
  const rotated: ScheduleDeviationSource = { ...schedule, timeline: { clips: schedule.timeline.clips.map(item =>
    item.id === 'clip:0' ? { ...item, assetId: 'a2', contentFingerprint: 'fp-a2' } : item) } };
  const changes = describeScheduleFormulaDeviations(selection, rotated,
    [clip('clip:0', 'clip:0', 'a2', 'fp-a2', 0), clip('clip:1', 'clip:1', 'b', 'fp-b', 1_000_000),
      clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000), clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000)]);
  assert.equal(changes.replacedClips.length, 0, '排时间实际用的那份就是基线');
}

// 7. 缺号由替代镜头顶上（选片没有候选文件）：不是人工改动。
{
  const missing = { ...selection, slots: [selection.slots[0], slot('slot-b', 1, 'S2', null, null), selection.slots[2]] } as FormulaSelection;
  const substituted: ScheduleDeviationSource = { ...schedule, timeline: { clips: schedule.timeline.clips.map(item =>
    item.id === 'clip:1' ? { ...item, assetId: 'b2', contentFingerprint: 'fp-b2' } : item) } };
  const changes = describeScheduleFormulaDeviations(missing, substituted,
    [clip('clip:0', 'clip:0', 'a', 'fp-a', 0), clip('clip:1', 'clip:1', 'b2', 'fp-b2', 1_000_000),
      clip('clip:2', 'slot-c', 'v', 'fp-v', 2_000_000), clip('clip:3', 'clip:3', 'x', 'fp-x', 3_000_000, 0, 500_000)]);
  assert.equal(changes.replacedClips.length, 0, '替代镜头是算法决定的，不是人工换片');
  assert.equal(changes.insertedClips.length, 0);
}

// 8. 公式里有被丢掉的镜头：按顺序配槽位时不能错位。
{
  const dropped: ScheduleDeviationSource = {
    plan: { items: [{ kind: 'shot', slotIndex: 0 }, { kind: 'shot', slotIndex: 1, dropped: true }, { kind: 'vo', slotIndex: 2 }] },
    timeline: { clips: [schedule.timeline.clips[0], schedule.timeline.clips[2]] },
  };
  const ids = scheduleClipSlotIds(selection, dropped);
  assert.equal(ids.get('clip:0'), 'slot-a');
  assert.equal(ids.get('clip:2'), 'slot-c');
  assert.equal(ids.size, 2, '被丢掉的镜头不占位');
}

console.log('live-mixcut deviations tests passed');
