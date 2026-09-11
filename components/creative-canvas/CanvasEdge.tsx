'use client';

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useContext } from 'react';
import { CanvasNodeContext } from './node-context';

/** 连线上的 ×：只解除引用，节点与当前结果保留。 */
export function CanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const context = useContext(CanvasNodeContext);
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
        style={{
          stroke: selected ? 'var(--color-accent)' : 'var(--color-ink-tertiary)',
          strokeWidth: selected ? 2 : 1.5,
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label="断开连线"
          data-testid={`edge-delete-${id}`}
          className="sc-canvas-edge-delete nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(event) => {
            event.stopPropagation();
            context?.controller.deleteEdge(id);
          }}
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const CANVAS_EDGE_TYPES = { canvas: CanvasEdge };
