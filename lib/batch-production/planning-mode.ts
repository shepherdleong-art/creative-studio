import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';

export type BatchPlanningMode = 'semantic' | 'formula';

export const BATCH_PLANNING_MODE_LABELS: Record<BatchPlanningMode, string> = {
  semantic: '普通智能混剪',
  formula: '实拍公式混剪',
};

/** 仅省略值兼容旧调用；未知值不能将公式批次静默解释为普通批次。 */
export function parseBatchPlanningMode(value: unknown): BatchPlanningMode {
  if (value === undefined) return 'semantic';
  if (value === 'semantic' || value === 'formula') return value;
  throw new BatchDomainError('invalid_input', '不支持的剪辑方式');
}

export function hasBatchPlanningModeColumn(
  db: Database.Database,
  table: 'batch_productions' | 'batch_production_versions',
): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(column => column.name === 'planningMode');
}

export function getBatchPlanningMode(db: Database.Database, projectId: string, batchId: string): BatchPlanningMode {
  const row = db.prepare('SELECT * FROM batch_productions WHERE id=? AND projectId=? AND deletedAt IS NULL')
    .get(batchId, projectId) as { planningMode?: unknown } | undefined;
  if (!row) throw new BatchDomainError('not_found', '批次不存在');
  return parseBatchPlanningMode(row.planningMode);
}

/** 旧语义入口不能处理公式批次，即使暂未接通公式生成也不可退回旧算法。 */
export function assertSemanticBatch(db: Database.Database, projectId: string, batchId: string): void {
  if (getBatchPlanningMode(db, projectId, batchId) !== 'semantic') {
    throw new BatchDomainError('conflict', '实拍公式批次不能使用普通智能混剪流程，请使用公式生成入口');
  }
}
