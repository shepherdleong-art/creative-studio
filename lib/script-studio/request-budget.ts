/**
 * 脚本文本请求预算（方案 §2.2 / A8）：
 * - 每条方案从首稿到保存最多 `scriptTextRequestsPerProposal`（默认 8）次应用层文本 completeJson 调用；
 * - 正文生成、无效结构重试、扩写/压缩、定向审核、兄弟方案去重和额外 fallback 共用余额，
 *   不创建嵌套独立预算；标题修复仍最多 `titleRepairMaxAttempts`（2）次，单独闸门但占用方案余额；
 * - 单任务脚本文本阶段总额不超过 requestedCount × 每方案上限；
 * - 调用前原子占用预算，实际发起的失败/取消调用也计入；
 * - 计数持久化在任务行维度，任务中断恢复（queued → 重新领取）时延续余额，不重置。
 * 视觉提取、证据复核与提炼阶段使用各自独立的阶段预算（phase 区分），不占脚本文本额度。
 */
import type Database from 'better-sqlite3';
import { ScriptStudioError } from './errors.ts';
import { getScriptStudioLimits } from './limits.ts';

export type ScriptRequestPurpose = 'generate' | 'repair' | 'review' | 'fallback' | 'title_repair' | 'distill';

export interface ScriptRequestBudgetScope {
  planIndex: number;
  purpose: ScriptRequestPurpose;
}

export interface ScriptRequestBudget {
  /** 原子占用一次调用额度；超出任何闸门时抛 request_budget_exhausted，不发起请求。 */
  reserve(scope: ScriptRequestBudgetScope): void;
  usedFor(planIndex: number): number;
  titleRepairUsedFor(planIndex: number): number;
  taskTextUsed(): number;
}

interface UsageRow {
  usedCount: number;
}

function readUsed(db: Database.Database, taskId: string, phase: string, scope: string): number {
  const row = db.prepare(
    `SELECT usedCount FROM script_studio_task_request_usage WHERE taskId = ? AND phase = ? AND scope = ?`,
  ).get(taskId, phase, scope) as UsageRow | undefined;
  return row?.usedCount ?? 0;
}

function incrementUsed(db: Database.Database, taskId: string, phase: string, scope: string, now: string): void {
  const result = db.prepare(`
    INSERT INTO script_studio_task_request_usage (taskId, phase, scope, usedCount, updatedAt)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(taskId, phase, scope) DO UPDATE SET
      usedCount = usedCount + 1, updatedAt = excluded.updatedAt
  `).run(taskId, phase, scope, now);
  if (result.changes !== 1) throw new Error('script_request_usage_update_failed');
}

export function createScriptRequestBudget(options: {
  db: Database.Database;
  taskId: string;
  requestedCount: number;
  now?: () => Date;
}): ScriptRequestBudget {
  const { db, taskId, requestedCount } = options;
  const now = options.now ?? (() => new Date());
  const textCache = new Map<string, number>();

  const readTextUsed = (scope: string): number => {
    const cached = textCache.get(scope);
    if (cached !== undefined) return cached;
    const used = readUsed(db, taskId, 'text', scope);
    textCache.set(scope, used);
    return used;
  };

  return {
    reserve({ planIndex, purpose }) {
      const limits = getScriptStudioLimits();
      const planScope = `plan:${planIndex}`;
      const titleScope = `plan:${planIndex}:title`;
      const taskScope = 'task';
      const taskCap = Math.max(1, requestedCount) * limits.scriptTextRequestsPerProposal;
      // 原子占用：同一事务里校验并递增方案/标题/任务三级计数，避免并发窗口。
      const reserveText = db.transaction(() => {
        const proposalUsed = readUsed(db, taskId, 'text', planScope);
        if (proposalUsed >= limits.scriptTextRequestsPerProposal) {
          throw new ScriptStudioError(
            'request_budget_exhausted',
            `方案 ${planIndex} 的脚本文本请求预算已耗尽（上限 ${limits.scriptTextRequestsPerProposal} 次），本方案不再发起新请求`,
          );
        }
        if (purpose === 'title_repair') {
          const titleUsed = readUsed(db, taskId, 'text', titleScope);
          if (titleUsed >= limits.titleRepairMaxAttempts) {
            throw new ScriptStudioError(
              'request_budget_exhausted',
              `方案 ${planIndex} 的标题修复请求已达上限（${limits.titleRepairMaxAttempts} 次）`,
            );
          }
        }
        const taskUsed = readUsed(db, taskId, 'text', taskScope);
        if (taskUsed >= taskCap) {
          throw new ScriptStudioError(
            'request_budget_exhausted',
            `本任务的脚本文本请求预算已耗尽（上限 ${taskCap} 次），不再发起新请求`,
          );
        }
        incrementUsed(db, taskId, 'text', planScope, now().toISOString());
        if (purpose === 'title_repair') {
          incrementUsed(db, taskId, 'text', titleScope, now().toISOString());
        }
        incrementUsed(db, taskId, 'text', taskScope, now().toISOString());
      });
      reserveText.immediate();
      textCache.delete(planScope);
      textCache.delete(titleScope);
      textCache.delete(taskScope);
    },
    usedFor(planIndex) {
      return readTextUsed(`plan:${planIndex}`);
    },
    titleRepairUsedFor(planIndex) {
      return readTextUsed(`plan:${planIndex}:title`);
    },
    taskTextUsed() {
      return readTextUsed('task');
    },
  };
}

/** 提炼阶段预算：独立计数，不占脚本文本额度（方案 §2.2 / §3.3）。 */
export function reserveDistillRequest(
  db: Database.Database,
  taskId: string,
  now: () => Date = () => new Date(),
): void {
  const limits = getScriptStudioLimits();
  const reserve = db.transaction(() => {
    const used = readUsed(db, taskId, 'distill', 'task');
    if (used >= limits.distillMaxRequestsPerTask) {
      throw new ScriptStudioError(
        'request_budget_exhausted',
        `本任务的卖点提炼请求已达上限（${limits.distillMaxRequestsPerTask} 次），本轮跳过提炼，可复用已有结果`,
      );
    }
    incrementUsed(db, taskId, 'distill', 'task', now().toISOString());
  });
  reserve.immediate();
}

export function distillRequestUsed(db: Database.Database, taskId: string): number {
  return readUsed(db, taskId, 'distill', 'task');
}

/** 受众画像分析预算：独立计数（phase=plan_analysis），失败降级不占用脚本文本额度。 */
export function reservePlanAnalysisRequest(
  db: Database.Database,
  taskId: string,
  now: () => Date = () => new Date(),
): void {
  const limits = getScriptStudioLimits();
  const reserve = db.transaction(() => {
    const used = readUsed(db, taskId, 'plan_analysis', 'task');
    if (used >= limits.planAnalysisMaxRequestsPerTask) {
      throw new ScriptStudioError(
        'request_budget_exhausted',
        `本任务的受众画像分析请求已达上限（${limits.planAnalysisMaxRequestsPerTask} 次），本轮使用降级画像`,
      );
    }
    incrementUsed(db, taskId, 'plan_analysis', 'task', now().toISOString());
  });
  reserve.immediate();
}
