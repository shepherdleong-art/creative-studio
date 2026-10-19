import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { OutputPresetId } from '@/lib/final-edit/types';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const body = await request.json() as { scriptDraftId?: string; shotSetId?: string; editedNarrationText?: string; selectedMaterialKeys?: string[]; count?: number; outputPreset?: OutputPresetId; providerId?: string; voice?: string; speed?: number; analysisProviderId?: string };
    const result = await getFinalEditWorkspace().preflight({ projectId, scriptDraftId: String(body.scriptDraftId || ''), shotSetId: body.shotSetId, editedNarrationText: body.editedNarrationText, selectedMaterialKeys: body.selectedMaterialKeys, count: Number(body.count || 2), outputPreset: body.outputPreset || '3x4', providerId: body.providerId, voice: body.voice, speed: body.speed, analysisProviderId: body.analysisProviderId });
    return NextResponse.json(result);
  } catch (error) { return finalEditErrorResponse(error); }
}
