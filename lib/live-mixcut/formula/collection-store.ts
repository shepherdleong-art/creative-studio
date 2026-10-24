import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { getBatchPlanningMode } from '../planning-mode.ts';
import { readFormulaInputEditing } from './input-editing.ts';

export interface FormulaCollection {
  id: string; revision: number; materialsSessionId: string | null; scriptsSessionId: string | null;
}

export function assertFormulaBatch(db: Database.Database, projectId: string, batchId: string, writable = false): void {
  if (getBatchPlanningMode(db, projectId, batchId) !== 'formula') throw new BatchDomainError('invalid_input', '此批次不是实拍公式混剪');
  if (writable && !readFormulaInputEditing(db, projectId, batchId).editable) {
    throw new BatchDomainError('conflict', '当前批次输入已冻结，请先建立新的输入版本');
  }
}

export function getFormulaCollection(db: Database.Database, projectId: string, batchId: string): FormulaCollection | undefined {
  return db.prepare('SELECT * FROM live_mixcut_formula_collections WHERE projectId=? AND batchId=?').get(projectId, batchId) as FormulaCollection | undefined;
}

/** 调用方在自己的写事务内使用，集合与第一份输入一起提交。 */
export function ensureFormulaCollection(db: Database.Database, projectId: string, batchId: string): FormulaCollection {
  assertFormulaBatch(db, projectId, batchId, true);
  const current = getFormulaCollection(db, projectId, batchId);
  if (current) return current;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO live_mixcut_formula_collections (id,projectId,batchId,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(id, projectId, batchId, now, now);
  return { id, revision: 0, materialsSessionId: null, scriptsSessionId: null };
}
