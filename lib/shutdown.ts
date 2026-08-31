import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataRoot } from './data-root.ts';
import { closeDb } from './db.ts';
import {
  abortRunningFfmpegProcesses,
  waitForFfmpegIdle,
} from './ffmpeg.ts';
import {
  abortRunningBatchTasks,
  getBatchSchedulerController,
  waitForBatchTasksIdle,
  type SchedulerController,
} from './batch-production/runner.ts';
import {
  abortRunningFinalEditJobs,
  waitForFinalEditJobsIdle,
} from './final-edit/worker.ts';
import {
  beginScriptGenerationShutdown,
  waitForScriptGenerationsIdle,
} from './script-generation-manager.ts';
import {
  abortRunningScriptStudioTasks,
  getScriptStudioSchedulerController,
  waitForScriptStudioTasksIdle,
  type ScriptStudioSchedulerController,
} from './script-studio/scheduler.ts';

export interface GracefulShutdownResult {
  stopped: boolean;
  pendingTasks: number;
}

export interface GracefulShutdownDependencies {
  /** 显式传 null 可在测试或无调度器进程中跳过批量调度器。 */
  scheduler?: SchedulerController | null;
  abortBatchTasks?: () => number;
  waitForBatchTasks?: (timeoutMs: number) => Promise<number>;
  abortFinalEdit?: () => number;
  waitForFinalEdit?: (timeoutMs: number) => Promise<number>;
  abortScriptGenerations?: () => number;
  waitForScriptGenerations?: (timeoutMs: number) => Promise<number>;
  scriptStudioScheduler?: ScriptStudioSchedulerController | null;
  abortScriptStudioTasks?: () => number;
  waitForScriptStudioTasks?: (timeoutMs: number) => Promise<number>;
  abortFfmpeg?: () => number;
  waitForFfmpeg?: (timeoutMs: number) => Promise<number>;
  closeDatabase?: () => void;
  stopSidecar?: () => void | Promise<void>;
}

let shutdownPromise: Promise<GracefulShutdownResult> | null = null;

function waitForStep(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(
      () => finish(true),
      () => finish(false),
    );
  });
}

async function waitForCountStep(
  operation: (timeoutMs: number) => Promise<number>,
  timeoutMs: number,
  fallbackCount: number,
): Promise<number> {
  let value = 0;
  const completed = await waitForStep(
    Promise.resolve().then(() => operation(timeoutMs)).then((result) => {
      value = result;
    }),
    timeoutMs,
  );
  return completed ? Math.max(0, value) : Math.max(1, fallbackCount);
}

/**
 * 停止源码启动时受控的 LiteLLM sidecar。
 *
 * stack.json 只提供状态，不应成为任意命令执行入口；因此这里只允许
 * dataRoot 或项目 scripts 目录中的已知停止脚本。
 */
export function stopControlledSidecar(): void {
  const stackFile = path.join(dataRoot(), 'storage', 'run', 'stack.json');
  if (!fs.existsSync(stackFile)) return;

  const stack = JSON.parse(
    fs.readFileSync(stackFile, 'utf-8').replace(/^\uFEFF/, ''),
  ) as { stopScript?: string };
  const controlledScriptsDirs = new Set([
    path.resolve(process.cwd(), 'scripts'),
    path.resolve(dataRoot(), 'scripts'),
  ]);
  const stopScript = typeof stack.stopScript === 'string' ? path.resolve(stack.stopScript) : '';
  const stopScriptName = path.basename(stopScript);
  const isControlledStopScript = controlledScriptsDirs.has(path.dirname(stopScript))
    && (stopScriptName === 'stop-stack.ps1' || stopScriptName === 'stop-litellm.sh');
  if (!isControlledStopScript || !fs.existsSync(stopScript)) return;

  if (process.platform === 'win32' && stopScriptName === 'stop-stack.ps1') {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScript],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', () => undefined);
    child.unref();
  } else if (process.platform !== 'win32' && stopScriptName === 'stop-litellm.sh') {
    const child = spawn('/bin/bash', [stopScript], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  }
}

