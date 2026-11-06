import type Database from 'better-sqlite3';
import {
  runSchemaUpgradeGate,
  type SchemaUpgradeGateReadiness,
} from '../../schema-upgrade/gate.ts';
import type { SchemaUpgradeDiskSpaceProbe } from '../../schema-upgrade/backup.ts';
import { ensureExecutionSchemaReady } from './schema.ts';

export type ExecutionReadiness = SchemaUpgradeGateReadiness;

export function checkExecutionReadiness(options: {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<ExecutionReadiness> {
  return runSchemaUpgradeGate({
    scope: 'execution',
    backupRoot: options.backupRoot,
    lockDatabasePath: options.lockDatabasePath,
    auditFilePath: options.auditFilePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    now: options.now,
    messages: {
      current: '共享执行设施已就绪。',
      ready: '共享执行设施已完成安全升级。',
      lockUnavailable: '无法取得数据库升级锁，共享执行设施暂不可用。',
      auditUnavailable: '无法写入数据库升级记录，共享执行设施暂不可用。',
      auditFinishUnavailable: '共享执行设施升级已结束，但无法保存审计结果。',
    },
    execute: async (now) => {
      const result = await ensureExecutionSchemaReady({
        db: options.db,
        backupRoot: options.backupRoot,
        now,
        diskSpaceProbe: options.diskSpaceProbe,
      });
      return {
        ...result,
        code: result.state === 'compatibility_only' ? result.code : undefined,
        message: result.state === 'compatibility_only' ? result.message : undefined,
      };
    },
  });
}
