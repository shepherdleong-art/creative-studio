import type Database from 'better-sqlite3';
import { runSchemaUpgradeGate } from '../../schema-upgrade/gate.ts';
import type { SchemaUpgradeDiskSpaceProbe } from '../../schema-upgrade/backup.ts';
import { ensureFormulaSchemaReady } from './schema.ts';

export function checkFormulaReadiness(options: {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}) {
  return runSchemaUpgradeGate({
    ...options,
    scope: 'batch-formula',
    messages: {
      current: '实拍公式混剪数据已就绪。',
      ready: '实拍公式混剪已完成安全升级。',
      lockUnavailable: '暂时无法取得升级锁，请稍后重试。',
      auditUnavailable: '无法记录升级过程，实拍公式混剪暂不可用。',
      auditFinishUnavailable: '无法保存升级结果，实拍公式混剪暂不可用。',
    },
    execute: now => ensureFormulaSchemaReady({ ...options, now }),
  });
}
