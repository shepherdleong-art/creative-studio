import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { wakeFinalEditWorker } from '@/lib/final-edit/worker';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: variantId } = await params;
    const body = await request.json() as { groupId?: string; expectedGroupRevision?: number; expectedVariantRevision?: number; overlayBundleId?: string };
    const result = await getFinalEditWorkspace().enqueueRender({ groupId: String(body.groupId || ''), variantId, expectedGroupRevision: Number(body.expectedGroupRevision), expectedVariantRevision: Number(body.expectedVariantRevision), overlayBundleId: String(body.overlayBundleId || '') });
    wakeFinalEditWorker();
    return NextResponse.json(result, { status: 202 });
  } catch (error) { return finalEditErrorResponse(error); }
}
