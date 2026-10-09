import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; videoJobId: string }> }) {
  try {
    const { id, videoJobId } = await params;
    return NextResponse.json(await getFinalEditWorkspace().reanalyzeAsset(id, videoJobId));
  } catch (error) { return finalEditErrorResponse(error); }
}
