import assert from 'node:assert/strict';
import { buildVideoUsage } from '../components/batch-production/review/video-usage.ts';

const clip = (clipId: string, assetId: string, sourceStartUs: number, sourceEndUs: number) => (
  { clipId, assetId, sourceStartUs, sourceEndUs }
);
const splitFilm = { planId: 'one', arrangement: { clips: [clip('a', 'video', 0, 2), clip('b', 'video', 2, 5)] } };
const split = buildVideoUsage([splitFilm]);
assert.equal(split.repeatedClipCount, 2, '同一视频拆成相邻两段也应提示素材复用');
assert.equal(split.overlapClipCount, 0, '相邻分割没有真正的源区间重叠');
assert.equal(split.byPlan.get('one')?.get('a')?.usesInFilm, 2);

const withinFilm = buildVideoUsage([{ planId: 'one', arrangement: { clips: [
  clip('a', 'video', 0, 3), clip('b', 'video', 2, 5), clip('other', 'other-video', 0, 3),
] } }]);
assert.equal(withinFilm.overlapClipCount, 2, '同一条成片内部也检查源区间交叠');
assert.equal(withinFilm.byPlan.get('one')?.get('other')?.hasOverlap, false, '不同视频同时间不误报');

const hiddenFilm = { planId: 'hidden', visible: false, arrangement: { clips: [
  clip('a', 'video', 1, 4),
] } };
const across = buildVideoUsage([splitFilm, hiddenFilm]);
assert.equal(across.repeatedClipCount, 3, '隐藏的成片也参加统计');
assert.equal(across.overlapClipCount, 3);
assert.equal(across.byPlan.get('one')?.get('a')?.filmCount, 2);
assert.equal(across.byPlan.get('hidden')?.get('a')?.usesInFilm, 1, '不同成片相同 clipId 不串状态');

const removed = buildVideoUsage([{ planId: 'one', arrangement: { clips: [clip('a', 'video', 0, 2)] } }]);
assert.equal(removed.repeatedClipCount, 0, '删除后复用标记清除');
assert.equal(removed.overlapClipCount, 0);
const replaced = buildVideoUsage([{ planId: 'one', arrangement: { clips: [clip('a', 'video', 0, 2), clip('b', 'new-video', 0, 2)] } }]);
assert.equal(replaced.repeatedClipCount, 0, '替换后重新计算素材身份');
assert.equal(buildVideoUsage([splitFilm]).repeatedClipCount, 2, '撤销恢复片段后标记恢复');
console.log('batch review video usage tests passed');

const sourceFilm = {
  planId: 'source', visible: false,
  sourceConflictAssetIds: ['v1', 'v2'],
  arrangement: { clips: [clip('a', 'v1', 0, 2), clip('b', 'v2', 0, 2), clip('c', 'unrelated', 0, 2)] },
};
const source = buildVideoUsage([sourceFilm, { planId: 'other', arrangement: { clips: [clip('a', 'v1', 2, 4)] } }]);
assert.equal(source.sourceConflictClipCount, 2, '隐藏行参与同源统计');
assert.equal(source.sourceConflictFilmCount, 1);
assert.equal(source.byPlan.get('source')?.get('b')?.hasSourceConflict, true);
assert.equal(source.byPlan.get('source')?.get('c')?.hasSourceConflict, false);
assert.equal(source.byPlan.get('other')?.get('a')?.hasSourceConflict, false, '跨成片使用不能传播同源告警');
const clearedSource = buildVideoUsage([{ ...sourceFilm, arrangement: { ...sourceFilm.arrangement, sourceConflictAssetIds: [] } }]);
assert.equal(clearedSource.sourceConflictClipCount, 0, '局部编辑后的空结果优先于旧卡片告警');
assert.equal(buildVideoUsage([sourceFilm]).sourceConflictClipCount, 2, '撤销恢复同源告警');
console.log('batch review source highlighting tests passed');

const groupedFilms = [
  { planId: 'one', arrangement: { clips: [clip('a', 'video-a', 0, 2), clip('b', 'video-b', 0, 2)] } },
  { planId: 'two', visible: false, arrangement: { clips: [clip('b2', 'video-b', 3, 5), clip('a2', 'video-a', 3, 5)] } },
];
const grouped = buildVideoUsage(groupedFilms);
const aGroup = grouped.byPlan.get('one')!.get('a')!.repeatGroup!;
const bGroup = grouped.byPlan.get('one')!.get('b')!.repeatGroup!;
assert.deepEqual(aGroup, grouped.byPlan.get('two')!.get('a2')!.repeatGroup, '跨片同素材同色同编号');
assert.notEqual(aGroup.colorIndex, bGroup.colorIndex, '不同素材分配不同色块');
assert.notEqual(aGroup.label, bGroup.label);
assert.deepEqual(buildVideoUsage([...groupedFilms].reverse()).repeatGroups, grouped.repeatGroups, '行顺序不改变颜色编号');
const many = buildVideoUsage([{ planId: 'many', arrangement: { clips: Array.from({ length: 28 }, (_, i) => [
  clip(`${i}-a`, `v${String(i).padStart(2, '0')}`, 0, 2), clip(`${i}-b`, `v${String(i).padStart(2, '0')}`, 2, 4),
]).flat() } }]);
assert.equal(new Set([...many.repeatGroups.values()].map(g => g.label)).size, 28, '超出色盘时仍有唯一编号');
assert.equal(many.repeatGroups.get('v26')!.label, 'AA');

const sourceGroupsFilm = { planId: 'sources', arrangement: {
  clips: ['v1', 'v2', 'v3', 'v4'].map(id => clip(id, id, 0, 2)),
  sourceConflictGroups: [{ key: 'image:project:a', assetIds: ['v1', 'v2'] }, { key: 'image:project:b', assetIds: ['v3', 'v4'] }],
} };
const sources = buildVideoUsage([sourceGroupsFilm]);
const sourceUsage = sources.byPlan.get('sources')!;
assert.deepEqual(sourceUsage.get('v1')!.sourceGroup, sourceUsage.get('v2')!.sourceGroup);
assert.notEqual(sourceUsage.get('v1')!.sourceGroup!.colorIndex, sourceUsage.get('v3')!.sourceGroup!.colorIndex, '两组同源素材不混成一组');
assert.equal(sourceUsage.get('v1')!.repeatGroup, undefined, '同源视频不合并素材身份');
assert.equal(sourceUsage.get('v1')!.sourceGroup!.label, 'S1');
assert.equal(buildVideoUsage([{ ...sourceGroupsFilm, arrangement: { ...sourceGroupsFilm.arrangement, sourceConflictGroups: [] } }]).sourceConflictClipCount, 0);
console.log('repeat and source group color identity tests passed');
