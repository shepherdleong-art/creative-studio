import type Database from 'better-sqlite3';
import { findExecutor, type BatchTaskExecutor, type BatchTaskProgress } from './executors.ts';
import {
  claimNextTask,
  completeTaskAttempt,
  expireStaleLeases,
  hasValidLease,
  recoverInterruptedWork,
  renewLease,
  setBatchSchedulerDraining,
  settleInterruptedTask,
} from './scheduler.ts';

export interface SchedulerRunOptions {
  db: Database.Database;
  workerId: string;
  executors: BatchTaskExecutor[];
  /** 全局同时运行的任务数上限(资源保护) */
  concurrency?: number;
  leaseDurationMs?: number;
  /** 执行期间独立心跳与批次控制检查间隔 */
  heartbeatMs?: number;
  /** 进度落库节流间隔;高频进度(如 FFmpeg)默认 1 秒写一次 */
  progressThrottleMs?: number;
  now?: () => Date;
  /** 调用方主动停止全部工作;属于用户停止语义。 */
  signal?: AbortSignal;
  /** 进程内调度器关闭;任务应可在下次启动恢复。 */
  shutdownSignal?: AbortSignal;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

const activeBatchTaskControllers = new Set<AbortController>();

/** 广播停机到不一定已经拿到 scheduler controller 的批量执行器。 */
export function abortRunningBatchTasks(): number {
  const running = [...activeBatchTaskControllers];
  for (const controller of running) controller.abort();
  return running.length;
}

/** 返回超时后仍在执行的批量任务数。 */
export async function waitForBatchTasksIdle(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeBatchTaskControllers.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return activeBatchTaskControllers.size;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

type ExecuteOneOutcome = 'completed' | 'lease_lost';
type InterruptionReason = 'batch_control' | 'lease_lost' | 'superseded';

/**
 * 领取并执行一轮可执行任务(受控 worker pool)。
 * 同时运行的任务数永远不超过 concurrency:每个并发槽独立循环领取,
 * 领取由数据库原子性保证不重复,所有槽执行完才返回。
 * 执行期间独立心跳续租(不依赖执行器是否报告进度),并监视批次控制状态:
 * 批次暂停/停止时中止运行任务并按期望落账。
 */
export async function runPendingOnce(options: SchedulerRunOptions): Promise<number> {
  const {
    db,
    workerId,
    executors,
    concurrency = 2,
    leaseDurationMs = 5 * 60_000,
    heartbeatMs = Math.max(200, Math.min(1_000, Math.floor(leaseDurationMs / 3))),
    progressThrottleMs = 1_000,
  } = options;
  const now = options.now;
  let handled = 0;

  // 一个并发槽:循环领取执行,直到没有可领取任务
  const slot = async (): Promise<void> => {
    while (!options.signal?.aborted && !options.shutdownSignal?.aborted) {
      const claim = claimNextTask(db, { workerId, now, leaseDurationMs });
      if (!claim) {
        return;
      }
      handled += 1;
      const controller = new AbortController();
      const outcome = await executeOne(claim, controller, {
        db,
        workerId,
        executors,
        leaseDurationMs,
        heartbeatMs,
        progressThrottleMs,
        now,
        signal: options.signal,
        shutdownSignal: options.shutdownSignal,
      });
      if (outcome === 'lease_lost') {
        // 本 worker 已失去提交资格。本轮不要立即重新领取同一任务;
        // 让下一轮或其他 worker 在新的租约下安全恢复。
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => slot()));
  return handled;
}

interface ExecuteOneOptions {
  db: Database.Database;
  workerId: string;
  executors: BatchTaskExecutor[];
  leaseDurationMs: number;
  heartbeatMs: number;
  progressThrottleMs: number;
  now?: () => Date;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
}

async function executeOne(
  claim: NonNullable<Awaited<ReturnType<typeof claimNextTask>>>,
  controller: AbortController,
  options: ExecuteOneOptions,
): Promise<ExecuteOneOutcome> {
  const { db, workerId, executors, leaseDurationMs, heartbeatMs, progressThrottleMs, now } = options;
  activeBatchTaskControllers.add(controller);
  const executor = findExecutor(executors, claim.task.workType);
  let lastProgressWrite = 0;
  const lastProgress: BatchTaskProgress = { phase: 'starting' };
  let interruptionReason: InterruptionReason | null = null;
  let discardUnacceptedResult: (() => Promise<void> | void) | undefined;
  const interrupt = (reason: InterruptionReason): void => {
    interruptionReason ??= reason;
    controller.abort();
  };
  const reportProgress = (progress: BatchTaskProgress): void => {
    Object.assign(lastProgress, progress);
    const nowMs = Date.now();
    if (nowMs - lastProgressWrite < progressThrottleMs) {
      return;
    }
    lastProgressWrite = nowMs;
    // 只有持有有效租约的 worker 才能写进度
    if (!renewLease(db, claim.attempt.id, { workerId, now, leaseDurationMs })) {
      interrupt('lease_lost');
      return;
    }
    db.prepare(`
      UPDATE batch_task_attempts SET progressJson = ? WHERE id = ? AND claimedBy = ?
    `).run(JSON.stringify(lastProgress), claim.attempt.id, workerId);
  };

  // 独立心跳:定期续租并检查控制状态,不依赖执行器是否报告进度。
  // 同时检查批次 controlState 和这个任务自己的 expectedState——单独暂停/取消
  // 一个任务(不动批次 controlState)必须能在下一个心跳周期内被感知并中止,
  // 不必等任务自然跑完。
  const heartbeat = setInterval(() => {
    if (!renewLease(db, claim.attempt.id, { workerId, now, leaseDurationMs })) {
      interrupt('lease_lost');
      return;
    }
    const control = db.prepare(`
      SELECT p.controlState, t.expectedState,
        CASE
          WHEN t.workType <> 'render' OR t.targetKind <> 'output_version' THEN 1
          WHEN EXISTS (
            SELECT 1 FROM batch_output_versions o
            JOIN batch_output_plans plan ON plan.id = o.planId
            WHERE o.id = t.targetId AND plan.currentVersionId = o.id
          ) THEN 1 ELSE 0
        END AS targetIsCurrent
      FROM batch_tasks t
      JOIN batch_productions p ON p.id = t.batchId
      WHERE t.id = ?
    `).get(claim.task.id) as { controlState: string; expectedState: string; targetIsCurrent: number } | undefined;
    if (control?.targetIsCurrent === 0) {
      interrupt('superseded');
    } else if (control && (control.controlState !== 'running' || control.expectedState !== 'running')) {
      interrupt('batch_control');
    }
  }, heartbeatMs);

  try {
    if (!executor) {
      throw new Error(`没有注册可执行 ${claim.task.workType} 任务的执行器`);
    }
    reportProgress({ phase: 'running' });
    // 执行器同时接收内部控制信号(批次暂停/停止)与外部停止信号
    const signals = [controller.signal, options.signal, options.shutdownSignal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    const executorSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
    const execution = await executor.execute({
      db,
      claim,
      signal: executorSignal,
      reportProgress,
    });
    let resultJson = execution.resultJson;
    discardUnacceptedResult = execution.discard;
    // 执行器可能没有及时响应 AbortSignal。结果发布前必须重新核对持久化
    // 控制状态,不能让 pause/stop 之后的迟到回调提交 succeeded。
    // 指针、控制态、租约和成功落账必须在同一 SQLite 事务内检查，避免
    // 重分配刚切换 currentVersionId 时旧 render 仍提交迟到候选。
    db.transaction(() => {
      const completionState = db.prepare(`
        SELECT t.expectedState, p.controlState,
          CASE
            WHEN t.workType <> 'render' OR t.targetKind <> 'output_version' THEN 1
            WHEN EXISTS (
              SELECT 1 FROM batch_output_versions o
              JOIN batch_output_plans plan ON plan.id = o.planId
              WHERE o.id = t.targetId AND plan.currentVersionId = o.id
            ) THEN 1 ELSE 0
          END AS targetIsCurrent
        FROM batch_tasks t
        JOIN batch_productions p ON p.id = t.batchId
        WHERE t.id = ?
      `).get(claim.task.id) as { expectedState: string; controlState: string; targetIsCurrent: number } | undefined;
      if (completionState?.targetIsCurrent === 0) {
        interrupt('superseded');
        throw new Error('渲染目标已被新成片版本替代,不能提交结果');
      }
      if (
        !completionState
        || executorSignal.aborted
        || completionState.expectedState !== 'running'
        || completionState.controlState !== 'running'
      ) {
        interrupt('batch_control');
        throw new Error('任务已被暂停或停止,不能提交结果');
      }
      if (!hasValidLease(db, claim.attempt.id, workerId, now)) {
        interrupt('lease_lost');
        throw new Error('任务租约已到期,不能提交结果');
      }
      if (execution.commit) {
        const committed = execution.commit();
        resultJson = committed.resultJson;
        discardUnacceptedResult = committed.discard ?? discardUnacceptedResult;
        if (committed.progress) Object.assign(lastProgress, committed.progress);
        // commit 回调也可能触发外部停止信号；再次检查可让同一事务完整
        // 回滚刚发布的领域写入，而不是把取消后的结果落成 succeeded。
        if (executorSignal.aborted) {
          interrupt('batch_control');
          throw new Error('任务在发布结果时被中止,不能提交成功结果');
        }
      }
      db.prepare(`
        UPDATE batch_task_attempts SET progressJson = ? WHERE id = ? AND claimedBy = ?
      `).run(JSON.stringify(lastProgress), claim.attempt.id, workerId);
      completeTaskAttempt(db, claim.attempt.id, {
        workerId,
        status: 'succeeded',
        progressJson: lastProgress,
        resultJson,
        now,
      });
    }).immediate();
    discardUnacceptedResult = undefined;
    return 'completed';
  } catch (error) {
    if (discardUnacceptedResult) {
      await Promise.resolve(discardUnacceptedResult()).catch(() => undefined);
      discardUnacceptedResult = undefined;
    }
    // 用信号状态判定中止来源,不靠错误消息猜测:
    // 外部停止信号 → 停止终态;内部控制检查(批次暂停/停止) → 按批次期望落账
    const abortedByUserStop = Boolean(options.signal?.aborted);
    const abortedBySchedulerShutdown = Boolean(options.shutdownSignal?.aborted);
    if (abortedByUserStop) {
      // 外部停止信号:任务进入停止终态,尝试记录为 interrupted
      settleInterruptedTask(db, claim.attempt.id, now, 'user_stop');
    } else if (abortedBySchedulerShutdown) {
      // 应用/调度器关闭不是用户停止:尝试结束,任务保持 running 期望并可恢复。
      settleInterruptedTask(db, claim.attempt.id, now, 'scheduler_shutdown');
    } else if (interruptionReason === 'superseded') {
      settleInterruptedTask(db, claim.attempt.id, now, 'superseded');
    } else if (interruptionReason === 'lease_lost' || !hasValidLease(db, claim.attempt.id, workerId, now)) {
      // 租约丢失不是用户暂停。只做过期恢复,保留 expectedState=running;
      // 如果尝试已被其他恢复流程处理,这里不会覆盖其结果。
      expireStaleLeases(db, { now });
      return 'lease_lost';
    } else if (controller.signal.aborted) {
      // 批次暂停/停止(内部控制检查):按批次期望落成可继续或终态
      settleInterruptedTask(db, claim.attempt.id, now, 'batch_control');
    } else {
      // 执行器抛出的带 code 错误(如 semantic_fallback)保留机器可读错误码,
      // 供重试入口与界面区分失败原因;其余维持 executor_error。
      const executorErrorCode = (error as { code?: unknown } | null)?.code;
      completeTaskAttempt(db, claim.attempt.id, {
        workerId,
        status: 'failed',
        errorCode: typeof executorErrorCode === 'string' && executorErrorCode ? executorErrorCode : 'executor_error',
        errorMessage: error instanceof Error ? error.message : String(error),
        progressJson: lastProgress,
        now,
      });
    }
    return 'completed';
  } finally {
    clearInterval(heartbeat);
    activeBatchTaskControllers.delete(controller);
  }
}

export interface SchedulerController {
  /** 停止领取并等待所有在途任务安全落账。 */
  stop(): Promise<void>;
  readonly running: boolean;
}

interface SchedulerState {
  stopped: boolean;
  loopPromise: Promise<void> | null;
  stopController: AbortController;
}

let schedulerInstance: SchedulerState | null = null;
let schedulerController: SchedulerController | null = null;

/**
 * 启动进程内单例调度循环:启动时先做一次恢复(旧实例 running 尝试失效),
 * 然后按间隔持续领取执行。同一进程重复初始化幂等(返回同一个 controller 实例);
 * stop() 停止继续领取并清理定时器与调度状态。
 */
export function startBatchScheduler(
  options: SchedulerRunOptions & { intervalMs?: number },
): SchedulerController {
  if (schedulerInstance && schedulerController) {
    return schedulerController;
  }
  setBatchSchedulerDraining(false);
  const { db, intervalMs = 2_000 } = options;
  recoverInterruptedWork(db, { now: options.now });
  const state: SchedulerState = {
    stopped: false,
    loopPromise: null,
    stopController: new AbortController(),
  };

  const loop = async (): Promise<void> => {
    while (!state.stopped) {
      // 每轮先处理过期租约,再执行受控的一轮
      try {
        expireStaleLeases(db, { now: options.now });
        await runPendingOnce({ ...options, shutdownSignal: state.stopController.signal });
      } catch (error) {
        // 单轮调度失败不影响循环;错误已由任务落账或在下轮重试
        console.error('批量调度单轮失败:', error instanceof Error ? error.message : String(error));
      }
      await sleep(intervalMs, state.stopController.signal);
    }
  };

  state.loopPromise = loop();
  schedulerInstance = state;
  const controller: SchedulerController = {
    async stop() {
      setBatchSchedulerDraining(true);
      if (!state.stopped) {
        state.stopped = true;
        state.stopController.abort();
      }
      // 不提前释放单例:必须等当前一轮中止并落账,避免重启后双调度器共存。
      await state.loopPromise;
      if (schedulerInstance === state && schedulerController === controller) {
        schedulerInstance = null;
        schedulerController = null;
      }
    },
    get running() {
      return !state.stopped;
    },
  };
  schedulerController = controller;
  return controller;
}

/** 返回当前进程的批量调度器；未启动时为 null。 */
export function getBatchSchedulerController(): SchedulerController | null {
  return schedulerController;
}

/** 测试用:重置进程内单例状态。 */
export async function resetSchedulerSingletonForTests(): Promise<void> {
  await schedulerController?.stop();
  schedulerInstance = null;
  schedulerController = null;
  setBatchSchedulerDraining(false);
}

export { nowIso };
