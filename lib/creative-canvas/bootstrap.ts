/**
 * 画布启动接入（技术约定 C5）。
 *
 * 开关关闭时这里立刻返回，既不创建画布表也不启动任何 worker。
 * HMR 复用 globalThis 单例；执行器语义变化时必须递增版本号，先停旧实例再换新实例。
 * P5 会把 stopCanvasScheduler 接入唯一的 gracefulShutdown。
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
const CANVAS_SCHEDULER_EXECUTOR_VERSION = 2;
const CANVAS_BOOTSTRAP_KEY = Symbol.for('creative-studio.creative-canvas-bootstrap');
const CANVAS_SCHEDULER_KEY = Symbol.for('creative-studio.creative-canvas-scheduler');
const CANVAS_SCHEDULER_VERSION_KEY = Symbol.for('creative-studio.creative-canvas-scheduler-version');

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
export async function ensureCanvasSchedulerStarted(): Promise<CanvasSchedulerController | null> {
  const scope = globalScope();
  const existing = scope[CANVAS_SCHEDULER_KEY] as CanvasSchedulerController | undefined;
  if (existing && scope[CANVAS_SCHEDULER_VERSION_KEY] === CANVAS_SCHEDULER_EXECUTOR_VERSION) {
    return existing;
  }
  await stopExistingScheduler();

  const config = readCanvasRuntimeConfig();
  if (config.executor === 'disabled') return null;

  const db = getDb();
  const storageRoot = canvasStorageRoot(dataRoot());
  const adapter = createCanvasAdapterForMode(config.executor, { db, storageRoot });
  if (!adapter) {
    console.error(`[creative-canvas] 执行器 ${config.executor} 尚未注册可用适配器，生成保持停用`);
    return null;
  }
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

/** 停止领取并等在飞任务结束；由 gracefulShutdown（P5）调用。 */
export async function stopCanvasScheduler(): Promise<void> {
  await stopExistingScheduler();
}

/**
 * 唯一入口：只有显式开启画布功能才执行 readiness（含迁移）。
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
    ensureCanvasCapabilitiesRegistered();
    // 进程重启后的恢复：调整本地可安全推进的状态（不重新生成、不释放可能占用的名额）
    try {
      recoverCanvasTasks(getDb());
    } catch {
      console.error('[creative-canvas] 恢复扫描失败，任务保持原状态');
    }
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
