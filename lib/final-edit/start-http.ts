import { getDb } from '../db';
import { getFinalEditWorkspace, recoverFinalEditPrepareJobs } from './runtime';
import type { OutputPresetId } from './types';
import { FinalEditError } from './workspace';

export interface FinalEditStartBody {
  scriptDraftId?: string | null;
  shotSetId?: string;
  editedNarrationText?: string;
  selectedMaterialKeys?: string[];
  count?: number;
  outputPreset?: OutputPresetId;
  providerId?: string;
  voice?: string;
  speed?: number;
  analysisProviderId?: string;
}

export async function startFinalEditFromHttp(projectId: string, body: FinalEditStartBody) {
  if (!body.providerId || !body.voice) throw new FinalEditError('tts_selection_required', '必须明确选择口播配音供应商和音色');
  recoverFinalEditPrepareJobs();
  const job = await getFinalEditWorkspace().start({
    projectId,
    scriptDraftId: String(body.scriptDraftId || ''),
    shotSetId: body.shotSetId,
    editedNarrationText: body.editedNarrationText,
    selectedMaterialKeys: body.selectedMaterialKeys,
    count: Number(body.count || 2),
    outputPreset: body.outputPreset || '3x4',
    providerId: body.providerId,
    voice: body.voice,
    speed: Number(body.speed || 1),
    analysisProviderId: body.analysisProviderId,
  });
  return getDb().prepare(`SELECT id, groupId, variantId, kind, status, phase, progress, startedAt, finishedAt, errorMessage FROM final_edit_jobs WHERE id=?`).get(job.id) || job;
}
