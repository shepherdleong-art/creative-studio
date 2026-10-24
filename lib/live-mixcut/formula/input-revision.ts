import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { BatchDomainError } from '../errors.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { readFormulaInputEditing } from './input-editing.ts';

/** Explicitly open the next input draft without thawing a frozen generation or replacing its outputs. */
export function beginFormulaInputRevision(db: Database.Database, projectId: string, batchId: string, input: {
  expectedBatchVersionId: string; expectedInputRevision: number;
}) {
  if (typeof input.expectedBatchVersionId !== 'string' || !input.expectedBatchVersionId
    || !Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0) {
    throw new BatchDomainError('invalid_input', '缺少当前制作版本和资料修订，请刷新后重试');
  }
  return db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId);
    if (!formulaExecutionAvailable(db)) throw new BatchDomainError('conflict', '实拍公式功能当前不可用，暂不能修改输入');
    const state = readFormulaInputEditing(db, projectId, batchId);
    if (state.batchVersionId !== input.expectedBatchVersionId) throw new BatchDomainError('conflict', '当前制作已变化，请刷新后再修改输入');
    if (state.revisionId) {
      const previous = db.prepare('SELECT baseInputRevision FROM live_mixcut_formula_input_revisions WHERE id=?')
        .get(state.revisionId) as { baseInputRevision: number };
      if (previous.baseInputRevision !== input.expectedInputRevision) throw new BatchDomainError('conflict', '输入修订已经打开，请刷新后继续修改');
      return state;
    }
    const collection = getFormulaCollection(db, projectId, batchId);
    if (!state.canRevise || !collection || collection.revision !== input.expectedInputRevision) {
      throw new BatchDomainError('conflict', '资料已更新或尚未开始制作，请刷新后继续');
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE live_mixcut_formula_collections SET revision=revision+1,updatedAt=? WHERE id=?').run(now, collection.id);
    db.prepare(`INSERT INTO live_mixcut_formula_input_revisions
      (id,projectId,batchId,baseBatchVersionId,baseInputRevision,openedRevision,createdAt) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), projectId, batchId, input.expectedBatchVersionId, input.expectedInputRevision, input.expectedInputRevision + 1, now);
    return readFormulaInputEditing(db, projectId, batchId);
  }).immediate();
}
