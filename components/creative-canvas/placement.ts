/**
 * 节点落位工具：新节点（工具栏创建／拉线派生）的碰撞避让。
 * 用 React Flow v12 的 measured 实测尺寸建 AABB；测量缺失（首帧）退回
 * 按节点种类的估算尺寸。避让策略：保持期望 x，沿 y 向下步进直到找到
 * 与既有节点都不重叠（含 24px 呼吸间距）的位置，最多 40 步。
 */

import type { Node, XYPosition } from '@xyflow/react';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 与 nodes.tsx 的卡片宽度对齐；measured 缺失时的兜底估算。 */
const FALLBACK_SIZE: Record<string, { width: number; height: number }> = {
  material: { width: 200, height: 200 },
  prompt: { width: 220, height: 170 },
  'image-generation': { width: 300, height: 420 },
  'video-generation': { width: 300, height: 440 },
};

const DEFAULT_SIZE = { width: 280, height: 260 };
const SPACING = 24;
const STEP = 80;
const MAX_STEPS = 40;

function nodeRect(node: Node): Rect {
  const fallback = FALLBACK_SIZE[node.type ?? ''] ?? DEFAULT_SIZE;
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? fallback.width,
    height: node.measured?.height ?? fallback.height,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x - SPACING < b.x + b.width + SPACING
    && b.x - SPACING < a.x + a.width + SPACING
    && a.y - SPACING < b.y + b.height + SPACING
    && b.y - SPACING < a.y + a.height + SPACING;
}

export function findOpenPosition(desired: XYPosition, nodes: Node[], kind: string): XYPosition {
  const size = FALLBACK_SIZE[kind] ?? DEFAULT_SIZE;
  const rects = nodes.map(nodeRect);
  const candidate = (position: XYPosition): Rect => ({ ...size, x: position.x, y: position.y });
  if (!rects.some((rect) => overlaps(candidate(desired), rect))) return desired;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const position = { x: desired.x, y: desired.y + step * STEP };
    if (!rects.some((rect) => overlaps(candidate(position), rect))) return position;
  }
  return { x: desired.x, y: desired.y + MAX_STEPS * STEP };
}