async function performGracefulShutdown(
  timeoutMs: number,
  dependencies: GracefulShutdownDependencies,
): Promise<GracefulShutdownResult> {
  const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs));
  const remainingBudget = (): number => Math.max(0, deadline - Date.now());
  let pendingTasks = 0;

  const scheduler = 'scheduler' in dependencies
    ? dependencies.scheduler
    : getBatchSchedulerController();
  let schedulerStop: Promise<void> | null = null;
  if (scheduler) {
    try {
      schedulerStop = Promise.resolve(scheduler.stop());
    } catch {
      pendingTasks += 1;
    }
  }

  const scriptStudioScheduler = 'scriptStudioScheduler' in dependencies
    ? dependencies.scriptStudioScheduler
    : getScriptStudioSchedulerController();
  let scriptStudioSchedulerStop: Promise<void> | null = null;
  if (scriptStudioScheduler) {
    try {
      scriptStudioSchedulerStop = Promise.resolve(scriptStudioScheduler.stop());
    } catch {
      pendingTasks += 1;
    }
  }

  // 先让调度器停止领取，再广播到各执行层及其直接 FFmpeg 子进程。
  // 脚本生成管理器紧随停止领取：拒绝新任务并以 shutdown 原因取消运行中任务。
  let abortedScriptGenerationCount = 0;
  try {
    abortedScriptGenerationCount = dependencies.abortScriptGenerations?.() ?? beginScriptGenerationShutdown();
  } catch {
    pendingTasks += 1;
  }

  let abortedBatchTaskCount = 0;
  try {
    abortedBatchTaskCount = dependencies.abortBatchTasks?.() ?? abortRunningBatchTasks();
  } catch {
    pendingTasks += 1;
  }

  let abortedFinalEditCount = 0;
  try {
    abortedFinalEditCount = dependencies.abortFinalEdit?.() ?? abortRunningFinalEditJobs();
  } catch {
    pendingTasks += 1;
  }
  let abortedScriptStudioCount = 0;
  try {
    abortedScriptStudioCount = dependencies.abortScriptStudioTasks?.() ?? abortRunningScriptStudioTasks();
  } catch {
    pendingTasks += 1;
  }

  let abortedFfmpegCount = 0;
  try {
    abortedFfmpegCount = dependencies.abortFfmpeg?.() ?? abortRunningFfmpegProcesses();
  } catch {
    pendingTasks += 1;
  }

  if (schedulerStop && !(await waitForStep(schedulerStop, remainingBudget()))) {
    pendingTasks += 1;
  }
  if (scriptStudioSchedulerStop && !(await waitForStep(scriptStudioSchedulerStop, remainingBudget()))) {
    pendingTasks += 1;
  }

  try {
    pendingTasks += await waitForCountStep(
      dependencies.waitForBatchTasks ?? waitForBatchTasksIdle,
      remainingBudget(),
      abortedBatchTaskCount,
    );
  } catch {
    pendingTasks += Math.max(1, abortedBatchTaskCount);
  }

  try {
    pendingTasks += await waitForCountStep(
      dependencies.waitForScriptStudioTasks ?? waitForScriptStudioTasksIdle,
      remainingBudget(),
      abortedScriptStudioCount,
    );
  } catch {
    pendingTasks += Math.max(1, abortedScriptStudioCount);
  }

  try {
    pendingTasks += await waitForCountStep(
      dependencies.waitForFinalEdit ?? waitForFinalEditJobsIdle,
      remainingBudget(),
      abortedFinalEditCount,
    );
  } catch {
    pendingTasks += Math.max(1, abortedFinalEditCount);
  }

  try {
    pendingTasks += await waitForCountStep(
      dependencies.waitForFfmpeg ?? waitForFfmpegIdle,
      remainingBudget(),
      abortedFfmpegCount,
    );
  } catch {
    pendingTasks += Math.max(1, abortedFfmpegCount);
  }

  // 等待脚本生成任务收尾后再关闭数据库（任务终态只写内存，但执行器落草稿要用 DB）。
  try {
    pendingTasks += await waitForCountStep(
      dependencies.waitForScriptGenerations ?? waitForScriptGenerationsIdle,
      remainingBudget(),
      abortedScriptGenerationCount,
    );
  } catch {
    pendingTasks += Math.max(1, abortedScriptGenerationCount);
  }

  try {
    if (dependencies.closeDatabase) dependencies.closeDatabase();
    else closeDb();
  } catch {
    pendingTasks += 1;
  }

  try {
    const stopSidecar = dependencies.stopSidecar ?? stopControlledSidecar;
    if (!(await waitForStep(Promise.resolve().then(stopSidecar), remainingBudget()))) {
      pendingTasks += 1;
    }
  } catch {
    pendingTasks += 1;
  }

  return {
    stopped: pendingTasks === 0,
    pendingTasks,
  };
}

/**
 * 进程级优雅退出入口。重复调用共享同一个 promise，避免重复关闭数据库
 * 或重复启动 sidecar 停止脚本。
 */
export function gracefulShutdown(
  opts: { timeoutMs: number },
  dependencies: GracefulShutdownDependencies = {},
): Promise<GracefulShutdownResult> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = performGracefulShutdown(opts.timeoutMs, dependencies).catch(() => ({
    stopped: false,
    pendingTasks: 1,
  }));
  return shutdownPromise;
}

/** 测试用：清除本进程停机单例。生产代码不应调用。 */
export async function resetGracefulShutdownForTests(): Promise<void> {
  try {
    await shutdownPromise;
  } catch {
    // gracefulShutdown 已尽量把错误转换为结果；测试清理仍需保持幂等。
  }
  shutdownPromise = null;
}
