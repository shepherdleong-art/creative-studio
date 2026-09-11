/**
 * 计划器（技术约定 C3，PRD 6.2／7.3）。
 *
 * 计划是「本次要跑什么、每个任务用什么输入」的不可变快照：
 * - 单点运行：有当前结果的输入立即固定 assetId；没有结果但有活跃上游，固定 upstreamTaskId；
 *   两者都没有则拒绝。
 * - 分支运行：范围内输入绑定本次上游 taskId；复用起点与范围外输入固定已有 assetId；
 *   范围外缺结果时不扩充计划。
 * - 计划指纹覆盖图修订、任务集合与全部输入身份；提交时重新计算并比对，避免按过期数量执行。
 *
 * 本模块不写库：只读当前图、节点运行投影与任务表。
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { findCanvasCapability, validateCapabilityInputs, type CanvasModelCapability } from './capabilities.ts';
import {
  CanvasError,
} from './errors.ts';
import {
  detachedReferenceSlots,
  findGraphNode,
  incomingEdges,
  resolveCanvasMentions,
} from './graph.ts';
import { getCanvasNodeState, requireCanvas, type CanvasRecord } from './repository.ts';
import { findActiveTaskForCanvasNode } from './tasks.ts';
import {
  isGenerationNode,
  type CanvasGraph,
  type CanvasGenerationNode,
  type CanvasNodeRunProjection,
  type CanvasReferenceSlot,
} from './types.ts';

export type CanvasPlanMode = 'single' | 'branch';

export type CanvasPlanProblemCode =
  | 'not_generation_node'
  | 'node_missing'
  | 'node_deleted'
  | 'node_busy'
  | 'model_not_selected'
  | 'capability_unknown'
  | 'capability_input_invalid'
  | 'input_asset_missing'
  | 'input_node_missing'
  | 'detached_reference_mentioned'
  | 'mention_unresolved'
  | 'upstream_without_result_or_task'
  | 'external_input_missing'
  | 'start_node_missing'
  | 'revision_conflict';

export interface CanvasPlanProblem {
  code: CanvasPlanProblemCode;
  message: string;
  nodeId?: string;
  refId?: string;
}

export interface CanvasPlanInput {
  refId: string;
  orderIndex: number;
  role: CanvasReferenceSlot['role'];
  note: string;
  sourceNodeId: string;
  kind: CanvasReferenceSlot['sourceKind'];
  /** 固定已有素材（含复用起点的当前结果）。 */
  assetId: string | null;
  /** 本次计划内的上游节点；创建任务时解析成该次运行的任务。 */
  upstreamNodeId: string | null;
  /** 已经存在、需要等待的上游任务（单点运行绑定时使用）。 */
  upstreamTaskId: string | null;
  textContent: string | null;
}

export interface CanvasPlanTask {
  nodeId: string;
  nodeEpoch: number;
  mediaKind: 'image' | 'video';
  capabilityKey: string;
  providerIdentity: string;
  modelAlias: string;
  generationMode: CanvasGenerationNode['data']['generationMode'];
  /** 冻结的完整文本：节点自己的提示词 + 连接的提示词节点文本。 */
  prompt: string;
  parameters: Record<string, string | number | boolean>;
  inputs: CanvasPlanInput[];
}

export interface CanvasPlanReuse {
  nodeId: string;
  assetId: string;
}

export interface CanvasPlan {
  canvasId: string;
  mode: CanvasPlanMode;
  graphRevision: number;
  requestKey: string;
  /** 计划内容的稳定摘要（含图修订）；提交时重新计算并比对。 */
  fingerprint: string;
  /** 参与本次执行的生成节点（按执行顺序）。 */
  tasks: CanvasPlanTask[];
  /** 复用的起点／已有结果。 */
  reused: CanvasPlanReuse[];
  /** 计划覆盖的全部节点（含复用的起点）。 */
  scope: string[];
}

