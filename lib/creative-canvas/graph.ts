/**
 * 画布图编辑操作（技术约定 C3）。纯函数，不导入数据库、浏览器或供应商。
 *
 * 职责边界：
 * - graphJson 只保存编辑定义；运行投影（currentAssetId / activeTaskId / nodeEpoch）
 *   由服务端 node_states 维护，客户端提交的图里出现这些字段一律拒绝。
 * - 本模块只做结构校验、连接合法性、循环检测、参考槽位对账与复制映射。
 *   模型能力校验由 capabilities.ts 提供，输入快照由 P2 的 planner 生成。
 */

import {
  CANVAS_GRAPH_SCHEMA_VERSION,
  CANVAS_GENERATION_MODES,
  CANVAS_REFERENCE_ROLES,
  isGenerationNode,
  type CanvasGenerationMode,
  type CanvasGenerationNode,
  type CanvasGenerationNodeData,
  type CanvasGraph,
  type CanvasGraphEdge,
  type CanvasGraphNode,
  type CanvasMaterialNode,
  type CanvasMediaKind,
  type CanvasNodeSize,
  type CanvasParameterValue,
  type CanvasPoint,
  type CanvasPromptNode,
  type CanvasReferenceRole,
  type CanvasReferenceSlot,
  type CanvasReferenceSourceKind,
} from './types.ts';
import { inputKindsOf, outputKindOf } from './node-kinds.ts';

export type CanvasGraphErrorCode =
  | 'invalid_graph'
  | 'invalid_node'
  | 'invalid_edge'
  | 'runtime_field_not_writable'
  | 'duplicate_node_id'
  | 'duplicate_edge_id'
  | 'unknown_node'
  | 'self_loop'
  | 'cycle'
  | 'target_not_generation'
  | 'incompatible_connection'
  | 'duplicate_connection'
  | 'node_not_found'
  | 'invalid_reference';

export class CanvasGraphError extends Error {
  readonly code: CanvasGraphErrorCode;

  constructor(code: CanvasGraphErrorCode, message: string) {
    super(message);
    this.name = 'CanvasGraphError';
    this.code = code;
  }
}

const RUNTIME_FIELD_NAMES = new Set([
  'currentAssetId',
  'activeTaskId',
  'resultTaskId',
  'nodeEpoch',
  'epoch',
  'taskStatus',
  'phase',
  'slotHeld',
  'leaseOwner',
  'leaseUntil',
  'fence',
  'providerTaskId',
  'outputAssetId',
]);

const MEDIA_KINDS: ReadonlyArray<CanvasMediaKind> = ['image', 'video', 'audio'];
const REFERENCE_SOURCE_KINDS: ReadonlyArray<CanvasReferenceSourceKind> = ['asset', 'text', 'result'];

export function emptyCanvasGraph(): CanvasGraph {
  return { schemaVersion: CANVAS_GRAPH_SCHEMA_VERSION, nodes: [], edges: [] };
}

function fail(code: CanvasGraphErrorCode, message: string): never {
  throw new CanvasGraphError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNoRuntimeFields(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    if (RUNTIME_FIELD_NAMES.has(key)) {
      fail('runtime_field_not_writable', `${path}.${key} 属于服务端运行投影，客户端不能写入。`);
    }
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('invalid_node', `${path} 含未知字段 ${key}。`);
    }
  }
}

export function canvasMentionToken(label: number): string {
  return `@参考${label}`;
}

function parsePosition(value: unknown, path: string): CanvasPoint {
  if (!isPlainObject(value)) fail('invalid_node', `${path} 缺少位置。`);
  const { x, y } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    fail('invalid_node', `${path} 的位置必须是有限数值。`);
  }
  return { x, y };
}

function parseSize(value: unknown, path: string): CanvasNodeSize | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('invalid_node', `${path} 必须是对象。`);
  assertKnownKeys(value, ['width'], path);
  const { width } = value;
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 120 || width > 2000) {
    fail('invalid_node', `${path}.width 必须是 120–2000 的有限数值。`);
  }
  return { width };
}

function parseParameters(value: unknown, path: string): Record<string, CanvasParameterValue> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail('invalid_node', `${path}.parameters 必须是对象。`);
  const result: Record<string, CanvasParameterValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) {
      result[key] = raw;
      continue;
    }
    fail('invalid_node', `${path}.parameters.${key} 只接受字符串、数值或布尔值。`);
  }
  return result;
}

