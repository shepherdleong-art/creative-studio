'use client';

/**
 * 画布编辑器状态机（P3）——编排层。
 *
 * 职责边界（技术约定 C3／C7）：
 * - 编辑定义（graphJson）由客户端持有并自动保存，服务端按 expectedGraphRevision 做乐观并发；
 * - 运行投影（当前结果／任务阶段）只从服务端读取，不写进节点 data，也不会覆盖正在编辑的草稿；
 * - 任务轮询只更新运行态订阅，不重建整张画布、不夺输入焦点。
 *
 * 拆分结构：保存管线（editor/save-pipeline）、历史栈（editor/history）、
 * 剪贴板（editor/clipboard）、Flow↔Graph 映射（editor/graph-mapping）。
 * 公开的 CanvasEditorController 接口保持稳定：节点组件与浏览器验收依赖它。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import { checkCanvasConnection, reconcileCanvasGraph } from '@/lib/creative-canvas/graph';
import { nodeKindSpec } from '@/lib/creative-canvas/node-kinds';
import type {
  CanvasGenerationMode,
  CanvasGraph,
  CanvasGraphEdge,
  CanvasGraphNode,
  CanvasMediaKind,
  CanvasNodeKind,
  CanvasParameterValue,
  CanvasReferenceSlot,
  CanvasViewport,
} from '@/lib/creative-canvas/types';
import {
  CanvasApiError,
  canvasApi,
  type CanvasAssetDto,
  type CanvasDto,
  type CanvasNodeCandidateDto,
  type CanvasPlanDto,
  type CanvasTaskDto,
} from './api';
import { useCanvasToasts } from './canvas-toasts';
import { canvasErrorText } from './error-copy';
import { CanvasRuntimeStore } from './runtime-store';
import { useCanvasClipboard } from './editor/clipboard';
import { useCanvasHistory, type CanvasHistorySnapshot } from './editor/history';
import { findOpenPosition } from './placement';
import {
  buildCanvasGraph,
  CANVAS_EDGE_MARKER_END,
  cloneEdges,
  cloneNodes,
  toFlowEdge,
  toFlowNode,
  toGraphEdge,
  toGraphNode,
} from './editor/graph-mapping';
import { useCanvasSavePipeline } from './editor/save-pipeline';

export interface CanvasFlowNodeData extends Record<string, unknown> {
  title: string;
  assetId?: string | null;
  mediaKind?: CanvasMediaKind;
  text?: string;
  modelKey?: string | null;
  generationMode?: CanvasGenerationMode;
  prompt?: string;
  parameters?: Record<string, CanvasParameterValue>;
  references?: CanvasReferenceSlot[];
  referenceLabelCounter?: number;
}

export type CanvasFlowNode = Node<CanvasFlowNodeData>;
export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'disabled';

export interface BranchPreview {
  plan: CanvasPlanDto;
  startNodeId: string;
  reuseStart: boolean;
}

export interface CanvasEditorController {
  canvasId: string;
  name: string;
  nodes: CanvasFlowNode[];
  edges: Edge[];
  saveState: SaveState;
  branchPreview: BranchPreview | null;
  runtime: CanvasRuntimeStore;
  canUndo: boolean;
  canRedo: boolean;
  loadState: 'loading' | 'ready' | 'error';
  onNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onNodeDragStart: () => void;
  onNodeResizeStart: () => void;
  onSelectionChange: (nodeIds: string[]) => void;
  addNode: (kind: CanvasNodeKind, position: XYPosition, options?: { connectFrom?: string }) => Promise<string | null>;
  uploadMaterial: (file: File, position: XYPosition) => Promise<void>;
  uploadIntoNode: (nodeId: string, file: File) => Promise<void>;
  updateNodeData: (nodeId: string, patch: Partial<CanvasFlowNodeData>, options?: { coalesce?: string }) => void;
  deleteSelection: () => void;
  deleteEdge: (edgeId: string) => void;
  disconnectReference: (nodeId: string, refId: string) => void;
  /**
   * 建立来源节点 → 生成节点的参考连线（@ 自动补全选中时用），返回分配到的引用编号。
   * 已存在连线时不重复建边、直接返回既有编号；其余校验失败 toast 并返回 null。
   */
  connectReference: (targetNodeId: string, sourceNodeId: string) => number | null;
  moveReference: (nodeId: string, refId: string, direction: -1 | 1) => void;
  updateReference: (nodeId: string, refId: string, patch: Partial<Pick<CanvasReferenceSlot, 'role' | 'note'>>) => void;
  copySelection: () => void;
  pasteClipboard: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  runNode: (nodeId: string, options?: { variantCount?: number }) => Promise<void>;
  previewBranch: (startNodeId: string, reuseStart: boolean) => Promise<void>;
  confirmBranch: () => Promise<void>;
  cancelBranchPreview: () => void;
  reload: () => Promise<void>;
  /** 由界面写入一条状态说明（导出、提示等）。 */
  showStatus: (message: string | null) => void;
  selection: string[];
  hasClipboard: boolean;
  /** 撤销／重做栈深度，供界面与测试观察（不参与保存）。 */
  historyDepth: { past: number; future: number };
}

