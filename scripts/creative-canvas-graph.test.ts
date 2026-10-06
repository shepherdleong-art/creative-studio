import assert from 'node:assert/strict';
import {
  CanvasGraphError,
  appendEdge,
  appendNode,
  checkCanvasConnection,
  detachedReferenceSlots,
  emptyCanvasGraph,
  findCycle,
  parseCanvasGraph,
  planCanvasCopy,
  reconcileCanvasGraph,
  removeEdge,
  removeNode,
  resolveCanvasMentions,
} from '../lib/creative-canvas/graph.ts';
import type {
  CanvasGraph,
  CanvasGenerationNode,
  CanvasGraphEdge,
  CanvasGraphNode,
} from '../lib/creative-canvas/types.ts';

function material(id: string, mediaKind: 'image' | 'video' | 'audio' = 'image', assetId: string | null = `a-${id}`): CanvasGraphNode {
  return { id, kind: 'material', position: { x: 0, y: 0 }, data: { title: id, assetId, mediaKind } };
}

function promptNode(id: string, text = '提示词'): CanvasGraphNode {
  return { id, kind: 'prompt', position: { x: 0, y: 100 }, data: { title: id, text } };
}

function imageNode(id: string, overrides: Partial<CanvasGenerationNode['data']> = {}): CanvasGraphNode {
  return {
    id,
    kind: 'image-generation',
    position: { x: 200, y: 0 },
    data: {
      title: id,
      modelKey: null,
      generationMode: 'image-to-image',
      prompt: '',
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
      ...overrides,
    },
  };
}

function videoNode(id: string, overrides: Partial<CanvasGenerationNode['data']> = {}): CanvasGraphNode {
  return {
    id,
    kind: 'video-generation',
    position: { x: 400, y: 0 },
    data: {
      title: id,
      modelKey: null,
      generationMode: 'image-to-video',
      prompt: '',
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
      ...overrides,
    },
  };
}

function edge(id: string, source: string, target: string): CanvasGraphEdge {
  return { id, source, target };
}

function graph(nodes: CanvasGraphNode[], edges: CanvasGraphEdge[] = []): CanvasGraph {
  return { schemaVersion: 1, nodes, edges };
}

function counterIds(prefix = 'new'): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function generationNode(graphValue: CanvasGraph, id: string): CanvasGenerationNode {
  const node = graphValue.nodes.find((candidate) => candidate.id === id);
  assert.ok(node && (node.kind === 'image-generation' || node.kind === 'video-generation'));
  return node;
}

// --- parseCanvasGraph -------------------------------------------------------

{
  const parsed = parseCanvasGraph(JSON.parse(JSON.stringify(graph([material('m1'), imageNode('g1')], [edge('e1', 'm1', 'g1')]))));
  assert.equal(parsed.nodes.length, 2);
  const reconciled = reconcileCanvasGraph(parsed);
  assert.equal(generationNode(reconciled, 'g1').data.references.length, 1);
  assert.equal(generationNode(reconciled, 'g1').data.references[0].label, 1);
  assert.equal(generationNode(reconciled, 'g1').data.references[0].sourceKind, 'asset');
  assert.equal(generationNode(reconciled, 'g1').data.references[0].role, 'subject');
  assert.equal(generationNode(reconciled, 'g1').data.referenceLabelCounter, 1);
}

{
  // 运行投影字段绝不能由客户端写入
  const bad = JSON.parse(JSON.stringify(graph([imageNode('g1')])));
  bad.nodes[0].data.currentAssetId = 'asset-1';
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'runtime_field_not_writable'
  ));
}

{
  const bad = JSON.parse(JSON.stringify(graph([imageNode('g1')])));
  bad.nodes[0].data.activeTaskId = 'task-1';
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'runtime_field_not_writable'
  ));
}

{
  const bad = JSON.parse(JSON.stringify(graph([material('m1')])));
  bad.nodes[0].data.nodeEpoch = 3;
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'runtime_field_not_writable'
  ));
}

{
  const bad = JSON.parse(JSON.stringify(graph([imageNode('g1')])));
  bad.nodes[0].data.somethingElse = true;
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'invalid_node'
  ));
}

