import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';

export type BatchReviewDecision = 'approved' | 'rework' | 'cancelled';

/**
 * 用户审核机制(问题 6):审核态就地存在当前成片版本 arrangementJson 的
 * review 字段(零迁移,写入端与 narration 的就地升级同一套 json_set)。
 * reallocate 会创建全新 output version,arrangement 没有 review 字段,
 * 语义上"换了画面要重新审"自动成立。
 */

export interface BatchReviewWriteResult {
  batchId: string;
  decision: BatchReviewDecision | null;
  updatedAt: string;
  planIds: string[];
  /** 目标成片是否仍有 queued/running 的渲染任务。 */
  pendingRender: boolean;
}

export interface BatchPlanReviewRow {
  id: string;
  seq: number;
  currentVersionId: string | null;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function assertReviewDecision(value: unknown): asserts value is BatchReviewDecision | null {
  if (value === null) return;
  if (value !== 'approved' && value !== 'rework' && value !== 'cancelled') {
    throw new BatchDomainError('invalid_input', '审核决定只能是 approved / rework / cancelled');
  }
}

/**
 * 批量写入审核决定。planIds 必须是该批次当前版本内的成片计划;
 * decision 为 null/cancelled 表示撤销审核,回到未审核态。
 */
export function setBatchPlanReviews(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: { planIds: string[]; decision: BatchReviewDecision | null },
  now?: () => Date,
): BatchReviewWriteResult {
  assertReviewDecision(input.decision);
  const uniquePlanIds = [...new Set(input.planIds.filter((value) => typeof value === 'string' && value.trim()))];
  if (uniquePlanIds.length === 0) {
    throw new BatchDomainError('invalid_input', '请至少选择一条成片进行审核操作');
  }
  const batch = db.prepare(`
    SELECT currentVersionId FROM batch_productions
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId) as { currentVersionId: string | null } | undefined;
  if (!batch) throw new BatchDomainError('not_found', '批次不存在');
  if (!batch.currentVersionId) {
    throw new BatchDomainError('conflict', '批次还没有建立成片计划,不能审核');
  }

  const plans = db.prepare(`
    SELECT p.id, p.seq, p.currentVersionId
    FROM batch_output_plans p
    WHERE p.batchVersionId = ?
      AND p.id IN (${uniquePlanIds.map(() => '?').join(',')})
  `).all(batch.currentVersionId, ...uniquePlanIds) as BatchPlanReviewRow[];
  if (plans.length !== uniquePlanIds.length) {
    throw new BatchDomainError('conflict', '部分成片计划不属于该批次当前版本');
  }

  const currentOutputVersionIds = plans
    .map(({ currentVersionId }) => currentVersionId)
    .filter((value): value is string => Boolean(value));
  const updatedAt = nowIso(now);
  // 撤销审核(cancelled)归一化为 decision=null:与“从未审核”同一种展示态,
  // 但保留 decidedAt 便于审计。领域语义保持文档约定 approved/rework/null。
  const normalizedDecision: BatchReviewDecision | null = input.decision === 'cancelled' ? null : input.decision;
  const reviewJson = JSON.stringify({ decision: normalizedDecision, decidedAt: updatedAt });
  const pendingRender = db.transaction(() => {
    const pendingRenderIds = currentOutputVersionIds.length === 0 ? new Set<string>() : new Set(
      (db.prepare(`
        SELECT targetId
        FROM batch_tasks
        WHERE projectId = ? AND batchId = ?
          AND workType = 'render' AND targetKind = 'output_version'
          AND status IN ('queued', 'running')
          AND targetId IN (${currentOutputVersionIds.map(() => '?').join(',')})
      `).all(projectId, batchId, ...currentOutputVersionIds) as Array<{ targetId: string }>).map(({ targetId }) => targetId),
    );
    const hasPendingRender = currentOutputVersionIds.some((outputVersionId) => pendingRenderIds.has(outputVersionId));
    for (const plan of plans) {
      if (!plan.currentVersionId) continue;
      // json_set 写入当前版本的 arrangement.review;撤销时写成 decision=null 保持字段可见。
      db.prepare(`
        UPDATE batch_output_versions
        SET arrangementJson = json_set(arrangementJson, '$.review', json(?))
        WHERE id = ?
      `).run(reviewJson, plan.currentVersionId);
    }
    return hasPendingRender;
  }).immediate();

  return {
    batchId,
    decision: input.decision,
    updatedAt,
    planIds: plans.map(({ id }) => id),
    pendingRender,
  };
}

/** 读取单条计划的审核态(供 API/测试读取)。 */
export function readBatchPlanReview(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
): { decision: BatchReviewDecision | null; decidedAt: string | null } {
  const row = db.prepare(`
    SELECT o.arrangementJson
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    LEFT JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as { arrangementJson: string | null } | undefined;
  if (!row?.arrangementJson) return { decision: null, decidedAt: null };
  try {
    const arrangement = JSON.parse(row.arrangementJson) as { review?: unknown };
    const review = arrangement.review;
    if (!review || typeof review !== 'object' || Array.isArray(review)) return { decision: null, decidedAt: null };
    const record = review as Record<string, unknown>;
    const decision = record.decision === 'approved' || record.decision === 'rework' || record.decision === 'cancelled'
      ? record.decision
      : null;
    return { decision, decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : null };
  } catch {
    return { decision: null, decidedAt: null };
  }
}
