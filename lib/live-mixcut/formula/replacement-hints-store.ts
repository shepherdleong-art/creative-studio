import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { assertFormulaBatch, ensureFormulaCollection, getFormulaCollection } from './collection-store.ts';
import { readFormulaInputEditing } from './input-editing.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { parseFormulaReplacementHints, type FormulaReplacementHintsFile } from './replacement-hints.ts';

export interface FormulaSavedReplacementHints extends FormulaReplacementHintsFile { id: string; baseInputRevision: number; createdAt: string }
interface Row { id: string; baseInputRevision: number; filename: string; fingerprint: string; hintsJson: string; createdAt: string }
function saved(row: Row): FormulaSavedReplacementHints {
  return { id: row.id, baseInputRevision: row.baseInputRevision, filename: row.filename, fingerprint: row.fingerprint,
    hints: JSON.parse(row.hintsJson), createdAt: row.createdAt };
}

export function readFormulaReplacementHints(db: Database.Database, projectId: string, batchId: string) {
  assertFormulaBatch(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const row = collection && db.prepare('SELECT * FROM live_mixcut_formula_replacement_hints WHERE collectionId=? ORDER BY baseInputRevision DESC LIMIT 1')
    .get(collection.id) as Row | undefined;
  const file = row ? saved(row) : null;
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  return { inputRevision: collection?.revision ?? 0, editable: readFormulaInputEditing(db, projectId, batchId).editable, saved: file,
    rows: (file?.hints ?? []).map(hint => ({ ...hint,
      status: !index.codes.some(code => code.logicalCode === hint.originalCode && code.defined) ? 'undefined' as const
        : !index.bindings.some(binding => binding.logicalCode === hint.replacementCode && binding.available && !binding.excludedReason) ? 'missing_target' as const
          : 'needs_verification' as const })) };
}
export type FormulaReplacementHintsView = ReturnType<typeof readFormulaReplacementHints>;

/** Atomic confirmed import. A hint never becomes an explicit user replacement rule. */
export function saveFormulaReplacementHints(db: Database.Database, projectId: string, batchId: string,
  input: { expectedInputRevision: number } & ({ filename: string; bytes: Buffer; clear?: false } | { clear: true })) {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
  assertFormulaBatch(db, projectId, batchId);
  if (!Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0) throw new BatchDomainError('invalid_input', '缺少有效的资料版本');
  const file: FormulaReplacementHintsFile = input.clear === true ? { filename: '', fingerprint: '', hints: [] }
    : parseFormulaReplacementHints(input.filename, input.bytes);
  return db.transaction(() => {
    const current = getFormulaCollection(db, projectId, batchId);
    const previous = current && db.prepare('SELECT * FROM live_mixcut_formula_replacement_hints WHERE collectionId=? AND baseInputRevision=?')
      .get(current.id, input.expectedInputRevision) as Row | undefined;
    if (previous && previous.fingerprint === file.fingerprint && previous.filename === file.filename) {
      return { ...readFormulaReplacementHints(db, projectId, batchId), acceptedId: previous.id };
    }
    assertFormulaBatch(db, projectId, batchId, true);
    if (previous || (current?.revision ?? 0) !== input.expectedInputRevision) throw new BatchDomainError('conflict', '资料已更新，请重新读取后导入建议');
    const collection = ensureFormulaCollection(db, projectId, batchId);
    const id = randomUUID(), now = new Date().toISOString();
    db.prepare(`INSERT INTO live_mixcut_formula_replacement_hints (id,collectionId,baseInputRevision,filename,fingerprint,hintsJson,createdAt)
      VALUES (?,?,?,?,?,?,?)`).run(id, collection.id, collection.revision, file.filename, file.fingerprint, JSON.stringify(file.hints), now);
    db.prepare('UPDATE live_mixcut_formula_collections SET revision=revision+1,updatedAt=? WHERE id=?').run(now, collection.id);
    return { ...readFormulaReplacementHints(db, projectId, batchId), acceptedId: id };
  }).immediate();
}