{
  // 新增模式枚举（智能多帧／智能编辑／超长视频）可正常反序列化
  const parsed = parseCanvasGraph(graph([
    videoNode('v-frames', { generationMode: 'frames-to-video' }),
    videoNode('v-edit', { generationMode: 'video-edit' }),
    videoNode('v-extend', { generationMode: 'video-extend' }),
  ]));
  assert.equal(parsed.nodes.length, 3);
}

{
  const bad = JSON.parse(JSON.stringify(graph([videoNode('v1')])));
  bad.nodes[0].data.generationMode = 'hollywood-to-video';
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'invalid_node'
  ));
}

{
  const bad = graph([material('m1'), material('m1')]);
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'duplicate_node_id'
  ));
}

{
  const bad = graph([material('m1')], [edge('e1', 'm1', 'ghost')]);
  assert.throws(() => parseCanvasGraph(bad), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'unknown_node'
  ));
}

{
  // 循环依赖用同为视频类型的节点构造，避免先被端口兼容性拦下
  const cyclic = graph([material('src', 'video'), videoNode('v1'), videoNode('v2')], [
    edge('e1', 'src', 'v1'),
    edge('e2', 'v1', 'v2'),
    edge('e3', 'v2', 'v1'),
  ]);
  assert.throws(() => parseCanvasGraph(cyclic), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'cycle'
  ));
  assert.deepEqual(findCycle(cyclic)?.length, 3);
}

{
  // 端口不兼容的连接不能落库（即使客户端绕过拖拽校验直接提交）
  const incompatible = graph([material('v-src', 'video'), imageNode('g1')], [edge('e1', 'v-src', 'g1')]);
  assert.throws(() => parseCanvasGraph(incompatible), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'incompatible_connection'
  ));

  const toMaterial = graph([material('m1'), material('m2')], [edge('e1', 'm1', 'm2')]);
  assert.throws(() => parseCanvasGraph(toMaterial), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'target_not_generation'
  ));

  const duplicated = graph([material('m1'), imageNode('g1')], [
    edge('e1', 'm1', 'g1'),
    edge('e2', 'm1', 'g1'),
  ]);
  assert.throws(() => parseCanvasGraph(duplicated), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'duplicate_connection'
  ));
}

{
  // 自环在解析阶段就被单独识别为 self_loop，而不是笼统的 cycle
  const selfLoop = graph([material('m1'), imageNode('g1')], [edge('e1', 'g1', 'g1')]);
  assert.throws(() => parseCanvasGraph(selfLoop), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'self_loop'
  ));
}

// --- 连接合法性 -------------------------------------------------------------

{
  const base = graph([material('m1'), material('v-src', 'video'), promptNode('p1'), imageNode('g1'), videoNode('v1')]);
  assert.equal(checkCanvasConnection(base, edge('e1', 'p1', 'g1')).ok, true);
  assert.equal(checkCanvasConnection(base, edge('e2', 'm1', 'g1')).ok, true);
  assert.equal(checkCanvasConnection(base, edge('e3', 'm1', 'v1')).ok, true);
  assert.equal(checkCanvasConnection(base, edge('e4', 'v-src', 'v1')).ok, true);
  assert.equal(checkCanvasConnection(base, edge('e5', 'g1', 'v1')).ok, true);

  const videoToImage = checkCanvasConnection(base, edge('e6', 'v-src', 'g1'));
  assert.equal(videoToImage.ok, false);
  assert.equal(videoToImage.ok === false && videoToImage.code, 'incompatible_connection');

  const materialToMaterial = checkCanvasConnection(base, edge('e7', 'm1', 'v-src'));
  assert.equal(materialToMaterial.ok, false);
  assert.equal(materialToMaterial.ok === false && materialToMaterial.code, 'target_not_generation');

  const selfLoop = checkCanvasConnection(base, edge('e8', 'g1', 'g1'));
  assert.equal(selfLoop.ok, false);
  assert.equal(selfLoop.ok === false && selfLoop.code, 'self_loop');
}

{
  const base = graph([material('m1'), imageNode('g1')], [edge('e1', 'm1', 'g1')]);
  const duplicate = checkCanvasConnection(base, edge('e2', 'm1', 'g1'));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.ok === false && duplicate.code, 'duplicate_connection');
}