const POLL_INTERVAL_MS = 1_500;

/**
 * 只影响展示、不参与参考槽位对账与端口类型判定的 data 字段。
 * updateNodeData 的补丁全部落在该集合内时走快速路径：跳过全图
 * reconcile（逐键打字不再全图解析重建节点 data，输入卡顿的根因）。
 * 结构变化（连线增删）仍走 commit 全路径；最终一致性由服务端保存时
 * 无条件执行的 reconcileCanvasGraph 兜底。
 */
const FAST_PATH_DATA_KEYS = new Set(['title', 'text', 'prompt', 'modelKey', 'generationMode', 'parameters']);

export function useCanvasEditor(canvasId: string): CanvasEditorController {
  const runtime = useMemo(() => new CanvasRuntimeStore(), []);
  const toasts = useCanvasToasts();
  const [nodes, setNodes] = useState<CanvasFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [name, setName] = useState('');
  const [branchPreview, setBranchPreview] = useState<BranchPreview | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selection, setSelection] = useState<string[]>([]);

  const nodesRef = useRef<CanvasFlowNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const dragSnapshotRef = useRef<CanvasHistorySnapshot | null>(null);
  /** 已自动物化过的产物 assetId；null = 尚未完成首次投影建档。 */
  const flownAssetIdsRef = useRef<Set<string> | null>(null);

  const setGraphState = useCallback((nextNodes: CanvasFlowNode[], nextEdges: Edge[]) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  const pipeline = useCanvasSavePipeline({ canvasId, nodesRef, edgesRef });
  const { markDirty, scheduleSave, saveWithCoalescing, revisionRef, setSaveState, resetBaseline } = pipeline;

  const restore = useCallback((snapshot: CanvasHistorySnapshot) => {
    setGraphState(cloneNodes(snapshot.nodes), cloneEdges(snapshot.edges));
    markDirty();
    scheduleSave();
  }, [markDirty, scheduleSave, setGraphState]);

  const currentSnapshot = useCallback((): CanvasHistorySnapshot => ({
    nodes: nodesRef.current,
    edges: edgesRef.current,
  }), []);

  const history = useCanvasHistory({ currentSnapshot, restore });
  const { pushHistory, pushHistorySnapshot } = history;

  const clipboard = useCanvasClipboard({
    canvasId,
    nodesRef,
    edgesRef,
    revisionRef,
    runtime,
    setGraphState,
    pushHistory,
    saveWithCoalescing,
    onPasted: (revision) => {
      // 粘贴后的图与服务器完全一致（服务端幂等接口已落库）
      resetBaseline(revision);
      setSaveState('saved');
    },
  });
  const { copySelection, pasteClipboard } = clipboard;

  const applyServerGraph = useCallback((graph: CanvasGraph) => {
    const reconciled = reconcileCanvasGraph(graph);
    setGraphState(reconciled.nodes.map(toFlowNode), reconciled.edges.map(toFlowEdge));
  }, [setGraphState]);

  /**
   * 连线变化时本地同步做一次参考槽位对账，避免等服务端回写才显示参考列表。
   * 规则与服务端 reconcileCanvasGraph 完全一致：补新槽位、移除来源已断开的槽位。
   */
  const reconcileFlowNodes = useCallback((nextNodes: CanvasFlowNode[], nextEdges: Edge[]): CanvasFlowNode[] => {
    try {
      const graph = reconcileCanvasGraph(buildCanvasGraph(nextNodes, nextEdges));
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      return nextNodes.map((node) => {
        const updated = byId.get(node.id);
        if (!updated) return node;
        return { ...node, data: toFlowNode(updated).data };
      });
    } catch {
      // 本地图暂时不合法（例如正在拖拽）：保持原样，服务端仍会做最终校验
      return nextNodes;
    }
  }, []);

  const commit = useCallback((nextNodes: CanvasFlowNode[], nextEdges: Edge[], options?: { coalesce?: string }) => {
    pushHistory(options?.coalesce);
    setGraphState(reconcileFlowNodes(nextNodes, nextEdges), nextEdges);
    markDirty();
    scheduleSave();
  }, [markDirty, pushHistory, reconcileFlowNodes, scheduleSave, setGraphState]);

  /**
   * 结果自动物化：新发布的产物在源节点右侧飞出素材节点并带来源连线（溯源连线）。
   * 快照语义：assetId 钉死，上游之后重跑不跟随；要新结果就等下一次飞出。
   */
  const materializeResults = useCallback((candidates: CanvasNodeCandidateDto[]) => {
    const nextNodes = [...nodesRef.current];
    const nextEdges = [...edgesRef.current];
    for (const candidate of candidates) {
      const source = nextNodes.find((node) => node.id === candidate.nodeId);
      if (!source) continue; // 源节点在任务完成前已被删除
      const id = `n-${crypto.randomUUID()}`;
      const sourceTitle = String(source.data.title ?? '').trim();
      const desired = {
        x: source.position.x + (source.measured?.width ?? 300) + 80,
        y: source.position.y,
      };
      nextNodes.push({
        id,
        type: 'material',
        position: findOpenPosition(desired, nextNodes, 'material'),
        data: {
          title: sourceTitle ? `${sourceTitle} · 结果` : '生成结果',
          assetId: candidate.assetId,
          mediaKind: source.type === 'video-generation' ? 'video' : 'image',
        },
      });
      nextEdges.push({
        id: `e-${crypto.randomUUID()}`,
        source: source.id,
        target: id,
        type: 'canvas',
        markerEnd: CANVAS_EDGE_MARKER_END,
      });
    }
    commit(nextNodes, nextEdges);
  }, [commit]);

  const updateRuntimeFromCanvas = useCallback((canvas: CanvasDto) => {
    runtime.update(canvas.nodeStates, canvas.tasks ?? [], canvas.nodeCandidates ?? []);
    const candidates = canvas.nodeCandidates ?? [];
    if (flownAssetIdsRef.current === null) {
      // 首次投影只建档：打开画布前的旧结果不补飞，否则每次进画布都刷屏
      flownAssetIdsRef.current = new Set(candidates.map((candidate) => candidate.assetId));
      return;
    }
    const known = flownAssetIdsRef.current;
    const fresh = candidates.filter((candidate) => !known.has(candidate.assetId));
    if (fresh.length === 0) return;
    for (const candidate of fresh) known.add(candidate.assetId);
    materializeResults(fresh);
  }, [runtime, materializeResults]);

  const load = useCallback(async () => {
    try {
      const { canvas } = await canvasApi.get(canvasId);
      resetBaseline(canvas.graphRevision);
      setName(canvas.name);
      applyServerGraph(canvas.graph);
      updateRuntimeFromCanvas(canvas);
      setSaveState('saved');
      setLoadState('ready');
    } catch (error) {
      setLoadState('error');
      if (error instanceof CanvasApiError && error.status === 503) {
        setSaveState('disabled');
        toasts.push('error', canvasErrorText(error));
      } else {
        toasts.push('error', `画布加载失败：${canvasErrorText(error)}`);
      }
    }
  }, [applyServerGraph, canvasId, resetBaseline, runtime, setSaveState, toasts]);

  useEffect(() => {
    // load() 的 setState 都发生在 await 之后，这里不是同步级联渲染。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // 任务轮询：只刷新运行投影；有未保存草稿时不覆盖编辑内容。
  useEffect(() => {
    if (loadState !== 'ready') return undefined;
    const timer = setInterval(async () => {
      try {
        const { canvas } = await canvasApi.get(canvasId);
        updateRuntimeFromCanvas(canvas);
        // 轮询只更新运行投影。若服务端图已在另一页面更新，保留本地图与其基准
        // revision，让下一次本地保存明确收到 409，而不是用旧图夺取新 revision。
      } catch {
        // 轮询失败不打断编辑；下一轮继续。
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [canvasId, loadState, runtime]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    const dragging = changes.some((change) => change.type === 'position' && change.dragging === true);
    const dragEnded = changes.some((change) => change.type === 'position' && change.dragging === false);
    const resizing = changes.some((change) => change.type === 'dimensions' && change.resizing === true);
    const resizeEnded = changes.some((change) => change.type === 'dimensions' && change.resizing === false);
    // 拖拽与缩放共用同一份「操作前」快照：撤销要回到操作前，而不是操作后的中间态
    if ((dragEnded || resizeEnded) && dragSnapshotRef.current) {
      pushHistorySnapshot(dragSnapshotRef.current);
      dragSnapshotRef.current = null;
    }
    // Material resize gestures scale width; its rendered media determines the height.
    // Do not freeze a measured/dragged height into the wrapper and leave blank space.
    const sizeChanges = changes.map((change) => (
      change.type === 'dimensions' && change.setAttributes
      && nodesRef.current.some((node) => node.id === change.id && node.type === 'material')
        ? { ...change, setAttributes: 'width' as const }
        : change
    ));
    const next = applyNodeChanges(sizeChanges, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    if (dragging || dragEnded || resizing || resizeEnded) {
      markDirty();
      scheduleSave();
    }
  }, [markDirty, pushHistorySnapshot, scheduleSave]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const next = applyEdgeChanges(changes, edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
  }, []);

  const onNodeDragStart = useCallback(() => {
    dragSnapshotRef.current = { nodes: cloneNodes(nodesRef.current), edges: cloneEdges(edgesRef.current) };
  }, []);

  /** 右缘缩放开始：与节点拖拽同一套路由，缩放结束在 onNodesChange 里入历史栈。 */
  const onNodeResizeStart = useCallback(() => {
    dragSnapshotRef.current = { nodes: cloneNodes(nodesRef.current), edges: cloneEdges(edgesRef.current) };
  }, []);

  const addNode = useCallback(async (
    kind: CanvasNodeKind,
    position: XYPosition,
    options?: { connectFrom?: string },
  ): Promise<string | null> => {
    const id = `n-${crypto.randomUUID()}`;
    // 默认 data 来自注册表（node-kinds.ts 单一事实源）
    const data = nodeKindSpec(kind).defaultData() as CanvasFlowNodeData;
    const node: CanvasFlowNode = { id, type: kind, position, data };
    let nextEdges = edgesRef.current;
    if (options?.connectFrom) {
      const edgeId = `e-${crypto.randomUUID()}`;
      const candidate = { id: edgeId, source: options.connectFrom, target: id };
      const candidateGraph: CanvasGraph = {
        schemaVersion: 1,
        nodes: [...nodesRef.current.map(toGraphNode), toGraphNode(node)],
        edges: [...edgesRef.current.map(toGraphEdge), candidate],
      };
      const check = checkCanvasConnection(
        { schemaVersion: 1, nodes: candidateGraph.nodes, edges: edgesRef.current.map(toGraphEdge) },
        candidate,
      );
      if (!check.ok) {
        toasts.push('error', check.message);
        return null;
      }
      nextEdges = [...edgesRef.current, {
        id: edgeId,
        source: options.connectFrom,
        target: id,
        type: 'canvas',
        markerEnd: CANVAS_EDGE_MARKER_END,
      }];
    }
    commit([...nodesRef.current, node], nextEdges);
    return id;
  }, [commit, toasts]);

  const uploadIntoNode = useCallback(async (nodeId: string, file: File) => {
    try {
      const { asset } = await canvasApi.uploadAsset(canvasId, file);
      const next = nodesRef.current.map((node) => (
        node.id === nodeId
          ? {
            ...node,
            data: {
              ...node.data,
              title: node.type === 'material' && !node.data.assetId ? file.name : node.data.title,
              assetId: asset.id,
              mediaKind: asset.mediaKind,
            },
          }
          : node
      ));
      commit(next, edgesRef.current);
    } catch (error) {
      toasts.push('error', `素材导入失败：${canvasErrorText(error)}`);
    }
  }, [canvasId, commit, toasts]);

  const uploadMaterial = useCallback(async (file: File, position: XYPosition) => {
    const nodeId = await addNode('material', position);
    if (!nodeId) return;
    await uploadIntoNode(nodeId, file);
  }, [addNode, uploadIntoNode]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const edge = { id: `e-${crypto.randomUUID()}`, source: connection.source, target: connection.target };
    const check = checkCanvasConnection(
      { schemaVersion: 1, nodes: nodesRef.current.map(toGraphNode), edges: edgesRef.current.map(toGraphEdge) },
      edge,
    );
    if (!check.ok) {
      toasts.push('error', check.message);
      return;
    }
    commit(nodesRef.current, [...edgesRef.current, {
      ...edge,
      type: 'canvas',
      markerEnd: CANVAS_EDGE_MARKER_END,
      sourceHandle: connection.sourceHandle ?? undefined,
      targetHandle: connection.targetHandle ?? undefined,
    }]);
  }, [commit, toasts]);

  const deleteEdgesInternal = useCallback((edgeIds: string[]) => {
    const removing = new Set(edgeIds);
    const nextEdges = edgesRef.current.filter((edge) => !removing.has(edge.id));
    // 节点与当前结果保留；生成节点上失去来源的参考槽位随对账移除
    commit(nodesRef.current, nextEdges);
  }, [commit]);

  const deleteSelection = useCallback(() => {
    const selectedNodeIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id);
    if (selectedNodeIds.size === 0 && selectedEdgeIds.length === 0) return;
    const nextEdges = edgesRef.current.filter((edge) => (
      !selectedEdgeIds.includes(edge.id)
      && !selectedNodeIds.has(edge.source)
      && !selectedNodeIds.has(edge.target)
    ));
    const nextNodes = nodesRef.current.filter((node) => !selectedNodeIds.has(node.id));
    commit(nextNodes, nextEdges);
  }, [commit]);

  const updateNodeData = useCallback((
    nodeId: string,
    patch: Partial<CanvasFlowNodeData>,
    options?: { coalesce?: string },
  ) => {
    const next = nodesRef.current.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
    ));
    // 快速路径：纯文本/参数字段跳过全图 reconcile，避免逐键输入全图解析
    if (Object.keys(patch).every((key) => FAST_PATH_DATA_KEYS.has(key))) {
      pushHistory(options?.coalesce);
      setGraphState(next, edgesRef.current);
      markDirty();
      scheduleSave();
      return;
    }
    commit(next, edgesRef.current, options);
  }, [commit, markDirty, pushHistory, scheduleSave, setGraphState]);

  const disconnectReference = useCallback((nodeId: string, refId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const slot = node?.data.references?.find((candidate) => candidate.refId === refId);
    if (!slot) return;
    const nextEdges = edgesRef.current.filter((edge) => !(edge.target === nodeId && edge.source === slot.sourceNodeId));
    commit(nodesRef.current, nextEdges);
  }, [commit]);

  const connectReference = useCallback((targetNodeId: string, sourceNodeId: string): number | null => {
    const edge = { id: `e-${crypto.randomUUID()}`, source: sourceNodeId, target: targetNodeId };
    const check = checkCanvasConnection(
      { schemaVersion: 1, nodes: nodesRef.current.map(toGraphNode), edges: edgesRef.current.map(toGraphEdge) },
      edge,
    );
    if (!check.ok && check.code !== 'duplicate_connection') {
      toasts.push('error', check.message);
      return null;
    }
    if (check.ok) {
      commit(nodesRef.current, [...edgesRef.current, {
        ...edge,
        type: 'canvas',
        markerEnd: CANVAS_EDGE_MARKER_END,
      }]);
    }
    // commit 同步完成 reconcile，槽位（含编号）已经落在节点 data 上
    const slot = nodesRef.current
      .find((candidate) => candidate.id === targetNodeId)
      ?.data.references?.find((candidate) => candidate.sourceNodeId === sourceNodeId);
    return slot?.label ?? null;
  }, [commit, toasts]);

  const moveReference = useCallback((nodeId: string, refId: string, direction: -1 | 1) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const references = node?.data.references;
    if (!references) return;
    const index = references.findIndex((slot) => slot.refId === refId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= references.length) return;
    const next = [...references];
    [next[index], next[target]] = [next[target], next[index]];
    updateNodeData(nodeId, { references: next });
  }, [updateNodeData]);

  const updateReference = useCallback((
    nodeId: string,
    refId: string,
    patch: Partial<Pick<CanvasReferenceSlot, 'role' | 'note'>>,
  ) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const references = node?.data.references;
    if (!references) return;
    updateNodeData(nodeId, {
      references: references.map((slot) => (slot.refId === refId ? { ...slot, ...patch } : slot)),
    }, { coalesce: `ref:${nodeId}:${refId}` });
  }, [updateNodeData]);

  const runNode = useCallback(async (nodeId: string, options?: { variantCount?: number }) => {
    const saved = await saveWithCoalescing();
    if (!saved) return;
    try {
      await canvasApi.run(canvasId, {
        mode: 'single',
        targetNodeId: nodeId,
        requestKey: `run-${crypto.randomUUID()}`,
        expectedGraphRevision: revisionRef.current,
        ...(options?.variantCount && options.variantCount > 1 ? { variantCount: options.variantCount } : {}),
      });
      toasts.push('success', '任务已提交，等待调度。');
      const { canvas } = await canvasApi.get(canvasId);
      updateRuntimeFromCanvas(canvas);
    } catch (error) {
      toasts.push('error', `启动失败：${canvasErrorText(error)}`);
    }
  }, [canvasId, revisionRef, saveWithCoalescing, toasts, updateRuntimeFromCanvas]);

  const previewBranch = useCallback(async (startNodeId: string, reuseStart: boolean) => {
    const saved = await saveWithCoalescing();
    if (!saved) return;
    try {
      const { plan } = await canvasApi.plan(canvasId, {
        mode: 'branch', startNodeId, reuseStart, expectedGraphRevision: revisionRef.current,
      });
      setBranchPreview({ plan, startNodeId, reuseStart });
    } catch (error) {
      toasts.push('error', `分支预览失败：${canvasErrorText(error)}`);
    }
  }, [canvasId, revisionRef, saveWithCoalescing, toasts]);

  const confirmBranch = useCallback(async () => {
    const preview = branchPreview;
    if (!preview) return;
    const saved = await saveWithCoalescing();
    if (!saved) return;
    try {
      // 预览与确认之间可能发生编辑。保存后重新计算计划，携带最新图修订与
      // 指纹提交，避免按旧范围创建任务。
      const { plan } = await canvasApi.plan(canvasId, {
        mode: 'branch',
        startNodeId: preview.startNodeId,
        reuseStart: preview.reuseStart,
        expectedGraphRevision: revisionRef.current,
      });
      setBranchPreview({ ...preview, plan });
      if (plan.fingerprint !== preview.plan.fingerprint) {
        toasts.push('info', '画布内容已变化，分支预览已更新，请再次确认启动。');
        return;
      }
      await canvasApi.run(canvasId, {
        mode: 'branch',
        startNodeId: preview.startNodeId,
        reuseStart: preview.reuseStart,
        requestKey: `branch-${crypto.randomUUID()}`,
        expectedGraphRevision: plan.graphRevision,
        planFingerprint: plan.fingerprint,
      });
      setBranchPreview(null);
      toasts.push('success', '分支已启动。');
      const { canvas } = await canvasApi.get(canvasId);
      updateRuntimeFromCanvas(canvas);
    } catch (error) {
      toasts.push('error', `分支启动失败：${canvasErrorText(error)}`);
    }
  }, [branchPreview, canvasId, revisionRef, saveWithCoalescing, toasts, updateRuntimeFromCanvas]);

  const cancelBranchPreview = useCallback(() => setBranchPreview(null), []);

  const onSelectionChange = useCallback((nodeIds: string[]) => {
    // 内容去重：React Flow 的 SelectionListener 效应依赖回调身份，内联回调每次渲染都换新，
    // 若这里无条件下发新数组会形成「渲染→效应→setState→渲染」死循环，路由过渡被永久饿死。
    setSelection((previous) => (
      previous.length === nodeIds.length && previous.every((id, index) => id === nodeIds[index])
        ? previous
        : nodeIds
    ));
  }, []);

  return {
    canvasId,
    name,
    nodes,
    edges,
    saveState: pipeline.saveState,
    branchPreview,
    runtime,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    loadState,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeDragStart,
    onNodeResizeStart,
    onSelectionChange,
    addNode,
    uploadMaterial,
    uploadIntoNode,
    updateNodeData,
    deleteSelection,
    deleteEdge: (edgeId: string) => deleteEdgesInternal([edgeId]),
    disconnectReference,
    connectReference,
    moveReference,
    updateReference,
    copySelection,
    pasteClipboard,
    undo: history.undo,
    redo: history.redo,
    runNode,
    previewBranch,
    confirmBranch,
    cancelBranchPreview,
    reload: load,
    showStatus: toasts.showStatus,
    selection,
    hasClipboard: clipboard.hasClipboard,
    historyDepth: history.historyDepth,
  };
}

// 既有 import 路径兼容（CanvasEditor.tsx / 子模块 / 测试从这里取）
export { buildCanvasGraph, toFlowNode, toGraphNode, toGraphEdge };
export type { CanvasAssetDto, CanvasTaskDto, CanvasPlanDto, CanvasViewport };
