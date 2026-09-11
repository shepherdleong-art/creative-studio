/**
 * 启动一次运行（技术约定 C3／C7）。
 *
 * 顺序很关键：
 * 1. 先查幂等记录——同一 requestKey 的重放必须返回原结果，
 *    不能因为图后来被修改或任务已经开始就拒绝；
 * 2. 再按当前图重新生成计划并与客户端预览指纹比对，避免按过期数量提交；
 * 3. 最后在同一事务里创建 run／tasks／inputs 与节点活跃关联。
 */

import type Database from 'better-sqlite3';
import { canvasExecutorMode } from './config.ts';
import { CanvasError } from './errors.ts';
import {
  canvasPlanFingerprint,
  canvasPlanRequestHash,
  planCanvasRun,
  type CanvasPlan,
  type CanvasPlanProblem,
  type CanvasPlanRequest,
} from './planner.ts';
import {
  createCanvasRun,
  findCanvasRunByRequestKey,
  listCanvasTasksForRun,
  type CanvasRunRecord,
  type CanvasTaskRecord,
} from './tasks.ts';

export interface StartCanvasRunParams {
  db: Database.Database;
  request: CanvasPlanRequest;
  /** 客户端预览时拿到的计划指纹；缺失时按当前图直接执行。 */
  planFingerprint?: string;
  now?: () => Date;
}

export interface StartCanvasRunResult {
  plan: CanvasPlan;
  run: CanvasRunRecord;
  tasks: CanvasTaskRecord[];
  idempotentReplay: boolean;
}

function problemsError(problems: CanvasPlanProblem[]): CanvasError {
  const first = problems[0];
  const conflictCodes = new Set(['node_busy', 'revision_conflict']);
  const capabilityCodes = new Set(['model_not_selected', 'capability_unknown', 'capability_input_invalid']);
  const code = first && conflictCodes.has(first.code) ? 'conflict'
    : first && capabilityCodes.has(first.code) ? 'capability_unavailable'
      : 'invalid_input';
  return new CanvasError(code, first?.message ?? '计划校验未通过。', { problems });
}

export function assertCanvasRunStartable(): void {
  const executor = canvasExecutorMode();
  if (executor === 'disabled') {
    throw new CanvasError(
      'runtime_unavailable',
      '当前执行器为 disabled：画布可以编辑，但不会启动生成任务。请在受控临时根设置 CREATIVE_STUDIO_CANVAS_EXECUTOR=fixture，或先配置公司执行器。',
    );
  }
}

export function startCanvasRun(params: StartCanvasRunParams): StartCanvasRunResult {
  const { db, request } = params;
  const now = params.now ?? (() => new Date());

  // 重放优先：先看幂等记录，再看当前图与活跃状态。
  // 图后来改了、任务已经开始，都不能拒绝本应返回原结果的同一请求重放。
  const existing = findCanvasRunByRequestKey(db, request.canvasId, request.requestKey);
  if (existing) {
    if (existing.requestHash !== canvasPlanRequestHash(request)) {
      throw new CanvasError('conflict', '同一请求标识对应了不同的运行请求，请重新预览后再提交。', {
        runId: existing.id,
      });
    }
    const plan = JSON.parse(existing.planSnapshot) as CanvasPlan;
    if (params.planFingerprint !== undefined && params.planFingerprint !== plan.fingerprint) {
      throw new CanvasError('conflict', '同一请求标识对应了不同的计划内容，请重新预览后再提交。', {
        runId: existing.id,
        actualFingerprint: plan.fingerprint,
      });
    }
    return {
      plan,
      run: existing,
      tasks: listCanvasTasksForRun(db, existing.id),
      idempotentReplay: true,
    };
  }

  assertCanvasRunStartable();

  const outcome = planCanvasRun(db, request);
  if (!outcome.ok) throw problemsError(outcome.problems);
  const plan = outcome.plan;

  if (params.planFingerprint !== undefined && params.planFingerprint !== plan.fingerprint) {
    throw new CanvasError('conflict', '画布或输入已经变化，请按更新后的计划重新确认。', {
      plan,
      expectedFingerprint: params.planFingerprint,
      actualFingerprint: plan.fingerprint,
    });
  }

  const requestHash = canvasPlanRequestHash(request);
  const created = createCanvasRun(db, { plan, requestHash, now });
  return { plan, run: created.run, tasks: created.tasks, idempotentReplay: created.idempotentReplay };
}

export { canvasPlanFingerprint };
