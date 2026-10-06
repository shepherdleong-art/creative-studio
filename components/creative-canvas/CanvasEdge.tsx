'use client';

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useContext } from 'react';
import { CanvasNodeContext } from './node-context';
import { CanvasRuntimeStore, useNodeRuntime } from './runtime-store';

/** context 缺失时的兜底（hooks 不能条件调用）；实际渲染路径中 Provider 必然存在。 */
const FALLBACK_RUNTIME_STORE = new CanvasRuntimeStore();

/**
 * 连线：方向箭头（markerEnd 由边的默认选项统一注入）、下游任务运行中的
 * 流动虚线（按 target 精确订阅运行投影，与节点同机制、不整图重渲染）、
 * 边中点的 ×（只解除引用，节点与当前结果保留；低调常显、hover 增强，纯 CSS）。
 */
export function CanvasEdge({
  id,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  markerEnd,
}: EdgeProps) {
  const context = useContext(CanvasNodeContext);
  const downstream = useNodeRuntime(context?.controller.runtime ?? FALLBACK_RUNTIME_STORE, target);
  const running = Boolean(downstream?.activeTaskId);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={[
          'sc-canvas-edge',
          selected ? 'sc-canvas-edge-selected' : '',
          running ? 'sc-canvas-edge-flowing' : '',
        ].filter(Boolean).join(' ')}
      />
      <EdgeLabelRenderer>
        <div
          className="sc-canvas-edge-delete-anchor nodrag nopan"
          data-testid={`edge-hit-area-${id}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button
            type="button"
            aria-label="断开连线"
            data-testid={`edge-delete-${id}`}
            className="sc-canvas-edge-delete"
            onClick={(event) => {
              event.stopPropagation();
              context?.controller.deleteEdge(id);
            }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const CANVAS_EDGE_TYPES = { canvas: CanvasEdge };