function parseReferenceSlot(value: unknown, path: string): CanvasReferenceSlot {
  if (!isPlainObject(value)) fail('invalid_reference', `${path} 必须是对象。`);
  assertNoRuntimeFields(value, path);
  assertKnownKeys(value, ['refId', 'label', 'role', 'note', 'sourceNodeId', 'sourceKind'], path);
  const { refId, label, role, note, sourceNodeId, sourceKind } = value;
  if (typeof refId !== 'string' || refId.length === 0) fail('invalid_reference', `${path}.refId 必须是字符串。`);
  if (typeof label !== 'number' || !Number.isInteger(label) || label < 1) {
    fail('invalid_reference', `${path}.label 必须是正整数。`);
  }
  if (typeof role !== 'string' || !CANVAS_REFERENCE_ROLES.includes(role as CanvasReferenceRole)) {
    fail('invalid_reference', `${path}.role 不是受支持的用途。`);
  }
  if (note !== undefined && typeof note !== 'string') fail('invalid_reference', `${path}.note 必须是字符串。`);
  if (typeof sourceNodeId !== 'string' || sourceNodeId.length === 0) {
    fail('invalid_reference', `${path}.sourceNodeId 必须是字符串。`);
  }
  if (
    typeof sourceKind !== 'string'
    || !REFERENCE_SOURCE_KINDS.includes(sourceKind as CanvasReferenceSourceKind)
  ) {
    fail('invalid_reference', `${path}.sourceKind 不是受支持的来源种类。`);
  }
  return {
    refId,
    label,
    role: role as CanvasReferenceRole,
    note: typeof note === 'string' ? note : '',
    sourceNodeId,
    sourceKind: sourceKind as CanvasReferenceSourceKind,
  };
}

function parseGenerationData(value: unknown, path: string): CanvasGenerationNodeData {
  if (!isPlainObject(value)) fail('invalid_node', `${path}.data 必须是对象。`);
  assertNoRuntimeFields(value, path);
  assertKnownKeys(
    value,
    ['title', 'modelKey', 'generationMode', 'prompt', 'parameters', 'references', 'referenceLabelCounter'],
    path,
  );
  const { title, modelKey, generationMode, prompt, parameters, references, referenceLabelCounter } = value;
  if (typeof title !== 'string') fail('invalid_node', `${path}.title 必须是字符串。`);
  if (modelKey !== null && typeof modelKey !== 'string') {
    fail('invalid_node', `${path}.modelKey 必须是字符串或 null。`);
  }
  if (
    typeof generationMode !== 'string'
    || !CANVAS_GENERATION_MODES.includes(generationMode as CanvasGenerationMode)
  ) {
    fail('invalid_node', `${path}.generationMode 不是受支持的生成模式。`);
  }
  if (typeof prompt !== 'string') fail('invalid_node', `${path}.prompt 必须是字符串。`);
  if (references !== undefined && !Array.isArray(references)) {
    fail('invalid_node', `${path}.references 必须是数组。`);
  }
  const parsedReferences = (references ?? []).map((entry, index) => (
    parseReferenceSlot(entry, `${path}.references[${index}]`)
  ));
  const refIds = new Set<string>();
  const labels = new Set<number>();
  for (const slot of parsedReferences) {
    if (refIds.has(slot.refId)) fail('invalid_reference', `${path} 的参考 refId 重复：${slot.refId}。`);
    if (labels.has(slot.label)) fail('invalid_reference', `${path} 的参考编号重复：${slot.label}。`);
    refIds.add(slot.refId);
    labels.add(slot.label);
  }
  const maxLabel = parsedReferences.reduce((max, slot) => Math.max(max, slot.label), 0);
  let counter = maxLabel;
  if (referenceLabelCounter !== undefined) {
    if (
      typeof referenceLabelCounter !== 'number'
      || !Number.isInteger(referenceLabelCounter)
      || referenceLabelCounter < maxLabel
    ) {
      fail('invalid_node', `${path}.referenceLabelCounter 必须是大于等于现有最大编号的整数。`);
    }
    counter = referenceLabelCounter;
  }
  return {
    title,
    modelKey: (modelKey as string | null) ?? null,
    generationMode: generationMode as CanvasGenerationMode,
    prompt,
    parameters: parseParameters(parameters, path),
    references: parsedReferences,
    referenceLabelCounter: counter,
  };
}

