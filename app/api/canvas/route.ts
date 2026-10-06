import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createCanvas, listCanvases } from '@/lib/creative-canvas/repository';
import {
  assertCanvasApiReady,
  canvasJsonError,
  readCanvasJson,
} from '@/lib/creative-canvas/http';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await assertCanvasApiReady();
    return NextResponse.json({ canvases: listCanvases(getDb()) });
  } catch (error) {
    return canvasJsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCanvasApiReady();
    const body = await readCanvasJson(request);
    const canvas = createCanvas(getDb(), { name: String(body.name ?? '') });
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
