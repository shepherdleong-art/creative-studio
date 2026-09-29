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
