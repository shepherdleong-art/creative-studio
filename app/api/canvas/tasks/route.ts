import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listCanvasTasks } from '@/lib/creative-canvas/tasks';
import {
  assertCanvasApiReady,
  canvasJsonError,
} from '@/lib/creative-canvas/http';
import { CANVAS_TASK_PHASES, type CanvasTaskPhase } from '@/lib/creative-canvas/types';

export const runtime = 'nodejs';

/** 全局任务入口：跨画布的近期任务；只返回界面需要的字段。 */
export async function GET(request: Request) {
  try {
    await assertCanvasApiReady();
    const url = new URL(request.url);
    const canvasId = url.searchParams.get('canvasId') ?? undefined;
    const phaseParam = url.searchParams.get('phase');
    const phases = phaseParam
      ? phaseParam.split(',').filter((value): value is CanvasTaskPhase => (
        CANVAS_TASK_PHASES.includes(value as CanvasTaskPhase)
      ))
      : undefined;
    const limit = Number(url.searchParams.get('limit') ?? 50);

    const db = getDb();
    const tasks = listCanvasTasks(db, {
      ...(canvasId ? { canvasId } : {}),
      ...(phases && phases.length > 0 ? { phases } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });

    const canvasNames = new Map<string, string>();
    for (const row of db.prepare(`SELECT id, name FROM creative_canvases`).all() as Array<{ id: string; name: string }>) {
      canvasNames.set(row.id, row.name);
    }

    return NextResponse.json({
      tasks: tasks.map((task) => ({
        id: task.id,
        runId: task.runId,
        canvasId: task.canvasId,
        canvasName: canvasNames.get(task.canvasId) ?? '',
        nodeId: task.nodeId,
        mediaKind: task.mediaKind,
        phase: task.phase,
        submissionState: task.submissionState,
        slotHeld: task.slotHeld,
        outputAssetId: task.outputAssetId,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        cancelRequestedAt: task.cancelRequestedAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
    });
  } catch (error) {
    return canvasJsonError(error);
  }
}
