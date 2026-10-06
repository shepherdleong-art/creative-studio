'use client';

/**
 * 画布编辑器（P3）。
 *
 * - React Flow 负责节点编辑与视口，后端负责执行；
 * - 定义、运行投影、选择／视口分别管理：任务轮询不重建画布、不夺输入焦点；
 * - 支持拉线到空白处弹菜单、Esc、断线 ×、多选复制粘贴、删除、撤销重做；
 * - 焦点在文本框时保留正常键盘编辑行为。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import LogDrawer from '@/components/LogDrawer';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
  type NodeMouseHandler,
  type XYPosition,
} from '@xyflow/react';
import { parseCanvasGraph } from '@/lib/creative-canvas/graph';
import { CANVAS_NODE_KIND_SPECS, canConnectKindTo } from '@/lib/creative-canvas/node-kinds';
import type { CanvasGraph, CanvasNodeKind, CanvasViewport } from '@/lib/creative-canvas/types';
import { canvasApi } from './api';
import { CANVAS_EDGE_TYPES } from './CanvasEdge';
import { CanvasTaskDrawer } from './CanvasTaskDrawer';
import { buildCanvasGraph, useCanvasEditor, type CanvasEditorController, type CanvasFlowNode } from './editor-store';
import { CanvasNodeContext, type CanvasModelCapabilityDto } from './node-context';
import { GenerationNode, MaterialNode, PromptNode } from './nodes';
import { findOpenPosition } from './placement';
import { CanvasToastProvider, useCanvasToasts } from './canvas-toasts';
import { canvasErrorText } from './error-copy';
import { ContextMenu, type ContextMenuItem } from './context-menu';

/** 模型证据等级排序权重：verified > mapped > candidate。 */
const EVIDENCE_RANK: Record<string, number> = { verified: 3, mapped: 2, candidate: 1 };

const NODE_TYPES = {
  material: MaterialNode,
  prompt: PromptNode,
  'image-generation': GenerationNode,
  'video-generation': GenerationNode,
};

