import type Database from 'better-sqlite3';
import { ScriptStudioError } from './errors.ts';
import {
  recoverInterruptedTasks,
  updateTask,
  type TaskView,
} from './tasks.ts';

export interface ClaimedScriptStudioTask {
  task: TaskView;
  leaseUntil: string;
}

export interface ScriptStudioTaskExecutor {
  execute(task: TaskView, signal: AbortSignal): Promise<void>;
}

export interface ScriptStudioSchedulerController {
  stop(): Promise<void>;
  runPendingOnce(): Promise<number>;
  /** 由 API route 通过全局调度器实例转发，避免 Next.js 多 bundle 的模块内状态隔离。 */
  requestCancel(taskId: string): boolean;
}

export const SCRIPT_STUDIO_SCHEDULER_KEY = Symbol.for('creative-studio.script-studio-scheduler');

export function getScriptStudioSchedulerController(): ScriptStudioSchedulerController | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[SCRIPT_STUDIO_SCHEDULER_KEY] as ScriptStudioSchedulerController | undefined;
}

let draining = false;
const activeControllers = new Set<AbortController>();
// running 任务的按 id 索引，供「停止任务」精确定位；取消标记保证 runner 落库为 cancelled 而不是 queued 重跑。
const activeTaskControllers = new Map<string, AbortController>();
const cancelRequestedTasks = new Set<string>();

export function setScriptStudioSchedulerDraining(value: boolean): void {
  draining = value;
}

export function abortRunningScriptStudioTasks(): number {
  for (const controller of activeControllers) controller.abort();
  return activeControllers.size;
}

/** 请求停止任务：running 中断信号；queued 返回 false，由调用方直接落库为 cancelled。 */
export function requestScriptStudioTaskCancel(taskId: string): boolean {
  // instrumentation 与 API route 在 Next.js 开发/生产构建中可能是不同模块实例；
  // 模块内 Map 可能是空的，但 Symbol.for 指向的调度器闭包才持有真正运行状态。
  const scheduler = getScriptStudioSchedulerController();
  if (scheduler) return scheduler.requestCancel(taskId);
  return requestLocalScriptStudioTaskCancel(taskId);
}

function requestLocalScriptStudioTaskCancel(taskId: string): boolean {
  cancelRequestedTasks.add(taskId);
  const controller = activeTaskControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isScriptStudioTaskCancelRequested(taskId: string): boolean {
  return cancelRequestedTasks.has(taskId);
}

export async function waitForScriptStudioTasksIdle(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeControllers.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return activeControllers.size;
}

function isoAfter(now: Date, durationMs: number): string {
  return new Date(now.getTime() + durationMs).toISOString();
}

export function claimNextScriptStudioTask(
  db: Database.Database,
  options: { workerId: string; leaseDurationMs?: number; now?: () => Date },
): ClaimedScriptStudioTask | null {
  if (draining) return null;
  const now = options.now ?? (() => new Date());
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM script_studio_tasks WHERE status = 'queued'
      ORDER BY createdAt, id LIMIT 1
    `).get() as TaskView | undefined;
    if (!row) return null;
    const leaseUntil = isoAfter(now(), options.leaseDurationMs ?? 5 * 60_000);
    const claimed = updateTask(db, row.projectId, row.id, {
      status: 'running',
      currentStage: '',
      leaseUntil,
      attemptCount: Number(row.attemptCount || 0) + 1,
    }, now);
    return { task: claimed, leaseUntil };
  }).immediate();
}

export function renewScriptStudioLease(
  db: Database.Database,
  taskId: string,
  projectId: string,
  options: { leaseDurationMs?: number; now?: () => Date },
): boolean {
  const task = db.prepare(`
    SELECT * FROM script_studio_tasks WHERE id = ? AND projectId = ?
  `).get(taskId, projectId) as TaskView | undefined;
  if (!task || task.status !== 'running') return false;
  const leaseUntil = isoAfter((options.now ?? (() => new Date()))(), options.leaseDurationMs ?? 5 * 60_000);
  updateTask(db, projectId, taskId, { leaseUntil }, options.now);
  return true;
}

export function recoverScriptStudioTasks(
  db: Database.Database,
  now?: () => Date,
): number {
  return recoverInterruptedTasks(db, now);
}

export function startScriptStudioScheduler(options: {
  db: Database.Database;
  workerId: string;
  executor: ScriptStudioTaskExecutor;
  intervalMs?: number;
  leaseDurationMs?: number;
  concurrency?: number;
}): ScriptStudioSchedulerController {
  const { db, workerId, executor } = options;
  const intervalMs = Math.max(250, options.intervalMs ?? 2_000);
  const concurrency = Math.max(1, Math.min(3, options.concurrency ?? 1));
  let stopped = false;
  let running = 0;
  let wake: (() => void) | null = null;
  const runPendingOnce = async (): Promise<number> => {
    if (stopped || draining) return 0;
    let handled = 0;
    const slot = async (): Promise<void> => {
      while (!stopped && !draining) {
        const claim = claimNextScriptStudioTask(db, {
          workerId,
          leaseDurationMs: options.leaseDurationMs,
        });
        if (!claim) return;
        const controller = new AbortController();
        activeControllers.add(controller);
        activeTaskControllers.set(claim.task.id, controller);
        // 取消请求可能抢先于注册到达：注册后立即补一次中断。
        if (cancelRequestedTasks.has(claim.task.id)) controller.abort();
        running += 1;
        handled += 1;
        try {
          await executor.execute(claim.task, controller.signal);
        } catch {
          // 执行器负责把任务写成失败/可恢复状态；调度器只保证不因异常退出循环。
        } finally {
          activeControllers.delete(controller);
          activeTaskControllers.delete(claim.task.id);
          cancelRequestedTasks.delete(claim.task.id);
          running -= 1;
          if (stopped && running === 0 && wake) wake();
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => slot()));
    return handled;
  };

  const timer = setInterval(() => {
    void runPendingOnce();
  }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      setScriptStudioSchedulerDraining(true);
      for (const controller of activeControllers) controller.abort();
      while (running > 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      clearInterval(timer);
      setScriptStudioSchedulerDraining(false);
    },
    runPendingOnce,
    requestCancel: requestLocalScriptStudioTaskCancel,
  };
}
