import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { copyCanvasNodes } from '@/lib/creative-canvas/copy';
import {
  assertCanvasApiReady,
  canvasJsonError,
  readCanvasJson,
} from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

/** 完整节点复制：接收已固定的复制快照，服务端重新分配身份并原子创建副本与连线。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    const body = await readCanvasJson(request);
    const result = copyCanvasNodes(getDb(), {
      canvasId: id,
      request: {
        sourceCanvasId: String(body.sourceCanvasId ?? ''),
        snapshotKey: String(body.snapshotKey ?? ''),
        nodes: body.nodes,
        edges: body.edges,
        resultAssetIds: body.resultAssetIds,
        ...(body.expectedGraphRevision === undefined
          ? {}
          : { expectedGraphRevision: Number(body.expectedGraphRevision) }),
      },
    });
    return NextResponse.json({ copy: result });
  } catch (error) {
    return canvasJsonError(error);
  }
}
