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
