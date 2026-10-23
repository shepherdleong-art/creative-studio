import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';

export interface FormulaInputEditing {
  batchVersionId: string | null;
  revisionId: string | null;
  editable: boolean;
  canRevise: boolean;
}

/** A draft belongs to one frozen generation. It stops being writable as soon as a new generation becomes current. */
export function readFormulaInputEditing(db: Database.Database, projectId: string, batchId: string): FormulaInputEditing {
  const current = db.prepare(`SELECT b.currentVersionId,v.inputState FROM batch_productions b
    LEFT JOIN batch_production_versions v ON v.id=b.currentVersionId AND v.batchId=b.id
    WHERE b.id=? AND b.projectId=? AND b.deletedAt IS NULL`).get(batchId, projectId) as {
      currentVersionId: string | null; inputState: string | null;
    } | undefined;
  if (!current) throw new BatchDomainError('not_found', '批次不存在');
  if (!current.currentVersionId || current.inputState === 'draft') {
    return { batchVersionId: current.currentVersionId, revisionId: null, editable: true, canRevise: false };
  }
  const hasRevisions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_formula_input_revisions'").get();
  if (!hasRevisions) return { batchVersionId: current.currentVersionId, revisionId: null, editable: false, canRevise: false };
  const revision = hasRevisions ? db.prepare(`SELECT id FROM batch_formula_input_revisions
    WHERE projectId=? AND batchId=? AND baseBatchVersionId=?`).get(projectId, batchId, current.currentVersionId) as { id: string } | undefined : undefined;
  const generated = db.prepare(`SELECT 1 FROM batch_formula_generation_requests WHERE projectId=? AND batchId=? AND batchVersionId=?`)
    .get(projectId, batchId, current.currentVersionId);
  return { batchVersionId: current.currentVersionId, revisionId: revision?.id ?? null,
    editable: !!revision, canRevise: !!hasRevisions && !!generated && !revision };
}
