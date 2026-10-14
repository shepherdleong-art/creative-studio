/**
 * 画布启动接入（技术约定 C5）。
 *
 * 开关关闭时这里立刻返回，既不创建画布表也不启动任何 worker。
 * HMR 复用 globalThis 单例；执行器语义变化时必须递增版本号，先停旧实例再换新实例。
 * API readiness 恢复后也会补启动；恢复与实例创建共用进程内单例。
 */

import { dataRoot } from '../data-root.ts';
import { getDb } from '../db.ts';
import { canvasStorageRoot } from './assets.ts';
import { createCanvasAdapterForMode } from './adapters/index.ts';
import { ensureCanvasCapabilitiesRegistered } from './capabilities-bootstrap.ts';
import { canvasFeatureEnabled, readCanvasRuntimeConfig } from './config.ts';
import { recoverCanvasTasks } from './recovery.ts';
import { getCanvasReadiness, canvasReadinessUnavailable } from './runtime-readiness.ts';
import type { CanvasReadiness } from './readiness.ts';
import { createCanvasScheduler, type CanvasSchedulerController } from './scheduler.ts';

// 任何改变任务实际执行语义的修改都必须递增此版本，使 HMR 下的旧闭包先停再换。
const CANVAS_SCHEDULER_EXECUTOR_VERSION = 4;
const CANVAS_BOOTSTRAP_KEY = Symbol.for('creative-studio.creative-canvas-bootstrap');
const CANVAS_SCHEDULER_KEY = Symbol.for('creative-studio.creative-canvas-scheduler');
const CANVAS_SCHEDULER_VERSION_KEY = Symbol.for('creative-studio.creative-canvas-scheduler-version');
const CANVAS_SCHEDULER_START_KEY = Symbol.for('creative-studio.creative-canvas-scheduler-start');

export interface CanvasBootstrapState {
  readiness: CanvasReadiness;
  executor: ReturnType<typeof readCanvasRuntimeConfig>['executor'];
  schedulerStarted: boolean;
  startedAt: string;
}

function globalScope(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

export function getCanvasBootstrapState(): CanvasBootstrapState | null {
  return (globalScope()[CANVAS_BOOTSTRAP_KEY] as CanvasBootstrapState | undefined) ?? null;
}

export function getCanvasSchedulerController(): CanvasSchedulerController | null {
  return (globalScope()[CANVAS_SCHEDULER_KEY] as CanvasSchedulerController | undefined) ?? null;
}

async function stopExistingScheduler(): Promise<void> {
  const scope = globalScope();
  const existing = scope[CANVAS_SCHEDULER_KEY] as CanvasSchedulerController | undefined;
  if (!existing) return;
  await existing.stop();
  if (scope[CANVAS_SCHEDULER_KEY] === existing) {
    delete scope[CANVAS_SCHEDULER_KEY];
    delete scope[CANVAS_SCHEDULER_VERSION_KEY];
  }
}

/**
 * 启动调度器单例。executor=disabled 时返回 null：编辑可用，但不启动生成。
 * 公司执行器在 P4 注册工厂前不启动，也不假装可用。
 */
async function startCurrentCanvasScheduler(): Promise<CanvasSchedulerController | null> {
  const scope = globalScope();
  await stopExistingScheduler();

  const config = readCanvasRuntimeConfig();
  if (config.executor === 'disabled') return null;

  const db = getDb();
  ensureCanvasCapabilitiesRegistered(db);
  const storageRoot = canvasStorageRoot(dataRoot());
  const adapter = createCanvasAdapterForMode(config.executor, { db, storageRoot });
  if (!adapter) {
    console.error(`[creative-canvas] 执行器 ${config.executor} 尚未注册可用适配器，生成保持停用`);
    return null;
  }
  // 启动失败后的 API 补启动也要恢复；仅在新建实例时运行，不能清空活跃任务的租约。
  recoverCanvasTasks(db);
  const scheduler = createCanvasScheduler({
    db,
    workerId: 'creative-canvas-scheduler',
    adapter,
    storageRoot,
    intervalMs: 2_000,
  });
  scheduler.start();
  scope[CANVAS_SCHEDULER_KEY] = scheduler;
  scope[CANVAS_SCHEDULER_VERSION_KEY] = CANVAS_SCHEDULER_EXECUTOR_VERSION;
  return scheduler;
}

/** readiness 通过后的幂等入口；启动钩子与并发 API 请求共享同一个启动过程。 */
export async function ensureCanvasSchedulerStarted(): Promise<CanvasSchedulerController | null> {
  if (!canvasFeatureEnabled() || readCanvasRuntimeConfig().executor === 'disabled') return null;
  const scope = globalScope();
  const existing = scope[CANVAS_SCHEDULER_KEY] as CanvasSchedulerController | undefined;
  if (existing && scope[CANVAS_SCHEDULER_VERSION_KEY] === CANVAS_SCHEDULER_EXECUTOR_VERSION) {
    return existing;
  }
  const pending = scope[CANVAS_SCHEDULER_START_KEY] as Promise<CanvasSchedulerController | null> | undefined;
  if (pending) return pending;
  const starting = startCurrentCanvasScheduler();
  scope[CANVAS_SCHEDULER_START_KEY] = starting;
  try {
    return await starting;
  } finally {
    if (scope[CANVAS_SCHEDULER_START_KEY] === starting) delete scope[CANVAS_SCHEDULER_START_KEY];
  }
}

/** 停止领取并等在飞任务结束；同时覆盖尚未完成的实例启动。 */
export async function stopCanvasScheduler(): Promise<void> {
  const pending = globalScope()[CANVAS_SCHEDULER_START_KEY] as Promise<CanvasSchedulerController | null> | undefined;
  if (pending) await pending.catch(() => undefined);
  await stopExistingScheduler();
}

/**
 * 应用启动入口：只有显式开启画布功能才执行 readiness（含迁移）。
 * 不可用时返回 null 并保持旧功能可用。
 */
export async function startCanvasAfterReadiness(): Promise<CanvasBootstrapState | null> {
  if (!canvasFeatureEnabled()) return null;
  try {
    const readiness = await getCanvasReadiness();
    if (canvasReadinessUnavailable(readiness)) {
      console.error('[creative-canvas] readiness 不可用，画布功能保持禁用');
      return null;
    }
    const config = readCanvasRuntimeConfig();
    const scheduler = config.executor === 'disabled' ? null : await ensureCanvasSchedulerStarted();
    const state: CanvasBootstrapState = {
      readiness,
      executor: config.executor,
      schedulerStarted: scheduler !== null,
      startedAt: new Date().toISOString(),
    };
    globalScope()[CANVAS_BOOTSTRAP_KEY] = state;
    return state;
  } catch {
    console.error('[creative-canvas] 启动接入失败，画布功能保持禁用');
    return null;
  }
}