const SAVE_LABELS: Record<string, string> = {
  idle: '未修改',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
  conflict: '保存冲突',
  disabled: '功能未开启',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function EditorInner({ canvasId }: { canvasId: string }) {
  const controller = useCanvasEditor(canvasId);
  const toasts = useCanvasToasts();
  const { screenToFlowPosition, fitView, getViewport, setViewport, setCenter } = useReactFlow();
  const [initialViewport, setInitialViewport] = useState<{ x: number; y: number; zoom: number } | undefined>();
  const [capabilities, setCapabilities] = useState<CanvasModelCapabilityDto[]>([]);
  const [executor, setExecutor] = useState<string>('disabled');
  const [logTarget, setLogTarget] = useState<{ canvasId: string; jobId?: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [miniMapVisible, setMiniMapVisible] = useState(true);
  const [dropMenu, setDropMenu] = useState<{
    fromNodeId: string;
    /** 屏幕坐标：screenToFlowPosition 需要（旧实现误传相对坐标导致落点偏移）。 */
    clientX: number;
    clientY: number;
    /** 相对 wrapper 的坐标：菜单定位需要。 */
    localX: number;
    localY: number;
  } | null>(null);
  // 右键上下文菜单（pane／node／edge 三态）
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const finishRenaming = useCallback(() => setRenamingNodeId(null), []);
  // 拉线菜单：Esc 之外，点击菜单外任意处也要能取消（与右键菜单同一手势）
  const dropMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dropMenu) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && dropMenuRef.current?.contains(event.target)) return;
      setDropMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [dropMenu]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CanvasEditorController>(controller);
  const viewportRestoreRef = useRef(false);
  const viewportInteractedRef = useRef(false);
  const latestViewportRef = useRef<CanvasViewport | null>(null);
  const viewportSaveVersionRef = useRef(0);
  const viewportSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    void canvasApi.get(canvasId).then(({ canvas }) => setInitialViewport(canvas.viewport)).catch(() => undefined);
  }, [canvasId]);

  useEffect(() => {
    if (!initialViewport || viewportInteractedRef.current || viewportRestoreRef.current) return undefined;
    viewportRestoreRef.current = true;
    latestViewportRef.current = initialViewport;
    void setViewport(initialViewport, { duration: 0 }).finally(() => {
      viewportRestoreRef.current = false;
    });
    return undefined;
  }, [initialViewport, setViewport]);

  useEffect(() => {
    // 只在提交后更新，避免渲染期读写 ref
    controllerRef.current = controller;
  }, [controller]);

  useEffect(() => {
    void (async () => {
      try {
        const payload = await canvasApi.models();
        setCapabilities(payload.models as CanvasModelCapabilityDto[]);
        setExecutor(payload.executor);
      } catch {
        setCapabilities([]);
      }
    })();
  }, []);

  const onMoveEnd = useCallback(() => {
    if (viewportRestoreRef.current) return;
    const viewport = getViewport();
    latestViewportRef.current = viewport;
    const version = ++viewportSaveVersionRef.current;
    viewportSaveQueueRef.current = viewportSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        // 一次拖拽／缩放可能产生多个结束事件，只把队列中最新的视口写入服务端。
        if (version !== viewportSaveVersionRef.current) return;
        const latest = latestViewportRef.current;
        if (!latest) return;
        try {
          await canvasApi.saveViewport(canvasId, latest);
        } catch (error) {
          if (version === viewportSaveVersionRef.current) {
            toasts.push('error', `视口自动保存失败：${error instanceof Error ? error.message : '请稍后重试。'}`);
          }
        }
      });
  }, [canvasId, getViewport, toasts]);

  const onMoveStart = useCallback(() => {
    if (!viewportRestoreRef.current) viewportInteractedRef.current = true;
  }, []);

  // 页面离开时把最近一次视口也尽力落盘；服务端视口更新不递增图修订号。
  useEffect(() => {
    const handler = () => {
      if (viewportRestoreRef.current) return;
      const viewport = latestViewportRef.current ?? getViewport();
      void fetch(`/api/canvas/${canvasId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport }),
        keepalive: true,
      });
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [canvasId, getViewport]);

  const graph = useMemo<CanvasGraph>(() => {
    try {
      return parseCanvasGraph(buildCanvasGraph(controller.nodes, controller.edges));
    } catch {
      // 本地草稿暂时不合法（例如拖动中）：退回空图，服务端仍会做最终校验
      return { schemaVersion: 1, nodes: [], edges: [] };
    }
  }, [controller.nodes, controller.edges]);

  const resolveSourceAssetId = useCallback((sourceNodeId: string): string | null => {
    const node = controller.nodes.find((candidate) => candidate.id === sourceNodeId);
    if (!node) return null;
    if (node.type === 'material') return (node.data.assetId as string | null) ?? null;
    return controller.runtime.get(sourceNodeId)?.currentAssetId ?? null;
  }, [controller.nodes, controller.runtime]);

  const onConnect = useCallback((connection: Connection) => {
    controllerRef.current.onConnect(connection);
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || state.toNode) return;
    const fromNodeId = state.fromNode?.id;
    if (!fromNodeId) return;
    const point = 'changedTouches' in event
      ? { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY }
      : { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
    // 菜单挂在 wrapper 内用相对坐标定位；创建节点时另需屏幕坐标换算 flow 坐标
    const bounds = wrapperRef.current?.getBoundingClientRect();
    setContextMenu(null);
    setDropMenu({
      fromNodeId,
      clientX: point.x,
      clientY: point.y,
      localX: point.x - (bounds?.left ?? 0),
      localY: point.y - (bounds?.top ?? 0),
    });
  }, []);

  /** 该 mediaKind 下证据等级最高的模型（verified > mapped > candidate）。 */
  const bestModelKey = useCallback((kind: CanvasNodeKind): string | null => {
    const mediaKind = kind === 'video-generation' ? 'video' : 'image';
    const available = capabilities
      .filter((capability) => capability.mediaKind === mediaKind)
      .sort((a, b) => (EVIDENCE_RANK[b.evidence] ?? 0) - (EVIDENCE_RANK[a.evidence] ?? 0));
    return available[0]?.key ?? null;
  }, [capabilities]);

  /** 创建节点：生成节点自动选中证据等级最高的模型（用户仍可更换）。 */
  const addNodeWithDefaults = useCallback(async (
    kind: CanvasNodeKind,
    position: XYPosition,
    options?: { connectFrom?: string },
  ): Promise<string | null> => {
    const id = await controllerRef.current.addNode(kind, position, options);
    if (id && (kind === 'image-generation' || kind === 'video-generation')) {
      const modelKey = bestModelKey(kind);
      if (modelKey) controllerRef.current.updateNodeData(id, { modelKey });
    }
    return id;
  }, [bestModelKey]);

  const createFromMenu = useCallback(async (kind: CanvasNodeKind) => {
    const menu = dropMenu;
    if (!menu) return;
    setDropMenu(null);
    const position = screenToFlowPosition({ x: menu.clientX, y: menu.clientY });
    await addNodeWithDefaults(kind, position, { connectFrom: menu.fromNodeId });
  }, [addNodeWithDefaults, dropMenu, screenToFlowPosition]);

  /** 生成节点的当前结果可物化为独立素材节点（大图展示、可再连线、可替换）。 */
  const dropMenuResultAssetId = useMemo(() => {
    if (!dropMenu) return null;
    const source = controller.nodes.find((node) => node.id === dropMenu.fromNodeId);
    if (!source || (source.type !== 'image-generation' && source.type !== 'video-generation')) return null;
    return controller.runtime.get(dropMenu.fromNodeId)?.currentAssetId ?? null;
  }, [dropMenu, controller.nodes, controller.runtime]);

  const materializeResult = useCallback(async () => {
    const menu = dropMenu;
    if (!menu) return;
    const source = controllerRef.current.nodes.find((node) => node.id === menu.fromNodeId);
    const assetId = resolveSourceAssetId(menu.fromNodeId);
    setDropMenu(null);
    if (!source || !assetId) return;
    const position = findOpenPosition(
      screenToFlowPosition({ x: menu.clientX, y: menu.clientY }),
      controllerRef.current.nodes,
      'material',
    );
    const id = await controllerRef.current.addNode('material', position);
    if (!id) return;
    const sourceTitle = String(source.data.title ?? '').trim();
    controllerRef.current.updateNodeData(id, {
      assetId,
      mediaKind: source.type === 'video-generation' ? 'video' : 'image',
      title: sourceTitle ? `${sourceTitle} · 结果` : '生成结果',
    });
  }, [dropMenu, resolveSourceAssetId, screenToFlowPosition]);

  // 防误触：点击后按钮不留键盘焦点，空格/回车不会把「生成」再触发一次白烧额度
  useEffect(() => {
    const blur = (event: PointerEvent) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (button) button.blur();
    };
    window.addEventListener('pointerup', blur);
    return () => window.removeEventListener('pointerup', blur);
  }, []);

  // 键盘快捷键：焦点在文本框时全部让位给正常编辑
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (logTarget) {
        if (event.key === 'Escape') setLogTarget(null);
        return;
      }
      if (event.key === 'Escape') {
        setDropMenu(null);
        setContextMenu(null);
        controllerRef.current.cancelBranchPreview();
        controllerRef.current.onNodesChange(
          controllerRef.current.nodes
            .filter((node) => node.selected)
            .map((node): NodeChange<CanvasFlowNode> => ({ type: 'select', id: node.id, selected: false })),
        );
        return;
      }
      if (isEditableTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        controllerRef.current.onNodesChange(
          controllerRef.current.nodes.map((node): NodeChange<CanvasFlowNode> => (
            { type: 'select', id: node.id, selected: true }
          )),
        );
        return;
      }
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        controllerRef.current.copySelection();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void controllerRef.current.pasteClipboard();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        controllerRef.current.copySelection();
        void controllerRef.current.pasteClipboard();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) controllerRef.current.redo();
        else controllerRef.current.undo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        controllerRef.current.deleteSelection();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [logTarget]);

  const onDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    let offset = 0;
    for (const file of files) {
      await controllerRef.current.uploadMaterial(file, { x: position.x + offset, y: position.y + offset });
      offset += 40;
    }
  }, [screenToFlowPosition]);

  const onLocate = useCallback((nodeId: string) => {
    void fitView({ nodes: [{ id: nodeId }], duration: 300, maxZoom: 1.2 });
  }, [fitView]);

  const knownNodeIds = useMemo(
    () => new Set(controller.nodes.map((node) => node.id)),
    [controller.nodes],
  );

  /** 打包选中的当前结果：manifest 由服务端固定，生成完整 ZIP 后才给出下载入口。 */
  const [exporting, setExporting] = useState(false);
  const exportSelection = useCallback(async () => {
    const selected = controllerRef.current.nodes.filter((node) => node.selected)
      .filter((node) => node.type === 'image-generation' || node.type === 'video-generation')
      .map((node) => node.id);
    if (selected.length === 0) {
      toasts.push('info', '请先选中至少一个有结果的生成节点。');
      return;
    }
    setExporting(true);
    try {
      const response = await fetch(`/api/canvas/${canvasId}/exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeIds: selected }),
      });
      const payload = await response.json() as {
        export?: { downloadUrl?: string; manifest?: { items?: unknown[]; skipped?: unknown[] } };
        message?: string;
      };
      if (!response.ok || !payload.export?.downloadUrl) {
        toasts.push('error', `导出失败（${response.status}）：${payload.message ?? '服务端未返回下载入口'}`);
        return;
      }
      const itemCount = payload.export.manifest?.items?.length ?? 0;
      const skipped = payload.export.manifest?.skipped?.length ?? 0;
      toasts.push('success', `已打包 ${itemCount} 个结果${skipped > 0 ? `，跳过 ${skipped} 个不可导出节点` : ''}，开始下载。`);
      window.location.href = payload.export.downloadUrl;
    } catch (error) {
      toasts.push('error', `导出请求失败：${canvasErrorText(error)}`);
    } finally {
      setExporting(false);
    }
  }, [canvasId, toasts]);

  const fitAll = useCallback(() => {
    void fitView({ padding: 0.12, maxZoom: 1, duration: 200 });
  }, [fitView]);

  const addAtCenter = useCallback(async (kind: CanvasNodeKind) => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    // 新节点落在当前视口中心附近的空位（碰撞避让）；不再强制 fitView 打断用户视口
    const center = screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? 0) / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? 0) / 2,
    });
    const position = findOpenPosition(center, controllerRef.current.nodes, kind);
    await addNodeWithDefaults(kind, position);
  }, [addNodeWithDefaults, screenToFlowPosition]);

  const onNodeClick: NodeMouseHandler = useCallback(() => {
    setDropMenu(null);
    setContextMenu(null);
  }, []);

  /**
   * 选择变化回传必须保持回调身份稳定：React Flow 的 SelectionListener 效应把回调列进依赖，
   * 内联箭头每次渲染都换新会让效应反复重触（editor-store 侧另有内容去重兜底），
   * 历史上这套组合形成「渲染→效应→setState→渲染」死循环，把路由过渡永久饿死。
   */
  const onFlowSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: CanvasFlowNode[] }) => {
    controllerRef.current.onSelectionChange(selectedNodes.map((node) => node.id));
  }, []);

  /** 右键空白：此处添加节点／粘贴／适配视图。创建坐标必须用屏幕坐标换算。 */
  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const flowPosition = screenToFlowPosition(point);
    setDropMenu(null);
    setContextMenu({
      x: point.x - (bounds?.left ?? 0),
      y: point.y - (bounds?.top ?? 0),
      items: [
        ...CANVAS_NODE_KIND_SPECS.map((spec) => ({
          label: `添加${spec.label}`,
          onClick: () => {
            const position = findOpenPosition(flowPosition, controllerRef.current.nodes, spec.kind);
            void addNodeWithDefaults(spec.kind, position);
          },
        })),
        {
          label: '粘贴',
          disabled: !controllerRef.current.hasClipboard,
          onClick: () => { void controllerRef.current.pasteClipboard(); },
        },
        { label: '适配视图', onClick: fitAll },
      ],
    });
  }, [addNodeWithDefaults, fitAll, screenToFlowPosition]);

  /** 右键节点：独占选中后提供重命名／复制／再制／删除（生成节点另有运行分支）。 */
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: CanvasFlowNode) => {
    event.preventDefault();
    controllerRef.current.onNodesChange(
      controllerRef.current.nodes.map((candidate): NodeChange<CanvasFlowNode> => (
        { type: 'select', id: candidate.id, selected: candidate.id === node.id }
      )),
    );
    const bounds = wrapperRef.current?.getBoundingClientRect();
    setDropMenu(null);
    const isGeneration = node.type === 'image-generation' || node.type === 'video-generation';
    setContextMenu({
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
      items: [
        { label: '重命名', testId: 'context-rename', onClick: () => setRenamingNodeId(node.id) },
        { label: '复制', testId: 'context-copy', onClick: () => controllerRef.current.copySelection() },
        {
          label: '再制',
          testId: 'context-duplicate',
          onClick: () => {
            controllerRef.current.copySelection();
            void controllerRef.current.pasteClipboard();
          },
        },
        ...(isGeneration ? [{
          label: '运行分支',
          testId: 'context-run-branch',
          onClick: () => { void controllerRef.current.previewBranch(node.id, true); },
        }] : []),
        { label: '删除', danger: true, testId: 'context-delete', onClick: () => controllerRef.current.deleteSelection() },
      ],
    });
  }, []);

  /** 右键连线：删除连线（对应参考槽位随对账一并移除）。 */
  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.preventDefault();
    const bounds = wrapperRef.current?.getBoundingClientRect();
    setDropMenu(null);
    setContextMenu({
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
      items: [{
        label: '删除连线',
        danger: true,
        testId: 'context-delete-edge',
        onClick: () => controllerRef.current.deleteEdge(edge.id),
      }],
    });
  }, []);

  const contextValue = useMemo(() => ({
    controller,
    renamingNodeId,
    finishRenaming,
    capabilities,
    graph,
    resolveSourceAssetId,
  }), [capabilities, controller, graph, resolveSourceAssetId, renamingNodeId, finishRenaming]);

  return (
    <CanvasNodeContext.Provider value={contextValue}>
      <div className="flex min-h-0 w-full flex-1 flex-col bg-surface" data-testid="canvas-editor">
        <header className="sc-canvas-toolbar">
          <Link className="sc-canvas-button" href="/canvas">← 画布列表</Link>
          <span className="text-[13px] font-semibold" data-testid="canvas-name">{controller.name || '创作画布'}</span>
          {/* 固定最小宽度：保存状态文案在「保存中…／已保存」之间切换时不能挤动右侧按钮 */}
          <span
            className="inline-block min-w-[56px] text-[11px] text-ink-secondary"
            data-testid="save-state"
          >
            {SAVE_LABELS[controller.saveState] ?? controller.saveState}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {CANVAS_NODE_KIND_SPECS.map((spec) => (
              <button
                key={spec.kind}
                type="button"
                className="nodrag sc-canvas-button"
                data-testid={`add-${spec.kind}`}
                onClick={() => { void addAtCenter(spec.kind); }}
              >
                + {spec.label}
              </button>
            ))}
            <button type="button" className="sc-canvas-button" data-testid="fit-view" onClick={fitAll}>
              适配视图
            </button>
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="undo"
              data-history={`${controller.historyDepth.past}/${controller.historyDepth.future}`}
              disabled={!controller.canUndo}
              onClick={controller.undo}
            >
              撤销
            </button>
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="redo"
              data-history={`${controller.historyDepth.past}/${controller.historyDepth.future}`}
              disabled={!controller.canRedo}
              onClick={controller.redo}
            >
              重做
            </button>
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="export-selection"
              disabled={exporting}
              onClick={() => { void exportSelection(); }}
            >
              打包选中
            </button>
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="toggle-tasks"
              onClick={() => setDrawerOpen((value) => !value)}
            >
              任务
            </button>
            <button type="button" className="sc-canvas-button" data-testid="toggle-logs"
              onClick={(event) => { event.currentTarget.blur(); setLogTarget({ canvasId }); }}>
              运行日志
            </button>
          </div>
        </header>

        {executor === 'disabled' ? (
          <div className="sc-canvas-banner" data-testid="executor-banner">
            当前执行器为 disabled：可以编辑画布，但点击生成不会启动任务。
          </div>
        ) : null}
        {executor === 'fixture' ? (
          <div className="sc-canvas-banner sc-canvas-banner-warning" data-testid="fixture-banner">
            测试模式：当前使用本地 fixture 执行器，产物是测试数据，不代表真实模型能力。
          </div>
        ) : null}
        {controller.saveState === 'conflict' ? (
          <div className="sc-canvas-banner sc-canvas-banner-warning" data-testid="save-conflict">
            画布已在别处被修改，本地草稿已保留。
            <button type="button" className="nodrag sc-canvas-button ml-2" data-testid="reload-canvas" onClick={() => { void controller.reload(); }}>
              重新加载
            </button>
            <button
              type="button"
              className="nodrag sc-canvas-button ml-2"
              data-testid="copy-draft-json"
              onClick={() => {
                const graph = buildCanvasGraph(controllerRef.current.nodes, controllerRef.current.edges);
                void navigator.clipboard.writeText(JSON.stringify(graph, null, 2))
                  .then(() => toasts.push('success', '本地草稿已复制到剪贴板。'))
                  .catch(() => toasts.push('error', '复制失败：浏览器未授权剪贴板。'));
              }}
            >
              复制本地草稿 JSON
            </button>
          </div>
        ) : null}

        {controller.branchPreview ? (
          <div className="sc-canvas-banner" data-testid="branch-preview">
            分支预览：将运行 {controller.branchPreview.plan.tasks.length} 个节点
            {controller.branchPreview.plan.reused.length > 0
              ? `，复用 ${controller.branchPreview.plan.reused.length} 个已有结果`
              : ''}
            <button type="button" className="sc-canvas-button ml-2" data-testid="confirm-branch" onClick={() => { void controller.confirmBranch(); }}>
              确认启动
            </button>
            <button type="button" className="sc-canvas-button ml-2" onClick={controller.cancelBranchPreview}>
              取消
            </button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div
            ref={wrapperRef}
            className="relative min-h-0 flex-1"
            onDrop={(event) => { void onDrop(event); }}
            onDragOver={(event) => event.preventDefault()}
            data-testid="canvas-surface"
          >
            <ReactFlow
              nodes={controller.nodes}
              edges={controller.edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={CANVAS_EDGE_TYPES}
              onNodesChange={controller.onNodesChange}
              onEdgesChange={controller.onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onNodeDragStart={controller.onNodeDragStart}
              onSelectionChange={onFlowSelectionChange}
              onNodeClick={onNodeClick}
              onPaneContextMenu={onPaneContextMenu}
              onNodeContextMenu={onNodeContextMenu}
              onEdgeContextMenu={onEdgeContextMenu}
              deleteKeyCode={null}
              multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
              selectionKeyCode={null}
              selectionOnDrag
              panOnDrag={[1]}
              zoomOnScroll={false}
              panOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              {...(initialViewport ? { defaultViewport: initialViewport } : {})}
              onMoveStart={onMoveStart}
              onMoveEnd={onMoveEnd}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--color-canvas-grid-dot)" />
              <Controls showInteractive={false} />
              {miniMapVisible ? (
                <div
                  className="contents"
                  title="点击定位 · 拖动平移 · 右键隐藏"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMiniMapVisible(false);
                    setContextMenu(null);
                    setDropMenu(null);
                  }}
                >
                  <MiniMap
                    pannable
                    zoomable
                    ariaLabel="画布小地图，点击定位，右键隐藏"
                    onClick={(_event, position) => {
                      void setCenter(position.x, position.y, { zoom: getViewport().zoom, duration: 180 });
                    }}
                  />
                </div>
              ) : (
                <Panel position="bottom-right">
                  <button
                    type="button"
                    className="nodrag sc-canvas-button bg-surface"
                    data-testid="show-minimap"
                    onClick={(event) => {
                      event.currentTarget.blur();
                      setMiniMapVisible(true);
                    }}
                  >
                    显示小地图
                  </button>
                </Panel>
              )}
            </ReactFlow>

            {dropMenu ? (
              <div
                ref={dropMenuRef}
                className="sc-canvas-menu"
                style={{ left: dropMenu.localX, top: dropMenu.localY }}
                data-testid="connection-menu"
              >
                {CANVAS_NODE_KIND_SPECS.filter((spec) => canConnectKindTo(graph, dropMenu.fromNodeId, spec.kind)).map((spec) => (
                  <button
                    key={spec.kind}
                    type="button"
                    className="nodrag sc-canvas-menu-item"
                    data-testid={`menu-${spec.kind}`}
                    onClick={() => { void createFromMenu(spec.kind); }}
                  >
                    {spec.label}
                  </button>
                ))}
                {dropMenuResultAssetId ? (
                  <button
                    type="button"
                    className="nodrag sc-canvas-menu-item"
                    data-testid="menu-material-from-result"
                    onClick={() => { void materializeResult(); }}
                  >
                    素材（当前结果）
                  </button>
                ) : null}
              </div>
            ) : null}
            {contextMenu ? (
              <ContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                items={contextMenu.items}
                onClose={() => setContextMenu(null)}
              />
            ) : null}
          </div>

          {drawerOpen ? (
            <CanvasTaskDrawer canvasId={canvasId} knownNodeIds={knownNodeIds} onLocate={onLocate} onShowLogs={(task) => setLogTarget({ canvasId: task.canvasId, jobId: task.id })} />
          ) : null}
        </div>
      </div>
      <LogDrawer open={logTarget !== null} logsUrl={logTarget ? `/api/canvas/${logTarget.canvasId}/logs` : undefined}
        jobId={logTarget?.jobId} autoRefresh onClose={() => setLogTarget(null)}
        description={logTarget?.jobId ? `任务 ${logTarget.jobId} · 最近 300 条日志` : '当前画布 · 最近 300 条日志，可筛选和复制错误'} />
    </CanvasNodeContext.Provider>
  );
}

export function CanvasEditor({ canvasId }: { canvasId: string }) {
  return (
    <ReactFlowProvider>
      <CanvasToastProvider>
        <EditorInner canvasId={canvasId} />
      </CanvasToastProvider>
    </ReactFlowProvider>
  );
}
