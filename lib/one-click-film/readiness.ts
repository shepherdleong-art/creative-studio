import type Database from 'better-sqlite3';
import {
  runSchemaUpgradeGate,
  type SchemaUpgradeGateReadiness,
} from '../schema-upgrade/gate.ts';
import { ensureOneClickFilmSchemaReady, type OneClickFilmSchemaFailureCode } from './schema.ts';
import type { SchemaUpgradeDiskSpaceProbe } from '../schema-upgrade/backup.ts';

export type OneClickFilmReadinessFailureCode =
  | OneClickFilmSchemaFailureCode
  | 'upgrade_in_progress'
  | 'lock_unavailable'
  | 'audit_unavailable';

export type OneClickFilmReadiness = SchemaUpgradeGateReadiness;

export interface CheckOneClickFilmReadinessOptions {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}

export function checkOneClickFilmReadiness(
  options: CheckOneClickFilmReadinessOptions,
): Promise<OneClickFilmReadiness> {
  return runSchemaUpgradeGate({
    scope: 'one-click-film',
    backupRoot: options.backupRoot,
    lockDatabasePath: options.lockDatabasePath,
    auditFilePath: options.auditFilePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    now: options.now,
    messages: {
      current: '一键成片已就绪。',
      ready: '一键成片已完成安全升级。',
      lockUnavailable: '无法取得数据库升级锁，一键成片暂不可用。',
      auditUnavailable: '无法写入数据库升级记录，一键成片暂不可用。',
      auditFinishUnavailable: '数据库升级已结束，但无法保存审计结果，一键成片暂不可用。',
    },
    execute: async (now) => {
      const schema = await ensureOneClickFilmSchemaReady({
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

export function oneClickFilmReadinessUnavailable(
  readiness: OneClickFilmReadiness,
): { code: string; message: string } | null {
  if (readiness.available === false) return { code: readiness.code, message: readiness.message };
  return null;
}
