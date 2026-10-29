import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, computeFullRenderContractHash, resolveFullRenderContract, resolveCoverContractHash, type FullRenderContractInput } from '../cover-contract.ts';
import { createBatchTask } from '../tasks.ts';
import { buildCoverRenderTaskRequestKey } from '../render-task-key.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { BatchWorkspaceTaskView } from '../batch-workspace.ts';

export interface FormulaExecutionResult {
  version: 1; status: 'ready'; executionReady: true;
  outputVersionId: string; checkedEditRevision: number; contentContractHash: string;
  audioMode: 'source' | 'mixed' | 'narration'; contract: FullRenderContractInput; checkedAt: string;
}

/** Readiness is about media content. Lock metadata can advance the edit revision without changing it. */
export function formulaExecutionContentHash(contract: FullRenderContractInput): string {
  return computeFullRenderContractHash({ ...contract, editRevision: 0 });
}

export function formulaExecutionInputKey(db: Database.Database, outputVersionId: string, arrangement: Record<string, unknown>): string {
  const input = { ...arrangement };
  delete input.productionReady;
  delete input.formulaExecution;
  let mediaContract: string | null = null;
  try { mediaContract = formulaExecutionContentHash(resolveFullRenderContract(db, outputVersionId, JSON.stringify(arrangement))); }
  catch { /* An invalid draft is still queued so its failure is visible and retryable. */ }
  return createHash('sha256').update(canonicalJson([input, mediaContract])).digest('hex');
}

function executionResultTable(sourceKind: 'timeline' | 'schedule'): string {
  return sourceKind === 'schedule'
    ? 'live_mixcut_formula_schedule_execution_results' : 'live_mixcut_formula_execution_results';
}

export interface FormulaExecutionProof { stageId: string; result: FormulaExecutionResult }

/**
 * 这条成片真正通过的检查：结果必须是 ready，且内容指纹等于现在成片的内容。
 * 判定只认「检查结果 + 内容指纹」；成片上的标记只是指针，丢了不等于没通过。
 */
export function readFormulaExecutionProof(db: Database.Database, outputVersionId: string, stageId?: string): FormulaExecutionProof | null {
  try {
    // 新旧两种执行检查各写各的结果表；血缘视图说明这次检查属于哪一条成片、来自哪条链。
    const rows = (stageId
      ? db.prepare('SELECT id AS stageId,sourceKind FROM live_mixcut_formula_execution_lineage WHERE outputVersionId=? AND id=?')
        .all(outputVersionId, stageId)
      : db.prepare('SELECT id AS stageId,sourceKind FROM live_mixcut_formula_execution_lineage WHERE outputVersionId=? ORDER BY revision DESC')
        .all(outputVersionId)) as Array<{ stageId: string; sourceKind: 'timeline' | 'schedule' }>;
    if (!rows.length) return null;
    const currentHash = formulaExecutionContentHash(resolveFullRenderContract(db, outputVersionId));
    for (const row of rows) {
      const stored = db.prepare(`SELECT resultJson FROM ${executionResultTable(row.sourceKind)} WHERE stageId=?`)
        .get(row.stageId) as { resultJson: string } | undefined;
      if (!stored) continue;
      const result = JSON.parse(stored.resultJson) as FormulaExecutionResult;
      if (result?.version !== 1 || result.status !== 'ready' || result.executionReady !== true) continue;
      if (result.outputVersionId !== outputVersionId || result.contentContractHash !== currentHash) continue;
      return { stageId: row.stageId, result };
    }
    return null;
  } catch { return null; }
}

/** A browser-supplied ready flag cannot replace a persisted, verified execution result. */
export function formulaOutputExecutionReady(db: Database.Database, outputVersionId: string, arrangement: Record<string, unknown>): boolean {
  if (arrangement.productionReady !== true || !arrangement.formula) return false;
  const proof = arrangement.formulaExecution as { stageId?: unknown; contentContractHash?: unknown } | undefined;
  if (typeof proof?.stageId !== 'string' || typeof proof.contentContractHash !== 'string') return false;
  const stored = readFormulaExecutionProof(db, outputVersionId, proof.stageId);
  return Boolean(stored && stored.result.contentContractHash === proof.contentContractHash);
}

/** 检查结果还在、指纹也对得上，只是成片上的通过标记丢了：补回去，不重跑检查。 */
export function restoreFormulaExecutionStamp(db: Database.Database, outputVersionId: string,
  arrangement: Record<string, unknown>, proof: FormulaExecutionProof): void {
  arrangement.productionReady = true;
  arrangement.formulaExecution = { stageId: proof.stageId, contentContractHash: proof.result.contentContractHash };
  arrangement.blockers = (Array.isArray(arrangement.blockers) ? arrangement.blockers : [])
    .filter(value => value !== 'formula_execution_pending');
  db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(arrangement), outputVersionId);
}

export function formulaOutputCoverReady(db: Database.Database, outputVersionId: string): boolean {
  try {
    const hash = resolveCoverContractHash(db, outputVersionId);
    return Boolean(db.prepare(`SELECT 1 FROM live_mixcut_tasks t JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
      WHERE t.workType='render' AND t.targetKind='output_version_cover' AND t.targetId=? AND t.requestKey=?
        AND t.status='succeeded' AND a.status='succeeded' AND json_extract(a.resultJson,'$.coverContractHash')=?
        AND json_type(a.resultJson,'$.coverRelativePath')='text' AND json_type(a.resultJson,'$.coverChecksum')='text'`)
      .get(outputVersionId, buildCoverRenderTaskRequestKey(outputVersionId, hash), hash));
  } catch { return false; }
}

