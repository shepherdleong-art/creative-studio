import assert from 'node:assert/strict';
import {
  filterMentionCandidates,
  findActiveMentionQuery,
  replaceMentionWithLabel,
} from '../lib/creative-canvas/mention-completion.ts';

// findActiveMentionQuery
assert.deepEqual(findActiveMentionQuery('@', 1), { start: 0, query: '' });
assert.deepEqual(findActiveMentionQuery('hello @产品', 9), { start: 6, query: '产品' });
assert.deepEqual(findActiveMentionQuery('前文 @ku1 后文', 7), { start: 3, query: 'ku1' });
// 光标不在 token 内（在 token 之后）
assert.equal(findActiveMentionQuery('@产品 后文', 5), null);
// 查询段含空白 → token 已结束
assert.equal(findActiveMentionQuery('@产 品', 4), null);
// `@` 前不是空白/行首（邮箱等）不触发
assert.equal(findActiveMentionQuery('a@b', 3), null);
assert.equal(findActiveMentionQuery('a@', 2), null);
// 没有 @
assert.equal(findActiveMentionQuery('没有符号', 4), null);
// 光标越界
assert.equal(findActiveMentionQuery('@', 5), null);
// 换行后重新计 token
assert.deepEqual(findActiveMentionQuery('第一行\n@图', 6), { start: 4, query: '图' });

// filterMentionCandidates
const candidates = [
  { nodeId: 'n1', title: '产品主图', label: 1 },
  { nodeId: 'n2', title: 'PK26A', label: null },
  { nodeId: 'n3', title: 'Room Video', label: 3 },
];
assert.deepEqual(
  filterMentionCandidates(candidates, '').map((c) => c.nodeId),
  ['n1', 'n2', 'n3'],
);
assert.deepEqual(filterMentionCandidates(candidates, '产品').map((c) => c.nodeId), ['n1']);
assert.deepEqual(filterMentionCandidates(candidates, 'pk26').map((c) => c.nodeId), ['n2']);
assert.deepEqual(filterMentionCandidates(candidates, 'ROOM').map((c) => c.nodeId), ['n3']);
// 按已连接的 参考N 匹配
assert.deepEqual(filterMentionCandidates(candidates, '参考3').map((c) => c.nodeId), ['n3']);
assert.deepEqual(filterMentionCandidates(candidates, '不存在'), []);

// replaceMentionWithLabel
assert.deepEqual(replaceMentionWithLabel('自拍 @产', 3, 5, 2), {
  text: '自拍 @参考2 ',
  caret: 8,
});
assert.deepEqual(replaceMentionWithLabel('@', 0, 1, 12), {
  text: '@参考12 ',
  caret: 6,
});
// 保留光标后的原文
assert.deepEqual(replaceMentionWithLabel('@产 在房间', 0, 2, 1), {
  text: '@参考1  在房间',
  caret: 5,
});

console.log('canvas-mention-completion.test.ts: all assertions passed');
