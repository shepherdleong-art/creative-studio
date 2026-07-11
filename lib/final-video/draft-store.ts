import { randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import {
  parseArrangementPlanJson,
  parseClipPoolJson,
  parseFinalVideoWorkflowConfigJson,
  parseNarrationBeatsJson,
  parseTimelineIssuesJson,
  type FinalVideoDraftRow,
  type FinalVideoJobSnapshot,
  type FinalVideoWorkflowConfig,
} from './types.ts';

type DraftPatch = Partial<Pick<FinalVideoDraftRow,
  | 'stage'
  | 'workflowConfigJson'
  | 'narrationBeatsJson'
  | 'clipPoolJson'
  | 'arrangementJson'
  | 'issuesJson'
  | 'previewJobId'
  | 'previewRevision'
  | 'errorMessage'
>>;

const PATCH_COLUMNS = [
  'stage', 'workflowConfigJson', 'narrationBeatsJson', 'clipPoolJson', 'arrangementJson',
  'issuesJson', 'previewJobId', 'previewRevision', 'errorMessage',
] as const;

function staleRevisionError(): Error & { code: string } {
  const error = new Error('stale_revision');
  return Object.assign(error, { code: 'stale_revision' });
}

function validateJsonPatch(patch: DraftPatch): void {
  if (patch.workflowConfigJson !== undefined) parseFinalVideoWorkflowConfigJson(patch.workflowConfigJson);
  if (patch.narrationBeatsJson !== undefined) parseNarrationBeatsJson(patch.narrationBeatsJson);
  if (patch.clipPoolJson !== undefined) parseClipPoolJson(patch.clipPoolJson);
  if (patch.arrangementJson !== undefined) parseArrangementPlanJson(patch.arrangementJson);
  if (patch.issuesJson !== undefined) parseTimelineIssuesJson(patch.issuesJson);
}

export function createFinalVideoDraft(input: {
  projectId: string;
  shotSetId: string;
  scriptDraftId: string | null;
  workflowConfig: FinalVideoWorkflowConfig;
}): FinalVideoDraftRow {
  const workflowConfigJson = JSON.stringify(input.workflowConfig);
  parseFinalVideoWorkflowConfigJson(workflowConfigJson);
  const db = getDb();
  return db.transaction(() => {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO final_video_drafts (
        id, projectId, shotSetId, scriptDraftId, stage, revision, workflowConfigJson,
        narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson
      ) VALUES (?, ?, ?, ?, 'draft', 0, ?, '[]', '[]', '{"assignments":[],"gaps":[]}', '[]')
    `).run(id, input.projectId, input.shotSetId, input.scriptDraftId, workflowConfigJson);
    return db.prepare(`SELECT * FROM final_video_drafts WHERE id = ?`).get(id) as FinalVideoDraftRow;
  })();
}

export function getFinalVideoDraft(id: string): FinalVideoDraftRow | null {
  return (getDb().prepare(`SELECT * FROM final_video_drafts WHERE id = ?`).get(id) as FinalVideoDraftRow | undefined) ?? null;
}

export function listFinalVideoDrafts(projectId: string, shotSetId?: string): FinalVideoDraftRow[] {
  if (shotSetId === undefined) {
    return getDb().prepare(`
      SELECT * FROM final_video_drafts WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC
    `).all(projectId) as FinalVideoDraftRow[];
  }
  return getDb().prepare(`
    SELECT * FROM final_video_drafts WHERE projectId = ? AND shotSetId = ? ORDER BY createdAt DESC, rowid DESC
  `).all(projectId, shotSetId) as FinalVideoDraftRow[];
}

export function updateFinalVideoDraft(id: string, expectedRevision: number, patch: DraftPatch): FinalVideoDraftRow {
  validateJsonPatch(patch);
  const values: unknown[] = [];
  const assignments: string[] = [];
  for (const column of PATCH_COLUMNS) {
    if (patch[column] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(patch[column]);
    }
  }

  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE final_video_drafts
      SET ${assignments.length ? `${assignments.join(', ')}, ` : ''}revision = revision + 1,
          updatedAt = datetime('now')
      WHERE id = ? AND revision = ?
    `).run(...values, id, expectedRevision);
    if (result.changes !== 1) throw staleRevisionError();
    return db.prepare(`SELECT * FROM final_video_drafts WHERE id = ?`).get(id) as FinalVideoDraftRow;
  })();
}

export function deleteFinalVideoDraft(id: string): void {
  getDb().prepare(`DELETE FROM final_video_drafts WHERE id = ?`).run(id);
}

export function snapshotDraftForJob(
  draftId: string,
  expectedRevision: number,
  kind: 'preview' | 'final',
): FinalVideoJobSnapshot {
  const row = getFinalVideoDraft(draftId);
  if (!row || row.revision !== expectedRevision) throw staleRevisionError();
  const workflowConfig = parseFinalVideoWorkflowConfigJson(row.workflowConfigJson);
  return {
    kind,
    draftId: row.id,
    draftRevision: row.revision,
    packageConfig: workflowConfig.packageConfig,
    narrationBeats: parseNarrationBeatsJson(row.narrationBeatsJson),
    clipPool: parseClipPoolJson(row.clipPoolJson),
    arrangement: parseArrangementPlanJson(row.arrangementJson),
    issues: parseTimelineIssuesJson(row.issuesJson),
    selectedClipIds: [...workflowConfig.selectedClipIds],
    solverVersion: 2,
  };
}
