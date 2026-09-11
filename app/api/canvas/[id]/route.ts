import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { CanvasError } from '@/lib/creative-canvas/errors';
import {
  listCanvasNodeStates,
  renameCanvas,
  requireCanvas,
  saveCanvasGraph,
  saveCanvasViewport,
} from '@/lib/creative-canvas/repository';
import { listCanvasTasks } from '@/lib/creative-canvas/tasks';
import {
  assertCanvasApiReady,
  canvasJsonError,
  readCanvasJson,
} from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

function canvasView(canvasId: string) {
  const canvas = requireCanvas(getDb(), canvasId);
  return {
    id: canvas.id,
    name: canvas.name,
    graphRevision: canvas.graphRevision,
    graph: canvas.graph,
    viewport: canvas.viewport,
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt,
    nodeStates: listCanvasNodeStates(getDb(), canvasId),
    // 节点状态要显示真实阶段（排队／生成／下载），所以带上本画布的近期任务
    tasks: listCanvasTasks(getDb(), { canvasId, limit: 100 }).map((task) => ({
      id: task.id,
      runId: task.runId,
      canvasId: task.canvasId,
      nodeId: task.nodeId,
      mediaKind: task.mediaKind,
      phase: task.phase,
      submissionState: task.submissionState,
      // 远端任务 ID 不是密钥：恢复流程（待核查时填入远端 ID）与样本回执都需要它
      providerTaskId: task.providerTaskId,
      slotHeld: task.slotHeld,
      outputAssetId: task.outputAssetId,
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,
      cancelRequestedAt: task.cancelRequestedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    return NextResponse.json({ canvas: canvasView(id) });
  } catch (error) {
    return canvasJsonError(error);
  }
}

/**
 * 一个端点覆盖三类互斥写入：图定义（带期望修订号）、名称、视口。
 * 运行投影（currentAssetId / activeTaskId）不接受客户端写入——图里出现这些字段会被解析层拒绝。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    const body = await readCanvasJson(request);

    if (body.graph !== undefined) {
      if (body.expectedGraphRevision === undefined) {
        throw new CanvasError('invalid_input', '保存编辑定义必须携带期望的图修订号。');
      }
      const result = saveCanvasGraph({
        db: getDb(),
        canvasId: id,
        expectedGraphRevision: Number(body.expectedGraphRevision),
        graph: body.graph,
        ...(body.viewport === undefined ? {} : { viewport: body.viewport }),
      });
      return NextResponse.json({
        canvas: {
          id,
          graphRevision: result.graphRevision,
          graph: result.graph,
          nodeStates: result.nodeStates,
          updatedAt: result.updatedAt,
        },
      });
    }

    if (body.name !== undefined) {
      const canvas = renameCanvas(getDb(), { canvasId: id, name: String(body.name) });
      return NextResponse.json({ canvas: canvasView(canvas.id) });
    }

    if (body.viewport !== undefined) {
      const canvas = saveCanvasViewport(getDb(), { canvasId: id, viewport: body.viewport });
      return NextResponse.json({ canvas: canvasView(canvas.id) });
    }

    throw new CanvasError('invalid_input', '请求没有包含可保存的内容。');
  } catch (error) {
    return canvasJsonError(error);
  }
}
