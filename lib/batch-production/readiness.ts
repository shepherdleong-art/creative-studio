import type Database from 'better-sqlite3';
import {
  runSchemaUpgradeGate,
  type SchemaUpgradeGateReadiness,
} from '../schema-upgrade/gate.ts';
import {
  ensureBatchSchemaReady,
  type BatchSchemaFailureCode,
} from './schema.ts';
import type { BatchSchemaDiskSpaceProbe } from './backup.ts';

export type BatchProductionReadinessFailureCode =
  | BatchSchemaFailureCode
  | 'upgrade_in_progress'
  | 'lock_unavailable'
  | 'audit_unavailable';

export type BatchProductionReadiness = SchemaUpgradeGateReadiness;

export interface CheckBatchProductionReadinessOptions {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: BatchSchemaDiskSpaceProbe;
}

export function checkBatchProductionReadiness(
  options: CheckBatchProductionReadinessOptions,
): Promise<BatchProductionReadiness> {
  return runSchemaUpgradeGate({
    scope: 'batch-production',
    backupRoot: options.backupRoot,
    lockDatabasePath: options.lockDatabasePath,
    auditFilePath: options.auditFilePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    now: options.now,
    messages: {
      current: '批量功能已就绪。',
      ready: '批量功能已完成安全升级。',
      lockUnavailable: '无法取得数据库升级锁，批量功能暂不可用。',
      auditUnavailable: '无法写入数据库升级记录，批量功能暂不可用。',
      auditFinishUnavailable: '数据库升级已结束，但无法保存审计结果，批量功能暂不可用。',
    },
    execute: async (now) => {
      const schema = await ensureBatchSchemaReady({
        db: options.db,
        backupRoot: options.backupRoot,
        now,
        diskSpaceProbe: options.diskSpaceProbe,
      });
      return {
        ...schema,
        code: schema.state === 'compatibility_only' ? schema.code : undefined,
        message: schema.state === 'compatibility_only' ? schema.message : undefined,
      };
    },
  });
}

/**
 * 批量 API 在兼容模式(备份/锁/迁移门禁未通过)下必须整体不可用。
 * 纯函数,便于在 Node 测试中直接验证门禁判定。
 */
export function batchReadinessUnavailable(
  readiness: BatchProductionReadiness,
): { code: string; message: string } | null {
  if (readiness.available === false) {
    return {
      code: readiness.code,
      message: readiness.message,
    };
  }
  return null;
}
