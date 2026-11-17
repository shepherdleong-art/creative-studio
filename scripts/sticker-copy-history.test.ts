import assert from 'node:assert/strict';
import { advanceStickerCopyHistory, type StickerCopyHistoryEntry } from '../components/batch-production/review/sticker-copy-history.ts';

const snapshot = { stickers: [], stickerDefaults: { animation: 'soft' as const } };
const entry: StickerCopyHistoryEntry = { kind: 'sticker-copy', targets: ['one', 'two'].map((planId) => ({
  planId, outputVersionId: `${planId}-v1`, currentEditRevision: 1, before: snapshot, after: snapshot,
})) };
let stack = [entry];
for (const [before, after] of [[1, 2], [2, 3], [3, 4]]) {
  stack = advanceStickerCopyHistory(stack, [{ planId: 'one', outputVersionId: 'one-v1', beforeEditRevision: before, afterEditRevision: after }]) as StickerCopyHistoryEntry[];
}
assert.deepEqual(stack[0].targets.map((target) => target.currentEditRevision), [4, 1], '本地编辑与撤销继续推进先前整批历史的目标修订');
assert.equal(entry.targets[0].currentEditRevision, 1, '不原地改动已捕获历史');
for (const change of [
  { planId: 'one', outputVersionId: 'one-v2', beforeEditRevision: 4, afterEditRevision: 5 },
  { planId: 'one', outputVersionId: 'one-v1', beforeEditRevision: 5, afterEditRevision: 6 },
  { planId: 'one', outputVersionId: 'one-v1', beforeEditRevision: 4, afterEditRevision: 6 },
]) assert.deepEqual(advanceStickerCopyHistory(stack, [change]), stack, '换版本、外部编辑或跨修订都不能升级旧历史');
assert.deepEqual(stack[0].targets.map((target) => target.before), [snapshot, snapshot]);
console.log('贴纸历史修订通过：连续本地编辑/撤销推进，版本变化与外部修订保留冲突保护。');
