'use client';

/**
 * 画布编辑器状态机（P3）。
 *
 * 职责边界（技术约定 C3／C7）：
 * - 编辑定义（graphJson）由客户端持有并自动保存，服务端按 expectedGraphRevision 做乐观并发；
 * - 运行投影（当前结果／任务阶段）只从服务端读取，不写进节点 data，也不会覆盖正在编辑的草稿；
 * - 任务轮询只更新运行态订阅，不重建整张画布、不夺输入焦点。
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
  type CanvasPlanDto,
  type CanvasTaskDto,
} from './api';
import { CanvasRuntimeStore } from './runtime-store';

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
  statusMessage: string | null;
  branchPreview: BranchPreview | null;
  runtime: CanvasRuntimeStore;
  canUndo: boolean;
  canRedo: boolean;
  loadState: 'loading' | 'ready' | 'error';
  onNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onNodeDragStart: () => void;
  onSelectionChange: (nodeIds: string[]) => void;
  addNode: (kind: CanvasNodeKind, position: XYPosition, options?: { connectFrom?: string }) => Promise<string | null>;
  uploadMaterial: (file: File, position: XYPosition) => Promise<void>;
  uploadIntoNode: (nodeId: string, file: File) => Promise<void>;
  updateNodeData: (nodeId: string, patch: Partial<CanvasFlowNodeData>, options?: { coalesce?: string }) => void;
  deleteSelection: () => void;
  deleteEdge: (edgeId: string) => void;
  disconnectReference: (nodeId: string, refId: string) => void;
  moveReference: (nodeId: string, refId: string, direction: -1 | 1) => void;
  updateReference: (nodeId: string, refId: string, patch: Partial<Pick<CanvasReferenceSlot, 'role' | 'note'>>) => void;
  copySelection: () => void;
  pasteClipboard: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  runNode: (nodeId: string) => Promise<void>;
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

const SAVE_DEBOUNCE_MS = 600;
const POLL_INTERVAL_MS = 1_500;
const HISTORY_LIMIT = 100;

function cloneNodes(nodes: CanvasFlowNode[]): CanvasFlowNode[] {
  return nodes.map((node) => ({ ...node, position: { ...node.position }, data: { ...node.data } }));
}

function cloneEdges(edges: Edge[]): Edge[] {
  return edges.map((edge) => ({ ...edge }));
}

function toFlowNode(node: CanvasGraphNode): CanvasFlowNode {
  if (node.kind === 'material') {
    return {
      id: node.id,
      type: 'material',
      position: { ...node.position },
      data: { title: node.data.title, assetId: node.data.assetId, mediaKind: node.data.mediaKind },
    };
  }
  if (node.kind === 'prompt') {
    return {
      id: node.id,
      type: 'prompt',
      position: { ...node.position },
      data: { title: node.data.title, text: node.data.text },
    };
  }
  return {
    id: node.id,
    type: node.kind,
    position: { ...node.position },
    data: {
      title: node.data.title,
      modelKey: node.data.modelKey,
      generationMode: node.data.generationMode,
      prompt: node.data.prompt,
      parameters: { ...node.data.parameters },
      references: node.data.references.map((slot) => ({ ...slot })),
      referenceLabelCounter: node.data.referenceLabelCounter,
    },
  };
}

/** 提交给服务端的节点只包含编辑定义；运行投影字段不会出现在这里。 */
function toGraphNode(node: CanvasFlowNode): CanvasGraphNode {
  if (node.type === 'material') {
    return {
      id: node.id,
      kind: 'material',
      position: { x: node.position.x, y: node.position.y },
      data: {
        title: String(node.data.title ?? ''),
        assetId: (node.data.assetId as string | null) ?? null,
        mediaKind: (node.data.mediaKind as CanvasMediaKind) ?? 'image',
      },
    };
  }
  if (node.type === 'prompt') {
    return {
      id: node.id,
      kind: 'prompt',
      position: { x: node.position.x, y: node.position.y },
      data: { title: String(node.data.title ?? ''), text: String(node.data.text ?? '') },
    };
  }
  return {
    id: node.id,
    kind: node.type === 'video-generation' ? 'video-generation' : 'image-generation',
    position: { x: node.position.x, y: node.position.y },
    data: {
      title: String(node.data.title ?? ''),
      modelKey: (node.data.modelKey as string | null) ?? null,
      generationMode: (node.data.generationMode as CanvasGenerationMode) ?? 'image-to-image',
      prompt: String(node.data.prompt ?? ''),
      parameters: { ...(node.data.parameters ?? {}) },
      references: (node.data.references ?? []).map((slot) => ({ ...slot })),
      referenceLabelCounter: Number(node.data.referenceLabelCounter ?? 0),
    },
  };
}

