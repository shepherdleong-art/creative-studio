import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { OutputPresetId } from '@/lib/final-edit/types';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const group = getDb().prepare(`SELECT projectId, scriptDraftId, narrationConfigJson, analysisProviderId FROM final_edit_groups WHERE id=?`).get(id) as { projectId: string; scriptDraftId: string; narrationConfigJson: string; analysisProviderId: string } | undefined;
    if (!group) return NextResponse.json({ error: 'group_not_found' }, { status: 404 });
    const body = await request.json() as { count?: number; outputPreset?: OutputPresetId };
    const narration = JSON.parse(group.narrationConfigJson) as { providerId: string; voice: string; speed: number };
    const job = await getFinalEditWorkspace().start({ projectId: group.projectId, scriptDraftId: group.scriptDraftId, count: Number(body.count || 1), outputPreset: body.outputPreset || '3x4', providerId: narration.providerId, voice: narration.voice, speed: narration.speed, analysisProviderId: group.analysisProviderId });
    return NextResponse.json(job, { status: 202 });
  } catch (error) { return finalEditErrorResponse(error); }
}
