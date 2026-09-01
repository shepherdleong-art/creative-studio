import { getDb } from '../db.ts';
import { executeScriptStudioTask } from './runner.ts';
import { createRuntimeDeps } from './runtime.ts';
import { getScriptStudioReadiness, scriptStudioReadinessUnavailable } from './runtime-readiness.ts';
import {
  getScriptStudioSchedulerController,
  recoverScriptStudioTasks,
  SCRIPT_STUDIO_SCHEDULER_KEY,
  startScriptStudioScheduler,
  type ScriptStudioSchedulerController,
} from './scheduler.ts';

// Next dev 热更新会保留 globalThis，但旧调度器的 executor 闭包不会自动换成新代码。
// 任何改变任务实际供应商/执行语义的修改都必须递增此版本，使旧闭包先停再换。
const SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION = 5;
const SCRIPT_STUDIO_SCHEDULER_VERSION_KEY = Symbol.for('creative-studio.script-studio-scheduler-version');
const SCRIPT_STUDIO_SCHEDULER_START_KEY = Symbol.for('creative-studio.script-studio-scheduler-start');

async function startCurrentScriptStudioScheduler(): Promise<ScriptStudioSchedulerController> {
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const existing = globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] as ScriptStudioSchedulerController | undefined;
  const existingVersion = globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY];
  if (existing && existingVersion === SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION) {
    return existing;
  }
  if (existing) {
    await existing.stop();
    if (globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] === existing) {
      delete globalScope[SCRIPT_STUDIO_SCHEDULER_KEY];
      delete globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY];
    }
  }
  const db = getDb();
  recoverScriptStudioTasks(db);
  const scheduler = startScriptStudioScheduler({
    db,
    workerId: 'script-studio-scheduler',
    executor: {
      async execute(task, signal) {
        const { runDeps } = createRuntimeDeps(getDb(), task, { signal, fallbackOnInvalid: false });
        await executeScriptStudioTask(runDeps);
      },
    },
    intervalMs: 2_000,
    concurrency: 1,
  });
  globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] = scheduler;
  globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY] = SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION;
  return scheduler;
}

export async function ensureScriptStudioSchedulerStarted(): Promise<ScriptStudioSchedulerController> {
  // 安全闸门：在没有明确真机授权前，生产调度器不得自动调用真实供应商。
  // 阶段 0-5 的验收通过直接注入假供应商的 runner 测试完成；部署到真机时
  // 由运行者显式设置 CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1。
  if (process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER !== '1') {
    throw new Error('script-studio scheduler disabled: real provider calls require explicit authorization');
  }
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const existing = globalScope[SCRIPT_STUDIO_SCHEDULER_KEY] as ScriptStudioSchedulerController | undefined;
  if (
    existing
    && globalScope[SCRIPT_STUDIO_SCHEDULER_VERSION_KEY] === SCRIPT_STUDIO_SCHEDULER_EXECUTOR_VERSION
  ) {
    return existing;
  }
  const pending = globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY] as Promise<ScriptStudioSchedulerController> | undefined;
  if (pending) return pending;
  const startPromise = startCurrentScriptStudioScheduler();
  globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY] = startPromise;
  try {
    return await startPromise;
  } finally {
    if (globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY] === startPromise) {
      delete globalScope[SCRIPT_STUDIO_SCHEDULER_START_KEY];
    }
  }
}

export async function startScriptStudioSchedulerAfterReadiness(): Promise<ScriptStudioSchedulerController | null> {
  try {
    const readiness = await getScriptStudioReadiness();
    if (scriptStudioReadinessUnavailable(readiness)) return null;
    recoverScriptStudioTasks(getDb());
    if (process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER !== '1') return null;
    return await ensureScriptStudioSchedulerStarted();
  } catch {
    return null;
  }
}

export { getScriptStudioSchedulerController };