{
  // 循环连接在加入前被拒绝（用同为视频类型的两个节点，先排除类型不兼容）
  const base = graph([material('src', 'video'), videoNode('v1'), videoNode('v2')], [
    edge('e1', 'src', 'v1'),
    edge('e2', 'v1', 'v2'),
  ]);
  const cycleCheck = checkCanvasConnection(base, edge('e3', 'v2', 'v1'));
  assert.equal(cycleCheck.ok, false);
  assert.equal(cycleCheck.ok === false && cycleCheck.code, 'cycle');

  // 类型不兼容优先于循环判定：视频结果不能回到图片生成节点
  const mixed = graph([material('m1'), imageNode('g1'), videoNode('v9')], [
    edge('e4', 'm1', 'g1'),
    edge('e5', 'g1', 'v9'),
  ]);
  const incompatible = checkCanvasConnection(mixed, edge('e6', 'v9', 'g1'));
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.ok === false && incompatible.code, 'incompatible_connection');
}

// --- 参考槽位对账 -----------------------------------------------------------

{
  let current = graph([material('m1'), material('m2'), imageNode('g1')]);
  current = appendEdge(current, edge('e1', 'm1', 'g1'));
  current = appendEdge(current, edge('e2', 'm2', 'g1'));
  const refs = generationNode(current, 'g1').data.references;
  assert.deepEqual(refs.map((slot) => slot.label), [1, 2]);

  // 断开第一条：槽位随对账移除，保留槽位的编号与顺序不变
  current = removeEdge(current, 'e1');
  const afterDetach = generationNode(current, 'g1').data.references;
  assert.deepEqual(afterDetach.map((slot) => slot.label), [2]);
  assert.deepEqual(detachedReferenceSlots(current, generationNode(current, 'g1')), []);

  // 重新连上：分配新编号，不复用已移除的旧编号（避免 @参考N 悄悄改指向）
  current = appendEdge(current, edge('e3', 'm1', 'g1'));
  const afterReconnect = generationNode(current, 'g1').data.references;
  assert.deepEqual(afterReconnect.map((slot) => slot.label), [2, 3]);
  assert.equal(afterReconnect.length, 2);

  // 重复连接被拒绝，不会凭空多出一个参考槽位
  assert.throws(
    () => appendEdge(current, edge('e4', 'm2', 'g1')),
    (error: unknown) => error instanceof CanvasGraphError && error.code === 'duplicate_connection',
  );
  assert.equal(generationNode(current, 'g1').data.references.length, 2);

  // 新增第四份参考：编号继续往后，不回收已移除的编号
  current = appendNode(current, material('m3'));
  current = appendEdge(current, edge('e5', 'm3', 'g1'));
  assert.deepEqual(
    generationNode(current, 'g1').data.references.map((slot) => slot.label),
    [2, 3, 4],
  );
  assert.equal(generationNode(current, 'g1').data.referenceLabelCounter, 4);
}

{
  // 文本输入也进入槽位，用途默认 reference
  const current = appendEdge(graph([promptNode('p1'), imageNode('g1')]), edge('e1', 'p1', 'g1'));
  const slot = generationNode(current, 'g1').data.references[0];
  assert.equal(slot.sourceKind, 'text');
  assert.equal(slot.role, 'reference');
}

// --- 溯源连线（生成 → 素材） ---------------------------------------------------

{
  let current = graph([material('m1'), imageNode('g1')]);
  // 允许：生成节点 → 素材节点；素材节点不会因此产生参考槽位
  const ok = checkCanvasConnection(current, edge('e1', 'g1', 'm1'));
  assert.equal(ok.ok, true);
  current = appendEdge(current, edge('e1', 'g1', 'm1'));
  assert.equal(current.edges.length, 1);
  assert.equal(generationNode(current, 'g1').data.references.length, 0);

  // 拒绝：提示词 → 素材、素材 → 素材
  const withPrompt = appendNode(current, promptNode('p1'));
  const promptToMaterial = checkCanvasConnection(withPrompt, edge('e2', 'p1', 'm1'));
  assert.equal(promptToMaterial.ok, false);
  assert.equal(promptToMaterial.ok === false && promptToMaterial.code, 'target_not_generation');
  const withM2 = appendNode(current, material('m2'));
  const materialToMaterial = checkCanvasConnection(withM2, edge('e3', 'm1', 'm2'));
  assert.equal(materialToMaterial.ok, false);

  // 拒绝：在已有溯源连线后补 素材 → 生成 的输入连线会构成环
  assert.throws(
    () => appendEdge(current, edge('e4', 'm1', 'g1')),
    (error: unknown) => error instanceof CanvasGraphError && error.code === 'cycle',
  );

  // 服务端解析同样接受溯源连线
  const parsed = parseCanvasGraph(JSON.parse(JSON.stringify(current)));
  assert.equal(parsed.edges.length, 1);
}