function toGraphEdge(edge: Edge): CanvasGraphEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
  };
}

export function buildCanvasGraph(nodes: CanvasFlowNode[], edges: Edge[]): CanvasGraph {
  return {
    schemaVersion: 1,
    nodes: nodes.map(toGraphNode),
    edges: edges.map(toGraphEdge),
  };
}

export function useCanvasEditor(canvasId: string): CanvasEditorController {
  const runtime = useMemo(() => new CanvasRuntimeStore(), []);
  const [nodes, setNodes] = useState<CanvasFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [name, setName] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [branchPreview, setBranchPreview] = useState<BranchPreview | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selection, setSelection] = useState<string[]>([]);
  const [hasClipboard, setHasClipboard] = useState(false);
  const [past, setPast] = useState<Array<{ nodes: CanvasFlowNode[]; edges: Edge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: CanvasFlowNode[]; edges: Edge[] }>>([]);

  const nodesRef = useRef<CanvasFlowNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCoalesceRef = useRef<{ key: string; at: number } | null>(null);
  const clipboardRef = useRef<{
    nodes: CanvasGraphNode[];
    edges: CanvasGraphEdge[];
    resultAssetIds: Record<string, string | null>;
  } | null>(null);
  const dragSnapshotRef = useRef<{ nodes: CanvasFlowNode[]; edges: Edge[] } | null>(null);

  const setGraphState = useCallback((nextNodes: CanvasFlowNode[], nextEdges: Edge[]) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  const applyServerGraph = useCallback((graph: CanvasGraph) => {
    const reconciled = reconcileCanvasGraph(graph);
    setGraphState(reconciled.nodes.map(toFlowNode), reconciled.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'canvas',
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    })));
  }, [setGraphState]);

  const pushHistorySnapshot = useCallback((snapshot: { nodes: CanvasFlowNode[]; edges: Edge[] }) => {
    setPast((entries) => [...entries.slice(-(HISTORY_LIMIT - 1)), snapshot]);
    setFuture([]);
  }, []);

  const pushHistory = useCallback((coalesceKey?: string) => {
    const now = Date.now();
    const last = lastCoalesceRef.current;
    if (coalesceKey && last && last.key === coalesceKey && now - last.at < 1_200) {
      lastCoalesceRef.current = { key: coalesceKey, at: now };
      return;
    }
    lastCoalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    pushHistorySnapshot({ nodes: cloneNodes(nodesRef.current), edges: cloneEdges(edgesRef.current) });
  }, [pushHistorySnapshot]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  const performSave = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current || savingRef.current) return !dirtyRef.current;
    savingRef.current = true;
    setSaveState('saving');
    const graph = buildCanvasGraph(nodesRef.current, edgesRef.current);
    try {
      const result = await canvasApi.saveGraph(canvasId, {
        expectedGraphRevision: revisionRef.current,
        graph,
      });
      revisionRef.current = result.canvas.graphRevision;
      dirtyRef.current = false;
      setSaveState('saved');
      setStatusMessage(null);
      // 服务端会对账参考槽位；本地无需回写，保持用户正在编辑的内容不动。
      return true;
    } catch (error) {
      if (error instanceof CanvasApiError && error.status === 409) {
        setSaveState('conflict');
        setStatusMessage('画布已在别处被修改：本地草稿已保留，请重新加载后再保存。');
        return false;
      }
      setSaveState('error');
      setStatusMessage(error instanceof Error ? error.message : '保存失败。');
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [canvasId]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void performSave();
    }, SAVE_DEBOUNCE_MS);
  }, [performSave]);

  /**
   * 连线变化时本地同步做一次参考槽位对账，避免等服务端回写才显示参考列表。
   * 规则与服务端 reconcileCanvasGraph 完全一致：只补新槽位，断开时保留槽位（成为失效引用）。
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

  const load = useCallback(async () => {
    try {
      const { canvas } = await canvasApi.get(canvasId);
      revisionRef.current = canvas.graphRevision;
      dirtyRef.current = false;
      setName(canvas.name);
      applyServerGraph(canvas.graph);
      runtime.update(canvas.nodeStates, canvas.tasks ?? []);
      setSaveState('saved');
      setLoadState('ready');
    } catch (error) {
      setLoadState('error');
      if (error instanceof CanvasApiError && error.status === 503) {
        setSaveState('disabled');
        setStatusMessage(error.message);
      } else {
        setStatusMessage(error instanceof Error ? error.message : '加载失败。');
      }
    }
  }, [applyServerGraph, canvasId, runtime]);

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
        runtime.update(canvas.nodeStates, canvas.tasks ?? []);
        if (!dirtyRef.current && !savingRef.current) {
          revisionRef.current = canvas.graphRevision;
        }
      } catch {
        // 轮询失败不打断编辑；下一轮继续。
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [canvasId, loadState, runtime]);

  // 离开页面时尽力保存未落盘的编辑
  useEffect(() => {
    const handler = () => {
      if (!dirtyRef.current) return;
      const graph = buildCanvasGraph(nodesRef.current, edgesRef.current);
      void fetch(`/api/canvas/${canvasId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedGraphRevision: revisionRef.current, graph }),
        keepalive: true,
      });
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [canvasId]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    const dragging = changes.some((change) => change.type === 'position' && change.dragging === true);
    const dragEnded = changes.some((change) => change.type === 'position' && change.dragging === false);
    if (dragEnded && dragSnapshotRef.current) {
      // 撤销要回到拖拽前的位置，而不是已经拖完的位置
      pushHistorySnapshot(dragSnapshotRef.current);
      dragSnapshotRef.current = null;
    }
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    if (dragging || dragEnded) {
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

  const addNode = useCallback(async (
    kind: CanvasNodeKind,
    position: XYPosition,
    options?: { connectFrom?: string },
  ): Promise<string | null> => {
    const id = `n-${crypto.randomUUID()}`;
    const data: CanvasFlowNodeData = kind === 'material'
      ? { title: '素材', assetId: null, mediaKind: 'image' }
      : kind === 'prompt'
        ? { title: '提示词', text: '' }
        : {
          title: kind === 'image-generation' ? '图片生成' : '视频生成',
          modelKey: null,
          generationMode: kind === 'image-generation' ? 'image-to-image' : 'image-to-video',
          prompt: '',
          parameters: {},
          references: [],
          referenceLabelCounter: 0,
        };
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
        setStatusMessage(check.message);
        return null;
      }
      nextEdges = [...edgesRef.current, { id: edgeId, source: options.connectFrom, target: id, type: 'canvas' }];
    }
    commit([...nodesRef.current, node], nextEdges);
    return id;
  }, [commit]);

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
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '素材导入失败。');
    }
  }, [canvasId, commit]);

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
      setStatusMessage(check.message);
      return;
    }
    setStatusMessage(null);
    commit(nodesRef.current, [...edgesRef.current, {
      ...edge,
      type: 'canvas',
      sourceHandle: connection.sourceHandle ?? undefined,
      targetHandle: connection.targetHandle ?? undefined,
    }]);
  }, [commit]);

  const deleteEdgesInternal = useCallback((edgeIds: string[]) => {
    const removing = new Set(edgeIds);
    const nextEdges = edgesRef.current.filter((edge) => !removing.has(edge.id));
    // 只解除引用：节点与当前结果保留，生成节点上的参考槽位变成失效引用
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
    commit(next, edgesRef.current, options);
  }, [commit]);

  const disconnectReference = useCallback((nodeId: string, refId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const slot = node?.data.references?.find((candidate) => candidate.refId === refId);
    if (!slot) return;
    const nextEdges = edgesRef.current.filter((edge) => !(edge.target === nodeId && edge.source === slot.sourceNodeId));
    commit(nodesRef.current, nextEdges);
  }, [commit]);

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

  const copySelection = useCallback(() => {
    const selected = nodesRef.current.filter((node) => node.selected);
    if (selected.length === 0) return;
    const selectedIds = new Set(selected.map((node) => node.id));
    const graph = buildCanvasGraph(nodesRef.current, edgesRef.current);
    const internalEdges = graph.edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
    const resultAssetIds: Record<string, string | null> = {};
    for (const node of selected) {
      resultAssetIds[node.id] = runtime.get(node.id)?.currentAssetId ?? null;
    }
    clipboardRef.current = {
      nodes: graph.nodes.filter((node) => selectedIds.has(node.id)),
      edges: internalEdges,
      resultAssetIds,
    };
    setHasClipboard(true);
    setStatusMessage(`已复制 ${selected.length} 个节点`);
  }, [runtime]);

  const pasteClipboard = useCallback(async () => {
    const clipboard = clipboardRef.current;
    if (!clipboard) return;
    const saved = await performSave();
    if (!saved) {
      setStatusMessage('有未保存的修改，暂时无法粘贴：请先处理保存冲突。');
      return;
    }
    try {
      const { copy } = await canvasApi.copy(canvasId, {
        sourceCanvasId: canvasId,
        snapshotKey: `paste-${crypto.randomUUID()}`,
        nodes: clipboard.nodes,
        edges: clipboard.edges,
        resultAssetIds: clipboard.resultAssetIds,
        expectedGraphRevision: revisionRef.current,
      });
      revisionRef.current = copy.graphRevision;
      const appendedNodes = copy.nodes.map(toFlowNode).map((node) => ({ ...node, selected: true }));
      const deselected = nodesRef.current.map((node) => ({ ...node, selected: false }));
      const appendedEdges = copy.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'canvas' as const,
      }));
      pushHistory();
      setGraphState([...deselected, ...appendedNodes], [...edgesRef.current, ...appendedEdges]);
      dirtyRef.current = false;
      setSaveState('saved');
      setStatusMessage(`已粘贴 ${appendedNodes.length} 个节点`);
      const { canvas } = await canvasApi.get(canvasId);
      runtime.update(canvas.nodeStates, canvas.tasks ?? []);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '粘贴失败。');
    }
  }, [canvasId, performSave, pushHistory, runtime, setGraphState]);

  const restore = useCallback((snapshot: { nodes: CanvasFlowNode[]; edges: Edge[] }) => {
    setGraphState(cloneNodes(snapshot.nodes), cloneEdges(snapshot.edges));
    markDirty();
    scheduleSave();
  }, [markDirty, scheduleSave, setGraphState]);

  // 注意：状态更新函数必须是纯的，restore 这类副作用要放在 updater 之外执行。
  const currentSnapshot = useCallback(() => ({
    nodes: cloneNodes(nodesRef.current),
    edges: cloneEdges(edgesRef.current),
  }), []);

  const undo = useCallback(() => {
    const entry = past.at(-1);
    if (!entry) return;
    // 快照必须在调用 setState 之前取：updater 是延迟执行的，
    // 在 updater 里取会拿到 restore 之后的状态。
    const snapshot = currentSnapshot();
    setPast((entries) => entries.slice(0, -1));
    setFuture((pending) => [...pending, snapshot]);
    restore(entry);
  }, [currentSnapshot, past, restore]);

  const redo = useCallback(() => {
    const entry = future.at(-1);
    if (!entry) return;
    const snapshot = currentSnapshot();
    setFuture((entries) => entries.slice(0, -1));
    setPast((pending) => [...pending.slice(-(HISTORY_LIMIT - 1)), snapshot]);
    restore(entry);
  }, [currentSnapshot, future, restore]);

  const runNode = useCallback(async (nodeId: string) => {
    const saved = await performSave();
    if (!saved) return;
    try {
      await canvasApi.run(canvasId, {
        mode: 'single',
        targetNodeId: nodeId,
        requestKey: `run-${crypto.randomUUID()}`,
      });
      setStatusMessage('任务已提交，等待调度。');
      const { canvas } = await canvasApi.get(canvasId);
      runtime.update(canvas.nodeStates, canvas.tasks ?? []);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '启动失败。');
    }
  }, [canvasId, performSave, runtime]);

  const previewBranch = useCallback(async (startNodeId: string, reuseStart: boolean) => {
    const saved = await performSave();
    if (!saved) return;
    try {
      const { plan } = await canvasApi.plan(canvasId, { mode: 'branch', startNodeId, reuseStart });
      setBranchPreview({ plan, startNodeId, reuseStart });
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '分支预览失败。');
    }
  }, [canvasId, performSave]);

  const confirmBranch = useCallback(async () => {
    const preview = branchPreview;
    if (!preview) return;
    try {
      await canvasApi.run(canvasId, {
        mode: 'branch',
        startNodeId: preview.startNodeId,
        reuseStart: preview.reuseStart,
        requestKey: `branch-${crypto.randomUUID()}`,
        planFingerprint: preview.plan.fingerprint,
      });
      setBranchPreview(null);
      setStatusMessage('分支已启动。');
      const { canvas } = await canvasApi.get(canvasId);
      runtime.update(canvas.nodeStates, canvas.tasks ?? []);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '分支启动失败。');
    }
  }, [branchPreview, canvasId, runtime]);

  const cancelBranchPreview = useCallback(() => setBranchPreview(null), []);

  const onSelectionChange = useCallback((nodeIds: string[]) => {
    setSelection(nodeIds);
  }, []);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  return {
    canvasId,
    name,
    nodes,
    edges,
    saveState,
    statusMessage,
    branchPreview,
    runtime,
    canUndo,
    canRedo,
    loadState,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeDragStart,
    onSelectionChange,
    addNode,
    uploadMaterial,
    uploadIntoNode,
    updateNodeData,
    deleteSelection,
    deleteEdge: (edgeId: string) => deleteEdgesInternal([edgeId]),
    disconnectReference,
    moveReference,
    updateReference,
    copySelection,
    pasteClipboard,
    undo,
    redo,
    runNode,
    previewBranch,
    confirmBranch,
    cancelBranchPreview,
    reload: load,
    showStatus: setStatusMessage,
    selection,
    hasClipboard,
    historyDepth: { past: past.length, future: future.length },
  };
}

export type { CanvasAssetDto, CanvasTaskDto, CanvasPlanDto, CanvasViewport };
