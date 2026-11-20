import assert from 'node:assert/strict';
import { appendEdge, parseCanvasGraph, planCanvasCopy, reconcileCanvasGraph, removeEdge, removeNode, resolveCanvasMentions } from '../lib/creative-canvas/graph.ts';
import type { CanvasGenerationNode, CanvasGraph } from '../lib/creative-canvas/types.ts';

const initial: CanvasGraph = {
  schemaVersion: 1,
  nodes: [
    ...['a', 'b', 'c'].map((id) => ({
      id, kind: 'material' as const, position: { x: 0, y: 0 },
      data: { title: id, assetId: null, mediaKind: 'image' as const },
    })),
    {
      id: 'video', kind: 'video-generation', position: { x: 400, y: 0 },
      data: { title: '视频', modelKey: null, generationMode: 'reference-to-video',
        prompt: '', parameters: {}, references: [], referenceLabelCounter: 0 },
    },
  ],
  edges: [],
};
const video = (graph: CanvasGraph) => graph.nodes.find((node) => node.id === 'video') as CanvasGenerationNode;
const connect = (graph: CanvasGraph, source: string) => appendEdge(graph, { id: source, source, target: 'video' });

// 清空参考后连接新素材，应从 1 开始。
{
  const graph = connect(removeEdge(connect(initial, 'a'), 'a'), 'b');
  assert.deepEqual(video(graph).data.references.map((slot) => slot.label), [1], '断开后新参考应从 1 开始');
}

// 删除首个来源后剩余参考连续编号，再接新素材也不留空号。
{
  let graph = connect(connect(initial, 'a'), 'b');
  graph = removeNode(graph, 'a');
  graph = connect(graph, 'c');
  assert.deepEqual(video(graph).data.references.map((slot) => slot.label), [1, 2]);
}

// 重新编号必须跟随素材身份改写文本，被删除的引用不能被新图片接管。
{
  let graph = connect(connect(connect(initial, 'a'), 'b'), 'c');
  video(graph).data.prompt = '保留 @参考2，参考 @参考3，删除 @参考1';
  graph = removeEdge(graph, 'a');
  assert.equal(video(graph).data.prompt, '保留 @参考1，参考 @参考2，删除 @失效参考1');
  assert.deepEqual(video(graph).data.references.map((slot) => [slot.sourceNodeId, slot.label]), [['b', 1], ['c', 2]]);
  assert.deepEqual(resolveCanvasMentions(graph, video(graph), video(graph).data.prompt).unknownLabels, [1]);
  graph = connect(graph, 'a');
  assert.match(video(graph).data.prompt, /@失效参考1/);
  assert.deepEqual(video(graph).data.references.map((slot) => slot.label), [1, 2, 3]);
  assert.equal(reconcileCanvasGraph(graph), graph, '重复对账应保持不变');
}

// 旧图中的 2/3/4 及历史游标也会在打开时恢复成连续编号。
{
  const graph = structuredClone(connect(connect(connect(initial, 'a'), 'b'), 'c'));
  video(graph).data.references.forEach((slot) => { slot.label += 1; });
  video(graph).data.referenceLabelCounter = 9;
  video(graph).data.prompt = '用 @参考2 与 @参考4';
  const restored = reconcileCanvasGraph(parseCanvasGraph(graph));
  assert.deepEqual(video(restored).data.references.map((slot) => slot.label), [1, 2, 3]);
  assert.equal(video(restored).data.prompt, '用 @参考1 与 @参考3');
}

// 提示词继承下游参考；序列化、复制和删除后仍保留素材对应关系。
{
  let graph = connect(connect(initial, 'a'), 'b');
  graph = { ...graph, nodes: [...graph.nodes, {
    id: 'prompt', kind: 'prompt', position: { x: 0, y: 200 }, data: { title: '提示词', text: '用 @参考1 与 @参考2' },
  }] };
  graph = appendEdge(graph, { id: 'prompt-video', source: 'prompt', target: 'video' });
  const prompt = graph.nodes.find((node) => node.kind === 'prompt')!;
  assert.equal(prompt.kind, 'prompt');
  if (prompt.kind !== 'prompt') throw new Error('missing prompt');
  assert.deepEqual(prompt.data.references?.map((slot) => [slot.sourceNodeId, slot.label]), [['a', 1], ['b', 2]]);
  assert.deepEqual(parseCanvasGraph(JSON.parse(JSON.stringify(graph))), graph);
  let sequence = 0;
  const copy = planCanvasCopy({ graph, nodeIds: ['a', 'b', 'prompt', 'video'], createId: () => `copy-${++sequence}` });
  const copiedPrompt = copy.nodes.find((node) => node.kind === 'prompt');
  assert.ok(copiedPrompt?.kind === 'prompt');
  assert.deepEqual(copiedPrompt.data.references?.map((slot) => slot.sourceNodeId), ['copy-1', 'copy-2']);
  graph = removeNode(graph, 'a');
  const updated = graph.nodes.find((node) => node.kind === 'prompt');
  assert.ok(updated?.kind === 'prompt');
  assert.equal(updated.data.text, '用 @失效参考1 与 @参考1');
}

// 旧提示词手写的编号按第一个下游的历史参考迁移，不能因补齐空号改指向。
{
  const graph = structuredClone(connect(connect(initial, 'a'), 'b'));
  video(graph).data.references.forEach((slot) => { slot.label += 1; });
  video(graph).data.referenceLabelCounter = 3;
  graph.nodes.push({ id: 'p', kind: 'prompt', position: { x: 0, y: 100 }, data: { title: '旧提示词', text: '用 @参考2' } });
  graph.edges.push({ id: 'p-video', source: 'p', target: 'video' });
  const restored = reconcileCanvasGraph(graph);
  const prompt = restored.nodes.find((node) => node.id === 'p');
  assert.ok(prompt?.kind === 'prompt');
  assert.equal(prompt.data.text, '用 @参考1');
  assert.equal(prompt.data.references?.find((slot) => slot.label === 1)?.sourceNodeId, 'a');
}

console.log('creative-canvas-reference-reconnect.test.ts: all assertions passed');
