import type Database from 'better-sqlite3';
import {
  runSchemaUpgradeGate,
  type SchemaUpgradeGateReadiness,
} from '../schema-upgrade/gate.ts';
import {
  ensureCreativeCanvasSchemaReady,
  type CanvasSchemaFailureCode,
} from './schema.ts';

export type CanvasReadinessFailureCode =
  | CanvasSchemaFailureCode
  | 'upgrade_in_progress'
  | 'lock_unavailable'
  | 'audit_unavailable';

export type CanvasReadiness = SchemaUpgradeGateReadiness;

export interface CheckCanvasReadinessOptions {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: (directory: string) => Promise<number>;
}

/**
 * 画布 readiness 走共享升级 gate：已验证备份 → 跨进程锁 → 审计 → 迁移。
 * 失败只禁用画布，不影响旧功能（旧功能不读画布表）。
 */
export function checkCanvasReadiness(options: CheckCanvasReadinessOptions): Promise<CanvasReadiness> {
  return runSchemaUpgradeGate({
    scope: 'creative-canvas',
    backupRoot: options.backupRoot,
    lockDatabasePath: options.lockDatabasePath,
    auditFilePath: options.auditFilePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    now: options.now,
    messages: {
      current: '创作画布已就绪。',
      ready: '创作画布已完成安全升级。',
      lockUnavailable: '无法取得数据库升级锁，创作画布暂不可用。',
      auditUnavailable: '无法写入数据库升级记录，创作画布暂不可用。',
      auditFinishUnavailable: '数据库升级已结束，但无法保存审计结果，创作画布暂不可用。',
    },
    execute: async (now) => {
      const schema = await ensureCreativeCanvasSchemaReady({
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

export function canvasReadinessUnavailable(
  readiness: CanvasReadiness,
): { code: string; message: string } | null {
  if (readiness.available === false) {
    return { code: readiness.code, message: readiness.message };
  }
  return null;
}