export interface CanvasPlanRequest {
  canvasId: string;
  mode: CanvasPlanMode;
  /** single：要运行的目标节点。 */
  targetNodeId?: string;
  /** branch：分支起点。 */
  startNodeId?: string;
  /** branch：起点已有结果时是否复用（默认复用）。 */
  reuseStart?: boolean;
  requestKey: string;
  expectedGraphRevision?: number;
}

export type CanvasPlanOutcome =
  | { ok: true; plan: CanvasPlan }
  | { ok: false; problems: CanvasPlanProblem[] };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function canvasPlanFingerprint(plan: Omit<CanvasPlan, 'fingerprint' | 'requestKey'>): string {
  return createHash('sha256').update(canonical({
    canvasId: plan.canvasId,
    mode: plan.mode,
    graphRevision: plan.graphRevision,
    scope: [...plan.scope].sort(),
    reused: [...plan.reused].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    tasks: plan.tasks,
  })).digest('hex');
}

/**
 * 请求形状摘要：只覆盖「让哪一次运行发生」的身份，不覆盖计划指纹。
 * 幂等重放先用它判断是不是同一个请求，再用客户端带来的指纹判断内容是否已变化。
 */
export function canvasPlanRequestHash(request: CanvasPlanRequest): string {
  return createHash('sha256').update(canonical({
    canvasId: request.canvasId,
    mode: request.mode,
    targetNodeId: request.mode === 'single' ? request.targetNodeId ?? null : null,
    startNodeId: request.mode === 'branch' ? request.startNodeId ?? null : null,
    reuseStart: request.mode === 'branch' ? request.reuseStart !== false : null,
  })).digest('hex');
}

/** 从起点出发、沿连线可达的生成节点（拓扑序：上游在前）。 */
export function reachableGenerationNodes(graph: CanvasGraph, startNodeId: string): CanvasGenerationNode[] {
  const start = findGraphNode(graph, startNodeId);
  if (!start) throw new CanvasError('invalid_input', `起点节点不存在：${startNodeId}。`);
  const visited = new Set<string>();
  const ordered: CanvasGenerationNode[] = [];

  const walk = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = findGraphNode(graph, nodeId);
    if (!node) return;
    if (isGenerationNode(node)) ordered.push(node);
    for (const edge of graph.edges) {
      if (edge.source === nodeId) walk(edge.target);
    }
  };
  walk(startNodeId);

  // 拓扑排序，保证范围内上游先于下游
  const inScope = new Set(ordered.map((node) => node.id));
  const indegree = new Map<string, number>();
  for (const node of ordered) indegree.set(node.id, 0);
  for (const edge of graph.edges) {
    if (inScope.has(edge.source) && inScope.has(edge.target)) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }
  const queue = ordered.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const sorted: CanvasGenerationNode[] = [];
  const byId = new Map(ordered.map((node) => [node.id, node]));
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const node = byId.get(current);
    if (node) sorted.push(node);
    for (const edge of graph.edges) {
      if (edge.source !== current) continue;
      if (!inScope.has(edge.target)) continue;
      const next = (indegree.get(edge.target) ?? 0) - 1;
      indegree.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }
  return sorted;
}

interface PlanBuildContext {
  db: Database.Database;
  canvas: CanvasRecord;
  graph: CanvasGraph;
  stateOf: (nodeId: string) => CanvasNodeRunProjection | null;
  activeTaskOf: (nodeId: string) => { id: string; phase: string } | null;
  problems: CanvasPlanProblem[];
}

