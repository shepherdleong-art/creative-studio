import type Database from 'better-sqlite3';
import type { SchemaUpgradeDiskSpaceProbe } from './schema-upgrade/backup.ts';
import {
  runSchemaUpgradeGate,
  type SchemaUpgradeGateReadiness,
} from './schema-upgrade/gate.ts';
import { ensureVideoProviderGatewaySchemaReady } from './video-provider-schema.ts';

export type VideoProviderGatewayReadiness = SchemaUpgradeGateReadiness;

export function checkVideoProviderGatewayReadiness(options: {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<VideoProviderGatewayReadiness> {
  return runSchemaUpgradeGate({
    scope: 'video-provider-gateway',
    backupRoot: options.backupRoot,
    lockDatabasePath: options.lockDatabasePath,
    auditFilePath: options.auditFilePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    now: options.now,
    messages: {
      current: '视频网关供应商数据结构已就绪。',
      ready: '视频网关供应商数据结构已完成安全升级。',
      lockUnavailable: '无法取得数据库升级锁。',
      auditUnavailable: '无法写入数据库升级记录。',
      auditFinishUnavailable: '数据库升级已结束，但无法保存审计结果。',
    },
    execute: async (now) => {
      const schema = await ensureVideoProviderGatewaySchemaReady({
        db: options.db,
        backupRoot: options.backupRoot,
        now,
        diskSpaceProbe: options.diskSpaceProbe,
      });
      return {
        ...schema,
        appliedVersions: schema.state === 'ready' ? [schema.targetVersion] : [],
        code: schema.state === 'compatibility_only' ? schema.code : undefined,
        message: schema.state === 'compatibility_only' ? schema.message : undefined,
      };
    },
  });
}