function parseNode(value: unknown, index: number): CanvasGraphNode {
  const path = `nodes[${index}]`;
  if (!isPlainObject(value)) fail('invalid_node', `${path} 必须是对象。`);
  assertNoRuntimeFields(value, path);
  assertKnownKeys(value, ['id', 'kind', 'position', 'size', 'data'], path);
  const { id, kind, position, size, data } = value;
  if (typeof id !== 'string' || id.length === 0) fail('invalid_node', `${path}.id 必须是非空字符串。`);
  const parsedPosition = parsePosition(position, path);
  const parsedSize = parseSize(size, `${path}.size`);
  if (!isPlainObject(data)) fail('invalid_node', `${path}.data 必须是对象。`);
  assertNoRuntimeFields(data, `${path}.data`);

  if (kind === 'material') {
    assertKnownKeys(data, ['title', 'assetId', 'mediaKind'], `${path}.data`);
    const { title, assetId, mediaKind } = data;
    if (typeof title !== 'string') fail('invalid_node', `${path}.data.title 必须是字符串。`);
    if (assetId !== null && typeof assetId !== 'string') {
      fail('invalid_node', `${path}.data.assetId 必须是字符串或 null。`);
    }
    if (typeof mediaKind !== 'string' || !MEDIA_KINDS.includes(mediaKind as CanvasMediaKind)) {
      fail('invalid_node', `${path}.data.mediaKind 不是受支持的媒体类型。`);
    }
    const node: CanvasMaterialNode = {
      id,
      kind: 'material',
      position: parsedPosition,
      ...(parsedSize ? { size: parsedSize } : {}),
      data: {
        title,
        assetId: (assetId as string | null) ?? null,
        mediaKind: mediaKind as CanvasMediaKind,
      },
    };
    return node;
  }

  if (kind === 'prompt') {
    assertKnownKeys(data, ['title', 'text'], `${path}.data`);
    const { title, text } = data;
    if (typeof title !== 'string') fail('invalid_node', `${path}.data.title 必须是字符串。`);
    if (typeof text !== 'string') fail('invalid_node', `${path}.data.text 必须是字符串。`);
    const node: CanvasPromptNode = {
      id,
      kind: 'prompt',
      position: parsedPosition,
      ...(parsedSize ? { size: parsedSize } : {}),
      data: { title, text },
    };
    return node;
  }

  if (kind === 'image-generation' || kind === 'video-generation') {
    const node: CanvasGenerationNode = {
      id,
      kind,
      position: parsedPosition,
      ...(parsedSize ? { size: parsedSize } : {}),
      data: parseGenerationData(data, `${path}.data`),
    };
    return node;
  }

  return fail('invalid_node', `${path}.kind 不是受支持的节点类型。`);
}

function parseEdge(value: unknown, index: number): CanvasGraphEdge {
  const path = `edges[${index}]`;
  if (!isPlainObject(value)) fail('invalid_edge', `${path} 必须是对象。`);
  assertNoRuntimeFields(value, path);
  assertKnownKeys(value, ['id', 'source', 'target', 'sourceHandle', 'targetHandle'], path);
  const { id, source, target, sourceHandle, targetHandle } = value;
  if (typeof id !== 'string' || id.length === 0) fail('invalid_edge', `${path}.id 必须是非空字符串。`);
  if (typeof source !== 'string' || source.length === 0) fail('invalid_edge', `${path}.source 必须是非空字符串。`);
  if (typeof target !== 'string' || target.length === 0) fail('invalid_edge', `${path}.target 必须是非空字符串。`);
  if (sourceHandle !== undefined && typeof sourceHandle !== 'string') {
    fail('invalid_edge', `${path}.sourceHandle 必须是字符串。`);
  }
  if (targetHandle !== undefined && typeof targetHandle !== 'string') {
    fail('invalid_edge', `${path}.targetHandle 必须是字符串。`);
  }
  return {
    id,
    source,
    target,
    ...(typeof sourceHandle === 'string' ? { sourceHandle } : {}),
    ...(typeof targetHandle === 'string' ? { targetHandle } : {}),
  };
}