export function readFormulaExecutionTask(db: Database.Database, outputVersionId: string): BatchWorkspaceTaskView | null {
  try {
    const row = db.prepare(`SELECT t.id,t.status,t.expectedState,t.attemptCount,a.progressJson,a.errorCode,a.errorMessage
      FROM live_mixcut_formula_execution_lineage e JOIN live_mixcut_tasks t ON t.targetId=e.id AND t.workType='formula_stage'
      LEFT JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
      WHERE e.outputVersionId=? ORDER BY e.revision DESC LIMIT 1`).get(outputVersionId) as
        (Omit<BatchWorkspaceTaskView, 'progress'> & { progressJson: string | null }) | undefined;
    if (!row) return null;
    return { id: row.id, status: row.status, expectedState: row.expectedState, attemptCount: row.attemptCount,
      progress: row.progressJson ? JSON.parse(row.progressJson) : null, errorCode: row.errorCode, errorMessage: row.errorMessage };
  } catch { return null; }
}

/**
 * Called in the same transaction as output creation/editing. Invalid media is a worker failure, not a lost edit.
 * 用 immediate 事务：修复循环读到的成片和写回的成片必须在同一把写锁里，不能把刚提交的通过标记覆盖成旧快照。
 */
export function queueFormulaExecutionCheck(db: Database.Database, projectId: string, batchId: string, outputVersionId: string): string | null {
  if (!formulaExecutionAvailable(db)) return null;
  return db.transaction(() => {
    const row = db.prepare(`SELECT o.arrangementJson,t.planId,t.selectionStageId FROM live_mixcut_formula_output_versions f
      JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_output_plans p ON p.id=o.planId
      JOIN live_mixcut_production_versions v ON v.id=p.batchVersionId JOIN live_mixcut_productions b ON b.id=v.batchId
      JOIN live_mixcut_formula_execution_stages t ON t.id=f.timelineStageId
      WHERE o.id=? AND b.id=? AND b.projectId=? AND b.currentVersionId=v.id AND p.currentVersionId=o.id
        AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND t.selectionStageId=(SELECT id FROM live_mixcut_formula_stages WHERE planId=p.id AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(outputVersionId, batchId, projectId) as { arrangementJson: string; planId: string; selectionStageId: string } | undefined;
    if (!row) return null;
    const arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
    if (formulaOutputExecutionReady(db, outputVersionId, arrangement)) return null;
    // 通过标记可能被别的写入冲掉过：检查结果还在且内容没变，就把标记补回去，不再重排一次检查。
    const proof = readFormulaExecutionProof(db, outputVersionId);
    if (proof) { restoreFormulaExecutionStamp(db, outputVersionId, arrangement, proof); return null; }
    arrangement.productionReady = false;
    delete arrangement.formulaExecution;
    const blockers = Array.isArray(arrangement.blockers) ? arrangement.blockers : [];
    arrangement.blockers = [...blockers.filter(value => value !== 'formula_execution_pending'), 'formula_execution_pending'];
    const inputJson = JSON.stringify(arrangement), inputKey = formulaExecutionInputKey(db, outputVersionId, arrangement);
    db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(inputJson, outputVersionId);
    let stage = db.prepare('SELECT id FROM live_mixcut_formula_execution_checks WHERE outputVersionId=? AND inputKey=?')
      .get(outputVersionId, inputKey) as { id: string } | undefined;
    if (!stage) {
      stage = { id: randomUUID() };
      const revision = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM live_mixcut_formula_execution_stages WHERE planId=? AND selectionStageId=? AND kind='execution'")
        .get(row.planId, row.selectionStageId) as { next: number }).next;
      db.prepare('INSERT INTO live_mixcut_formula_execution_checks (id,outputVersionId,revision,inputKey,inputJson,createdAt) VALUES (?,?,?,?,?,?)')
        .run(stage.id, outputVersionId, revision, inputKey, inputJson, new Date().toISOString());
    }
    return createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id,
      requestKey: `formula:execution:${stage.id}` });
  }).immediate();
}

/** Upgrades and interrupted edit responses must not rely on a page to finish the workflow. */
export function repairFormulaExecutionChecks(db: Database.Database, onError: (projectId: string, requestId: string) => void): void {
  if (!formulaExecutionAvailable(db)) return;
  const rows = db.prepare(`SELECT o.id,b.projectId,b.id AS batchId,t.requestId FROM live_mixcut_formula_output_versions f
    JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_output_plans p ON p.currentVersionId=o.id
    JOIN live_mixcut_production_versions v ON v.id=p.batchVersionId JOIN live_mixcut_productions b ON b.currentVersionId=v.id
    JOIN live_mixcut_formula_execution_stages t ON t.id=f.timelineStageId WHERE b.deletedAt IS NULL AND b.controlState='running'`)
    .all() as Array<{ id: string; projectId: string; batchId: string; requestId: string }>;
  for (const row of rows) {
    try { queueFormulaExecutionCheck(db, row.projectId, row.batchId, row.id); }
    catch { onError(row.projectId, row.requestId); }
  }
}
