import { writeCanvasLog } from '@/lib/creative-canvas/logs';
import { requireCanvas } from '@/lib/creative-canvas/repository';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import type { CanvasPlanMode } from '@/lib/creative-canvas/planner';
import { startCanvasRun } from '@/lib/creative-canvas/runs';
import { normalizeVariantCount } from '@/lib/creative-canvas/planner';
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
  let logCanvasId: string | undefined;
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    requireCanvas(getDb(), id);
    logCanvasId = id;
    const body = await readCanvasJson(request);
    const requestKey = String(body.requestKey ?? '').trim();
    if (!requestKey) throw new CanvasError('invalid_input', '缺少请求标识 requestKey。');
    if (!Number.isInteger(body.expectedGraphRevision) || Number(body.expectedGraphRevision) < 0) {
      throw new CanvasError('invalid_input', '缺少有效的图修订号 expectedGraphRevision。');
    }

    const result = startCanvasRun({
      db: getDb(),
      request: {
        canvasId: id,
        mode: body.mode === 'branch' ? 'branch' as CanvasPlanMode : 'single' as CanvasPlanMode,
        ...(body.targetNodeId === undefined ? {} : { targetNodeId: String(body.targetNodeId) }),
        ...(body.startNodeId === undefined ? {} : { startNodeId: String(body.startNodeId) }),
        ...(body.reuseStart === undefined ? {} : { reuseStart: Boolean(body.reuseStart) }),
        // 变体数量：仅 single 接受 1/2/4；branch 强制 1
        ...((body.mode !== 'single' || body.variantCount === undefined)
          ? {}
          : { variantCount: normalizeVariantCount(Number(body.variantCount)) }),
        requestKey,
        expectedGraphRevision: Number(body.expectedGraphRevision),
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
    if (logCanvasId) writeCanvasLog(getDb(), { canvasId: logCanvasId, level: 'error',
      message: `启动任务失败 · ${error instanceof CanvasError ? error.code + ' · ' : ''}${error instanceof Error ? error.message : String(error)}` });
    return canvasJsonError(error);
  }
}