/**
 * 严格解析客户端提交的图。未知字段、运行投影字段、重复 id、悬空连线都直接拒绝，
 * 不做静默丢弃——静默丢弃会让客户端以为保存成功。
 */
export function parseCanvasGraph(value: unknown): CanvasGraph {
  if (!isPlainObject(value)) fail('invalid_graph', '图定义必须是对象。');
  assertNoRuntimeFields(value, 'graph');
  assertKnownKeys(value, ['schemaVersion', 'nodes', 'edges'], 'graph');
  const { schemaVersion, nodes, edges } = value;
  if (schemaVersion !== CANVAS_GRAPH_SCHEMA_VERSION) {
    fail('invalid_graph', `图定义 schemaVersion 必须是 ${CANVAS_GRAPH_SCHEMA_VERSION}。`);
  }
  if (!Array.isArray(nodes)) fail('invalid_graph', 'nodes 必须是数组。');
  if (!Array.isArray(edges)) fail('invalid_graph', 'edges 必须是数组。');

  const parsedNodes = nodes.map(parseNode);
  const parsedEdges = edges.map(parseEdge);

  const nodeIds = new Set<string>();
  for (const node of parsedNodes) {
    if (nodeIds.has(node.id)) fail('duplicate_node_id', `节点 id 重复：${node.id}。`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of parsedEdges) {
    if (edgeIds.has(edge.id)) fail('duplicate_edge_id', `连线 id 重复：${edge.id}。`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) fail('unknown_node', `连线 ${edge.id} 的来源节点不存在。`);
    if (!nodeIds.has(edge.target)) fail('unknown_node', `连线 ${edge.id} 的目标节点不存在。`);
    if (edge.source === edge.target) fail('self_loop', `连线 ${edge.id} 指向了自身。`);
  }

  const graph: CanvasGraph = {
    schemaVersion: CANVAS_GRAPH_SCHEMA_VERSION,
    nodes: parsedNodes,
    edges: parsedEdges,
  };
  assertConnectionsCompatible(graph);
  assertAcyclic(graph);
  return graph;
}

/**
 * 端口兼容性在服务端也要校验：客户端拖拽会被 checkCanvasConnection 拒绝，
 * 但直接提交的图同样不能让「视频结果接到图片生成节点」这类连接落库。
 */
function assertConnectionsCompatible(graph: CanvasGraph): void {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    const key = `${edge.source}\u0000${edge.target}`;
    if (pairs.has(key)) fail('duplicate_connection', `节点之间重复连接：${edge.id}。`);
    pairs.add(key);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    // 溯源连线（生成 → 素材）例外：只记录结果出处，不参与端口类型匹配
    if (isGenerationNode(source) && target.kind === 'material') continue;
    if (!isGenerationNode(target)) {
      fail('target_not_generation', `连线 ${edge.id} 的目标不是生成节点。`);
    }
    const accepted = nodeInputKinds(target);
    const output = nodeOutputKind(source);
    if (!accepted || !accepted.includes(output)) {
      fail('incompatible_connection', `连线 ${edge.id} 的端口类型不兼容。`);
    }
  }
}

export function findGraphNode(graph: CanvasGraph, nodeId: string): CanvasGraphNode | null {
  return graph.nodes.find((node) => node.id === nodeId) ?? null;
}

export function requireGraphNode(graph: CanvasGraph, nodeId: string): CanvasGraphNode {
  const node = findGraphNode(graph, nodeId);
  if (!node) fail('node_not_found', `节点不存在：${nodeId}。`);
  return node;
}

export function incomingEdges(graph: CanvasGraph, nodeId: string): CanvasGraphEdge[] {
  return graph.edges.filter((edge) => edge.target === nodeId);
}

export function outgoingEdges(graph: CanvasGraph, nodeId: string): CanvasGraphEdge[] {
  return graph.edges.filter((edge) => edge.source === nodeId);
}

/** 节点输出端口类型：规则唯一事实源在 node-kinds.ts 注册表，这里保留导出兼容既有调用方。 */
export function nodeOutputKind(node: CanvasGraphNode): CanvasMediaKind | 'text' {
  return outputKindOf(node);
}

export function nodeInputKinds(node: CanvasGraphNode): ReadonlyArray<CanvasMediaKind | 'text'> | null {
  return inputKindsOf(node);
}

