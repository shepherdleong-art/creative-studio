import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import type { CanvasPlanMode } from '@/lib/creative-canvas/planner';
import { startCanvasRun } from '@/lib/creative-canvas/runs';
import {
  assertCanvasApiReady,
  canvasJsonError,
  readCanvasJson,
} from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 幂等启动一次运行；数据事务成功后由后端调度器推进，不依赖前端计时器。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    const body = await readCanvasJson(request);
    const requestKey = String(body.requestKey ?? '').trim();
    if (!requestKey) throw new CanvasError('invalid_input', '缺少请求标识 requestKey。');

    const result = startCanvasRun({
      db: getDb(),
      request: {
        canvasId: id,
        mode: body.mode === 'branch' ? 'branch' as CanvasPlanMode : 'single' as CanvasPlanMode,
        ...(body.targetNodeId === undefined ? {} : { targetNodeId: String(body.targetNodeId) }),
        ...(body.startNodeId === undefined ? {} : { startNodeId: String(body.startNodeId) }),
        ...(body.reuseStart === undefined ? {} : { reuseStart: Boolean(body.reuseStart) }),
        requestKey,
      },
      ...(body.planFingerprint === undefined ? {} : { planFingerprint: String(body.planFingerprint) }),
    });

    return NextResponse.json({
      run: {
        id: result.run.id,
        mode: result.run.mode,
        status: result.run.status,
        createdAt: result.run.createdAt,
      },
      plan: result.plan,
      idempotentReplay: result.idempotentReplay,
      tasks: result.tasks.map((task) => ({
        id: task.id,
        nodeId: task.nodeId,
        mediaKind: task.mediaKind,
        phase: task.phase,
        createdAt: task.createdAt,
      })),
    });
  } catch (error) {
    return canvasJsonError(error);
  }
}
