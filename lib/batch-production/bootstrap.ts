import { getDb } from '../db.ts';
import { analyzeAssetExecutor } from './executors.ts';
import { assertBatchApiReady } from './runtime-readiness.ts';
import { startBatchScheduler, type SchedulerController } from './runner.ts';

/**
 * 进程内单例调度 bootstrap。
 * 首次在批量写 API(readiness 门禁通过后)调用时启动调度循环,
 * 启动即执行恢复(旧实例 running 尝试失效);重复调用幂等返回同一实例。
 * 不会为每个 API 请求启动新的调度器。
 */
export function ensureBatchSchedulerStarted(): SchedulerController {
  return startBatchScheduler({
    db: getDb(),
    workerId: 'batch-scheduler',
    executors: [analyzeAssetExecutor],
    intervalMs: 2_000,
  });
}

/**
 * 应用启动恢复入口。批量门禁未就绪时静默保持旧功能可用;
 * 后续批量 API 门禁通过后仍会再次调用 ensureBatchSchedulerStarted。
 */
export async function startBatchSchedulerAfterReadiness(): Promise<SchedulerController | null> {
  try {
    await assertBatchApiReady();
    return ensureBatchSchedulerStarted();
  } catch {
    return null;
  }
}