export type CanvasConnectionRejectionCode =
  | 'self_loop'
  | 'cycle'
  | 'duplicate_connection'
  | 'target_not_generation'
  | 'incompatible_connection'
  | 'unknown_node';

export type CanvasConnectionCheck =
  | { ok: true }
  | { ok: false; code: CanvasConnectionRejectionCode; message: string };

/** 溯源连线：生成节点 → 素材节点。只记录结果出处（结果物化），不产生参考槽位、不参与计划。 */
export function isProvenanceEdge(graph: CanvasGraph, edge: Pick<CanvasGraphEdge, 'source' | 'target'>): boolean {
  const source = findGraphNode(graph, edge.source);
  const target = findGraphNode(graph, edge.target);
  return Boolean(source && target && isGenerationNode(source) && target.kind === 'material');
}

export function checkCanvasConnection(graph: CanvasGraph, edge: CanvasGraphEdge): CanvasConnectionCheck {
  const source = findGraphNode(graph, edge.source);
  const target = findGraphNode(graph, edge.target);
  if (!source || !target) {
    return { ok: false, code: 'unknown_node', message: '连线的节点不存在。' };
  }
  if (edge.source === edge.target) {
    return { ok: false, code: 'self_loop', message: '节点不能连接到自己。' };
  }
  const provenance = isGenerationNode(source) && target.kind === 'material';
  if (!isGenerationNode(target) && !provenance) {
    return { ok: false, code: 'target_not_generation', message: '只有生成节点接受输入。' };
  }
  if (graph.edges.some((existing) => existing.source === edge.source && existing.target === edge.target)) {
    return { ok: false, code: 'duplicate_connection', message: '这两个节点已经连接。' };
  }
  if (!provenance) {
    const accepted = nodeInputKinds(target);
    const output = nodeOutputKind(source);
    if (!accepted || !accepted.includes(output)) {
      return {
        ok: false,
        code: 'incompatible_connection',
        message: `${source.kind === 'material' ? '该素材' : '该节点'}的输出不能连接到${target.kind === 'image-generation' ? '图片' : '视频'}生成节点。`,
      };
    }
  }
  const withEdge: CanvasGraph = { ...graph, edges: [...graph.edges, edge] };
  const cycle = findCycle(withEdge);
  if (cycle) {
    return { ok: false, code: 'cycle', message: '连接会形成循环依赖。' };
  }
  return { ok: true };
}

