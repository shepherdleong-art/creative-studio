import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { OutputPresetId } from '@/lib/final-edit/types';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const ids = getDb().prepare(`SELECT id FROM final_edit_groups WHERE projectId=? ORDER BY createdAt DESC`).all(projectId) as Array<{ id: string }>;
    return NextResponse.json({ groups: ids.map((row) => getFinalEditWorkspace().load(row.id)) });
  } catch (error) { return finalEditErrorResponse(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const body = await request.json() as { scriptDraftId?: string; count?: number; outputPreset?: OutputPresetId; providerId?: string; voice?: string; speed?: number; analysisProviderId?: string };
    if (!body.providerId || !body.voice) return NextResponse.json({ error: 'tts_selection_required', message: '必须明确选择口播配音供应商和音色' }, { status: 400 });
    const job = await getFinalEditWorkspace().start({
      projectId, scriptDraftId: String(body.scriptDraftId || ''), count: Number(body.count || 2), outputPreset: body.outputPreset || '3x4',
      providerId: body.providerId, voice: body.voice, speed: Number(body.speed || 1), analysisProviderId: body.analysisProviderId,
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) { return finalEditErrorResponse(error); }
}
