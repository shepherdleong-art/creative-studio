'use client';

/**
 * 画布多选复制／粘贴（从 editor-store 拆出）。
 * 粘贴走服务端 /copies 幂等接口（服务端重分配全部 ID、映射内部连线、
 * 保留范围外输入引用与结果资产）；本地只存剪贴板快照。
 */

import { useCallback, useRef, useState } from 'react';
import type { Edge } from '@xyflow/react';
import { canvasApi } from '../api';
import type { CanvasGraphEdge, CanvasGraphNode } from '@/lib/creative-canvas/types';
import { useCanvasToasts } from '../canvas-toasts';
import { canvasErrorText } from '../error-copy';
import type { CanvasFlowNode } from '../editor-store';
import type { CanvasRuntimeStore } from '../runtime-store';
import { buildCanvasGraph, CANVAS_EDGE_MARKER_END, toFlowNode } from './graph-mapping';

interface ClipboardPayload {
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
  resultAssetIds: Record<string, string | null>;
}

export interface CanvasClipboard {
  hasClipboard: boolean;
  copySelection: () => void;
  pasteClipboard: () => Promise<void>;
}

export function useCanvasClipboard(options: {
  canvasId: string;
  nodesRef: React.MutableRefObject<CanvasFlowNode[]>;
  edgesRef: React.MutableRefObject<Edge[]>;
  revisionRef: React.MutableRefObject<number>;
  runtime: CanvasRuntimeStore;
  setGraphState: (nodes: CanvasFlowNode[], edges: Edge[]) => void;
  pushHistory: () => void;
  saveWithCoalescing: () => Promise<boolean>;
  /** 粘贴成功后复位保存基准（图与服务器一致，revision 由服务端返回）。 */
  onPasted: (revision: number) => void;
}): CanvasClipboard {
  const {
    canvasId, nodesRef, edgesRef, revisionRef, runtime,
    setGraphState, pushHistory, saveWithCoalescing, onPasted,
  } = options;
  const toasts = useCanvasToasts();
  const [hasClipboard, setHasClipboard] = useState(false);
  const clipboardRef = useRef<ClipboardPayload | null>(null);

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
    toasts.push('success', `已复制 ${selected.length} 个节点`);
  }, [nodesRef, edgesRef, runtime, toasts]);

  const pasteClipboard = useCallback(async () => {
    const clipboard = clipboardRef.current;
    if (!clipboard) return;
    const saved = await saveWithCoalescing();
    if (!saved) {
      toasts.push('error', '有未保存的修改，暂时无法粘贴：请先处理保存冲突。');
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
        markerEnd: CANVAS_EDGE_MARKER_END,
      }));
      pushHistory();
      setGraphState([...deselected, ...appendedNodes], [...edgesRef.current, ...appendedEdges]);
      onPasted(copy.graphRevision);
      toasts.push('success', `已粘贴 ${appendedNodes.length} 个节点`);
      const { canvas } = await canvasApi.get(canvasId);
      runtime.update(canvas.nodeStates, canvas.tasks ?? [], canvas.nodeCandidates ?? []);
    } catch (error) {
      toasts.push('error', `粘贴失败：${canvasErrorText(error)}`);
    }
  }, [canvasId, edgesRef, nodesRef, pushHistory, revisionRef, runtime, saveWithCoalescing, setGraphState, toasts]);

  return { hasClipboard, copySelection, pasteClipboard };
}