/** 返回构成循环的节点 id（按环顺序），没有循环时返回 null。 */
export function findCycle(graph: CanvasGraph): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (nodeId: string): string[] | null => {
    const current = state.get(nodeId);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(nodeId);
      return stack.slice(start >= 0 ? start : 0).concat(nodeId);
    }
    state.set(nodeId, 'visiting');
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(nodeId, 'done');
    return null;
  };

  for (const node of graph.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

function assertAcyclic(graph: CanvasGraph): void {
  const cycle = findCycle(graph);
  if (cycle) fail('cycle', `图定义存在循环依赖：${cycle.join(' → ')}。`);
}

export function appendEdge(graph: CanvasGraph, edge: CanvasGraphEdge): CanvasGraph {
  const check = checkCanvasConnection(graph, edge);
  if (!check.ok) fail(check.code, check.message);
  return reconcileCanvasGraph({ ...graph, edges: [...graph.edges, edge] });
}

export function removeEdge(graph: CanvasGraph, edgeId: string): CanvasGraph {
  const next = graph.edges.filter((edge) => edge.id !== edgeId);
  return reconcileCanvasGraph({ ...graph, edges: next });
}

export function appendNode(graph: CanvasGraph, node: CanvasGraphNode): CanvasGraph {
  if (findGraphNode(graph, node.id)) fail('duplicate_node_id', `节点 id 重复：${node.id}。`);
  return reconcileCanvasGraph({ ...graph, nodes: [...graph.nodes, node] });
}

/**
 * 删除节点的编辑定义与关联连线。不删除任务身份；其他节点指向它的参考槽位
 * 会因为连线消失而随对账一并移除。
 */
export function removeNode(graph: CanvasGraph, nodeId: string): CanvasGraph {
  requireGraphNode(graph, nodeId);
  return reconcileCanvasGraph({
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  });
}

export function cloneCanvasGraph(graph: CanvasGraph): CanvasGraph {
  return {
    schemaVersion: graph.schemaVersion,
    nodes: graph.nodes.map((node) => cloneNode(node)),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

export function cloneNode(node: CanvasGraphNode): CanvasGraphNode {
  const size = node.size ? { size: { ...node.size } } : {};
  if (node.kind === 'material') {
    return { ...node, position: { ...node.position }, ...size, data: { ...node.data } };
  }
  if (node.kind === 'prompt') {
    return { ...node, position: { ...node.position }, ...size, data: { ...node.data } };
  }
  return {
    ...node,
    position: { ...node.position },
    ...size,
    data: {
      ...node.data,
      parameters: { ...node.data.parameters },
      references: node.data.references.map((slot) => ({ ...slot })),
    },
  };
}

const DEFAULT_ROLE_BY_SOURCE: Record<CanvasReferenceSourceKind, CanvasReferenceRole> = {
  asset: 'subject',
  text: 'reference',
  result: 'reference',
};

function referenceSourceKindFor(node: CanvasGraphNode): CanvasReferenceSourceKind {
  if (node.kind === 'material') return 'asset';
  if (node.kind === 'prompt') return 'text';
  return 'result';
}

function defaultRoleFor(source: CanvasGraphNode): CanvasReferenceRole {
  if (source.kind === 'material') {
    if (source.data.mediaKind === 'audio') return 'audio';
    // 视频素材默认按「参考」接入：它是参考视频／运镜参考，不是首帧图
    if (source.data.mediaKind === 'video') return 'reference';
  }
  return DEFAULT_ROLE_BY_SOURCE[referenceSourceKindFor(source)];
}

export function referenceSourceKindOf(node: CanvasGraphNode): CanvasReferenceSourceKind {
  return referenceSourceKindFor(node);
}

export function defaultReferenceRoleFor(node: CanvasGraphNode): CanvasReferenceRole {
  return defaultRoleFor(node);
}

/** 生成节点上来源已断开的参考槽位（对账会移除它们；仅用于识别未对账的旧图）。 */
export function detachedReferenceSlots(
  graph: CanvasGraph,
  node: CanvasGenerationNode,
): CanvasReferenceSlot[] {
  const connected = new Set(incomingEdges(graph, node.id).map((edge) => edge.source));
  return node.data.references.filter((slot) => !connected.has(slot.sourceNodeId));
}

/**
 * 参考槽位对账：为新增连线补槽位，并移除来源连线已断开的槽位。
 * 保留槽位的编号与顺序不变；编号游标只增不减，@参考N 不会被回收给别的素材，
 * 重连同一来源会分配新编号，提示词里的旧 @参考N 按「不存在」显式报错。
 */
export function reconcileCanvasGraph(graph: CanvasGraph): CanvasGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (!isGenerationNode(node)) return node;
    const inEdges = incomingEdges(graph, node.id);
    const connected = new Set(inEdges.map((edge) => edge.source));
    const sources = inEdges
      .map((edge) => findGraphNode(graph, edge.source))
      .filter((source): source is CanvasGraphNode => Boolean(source));
    const known = new Set(node.data.references.map((slot) => slot.sourceNodeId));
    const missing = sources.filter((source) => !known.has(source.id));
    const kept = node.data.references.filter((slot) => connected.has(slot.sourceNodeId));
    if (missing.length === 0 && kept.length === node.data.references.length) return node;
    changed = true;
    let counter = node.data.referenceLabelCounter;
    const appended = missing.map((source) => {
      counter += 1;
      return {
        refId: `ref-${source.id}`,
        label: counter,
        role: defaultRoleFor(source),
        note: '',
        sourceNodeId: source.id,
        sourceKind: referenceSourceKindFor(source),
      } satisfies CanvasReferenceSlot;
    });
    const data: CanvasGenerationNodeData = {
      ...node.data,
      references: [...kept, ...appended],
      referenceLabelCounter: counter,
    };
    return { ...node, data } as CanvasGenerationNode;
  });
  return changed ? { ...graph, nodes } : graph;
}

export function collectMentionedLabels(text: string): number[] {
  const labels: number[] = [];
  const pattern = /@参考(\d+)/g;
  let match = pattern.exec(text);
  while (match) {
    labels.push(Number(match[1]));
    match = pattern.exec(text);
  }
  return labels;
}

