import type Database from 'better-sqlite3';
import { getDb } from '../db.ts';
import { analyzeAssetExecutor, semanticScoreExecutor } from './executors.ts';
import { proxyGenerateExecutor } from './proxy-executor.ts';
import { batchRenderExecutor } from './batch-render-executor.ts';
import { batchNarrationExecutor } from './narration-executor.ts';
import { completePendingProxyDeletions } from './proxy-cache.ts';
import { assertBatchApiReady } from './runtime-readiness.ts';
import {
  getBatchSchedulerController,
  startBatchScheduler,
  wakeBatchScheduler,
  type SchedulerController,
} from './runner.ts';
import { readTeamModuleSwitches } from '../team-service/module-switches.ts';
import type { ExecutionModuleLifecycle } from '../media-core/execution/contracts.ts';
import { MATERIAL_ANALYSIS_CONCURRENCY } from '../media-core/analysis-concurrency.ts';

/**
 * 进程内单例调度 bootstrap。
 * 首次在批量写 API(readiness 门禁通过后)调用时启动调度循环,
 * 启动即执行恢复(旧实例 running 尝试失效);重复调用幂等返回同一实例。
 * 默认会唤醒已有调度的空闲执行位——新入队任务不必等下一次空闲轮询;
 * 只读 GET 可传 `{ wake: false }`,只保证调度器已启动而不打断执行位等待。
 * 不会为每个 API 请求启动新的调度器。
 */
export function ensureBatchSchedulerStarted(
  db: Database.Database = getDb(),
  options: { wake?: boolean } = {},
): SchedulerController | null {
  // 模块开关关闭时不创建任何 worker；API 仍可读写历史数据，但不会执行新任务。
  if (!readTeamModuleSwitches().batch) return null;
  // pending-delete 是持久状态，而进程内读写租约不会跨重启存活；启动调度器前
  // 先安全重试上次因占用而延后的文件删除，失败记录继续保留供后续重试。
  completePendingProxyDeletions(db);
  const existing = getBatchSchedulerController();
  if (existing) {
    if (existing.running && options.wake !== false) wakeBatchScheduler();
    return existing;
  }
  return startBatchScheduler({
    db,
    workerId: 'batch-scheduler',
    executors: [analyzeAssetExecutor, proxyGenerateExecutor, batchNarrationExecutor, semanticScoreExecutor, batchRenderExecutor],
    intervalMs: 2_000,
    analysisConcurrency: MATERIAL_ANALYSIS_CONCURRENCY,
  });
}

/**
 * 应用启动恢复入口。批量门禁未就绪时静默保持旧功能可用;
 * 后续批量 API 门禁通过后仍会再次调用 ensureBatchSchedulerStarted。
 */
export async function startBatchSchedulerAfterReadiness(): Promise<SchedulerController | null> {
  try {
    if (!readTeamModuleSwitches().batch) return null;
    await assertBatchApiReady();
    return ensureBatchSchedulerStarted();
  } catch {
    return null;
  }
}

/**
 * server 组合根使用：无人访问页面/API 也能恢复排队与运行中的批量任务。
 * 调度器单例与 API 懒启动共享，重复调用不会创建第二个 worker。
 */
export function createBatchProductionLifecycle(options: {
  db: Database.Database;
}): ExecutionModuleLifecycle {
  let controller: SchedulerController | null = null;
  return {
    name: 'batch-production',
    async ensureSchemaReady() {
      if (!readTeamModuleSwitches().batch) return;
      await assertBatchApiReady();
    },
    registerRecovery() {},
    recover() {
      // startBatchScheduler 内部先执行 recoverInterruptedWork，恢复语义归调度器单例。
    },
    start(context) {
      if (!readTeamModuleSwitches().batch || context.signal.aborted) return;
      controller = ensureBatchSchedulerStarted(options.db);
      context.signal.addEventListener('abort', () => { void controller?.stop(); }, { once: true });
    },
    async drain() {
      await controller?.stop();
      controller = null;
      return 0;
    },
  };
}
