'use client';

/**
 * FlowNode ↔ GraphNode 的纯映射（从 editor-store 拆出，供保存管线／剪贴板／
 * 主状态机共享）。拆出原因：save-pipeline 与 clipboard 都需要 buildCanvasGraph，
 * 若留在 editor-store 会形成运行时循环依赖。
 */

import { MarkerType, type Edge } from '@xyflow/react';
import { nodeKindSpec } from '@/lib/creative-canvas/node-kinds';
import type {
  CanvasGenerationMode,
  CanvasGraph,
  CanvasGraphEdge,
  CanvasGraphNode,
  CanvasMediaKind,
  CanvasNodeKind,
  CanvasNodeSize,
} from '@/lib/creative-canvas/types';
import type { CanvasFlowNode, CanvasFlowNodeData } from '../editor-store';

/** 全部连线统一的方向箭头（颜色由 React Flow 默认 marker 提供）。 */
export const CANVAS_EDGE_MARKER_END = { type: MarkerType.ArrowClosed } as const;

export function cloneNodes(nodes: CanvasFlowNode[]): CanvasFlowNode[] {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
    ...(node.style ? { style: { ...node.style } } : {}),
  }));
}

/** 节点当前宽度：缩放后 React Flow 写 node.width（setAttributes），style.width 是加载期默认值。 */
function flowNodeWidth(node: CanvasFlowNode): number | undefined {
  const width = node.width ?? node.style?.width;
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined;
  return Math.round(width);
}

function nodeSizePatch(kind: CanvasNodeKind, node: CanvasFlowNode): { size: CanvasNodeSize } | Record<string, never> {
  const width = flowNodeWidth(node) ?? nodeKindSpec(kind).defaultWidth;
  // measured.height is automatic content measurement, not a user-selected size.
  const rawHeight = kind === 'material' ? undefined : node.height ?? node.style?.height;
  const height = typeof rawHeight === 'number' && Number.isFinite(rawHeight) ? Math.round(rawHeight) : undefined;
  return height !== undefined || width !== nodeKindSpec(kind).defaultWidth
    ? { size: { width, ...(height !== undefined ? { height } : {}) } }
    : {};
}

export function cloneEdges(edges: Edge[]): Edge[] {
  return edges.map((edge) => ({ ...edge }));
}

export function toFlowNode(node: CanvasGraphNode): CanvasFlowNode {
  const style = {
    width: node.size?.width ?? nodeKindSpec(node.kind).defaultWidth,
    // Material content follows its media aspect ratio, including graphs saved with a stale height.
    ...(node.kind !== 'material' && node.size?.height !== undefined ? { height: node.size.height } : {}),
  };
  if (node.kind === 'material') {
    return {
      id: node.id,
      type: 'material',
      position: { ...node.position },
      style,
      data: { title: node.data.title, assetId: node.data.assetId, mediaKind: node.data.mediaKind },
    };
  }
  if (node.kind === 'prompt') {
    return {
      id: node.id,
      type: 'prompt',
      position: { ...node.position },
      style,
      data: { title: node.data.title, text: node.data.text },
    };
  }
  return {
    id: node.id,
    type: node.kind,
    position: { ...node.position },
    style,
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
export function toGraphNode(node: CanvasFlowNode): CanvasGraphNode {
  if (node.type === 'material') {
    return {
      id: node.id,
      kind: 'material',
      position: { x: node.position.x, y: node.position.y },
      ...nodeSizePatch('material', node),
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
      ...nodeSizePatch('prompt', node),
      data: { title: String(node.data.title ?? ''), text: String(node.data.text ?? '') },
    };
  }
  const kind = node.type === 'video-generation' ? 'video-generation' : 'image-generation';
  return {
    id: node.id,
    kind,
    position: { x: node.position.x, y: node.position.y },
    ...nodeSizePatch(kind, node),
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

export function toGraphEdge(edge: Edge): CanvasGraphEdge {
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

export function toFlowEdge(edge: CanvasGraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'canvas',
    markerEnd: CANVAS_EDGE_MARKER_END,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
  };
}
