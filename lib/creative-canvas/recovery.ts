/**
 * 画布故障恢复（技术约定 C4／C5）。
 *
 * 恢复按事实处理，不用「重新生成」绕过错误：
 * - 有 providerTaskId：只查询原任务，成功就补下载原产物；
 * - 可能已提交但没有远端身份：进入 uncertain，保留名额，等用户核查，禁止自动重发；
 * - 确定未提交（preparing 或 queued）：回到等待用户继续，用原设置启动原任务；
 * - 输出已落盘但发布事务中断：文件与资产身份都在，接管同一文件而不是重新生成。
 *
 * 所有恢复动作都不改变输入快照；用户改了草稿只能启动新任务。
 */

import type Database from 'better-sqlite3';
import { CanvasError } from './errors.ts';
import {
  getCanvasTask,
  listCanvasTasks,
  requireCanvasTask,
  updateCanvasTaskUnGuarded,
  type CanvasTaskRecord,
} from './tasks.ts';

export interface CanvasRecoveryReport {
  /** 有远端身份、可以继续查询或补下载的任务。 */
  resumable: string[];
  /** 确定未提交、等用户继续的任务。 */
  pending: string[];
  /** 可能已提交但身份不明，必须核查的任务。 */
  uncertain: string[];
  /** 本地工作中断、可清理准备状态的任务。 */
  cleaned: string[];
}

/**
 * 重启后的恢复：只调整本地可安全推进的状态，不重新生成、不释放可能仍占用的名额。
 * 由 bootstrap 在 readiness 通过后调用一次。
 */
export function recoverCanvasTasks(
  db: Database.Database,
  now: () => Date = () => new Date(),
): CanvasRecoveryReport {
  const report: CanvasRecoveryReport = { resumable: [], pending: [], uncertain: [], cleaned: [] };
  const at = now().toISOString();
  const inFlight = listCanvasTasks(db, { limit: 500 }).filter((task) => (
    ['preparing', 'submitting', 'polling', 'downloading'].includes(task.phase)
  ));

  for (const task of inFlight) {
    if (task.providerTaskId) {
      // 有远端身份：保留名额，交给调度器接管查询／补下载
      updateCanvasTaskUnGuarded(db, task.id, {
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: at,
      });
      report.resumable.push(task.id);
      continue;
    }
    if (task.phase === 'preparing') {
      // 确定还没提交：清理准备状态，等用户继续
      updateCanvasTaskUnGuarded(db, task.id, {
        phase: 'resume_pending',
        slotHeld: false,
        submissionState: 'not_sent',
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: at,
      });
      report.pending.push(task.id);
      continue;
    }
    // submitting 且没有远端身份：请求可能已经送达，保守进入待核查并保留名额
    updateCanvasTaskUnGuarded(db, task.id, {
      phase: 'uncertain',
      slotHeld: true,
      submissionState: 'maybe_sent',
      errorCode: task.errorCode ?? 'submission_unknown',
      errorMessage: task.errorMessage ?? '进程在提交过程中中断，远端是否已创建任务不明，请核查后再继续。',
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: at,
    });
    report.uncertain.push(task.id);
  }

  return report;
}

/** 用户确认「远端没有创建任务」：按失败收尾并释放名额，不自动重发。 */
export function reconcileCanvasTaskNotCreated(
  db: Database.Database,
  params: { taskId: string; now?: () => Date },
): CanvasTaskRecord {
  const task = requireCanvasTask(db, params.taskId);
  if (task.phase !== 'uncertain') {
    throw new CanvasError('conflict', '只有待核查的任务需要核查结论。');
  }
  const at = (params.now ?? (() => new Date()))().toISOString();
  updateCanvasTaskUnGuarded(db, task.id, {
    phase: 'failed',
    slotHeld: false,
    submissionState: 'terminal',
    errorCode: 'confirmed_not_created',
    errorMessage: '已核查：远端没有创建任务。',
    updatedAt: at,
  });
  releaseNodeActiveTask(db, task);
  return requireCanvasTask(db, task.id);
}

/** 用户核查到远端任务 ID：接管原任务继续查询，不重新提交。 */
export function reconcileCanvasTaskWithRemoteId(
  db: Database.Database,
  params: { taskId: string; providerTaskId: string; now?: () => Date },
): CanvasTaskRecord {
  const task = requireCanvasTask(db, params.taskId);
  if (task.phase !== 'uncertain') {
    throw new CanvasError('conflict', '只有待核查的任务需要核查结论。');
  }
  const providerTaskId = params.providerTaskId.trim();
  if (!providerTaskId) throw new CanvasError('invalid_input', '远端任务 ID 不能为空。');
  const at = (params.now ?? (() => new Date()))().toISOString();
  updateCanvasTaskUnGuarded(db, task.id, {
    phase: 'polling',
    slotHeld: true,
    submissionState: 'accepted',
    providerTaskId,
    errorCode: null,
    errorMessage: null,
    updatedAt: at,
  });
  return requireCanvasTask(db, task.id);
}

/**
 * 下载失败后的补下载：回到查询阶段，用已保存的远端身份重新取原产物。
 * 这里绝不重新生成——提交状态与参数快照都不变。
 */
