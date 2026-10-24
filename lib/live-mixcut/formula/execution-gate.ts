import type Database from 'better-sqlite3';
import { hasBatchPlanningModeColumn } from '../planning-mode.ts';
import { liveMixcutFeatureEnabled } from '../config.ts';

/** 表结构由 ../schema.ts 的迁移和就绪检查保证，这里只看开关。 */
export function formulaExecutionAvailable(_db?: Database.Database): boolean {
  return liveMixcutFeatureEnabled();
}

/** 旧基础库不查询公式表；关闭能力也不影响普通或项目素材级任务。 */
export function formulaTaskPermission(db: Database.Database, task: { batchId: string | null; workType: string; targetId: string }): 'ready' | 'unavailable' | 'superseded' {
  const hasMode = hasBatchPlanningModeColumn(db, 'live_mixcut_productions');
  const batch = task.batchId && hasMode ? db.prepare('SELECT planningMode,currentVersionId,deletedAt FROM live_mixcut_productions WHERE id=?').get(task.batchId) as {
    planningMode: string; currentVersionId: string | null; deletedAt: string | null;
  } | undefined : undefined;
  if (task.workType !== 'formula_stage' && batch?.planningMode !== 'formula') return 'ready';
  if (!formulaExecutionAvailable(db)) return 'unavailable';
  if (task.workType === 'formula_stage') {
    const stage = db.prepare(`SELECT r.batchId,r.batchVersionId,s.revision,s.selectionStageId,
      (SELECT newer.id FROM live_mixcut_formula_stages newer WHERE newer.planId=s.planId AND newer.kind='select' ORDER BY newer.revision DESC LIMIT 1) AS latestSelectionId,
      (SELECT MAX(newer.revision) FROM live_mixcut_formula_execution_stages newer WHERE newer.planId=s.planId AND newer.kind=s.kind
        AND newer.selectionStageId=s.selectionStageId AND newer.assetId IS s.assetId) AS latestRevision
      FROM live_mixcut_formula_execution_stages s JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId WHERE s.id=?`)
      .get(task.targetId) as { batchId: string; batchVersionId: string; revision: number; latestRevision: number; selectionStageId: string; latestSelectionId: string } | undefined;
    if (!stage || !batch || batch.deletedAt || stage.batchId !== task.batchId || stage.batchVersionId !== batch.currentVersionId) return 'superseded';
    if (stage.revision !== stage.latestRevision || stage.selectionStageId !== stage.latestSelectionId) return 'superseded';
  }
  return 'ready';
}
