import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; shotSetId: string; assetId: string }> },
) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id: projectId, shotSetId, assetId } = await params;
    return NextResponse.json(getFinalEditWorkspace().deleteShotSetExternalAsset({ projectId, shotSetId, assetId }));
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
