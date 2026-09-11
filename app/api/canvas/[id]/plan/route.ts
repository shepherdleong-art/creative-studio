import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import { planCanvasRun, type CanvasPlanMode } from '@/lib/creative-canvas/planner';
import {
  assertCanvasApiReady,
  canvasJsonError,
  readCanvasJson,
} from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

function planRequestFromBody(canvasId: string, body: Record<string, unknown>) {
  const mode = body.mode === 'branch' ? 'branch' as CanvasPlanMode : 'single' as CanvasPlanMode;
  return {
    canvasId,
    mode,
    ...(body.targetNodeId === undefined ? {} : { targetNodeId: String(body.targetNodeId) }),
    ...(body.startNodeId === undefined ? {} : { startNodeId: String(body.startNodeId) }),
    ...(body.reuseStart === undefined ? {} : { reuseStart: Boolean(body.reuseStart) }),
    requestKey: body.requestKey === undefined ? '' : String(body.requestKey),
  };
}

/** 单点／分支计划预检：只读当前图与任务状态，不产生任何写入。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    const body = await readCanvasJson(request);
    const outcome = planCanvasRun(getDb(), planRequestFromBody(id, body));
    if (!outcome.ok) {
      throw new CanvasError('invalid_input', outcome.problems[0]?.message ?? '计划校验未通过。', {
        problems: outcome.problems,
      });
    }
    return NextResponse.json({ plan: outcome.plan });
  } catch (error) {
    return canvasJsonError(error);
  }
}
