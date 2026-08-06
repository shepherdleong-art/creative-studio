import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import type { EnsureMixcutDraftInput } from '@/lib/final-edit/workspace';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id: projectId } = await params;
    const body = await request.json() as Omit<EnsureMixcutDraftInput, 'projectId'>;
    return NextResponse.json(getFinalEditWorkspace().ensureMixcutDraft({
      projectId,
      shotSetId: String(body.shotSetId || ''),
      scriptDraftId: String(body.scriptDraftId || ''),
      editedNarrationText: String(body.editedNarrationText || ''),
      selectedMaterialKeys: Array.isArray(body.selectedMaterialKeys) ? body.selectedMaterialKeys.map(String) : [],
      providerId: String(body.providerId || ''),
      voice: String(body.voice || ''),
      speed: Number(body.speed ?? 1),
      analysisProviderId: String(body.analysisProviderId || ''),
    }), { status: 201 });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
