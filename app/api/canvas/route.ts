import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createCanvas, listCanvases } from '@/lib/creative-canvas/repository';
import {
  assertCanvasApiReady,
  canvasJsonError,
  readCanvasJson,
} from '@/lib/creative-canvas/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

async function __teamRouteGET() {
  try {
    await assertCanvasApiReady();
    return NextResponse.json({ canvases: listCanvases(getDb()) });
  } catch (error) {
    return canvasJsonError(error);
  }
}

async function __teamRoutePOST(request: Request) {
  try {
    await assertCanvasApiReady();
    const body = await readCanvasJson(request);
    const canvas = createCanvas(getDb(), { name: String(body.name ?? ''), ownerUserId: body.ownerUserId as string | undefined });
    return NextResponse.json({
      canvas: {
        id: canvas.id,
        name: canvas.name,
        graphRevision: canvas.graphRevision,
        graph: canvas.graph,
        viewport: canvas.viewport,
        createdAt: canvas.createdAt,
        updatedAt: canvas.updatedAt,
        nodeStates: [],
      },
    }, { status: 201 });
  } catch (error) {
    return canvasJsonError(error);
  }
}
export const GET = withTeamRoute('/api/canvas', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/canvas', 'POST', __teamRoutePOST);
