import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { startFinalEditFromHttp, type FinalEditStartBody } from '@/lib/final-edit/start-http';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    return NextResponse.json(await startFinalEditFromHttp(projectId, await request.json() as FinalEditStartBody), { status: 202 });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
