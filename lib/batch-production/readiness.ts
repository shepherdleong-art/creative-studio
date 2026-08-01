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
