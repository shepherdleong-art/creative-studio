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
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type FinalConnectionState,
  type NodeMouseHandler,
} from '@xyflow/react';
import { checkCanvasConnection, parseCanvasGraph } from '@/lib/creative-canvas/graph';
import type { CanvasGraph, CanvasNodeKind, CanvasViewport } from '@/lib/creative-canvas/types';
import { canvasApi } from './api';
import { CANVAS_EDGE_TYPES } from './CanvasEdge';
import { CanvasTaskDrawer } from './CanvasTaskDrawer';
import { buildCanvasGraph, useCanvasEditor, type CanvasEditorController } from './editor-store';
import { CanvasNodeContext, type CanvasModelCapabilityDto } from './node-context';
import { GenerationNode, MaterialNode, PromptNode } from './nodes';

const NODE_TYPES = {
  material: MaterialNode,
  prompt: PromptNode,
  'image-generation': GenerationNode,
  'video-generation': GenerationNode,
};

const NODE_LABELS: Array<{ kind: CanvasNodeKind; label: string }> = [
  { kind: 'material', label: '素材' },
  { kind: 'prompt', label: '提示词' },
  { kind: 'image-generation', label: '图片生成' },
  { kind: 'video-generation', label: '视频生成' },
];

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
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow();
  const [initialViewport, setInitialViewport] = useState<{ x: number; y: number; zoom: number } | undefined>();
  const [capabilities, setCapabilities] = useState<CanvasModelCapabilityDto[]>([]);
  const [executor, setExecutor] = useState<string>('disabled');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dropMenu, setDropMenu] = useState<{ fromNodeId: string; x: number; y: number } | null>(null);
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
            controllerRef.current.showStatus(`视口自动保存失败：${error instanceof Error ? error.message : '请稍后重试。'}`);
          }
        }
      });
  }, [canvasId, getViewport]);

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

  const contextValue = useMemo(() => ({
    controller,
    capabilities,
    graph,
    resolveSourceAssetId,
  }), [capabilities, controller, graph, resolveSourceAssetId]);

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
    // 菜单挂在 wrapper 内，坐标要换算成相对 wrapper 的位置
    const bounds = wrapperRef.current?.getBoundingClientRect();
    setDropMenu({ fromNodeId, x: point.x - (bounds?.left ?? 0), y: point.y - (bounds?.top ?? 0) });
  }, []);

  const createFromMenu = useCallback(async (kind: CanvasNodeKind) => {
    const menu = dropMenu;
    if (!menu) return;
    setDropMenu(null);
    const position = screenToFlowPosition({ x: menu.x, y: menu.y });
    await controllerRef.current.addNode(kind, position, { connectFrom: menu.fromNodeId });
  }, [dropMenu, screenToFlowPosition]);

  // 键盘快捷键：焦点在文本框时全部让位给正常编辑
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDropMenu(null);
        controllerRef.current.cancelBranchPreview();
        return;
      }
      if (isEditableTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
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
  }, []);

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
      controllerRef.current.showStatus('请先选中至少一个有结果的生成节点。');
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
        controllerRef.current.showStatus(
          `导出失败（${response.status}）：${payload.message ?? '服务端未返回下载入口'}`,
        );
        return;
      }
      const itemCount = payload.export.manifest?.items?.length ?? 0;
      const skipped = payload.export.manifest?.skipped?.length ?? 0;
      controllerRef.current.showStatus(`已打包 ${itemCount} 个结果${skipped > 0 ? `，跳过 ${skipped} 个不可导出节点` : ''}，开始下载。`);
      window.location.href = payload.export.downloadUrl;
    } catch (error) {
      controllerRef.current.showStatus(`导出请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }, [canvasId]);

  const fitAll = useCallback(() => {
    void fitView({ padding: 0.12, maxZoom: 1, duration: 200 });
  }, [fitView]);

  const addAtCenter = useCallback(async (kind: CanvasNodeKind) => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    // 新节点落在当前可见区域的左上角按网格排布，避免叠在一起或跑到视口外
    const base = screenToFlowPosition({
      x: (bounds?.left ?? 0) + 48,
      y: (bounds?.top ?? 0) + 48,
    });
    const index = controllerRef.current.nodes.length;
    const position = {
      x: base.x + (index % 2) * 340,
      y: base.y + Math.floor(index / 2) * 320,
    };
    await controllerRef.current.addNode(kind, position);
    fitAll();
  }, [fitAll, screenToFlowPosition]);

  const onNodeClick: NodeMouseHandler = useCallback(() => {
    setDropMenu(null);
  }, []);

  return (
    <CanvasNodeContext.Provider value={contextValue}>
      <div className="flex h-dvh w-full flex-col bg-surface" data-testid="canvas-editor">
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
            {NODE_LABELS.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                className="sc-canvas-button"
                data-testid={`add-${entry.kind}`}
                onClick={() => { void addAtCenter(entry.kind); }}
              >
                + {entry.label}
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
            <button type="button" className="sc-canvas-button ml-2" data-testid="reload-canvas" onClick={() => { void controller.reload(); }}>
              重新加载
            </button>
          </div>
        ) : null}
        {controller.statusMessage ? (
          <div className="sc-canvas-banner" data-testid="status-message">{controller.statusMessage}</div>
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
              onSelectionChange={({ nodes }) => controller.onSelectionChange(nodes.map((node) => node.id))}
              onNodeClick={onNodeClick}
              deleteKeyCode={null}
              multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
              selectionOnDrag
              panOnDrag={[1, 2]}
              {...(initialViewport ? { defaultViewport: initialViewport } : {})}
              onMoveStart={onMoveStart}
              onMoveEnd={onMoveEnd}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable />
            </ReactFlow>

            {dropMenu ? (
              <div
                className="sc-canvas-menu"
                style={{ left: dropMenu.x, top: dropMenu.y }}
                data-testid="connection-menu"
              >
                {NODE_LABELS.filter((entry) => canConnectKind(graph, dropMenu.fromNodeId, entry.kind)).map((entry) => (
                  <button
                    key={entry.kind}
                    type="button"
                    className="sc-canvas-menu-item"
                    data-testid={`menu-${entry.kind}`}
                    onClick={() => { void createFromMenu(entry.kind); }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {drawerOpen ? (
            <CanvasTaskDrawer canvasId={canvasId} knownNodeIds={knownNodeIds} onLocate={onLocate} />
          ) : null}
        </div>
      </div>
    </CanvasNodeContext.Provider>
  );
}

function canConnectKind(graph: CanvasGraph, fromNodeId: string, kind: CanvasNodeKind): boolean {
  const edge = { id: 'probe', source: fromNodeId, target: 'probe-target' };
  const source = graph.nodes.find((node) => node.id === fromNodeId);
  const probeNode = {
    id: 'probe-target',
    kind,
    position: { x: 0, y: 0 },
    data: probeDataFor(kind),
  } as unknown as CanvasGraph['nodes'][number];
  const probeGraph: CanvasGraph = { ...graph, nodes: [...graph.nodes, probeNode] };
  if (!source) return true;
  return checkCanvasConnection(probeGraph, edge).ok;
}

function probeDataFor(kind: CanvasNodeKind) {
  if (kind === 'material') return { title: '', assetId: null, mediaKind: 'image' };
  if (kind === 'prompt') return { title: '', text: '' };
  return {
    title: '',
    modelKey: null,
    generationMode: kind === 'image-generation' ? 'image-to-image' : 'image-to-video',
    prompt: '',
    parameters: {},
    references: [],
    referenceLabelCounter: 0,
  };
}

export function CanvasEditor({ canvasId }: { canvasId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner canvasId={canvasId} />
    </ReactFlowProvider>
  );
}