// --- 提示词提及 -------------------------------------------------------------
{
  let current = graph([material('m1'), material('m2'), imageNode('g1')]);
  current = appendEdge(current, edge('e1', 'm1', 'g1'));
  current = appendEdge(current, edge('e2', 'm2', 'g1'));
  const node = generationNode(current, 'g1');

  const resolved = resolveCanvasMentions(current, node, '把 @参考1 的沙发放到 @参考2 的场景里');
  assert.deepEqual(resolved.mentioned.map((slot) => slot.label), [1, 2]);
  assert.deepEqual(resolved.unknownLabels, []);

  const unknown = resolveCanvasMentions(current, node, '参考 @参考9');
  assert.deepEqual(unknown.unknownLabels, [9]);
  assert.deepEqual(unknown.mentioned, []);

  // 断开后槽位移除，提示词里的旧编号按「不存在」报告
  const prunedGraph = removeEdge(current, 'e1');
  const prunedNode = generationNode(prunedGraph, 'g1');
  const afterPrune = resolveCanvasMentions(prunedGraph, prunedNode, '用 @参考1 和 @参考2');
  assert.deepEqual(afterPrune.mentioned.map((slot) => slot.label), [2]);
  assert.deepEqual(afterPrune.unknownLabels, [1]);

  // 排序改变提交顺序但不改变编号指向
  const reordered = generationNode(current, 'g1');
  const swapped: CanvasGenerationNode = {
    ...reordered,
    data: { ...reordered.data, references: [...reordered.data.references].reverse() },
  };
  const afterSwap = resolveCanvasMentions(current, swapped, '@参考1');
  assert.equal(afterSwap.mentioned[0].sourceNodeId, 'm1');
}

// --- 删除节点 ---------------------------------------------------------------

{
  let current = graph([material('m1'), material('m2'), imageNode('g1')]);
  current = appendEdge(current, edge('e1', 'm1', 'g1'));
  current = appendEdge(current, edge('e2', 'm2', 'g1'));
  const removed = removeNode(current, 'm1');
  assert.equal(removed.nodes.length, 2);
  assert.equal(removed.edges.length, 1);
  // 指向被删节点的槽位随对账移除
  assert.deepEqual(generationNode(removed, 'g1').data.references.map((slot) => slot.label), [2]);
}

// --- 节点尺寸（自定义宽高） -----------------------------------------------------

{
  const parsed = parseCanvasGraph({
    schemaVersion: 1,
    nodes: [
      { id: 'm1', kind: 'material', position: { x: 0, y: 0 }, size: { width: 320 }, data: { title: 'm', assetId: null, mediaKind: 'image' } },
      { id: 'p1', kind: 'prompt', position: { x: 0, y: 0 }, data: { title: 'p', text: '' } },
    ],
    edges: [],
  });
  assert.equal(parsed.nodes[0].size?.width, 320);
  assert.equal(parsed.nodes[1].size, undefined, '未调整宽度的节点不写 size');

  for (const bad of [40, 99999, Number.NaN]) {
    assert.throws(() => parseCanvasGraph({
      schemaVersion: 1,
      nodes: [{ id: 'm1', kind: 'material', position: { x: 0, y: 0 }, size: { width: bad }, data: { title: 'm', assetId: null, mediaKind: 'image' } }],
      edges: [],
    }), (error: unknown) => error instanceof CanvasGraphError && error.code === 'invalid_node');
  }
}

{
  const sized = (height: unknown) => ({
    schemaVersion: 1,
    nodes: [{ id: 'p1', kind: 'prompt', position: { x: 0, y: 0 }, size: { width: 320, height }, data: { title: 'p', text: '' } }],
    edges: [],
  });
  assert.deepEqual(parseCanvasGraph(sized(480)).nodes[0].size, { width: 320, height: 480 });
  for (const bad of [0, 119, 2001, Number.NaN, Number.POSITIVE_INFINITY, '480', null]) {
    assert.throws(() => parseCanvasGraph(sized(bad)), (error: unknown) => error instanceof CanvasGraphError && error.code === 'invalid_node');
  }
}