function collectMentions(
  context: PlanBuildContext,
  node: CanvasGenerationNode,
  text: string,
): Set<string> {
  const resolution = resolveCanvasMentions(context.graph, node, text);
  if (resolution.unknownLabels.length > 0) {
    context.problems.push({
      code: 'mention_unresolved',
      nodeId: node.id,
      message: `提示词提到的 @参考${resolution.unknownLabels.join('、@参考')} 不存在，请先连接对应素材。`,
    });
  }
  const detached = new Set(detachedReferenceSlots(context.graph, node).map((slot) => slot.refId));
  for (const refId of resolution.mentionRefIds) {
    if (detached.has(refId)) {
      const slot = node.data.references.find((candidate) => candidate.refId === refId);
      context.problems.push({
        code: 'detached_reference_mentioned',
        nodeId: node.id,
        refId,
        message: `提示词提到的 @参考${slot?.label ?? '?'} 已经断开连接，请重新连接或修改提示词。`,
      });
    }
  }
  return new Set(resolution.mentionRefIds);
}

interface PlanContextWithMode extends PlanBuildContext {
  mode: CanvasPlanMode;
}

function resolveInputSlot(
  context: PlanContextWithMode,
  node: CanvasGenerationNode,
  slot: CanvasReferenceSlot,
  orderIndex: number,
  planScope: Set<string>,
  reuseAssets: Map<string, string>,
): CanvasPlanInput | null {
  const source = findGraphNode(context.graph, slot.sourceNodeId);
  if (!source) {
    context.problems.push({
      code: 'input_node_missing',
      nodeId: node.id,
      refId: slot.refId,
      message: `参考 @参考${slot.label} 的来源节点已经不存在。`,
    });
    return null;
  }

  if (source.kind === 'prompt') {
    return {
      refId: slot.refId,
      orderIndex,
      role: slot.role,
      note: slot.note,
      sourceNodeId: source.id,
      kind: 'text',
      assetId: null,
      upstreamNodeId: null,
      upstreamTaskId: null,
      textContent: source.data.text,
    };
  }

  if (source.kind === 'material') {
    if (!source.data.assetId) {
      context.problems.push({
        code: 'input_asset_missing',
        nodeId: node.id,
        refId: slot.refId,
        message: `素材「${source.data.title || source.id}」还没有导入文件。`,
      });
      return null;
    }
    const asset = context.db.prepare(
      `SELECT id, canvasId, ready FROM creative_canvas_assets WHERE id = ?`,
    ).get(source.data.assetId) as { id: string; canvasId: string; ready: number } | undefined;
    if (!asset || asset.canvasId !== context.canvas.id || asset.ready !== 1) {
      context.problems.push({
        code: 'input_asset_missing',
        nodeId: node.id,
        refId: slot.refId,
        message: `素材「${source.data.title || source.id}」的文件不可用。`,
      });
      return null;
    }
    return {
      refId: slot.refId,
      orderIndex,
      role: slot.role,
      note: slot.note,
      sourceNodeId: source.id,
      kind: 'asset',
      assetId: asset.id,
      upstreamNodeId: null,
      upstreamTaskId: null,
      textContent: null,
    };
  }

  // 上游生成节点的当前结果
  const reuseAsset = reuseAssets.get(source.id);
  if (planScope.has(source.id)) {
    // 范围内依赖绑定本次运行的任务：即使上游节点已有旧结果，也等这次的新结果
    return {
      refId: slot.refId,
      orderIndex,
      role: slot.role,
      note: slot.note,
      sourceNodeId: source.id,
      kind: 'result',
      assetId: null,
      upstreamNodeId: source.id,
      upstreamTaskId: null,
      textContent: null,
    };
  }

  // 范围外（或单点运行的上游）：固定当时可见的当前结果
  const upstreamState = context.stateOf(source.id);
  const fixedAssetId = reuseAsset ?? upstreamState?.currentAssetId ?? null;
  if (fixedAssetId) {
    return {
      refId: slot.refId,
      orderIndex,
      role: slot.role,
      note: slot.note,
      sourceNodeId: source.id,
      kind: 'result',
      assetId: fixedAssetId,
      upstreamNodeId: null,
      upstreamTaskId: null,
      textContent: null,
    };
  }

  const activeTask = context.activeTaskOf(source.id);
  if (activeTask) {
    // 没有结果但有已启动任务（含排队）：绑定这一次任务，等它的产物
    return {
      refId: slot.refId,
      orderIndex,
      role: slot.role,
      note: slot.note,
      sourceNodeId: source.id,
      kind: 'result',
      assetId: null,
      upstreamNodeId: null,
      upstreamTaskId: activeTask.id,
      textContent: null,
    };
  }

  context.problems.push({
    code: context.mode === 'branch' ? 'external_input_missing' : 'upstream_without_result_or_task',
    nodeId: node.id,
    refId: slot.refId,
    message: context.mode === 'branch'
      ? `范围外输入 ${source.id} 没有可用的当前结果，请先生成它。`
      : `上游节点 ${source.id} 还没有结果，也没有正在进行的任务，请先生成上游。`,
  });
  return null;
}