export interface CanvasMentionResolution {
  mentioned: CanvasReferenceSlot[];
  /** 提示词提到但节点里不存在的编号（含连线断开后被对账移除的槽位）。 */
  unknownLabels: number[];
  /** 同一次生成里被提及的槽位（可能重复），用于计划指纹。 */
  mentionRefIds: string[];
}

export function resolveCanvasMentions(
  graph: CanvasGraph,
  node: CanvasGenerationNode,
  text: string,
): CanvasMentionResolution {
  const labels = collectMentionedLabels(text);
  const byLabel = new Map(node.data.references.map((slot) => [slot.label, slot]));
  const mentioned: CanvasReferenceSlot[] = [];
  const unknownLabels: number[] = [];
  const mentionRefIds: string[] = [];
  for (const label of labels) {
    const slot = byLabel.get(label);
    if (!slot) {
      unknownLabels.push(label);
      continue;
    }
    mentioned.push(slot);
    mentionRefIds.push(slot.refId);
  }
  return {
    mentioned,
    unknownLabels: [...new Set(unknownLabels)],
    mentionRefIds,
  };
}

export interface CanvasCopyPlan {
  /** 新节点定义，id 由 createId 生成，运行投影不复制。 */
  nodes: CanvasGraphNode[];
  /** 选择范围内部的连线，指向副本。 */
  edges: CanvasGraphEdge[];
  /** 原节点 id → 新节点 id（仅包含被复制的节点）。 */
  nodeIdMap: Map<string, string>;
}

export function planCanvasCopy(params: {
  graph: CanvasGraph;
  nodeIds: ReadonlyArray<string>;
  createId: () => string;
  positionOffset?: CanvasPoint;
}): CanvasCopyPlan {
  const { graph, nodeIds, createId, positionOffset = { x: 48, y: 48 } } = params;
  if (nodeIds.length === 0) fail('node_not_found', '没有选择要复制的节点。');
  const selected = new Set<string>();
  for (const nodeId of nodeIds) {
    requireGraphNode(graph, nodeId);
    if (selected.has(nodeId)) fail('node_not_found', `重复选择节点：${nodeId}。`);
    selected.add(nodeId);
  }

  const nodeIdMap = new Map<string, string>();
  for (const nodeId of nodeIds) nodeIdMap.set(nodeId, createId());

  const nodes = nodeIds.map((nodeId) => {
    const node = requireGraphNode(graph, nodeId);
    const copy = cloneNode(node);
    copy.id = nodeIdMap.get(nodeId) as string;
    copy.position = { x: copy.position.x + positionOffset.x, y: copy.position.y + positionOffset.y };
    if (isGenerationNode(copy)) {
      // 内部来源指向副本，外部输入继续引用原来源；编号保持稳定，不重新分配。
      copy.data.references = copy.data.references.map((slot) => ({
        ...slot,
        sourceNodeId: nodeIdMap.get(slot.sourceNodeId) ?? slot.sourceNodeId,
      }));
    }
    return copy;
  });

  const edges: CanvasGraphEdge[] = [];
  for (const edge of graph.edges) {
    if (!selected.has(edge.source) || !selected.has(edge.target)) continue;
    edges.push({
      ...edge,
      id: createId(),
      source: nodeIdMap.get(edge.source) as string,
      target: nodeIdMap.get(edge.target) as string,
    });
  }

  return { nodes, edges, nodeIdMap };
}

export function applyCopyPlan(graph: CanvasGraph, plan: CanvasCopyPlan): CanvasGraph {
  return reconcileCanvasGraph({
    ...graph,
    nodes: [...graph.nodes, ...plan.nodes],
    edges: [...graph.edges, ...plan.edges],
  });
}

export function serializeCanvasGraph(graph: CanvasGraph): string {
  return JSON.stringify(graph);
}

/** 读取已有 graphJson；损坏时返回空图而不是抛错，避免整个画布打不开。 */
export function readCanvasGraph(value: string | null | undefined): CanvasGraph {
  if (!value) return emptyCanvasGraph();
  try {
    return parseCanvasGraph(JSON.parse(value));
  } catch {
    return emptyCanvasGraph();
  }
}