// --- 复制 -------------------------------------------------------------------

{
  let current = graph([
    material('m1'),
    material('external'),
    imageNode('g1', { prompt: '改场景', parameters: { ratio: '3:4' } }),
    videoNode('v1', { prompt: '运镜', generationMode: 'image-to-video' }),
  ]);
  current = appendEdge(current, edge('e1', 'm1', 'g1'));
  current = appendEdge(current, edge('e2', 'external', 'g1'));
  current = appendEdge(current, edge('e3', 'g1', 'v1'));

  const plan = planCanvasCopy({ graph: current, nodeIds: ['g1', 'v1'], createId: counterIds() });
  assert.deepEqual([...plan.nodeIdMap.entries()], [['g1', 'new-1'], ['v1', 'new-2']]);
  assert.equal(plan.nodes.length, 2);
  // 只复制选择范围内部的连线
  assert.equal(plan.edges.length, 1);
  assert.equal(plan.edges[0].source, 'new-1');
  assert.equal(plan.edges[0].target, 'new-2');

  const copyImage = plan.nodes[0] as CanvasGenerationNode;
  // 内部来源指向副本，外部输入继续引用原来源
  const bySource = new Map(copyImage.data.references.map((slot) => [slot.sourceNodeId, slot]));
  assert.equal(bySource.has('new-1') === false, true);
  assert.deepEqual([...bySource.keys()].sort(), ['external', 'm1']);
  // 编号保持稳定
  assert.deepEqual(copyImage.data.references.map((slot) => slot.label), [1, 2]);
  assert.equal(copyImage.data.prompt, '改场景');
  assert.deepEqual(copyImage.data.parameters, { ratio: '3:4' });
  assert.equal(copyImage.position.x, imageNode('x').position.x + 48);
  // 复制不携带任何运行投影字段
  assert.equal('currentAssetId' in copyImage.data, false);

  const applied = parseCanvasGraph(JSON.parse(JSON.stringify({
    ...current,
    nodes: [...current.nodes, ...plan.nodes],
    edges: [...current.edges, ...plan.edges],
  })));
  assert.equal(applied.nodes.length, 6);
  assert.equal(applied.edges.length, 4);
}

{
  // 复制保留复制时的结果 assetId（由服务端 node_states 提供，不进入 graphJson）
  const current = graph([imageNode('g1')]);
  const plan = planCanvasCopy({ graph: current, nodeIds: ['g1'], createId: counterIds('copy') });
  assert.equal(plan.nodes.length, 1);
  const copy = plan.nodes[0] as CanvasGenerationNode;
  assert.equal(copy.id, 'copy-1');
  assert.equal(copy.data.references.length, 0);
}

{
  const current = graph([imageNode('g1')]);
  assert.throws(() => planCanvasCopy({ graph: current, nodeIds: ['ghost'], createId: counterIds() }), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'node_not_found'
  ));
  assert.throws(() => planCanvasCopy({ graph: current, nodeIds: [], createId: counterIds() }), (error: unknown) => (
    error instanceof CanvasGraphError && error.code === 'node_not_found'
  ));
}

// --- 空图与容错读取 ---------------------------------------------------------

{
  const empty = emptyCanvasGraph();
  assert.deepEqual(empty, { schemaVersion: 1, nodes: [], edges: [] });
  assert.equal(parseCanvasGraph(JSON.parse(JSON.stringify(empty))).nodes.length, 0);
}

console.log('creative-canvas-graph.test.ts 通过');

// 已保存的 Fast 默认值升级为固定 720p，其他模型和显式设置保持原样。
for (const [modelKey, resolution, expected] of [
  ['company-seedance-2-0-fast', 'gateway-default', '720p'],
  ['company-seedance-2-0-fast', '1080p', '1080p'],
  ['company-seedance-2-5', 'gateway-default', 'gateway-default'],
]) {
  const graph = parseCanvasGraph({ schemaVersion: 1, edges: [], nodes: [videoNode('legacy-fast', { modelKey, parameters: { resolution } })] });
  const node = graph.nodes[0];
  assert.equal(node.kind, 'video-generation');
  if (node.kind === 'video-generation') assert.equal(node.data.parameters.resolution, expected);
}
