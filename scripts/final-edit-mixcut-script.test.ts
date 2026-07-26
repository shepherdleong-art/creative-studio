import assert from 'node:assert/strict';
import {
  buildMixcutTaskScriptSnapshot,
  getScriptSyncState,
  normalizeNarrationText,
  splitNarrationSentences,
} from '../lib/final-edit/mixcut-script.ts';

assert.equal(normalizeNarrationText('  第一行  \r\n\r\n 第二   行 '), '第一行\n第二 行');
assert.equal(getScriptSyncState('第一句\n第二句', '第一句\r\n第二句'), 'synced');
assert.equal(getScriptSyncState('第一句', '第一句。'), 'modified');
assert.deepEqual(splitNarrationSentences('第一句。第二句！\nThird? Last'), ['第一句。', '第二句！', 'Third?', 'Last']);

const realShortMaterialNarration = '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。';
const realShortMaterialSegments = splitNarrationSentences(realShortMaterialNarration);
assert.equal(realShortMaterialSegments.length, 6, '真实 116 字口播必须稳定切成 5–8 个适合短素材的句段');
assert.deepEqual(realShortMaterialSegments, [
  '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，',
  '感受5芯软弹带来的极致解压。',
  '112度的人体工学靠背，精准承托疲惫的腰背，',
  '久坐不累，让阅读时光也变得格外轻盈。',
  '触手可及的是婴幼级半青皮，A类认证的细腻质感，',
  '给全家一份可以贴脸呼吸的安心。',
], '已实测 5.6 秒的“靠背 + 腰背 + 久坐”长段必须在第三个逗号前断开');
assert.ok(realShortMaterialSegments.every((segment) => {
  const contentLength = Array.from(segment.replace(/[\p{P}\p{S}\s]/gu, '')).length;
  return contentLength >= 10 && contentLength <= 25;
}), '逗号切分后必须合并过短子句，且单段不得继续接近原来的 38–40 字');

const source = {
  version: 2,
  title: '原始标题',
  targetDurationSec: 20,
  shotSetId: 'set-a',
  fullScript: '忽略这个回退字段',
  segments: [
    { id: 'source-1', shotId: 'shot-1', narration: '第一句。' },
    { id: 'source-2', shotId: 'shot-2', narration: '第二句！' },
  ],
};
const synced = buildMixcutTaskScriptSnapshot({
  sourceDraftId: 'draft-1', sourceScriptUpdatedAt: '2026-07-24T00:00:00.000Z',
  sourceScript: source, shotSetId: 'set-a', editedNarrationText: '第一句。\n第二句！',
});
assert.equal(synced.scriptSyncState, 'synced');
assert.deepEqual(synced.segments.map((segment) => [segment.id, segment.shotId]), [['source-1', 'shot-1'], ['source-2', 'shot-2']]);

const realSynced = buildMixcutTaskScriptSnapshot({
  sourceDraftId: 'draft-real',
  sourceScript: {
    version: 2,
    shotSetId: 'set-a',
    fullScript: realShortMaterialNarration,
    segments: [
      { id: 'real-1', shotId: 'shot-1', narration: '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。' },
      { id: 'real-2', shotId: 'shot-2', narration: '112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。' },
      { id: 'real-3', shotId: 'shot-3', narration: '触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。' },
    ],
  },
  shotSetId: 'set-a',
  editedNarrationText: '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。\n112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。\n触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。',
});
assert.equal(realSynced.segments.length, 6);
assert.deepEqual(realSynced.segments.map((segment) => segment.shotId), ['shot-1', 'shot-1', 'shot-2', 'shot-2', 'shot-3', 'shot-3'], '每个细分句段必须继承父分镜 shotId，不能按新数组下标错配');

const alreadyFineSource = {
  version: 2,
  shotSetId: 'set-a',
  segments: Array.from({ length: 7 }, (_, index) => ({ id: `fine-${index + 1}`, shotId: `fine-shot-${index + 1}`, narration: `第${index + 1}段已经足够短，保留这一段。` })),
};
const alreadyFine = buildMixcutTaskScriptSnapshot({
  sourceDraftId: 'draft-fine',
  sourceScript: alreadyFineSource,
  shotSetId: 'set-a',
  editedNarrationText: alreadyFineSource.segments.map((segment) => segment.narration).join('\n'),
});
assert.equal(alreadyFine.segments.length, 7, '模块 3 已有 5–8 段时不得再次按逗号翻倍切分');

const modified = buildMixcutTaskScriptSnapshot({
  sourceDraftId: 'draft-1', sourceScript: source, shotSetId: 'set-a',
  editedNarrationText: '改写第一句。新增一句！',
});
assert.equal(modified.scriptSyncState, 'modified');
assert.deepEqual(modified.segments.map((segment) => [segment.narration, segment.shotId]), [['改写第一句。', 'shot-1'], ['新增一句！', 'shot-2']]);

const manual = buildMixcutTaskScriptSnapshot({ shotSetId: 'set-a', editedNarrationText: '纯手工第一句。纯手工第二句。' });
assert.equal(manual.source, 'manual');
assert.equal(manual.sourceDraftId, null);
assert.equal(manual.scriptSyncState, 'modified');
assert.equal(manual.segments.length, 2);

console.log('final-edit mixcut script tests passed');
