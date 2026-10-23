import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import { batchOutputReviewContext, type BatchReviewTarget } from './review-context.ts';
import { formulaExecutionAvailable } from './formula/execution-gate.ts';
import { formulaOutputExecutionReady, formulaOutputCoverReady } from './formula/execution-store.ts';
import { readFormulaOutputAudioPlan } from './formula/output-audio.ts';
import { getBatchPlanningMode } from './planning-mode.ts';
import type { BatchReviewDecision, BatchReviewWriteResult } from './review.ts';

export function confirmBatchReviews(db: Database.Database, projectId: string, batchId: string,
  input: { items: BatchReviewTarget[]; decision: BatchReviewDecision | null }, now?: () => Date): BatchReviewWriteResult {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 1_000
    || ![null, 'approved', 'rework', 'cancelled'].includes(input.decision)) {
    throw new BatchDomainError('invalid_input', '请选择有效的成片和审核操作');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || typeof item.planId !== 'string' || !item.planId.trim() || seen.has(item.planId)
      || typeof item.outputVersionId !== 'string' || !item.outputVersionId.trim() || !Number.isSafeInteger(item.editRevision) || item.editRevision < 0
      || typeof item.issueSetHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.issueSetHash)) {
      throw new BatchDomainError('invalid_input', '审核缺少当前所见版本或提醒信息，请刷新检查页后重试');
    }
    seen.add(item.planId);
  }
  return db.transaction(() => {
    const batch = db.prepare(`SELECT b.currentVersionId,b.controlState,v.inputState FROM batch_productions b
      LEFT JOIN batch_production_versions v ON v.id=b.currentVersionId WHERE b.id=? AND b.projectId=? AND b.deletedAt IS NULL`)
      .get(batchId, projectId) as { currentVersionId: string | null; controlState: string; inputState: string } | undefined;
    if (!batch) throw new BatchDomainError('not_found', '批次不存在');
    const formulaBatch = getBatchPlanningMode(db, projectId, batchId) === 'formula';
    const updatedAt = (now?.() ?? new Date()).toISOString();
    const results: BatchReviewWriteResult['results'] = [];
    let pendingRender = false;
    for (const item of input.items) {
      const conflict = (message: string, status: 'conflict' | 'not_ready' | 'unavailable' = 'conflict') => results.push({ planId: item.planId, status, message });
      if (batch.controlState === 'stopped' || batch.inputState !== 'frozen') {
        conflict('批次已停止或尚未冻结，请重新核对'); continue;
      }
      const row = db.prepare(`SELECT p.currentVersionId,o.arrangementJson FROM batch_output_plans p
        LEFT JOIN batch_output_versions o ON o.id=p.currentVersionId WHERE p.id=? AND p.batchVersionId=?`)
        .get(item.planId, batch.currentVersionId) as { currentVersionId: string | null; arrangementJson: string | null } | undefined;
      if (!row?.arrangementJson || row.currentVersionId !== item.outputVersionId) {
        conflict('这条成片已不是页面显示的版本，请重新检查'); continue;
      }
      const arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
      const context = batchOutputReviewContext(db, item.outputVersionId, arrangement);
      if (context.editRevision !== item.editRevision || context.issueSetHash !== item.issueSetHash) {
        conflict('成片或提醒内容已改变，请重新查看后再确认'); continue;
      }
      if (formulaBatch || arrangement.formula) {
        if (!formulaExecutionAvailable(db)) { conflict('实拍公式制作暂不可用，原审核记录保留', 'unavailable'); continue; }
        const audio = readFormulaOutputAudioPlan(arrangement.audioPlan);
        if (input.decision === 'approved' && (!formulaOutputExecutionReady(db, item.outputVersionId, arrangement)
          || !formulaOutputCoverReady(db, item.outputVersionId) || !audio || audio.issues.length
          || context.issues.some(issue => issue.kind === 'blocker' || issue.kind === 'audio'))) {
          conflict('这条公式成片还有未完成的声音、制作检查或封面，请处理后再确认', 'not_ready'); continue;
        }
      }
      const decision = input.decision === 'cancelled' ? null : input.decision;
      db.prepare("UPDATE batch_output_versions SET arrangementJson=json_set(arrangementJson,'$.review',json(?)) WHERE id=?")
        .run(JSON.stringify({ version: 1, decision, decidedAt: updatedAt, ...context }), item.outputVersionId);
      results.push({ planId: item.planId, status: 'saved' });
      if (db.prepare(`SELECT 1 FROM batch_tasks WHERE projectId=? AND batchId=? AND targetId=? AND workType='render'
        AND targetKind='output_version' AND status IN ('queued','running') LIMIT 1`).get(projectId, batchId, item.outputVersionId)) pendingRender = true;
    }
    return { batchId, decision: input.decision, updatedAt, pendingRender, results,
      planIds: results.filter(item => item.status === 'saved').map(item => item.planId) };
  }).immediate();
}
