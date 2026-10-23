import type Database from 'better-sqlite3';
import { hasBatchPlanningModeColumn } from '../planning-mode.ts';
import { validateFormulaExecutionSchema } from './schema.ts';

const checks = new WeakMap<Database.Database, { schemaVersion: number; migrations: string; available: boolean }>();

export function formulaExecutionAvailable(db: Database.Database): boolean {
  if (process.env.CREATIVE_STUDIO_FORMULA_MIXCUT !== '1') return false;
  try {
    const schemaVersion = db.pragma('schema_version', { simple: true }) as number;
    const migrations = JSON.stringify(db.prepare('SELECT version FROM batch_formula_schema_migrations ORDER BY version').all());
    const cached = checks.get(db);
    if (cached?.schemaVersion === schemaVersion && cached.migrations === migrations) return cached.available;
    let available = true;
    try { validateFormulaExecutionSchema(db); } catch { available = false; }
    checks.set(db, { schemaVersion, migrations, available });
    return available;
  } catch { return false; }
}

/** 旧基础库不查询公式表；关闭能力也不影响普通或项目素材级任务。 */
export function formulaTaskPermission(db: Database.Database, task: { batchId: string | null; workType: string; targetId: string }): 'ready' | 'unavailable' | 'superseded' {
  const hasMode = hasBatchPlanningModeColumn(db, 'batch_productions');
  const batch = task.batchId && hasMode ? db.prepare('SELECT planningMode,currentVersionId,deletedAt FROM batch_productions WHERE id=?').get(task.batchId) as {
    planningMode: string; currentVersionId: string | null; deletedAt: string | null;
  } | undefined : undefined;
  if (task.workType !== 'formula_stage' && batch?.planningMode !== 'formula') return 'ready';
  if (!formulaExecutionAvailable(db)) return 'unavailable';
  if (task.workType === 'formula_stage') {
    const stage = db.prepare(`SELECT r.batchId,r.batchVersionId,s.revision,s.selectionStageId,
      (SELECT newer.id FROM batch_formula_stages newer WHERE newer.planId=s.planId AND newer.kind='select' ORDER BY newer.revision DESC LIMIT 1) AS latestSelectionId,
      (SELECT MAX(newer.revision) FROM batch_formula_execution_stages newer WHERE newer.planId=s.planId AND newer.kind=s.kind
        AND newer.selectionStageId=s.selectionStageId AND newer.assetId IS s.assetId) AS latestRevision
      FROM batch_formula_execution_stages s JOIN batch_formula_generation_requests r ON r.id=s.requestId WHERE s.id=?`)
      .get(task.targetId) as { batchId: string; batchVersionId: string; revision: number; latestRevision: number; selectionStageId: string; latestSelectionId: string } | undefined;
    if (!stage || !batch || batch.deletedAt || stage.batchId !== task.batchId || stage.batchVersionId !== batch.currentVersionId) return 'superseded';
    if (stage.revision !== stage.latestRevision || stage.selectionStageId !== stage.latestSelectionId) return 'superseded';
  }
  return 'ready';
}
