import { NextResponse } from 'next/server';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { cancelFinalEditRenderJob } from '@/lib/final-edit/worker';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { checkLocalRequest(request); cancelFinalEditRenderJob((await params).id); return NextResponse.json({ status: 'cancelled' }); }
  catch (error) { return finalEditErrorResponse(error); }
}