export function retryCanvasTaskDownload(
  db: Database.Database,
  params: { taskId: string; now?: () => Date },
): CanvasTaskRecord {
  const task = requireCanvasTask(db, params.taskId);
  if (task.phase !== 'download_failed') {
    throw new CanvasError('conflict', '只有下载失败的任务需要补下载。');
  }
  if (!task.providerTaskId) {
    throw new CanvasError('conflict', '该任务没有远端任务身份，无法补下载。');
  }
  const at = (params.now ?? (() => new Date()))().toISOString();
  updateCanvasTaskUnGuarded(db, task.id, {
    phase: 'polling',
    slotHeld: true,
    errorCode: null,
    errorMessage: null,
    updatedAt: at,
  });
  return requireCanvasTask(db, task.id);
}

/**
 * 继续一个确定未提交的任务（本地工作中断后的 resume_pending）。
 * 输入快照不变；如果用户已经改了草稿，那属于新任务，应该重新生成而不是走到这里。
 */
export function resumeCanvasTask(
  db: Database.Database,
  params: { taskId: string; now?: () => Date },
): CanvasTaskRecord {
  const task = requireCanvasTask(db, params.taskId);
  if (task.phase !== 'resume_pending' && task.phase !== 'uncertain') {
    throw new CanvasError('conflict', '只有等待继续或待核查的任务可以继续。');
  }
  if (task.phase === 'uncertain') {
    throw new CanvasError('conflict', '待核查任务必须先给出核查结论（未创建或已有远端 ID）。');
  }
  const at = (params.now ?? (() => new Date()))().toISOString();
  updateCanvasTaskUnGuarded(db, task.id, {
    phase: 'queued',
    submissionState: 'not_sent',
    slotHeld: false,
    errorCode: null,
    errorMessage: null,
    updatedAt: at,
  });
  return requireCanvasTask(db, task.id);
}

/**
 * 用户停止任务：
 * - 还没提交（等待／排队／准备）→ 直接取消，不占名额；
 * - 已经提交 → 只记录取消意图，由在飞执行器按供应商真实能力处理（不支持取消时保留名额与身份）。
 */
export function requestCanvasTaskCancel(
  db: Database.Database,
  params: { taskId: string; now?: () => Date },
): CanvasTaskRecord {
  const task = requireCanvasTask(db, params.taskId);
  const at = (params.now ?? (() => new Date()))().toISOString();
  const notSubmitted = !task.providerTaskId
    && ['waiting_input', 'queued', 'preparing', 'resume_pending'].includes(task.phase);
  if (notSubmitted) {
    updateCanvasTaskUnGuarded(db, task.id, {
      phase: 'cancelled',
      slotHeld: false,
      submissionState: 'terminal',
      errorCode: 'cancelled',
      errorMessage: '用户已停止该任务。',
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: at,
    });
    releaseNodeActiveTask(db, task);
    return requireCanvasTask(db, task.id);
  }
  if (['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.phase)) {
    throw new CanvasError('conflict', '该任务已经结束。');
  }
  updateCanvasTaskUnGuarded(db, task.id, { cancelRequestedAt: at, updatedAt: at });
  return requireCanvasTask(db, task.id);
}

/** 把节点的活跃任务关联清掉（任务收尾时用；发布检查仍以 activeTaskId + epoch 为准）。 */
function releaseNodeActiveTask(db: Database.Database, task: CanvasTaskRecord): void {
  db.prepare(
    `UPDATE creative_canvas_node_states SET activeTaskId = NULL, updatedAt = ?
      WHERE canvasId = ? AND nodeId = ? AND activeTaskId = ?`,
  ).run(new Date().toISOString(), task.canvasId, task.nodeId, task.id);
}

/**
 * 接管可安全继续的任务：lease 过期且已有远端身份时，允许新 worker 继续查询／下载。
 * **不会**把可能已提交的工作变回「可以再 POST」。
 */
export function takeOverResumableCanvasTasks(
  db: Database.Database,
  params: { now?: () => Date } = {},
): string[] {
  const at = (params.now ?? (() => new Date()))();
  const atIso = at.toISOString();
  const rows = db.prepare(`
    SELECT id FROM creative_canvas_tasks
     WHERE providerTaskId IS NOT NULL
       AND phase IN ('polling', 'downloading')
       AND (leaseUntil IS NULL OR leaseUntil < ?)
  `).all(atIso) as Array<{ id: string }>;
  for (const row of rows) {
    updateCanvasTaskUnGuarded(db, row.id, { leaseOwner: null, leaseUntil: null, updatedAt: atIso });
  }
  return rows.map((row) => row.id);
}

/** 画布恢复入口的汇总视图（界面与测试共用）。 */
export function canvasRecoverySnapshot(db: Database.Database): {
  uncertain: CanvasTaskRecord[];
  downloadFailed: CanvasTaskRecord[];
  resumePending: CanvasTaskRecord[];
} {
  const tasks = listCanvasTasks(db, { limit: 500 });
  return {
    uncertain: tasks.filter((task) => task.phase === 'uncertain'),
    downloadFailed: tasks.filter((task) => task.phase === 'download_failed'),
    resumePending: tasks.filter((task) => task.phase === 'resume_pending'),
  };
}

export function canvasTaskNeedsAttention(task: CanvasTaskRecord): boolean {
  return task.phase === 'uncertain'
    || task.phase === 'download_failed'
    || task.phase === 'resume_pending';
}

export { getCanvasTask };
