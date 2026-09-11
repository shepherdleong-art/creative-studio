/**
 * 持久化调度器（技术约定 C4）。
 *
 * - 所有创作画布的图片与视频任务共享全局默认 10 个名额；等待输入的任务不占名额。
 * - 名额由 SQLite 写事务领取并持久化到 slotHeld，两个调度器实例同时领取也不会超过上限。
 * - 某个任务缺输入或某个模型名额不足时跳过它继续扫描，不阻塞其他就绪任务。
 * - 任务推进不依赖前端计时器：HTTP 启动的任务由这里的循环推进。
 */

import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { canvasStorageRoot } from './assets.ts';
import type { CanvasTaskAdapter } from './adapters/types.ts';
import { runCanvasTask, type CanvasRunTaskOutcome } from './runner.ts';
import {
  CANVAS_DEFAULT_GLOBAL_TASK_LIMIT,
  CANVAS_DEFAULT_TASK_LEASE_MS,
  claimCanvasTasks,
  resolveCanvasTaskInputs,
} from './tasks.ts';

export interface CanvasSchedulerOptions {
  db: Database.Database;
  workerId: string;
  /** 执行器：fixture 或公司适配器；P2 只要求可注入。 */
  adapter: CanvasTaskAdapter;
  storageRoot?: string;
  globalLimit?: number;
  intervalMs?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  now?: () => Date;
  quotaLimits?: Record<string, number>;
  sleep?: (ms: number) => Promise<void>;
  onTaskSettled?: (outcome: CanvasRunTaskOutcome) => void;
}

export interface CanvasTickResult {
  promoted: string[];
  blocked: string[];
  claimed: string[];
  running: number;
}

export interface CanvasSchedulerController {
  readonly workerId: string;
  tick(): Promise<CanvasTickResult>;
  /** 等待当前在飞的任务结束（测试与停机使用）。 */
  drain(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

export function createCanvasScheduler(options: CanvasSchedulerOptions): CanvasSchedulerController {
  const {
    db,
    workerId,
    adapter,
    globalLimit = CANVAS_DEFAULT_GLOBAL_TASK_LIMIT,
    intervalMs = 1_000,
    pollIntervalMs = 1_000,
    leaseMs = CANVAS_DEFAULT_TASK_LEASE_MS,
    now = () => new Date(),
    quotaLimits,
    sleep,
    onTaskSettled,
  } = options;
  const storageRoot = options.storageRoot ?? canvasStorageRoot(dataRoot());

  const inFlight = new Map<string, Promise<CanvasRunTaskOutcome>>();
  // 停机时用同一组 AbortSignal 中断本地 I/O；已有远端身份的查询由恢复流程接管。
  const runAborters = new Map<string, AbortController>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let ticking = false;

  async function tick(): Promise<CanvasTickResult> {
    const resolved = resolveCanvasTaskInputs(db, now);
    const claimed = claimCanvasTasks({
      db,
      workerId,
      globalLimit,
      leaseMs,
      now,
      ...(quotaLimits ? { quotaLimits } : {}),
    });

    for (const { task, fence } of claimed) {
      if (inFlight.has(task.id)) continue;
      const aborter = new AbortController();
      runAborters.set(task.id, aborter);
      const run = runCanvasTask({
        db,
        taskId: task.id,
        adapter,
        workerId,
        fence,
        storageRoot,
        now,
        pollIntervalMs,
        signal: aborter.signal,
        ...(sleep ? { sleep } : {}),
      }).then((outcome) => {
        inFlight.delete(task.id);
        runAborters.delete(task.id);
        onTaskSettled?.(outcome);
        return outcome;
      }, (error: unknown) => {
        inFlight.delete(task.id);
        runAborters.delete(task.id);
        throw error;
      });
      // 执行器内部已经处理阶段错误；这里只保证不会产生未处理的 rejection
      run.catch(() => undefined);
      inFlight.set(task.id, run);
    }

    return {
      promoted: resolved.promoted,
      blocked: resolved.blocked,
      claimed: claimed.map(({ task }) => task.id),
      running: inFlight.size,
    };
  }

  return {
    workerId,
    get running(): boolean {
      return !stopped;
    },
    tick,
    async drain(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
      }
    },
    start(): void {
      if (!stopped) return;
      stopped = false;
      const loop = async () => {
        if (stopped || ticking) return;
        ticking = true;
        try {
          await tick();
        } catch {
          // 单次 tick 失败不能终止调度循环
        } finally {
          ticking = false;
        }
      };
      timer = setInterval(() => { void loop(); }, intervalMs);
      timer.unref?.();
      void loop();
    },
    async stop(): Promise<void> {
      // 顺序与 C5 一致：先停止领取，再中止本地 I/O，最后等在飞任务结束。
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const aborter of runAborters.values()) aborter.abort();
      await this.drain();
    },
  };
}