function buildTaskPlan(
  context: PlanContextWithMode,
  node: CanvasGenerationNode,
  planScope: Set<string>,
  reuseAssets: Map<string, string>,
): CanvasPlanTask | null {
  const state = context.stateOf(node.id);
  if (!state || state.deleted) {
    context.problems.push({
      code: 'node_deleted',
      nodeId: node.id,
      message: `节点 ${node.id} 已被删除。`,
    });
    return null;
  }
  const activeTask = context.activeTaskOf(node.id);
  if (activeTask) {
    context.problems.push({
      code: 'node_busy',
      nodeId: node.id,
      message: `节点 ${node.id} 已有正在进行的任务（${activeTask.phase}）。`,
    });
    return null;
  }

  const capability: CanvasModelCapability | null = findCanvasCapability(node.data.modelKey);
  if (!capability) {
    context.problems.push({
      code: node.data.modelKey ? 'capability_unknown' : 'model_not_selected',
      nodeId: node.id,
      message: node.data.modelKey
        ? `模型 ${node.data.modelKey} 尚未在画布能力表中开放。`
        : '节点还没有选择模型。',
    });
    return null;
  }

  const mentioned = collectMentions(context, node, node.data.prompt);
  const connected = new Set(incomingEdges(context.graph, node.id).map((edge) => edge.source));
  const slots = node.data.references.filter((slot) => connected.has(slot.sourceNodeId));

  const inputs: CanvasPlanInput[] = [];
  let orderIndex = 0;
  for (const slot of slots) {
    const input = resolveInputSlot(context, node, slot, orderIndex, planScope, reuseAssets);
    if (input) {
      inputs.push(input);
      orderIndex += 1;
    }
  }

  const capabilityProblems = validateCapabilityInputs({
    capability,
    mode: node.data.generationMode,
    refs: inputs.map((input) => ({
      kind: input.kind === 'text' ? 'text' : inputKindOfInput(context, input),
      role: input.role,
      refId: input.refId,
    })),
    parameters: node.data.parameters,
  });
  for (const problem of capabilityProblems) {
    context.problems.push({
      code: 'capability_input_invalid',
      nodeId: node.id,
      ...(problem.refId ? { refId: problem.refId } : {}),
      message: problem.message,
    });
  }

  const promptParts = [
    node.data.prompt,
    ...inputs.filter((input) => input.kind === 'text').map((input) => input.textContent ?? ''),
  ].filter((part) => part.trim().length > 0);

  void mentioned;
  return {
    nodeId: node.id,
    nodeEpoch: state.nodeEpoch,
    mediaKind: capability.mediaKind,
    capabilityKey: capability.key,
    providerIdentity: capability.providerIdentity,
    modelAlias: capability.modelAlias,
    generationMode: node.data.generationMode,
    prompt: promptParts.join('\n\n'),
    parameters: { ...node.data.parameters },
    inputs,
  };
}

function inputKindOfInput(context: PlanBuildContext, input: CanvasPlanInput): 'image' | 'video' | 'audio' {
  const source = findGraphNode(context.graph, input.sourceNodeId);
  if (source?.kind === 'material') return source.data.mediaKind;
  if (source?.kind === 'image-generation') return 'image';
  if (source?.kind === 'video-generation') return 'video';
  return 'image';
}

