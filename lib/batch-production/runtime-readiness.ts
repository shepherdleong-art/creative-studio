import { dataRoot } from '../data-root';
import { getDb } from '../db';
import {
  cacheSuccessfulReadiness,
  schemaUpgradeRuntimePaths,
} from '../schema-upgrade/runtime';
import {
  batchReadinessUnavailable,
  checkBatchProductionReadiness,
  type BatchProductionReadiness,
} from './readiness';

const checkRuntimeReadiness = cacheSuccessfulReadiness<BatchProductionReadiness>(() => (
  checkBatchProductionReadiness({
    db: getDb(),
    ...schemaUpgradeRuntimePaths(dataRoot()),
  })
));

export function getBatchProductionReadiness(): Promise<BatchProductionReadiness> {
  return checkRuntimeReadiness();
}

export { batchReadinessUnavailable };

export class BatchApiUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchApiUnavailableError';
    this.code = code;
  }
}

/**
 * 每个批量 API 在读取或写入任何 batch_* 数据前都必须先通过这道门禁:
 * 旧库、升级锁失败或兼容模式下统一返回 503,不得绕过备份、锁、审计与迁移。
 */
export async function assertBatchApiReady(): Promise<void> {
  const readiness = await getBatchProductionReadiness();
  const unavailable = batchReadinessUnavailable(readiness);
  if (unavailable) {
    throw new BatchApiUnavailableError(unavailable.code, unavailable.message);
  }
}
