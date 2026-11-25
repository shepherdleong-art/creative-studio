import type Database from 'better-sqlite3';
import { referenceVideoDurationSec } from '../minimax-h3-pricing.ts';
import type { CanvasTaskRecord } from './tasks.ts';

export function readCanvasReferenceVideoDuration(db: Database.Database, task: CanvasTaskRecord, generationMode: unknown): number | null {
  if (generationMode !== 'reference-to-video') return 0;
  // Use frozen task inputs and only resolve upstream results owned by this canvas.
  const references = db.prepare(`SELECT a.mediaKind AS kind, a.durationSec
    FROM creative_canvas_task_inputs i
    LEFT JOIN creative_canvas_tasks upstream ON upstream.id = i.upstreamTaskId AND upstream.canvasId = ?
    LEFT JOIN creative_canvas_assets a ON a.id = COALESCE(i.resolvedAssetId, i.assetId, upstream.outputAssetId)
      AND a.canvasId = ? AND a.ready = 1
    WHERE i.taskId = ? AND i.textContent IS NULL ORDER BY i.orderIndex`)
    .all(task.canvasId, task.canvasId, task.id) as { kind: string | null; durationSec: number | null }[];
  return referenceVideoDurationSec(references);
}