function runtimeFor(db: Database.Database, canvas: CanvasRecord) {
  return {
    stateOf: (nodeId: string) => getCanvasNodeState(db, canvas.id, nodeId),
    activeTaskOf: (nodeId: string) => {
      const task = findActiveTaskForCanvasNode(db, canvas.id, nodeId);
      return task ? { id: task.id, phase: task.phase } : null;
    },
  };
}

/**
 * 生成计划。不写库：预览与提交前重验共用同一实现。
 */
export function planCanvasRun(db: Database.Database, request: CanvasPlanRequest): CanvasPlanOutcome {
  const canvas = requireCanvas(db, request.canvasId);
  if (request.expectedGraphRevision !== undefined && canvas.graphRevision !== request.expectedGraphRevision) {
    return { ok: false, problems: [{ code: 'revision_conflict', message: '画布已在别处修改，请刷新后重试。' }] };
  }
  const graph = canvas.graph;
  const runtime = runtimeFor(db, canvas);
  const problems: CanvasPlanProblem[] = [];

  if (request.mode === 'single') {
    const nodeId = request.targetNodeId ?? '';
    const node = findGraphNode(graph, nodeId);
    if (!node) {
      return { ok: false, problems: [{ code: 'node_missing', message: '目标节点不存在。', nodeId }] };
    }
    if (!isGenerationNode(node)) {
      return {
        ok: false,
        problems: [{ code: 'not_generation_node', message: '只有生成节点可以运行。', nodeId }],
      };
    }
    const context: PlanContextWithMode = {
      db,
      canvas,
      graph,
      mode: 'single',
      problems,
      ...runtime,
    };
    const planScope = new Set([node.id]);
    const task = buildTaskPlan(context, node, planScope, new Map());
    if (problems.length > 0 || !task) return { ok: false, problems };
    const base = {
      canvasId: canvas.id,
      mode: 'single' as const,
      graphRevision: canvas.graphRevision,
      tasks: [task],
      reused: [] as CanvasPlanReuse[],
      scope: [node.id],
    };
    return { ok: true, plan: { ...base, requestKey: request.requestKey, fingerprint: canvasPlanFingerprint(base) } };
  }

  const startNodeId = request.startNodeId ?? '';
  const start = findGraphNode(graph, startNodeId);
  if (!start) {
    return { ok: false, problems: [{ code: 'start_node_missing', message: '分支起点不存在。', nodeId: startNodeId }] };
  }
  const reachable = reachableGenerationNodes(graph, startNodeId);
  const planScope = new Set(reachable.map((node) => node.id));
  const reuseAssets = new Map<string, string>();
  const reused: CanvasPlanReuse[] = [];
  const context: PlanContextWithMode = { db, canvas, graph, mode: 'branch', problems, ...runtime };

  // 起点本身是生成节点且已有结果时，默认复用（不产生新任务）
  const reuseStart = request.reuseStart !== false;
  if (isGenerationNode(start) && reuseStart) {
    const startState = runtime.stateOf(start.id);
    if (startState?.currentAssetId) {
      reuseAssets.set(start.id, startState.currentAssetId);
      reused.push({ nodeId: start.id, assetId: startState.currentAssetId });
      planScope.delete(start.id);
    }
  }

  const tasks: CanvasPlanTask[] = [];
  for (const node of reachable) {
    if (!planScope.has(node.id)) continue;
    const task = buildTaskPlan(context, node, planScope, reuseAssets);
    if (task) tasks.push(task);
  }
  if (problems.length > 0) return { ok: false, problems };

  const base = {
    canvasId: canvas.id,
    mode: 'branch' as const,
    graphRevision: canvas.graphRevision,
    tasks,
    reused,
    scope: [...planScope, ...reused.map((entry) => entry.nodeId)],
  };
  return { ok: true, plan: { ...base, requestKey: request.requestKey, fingerprint: canvasPlanFingerprint(base) } };
}
