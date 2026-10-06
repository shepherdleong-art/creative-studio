import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertCanvasApiReady, canvasJsonError } from '@/lib/creative-canvas/http';
import { requireCanvas } from '@/lib/creative-canvas/repository';
import { getCanvasLogs } from '@/lib/creative-canvas/logs';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertCanvasApiReady();
    const { id } = await params;
    const db = getDb();
    requireCanvas(db, id);
    const query = new URL(request.url).searchParams;
    return NextResponse.json(getCanvasLogs(db, id, {
      jobId: query.get('jobId') || undefined,
      limit: Number(query.get('limit') ?? 300),
    }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return canvasJsonError(error);
  }
}
