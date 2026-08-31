import type Database from 'better-sqlite3';
import {
  runSchemaUpgradeGate,
  type SchemaUpgradeGateReadiness,
} from '../schema-upgrade/gate.ts';
import {
  ensureScriptStudioSchemaReady,
  type ScriptStudioSchemaFailureCode,
} from './schema.ts';

export type ScriptStudioReadinessFailureCode = ScriptStudioSchemaFailureCode | 'upgrade_in_progress' | 'lock_unavailable' | 'audit_unavailable';
export type ScriptStudioReadiness = SchemaUpgradeGateReadiness;

export interface CheckScriptStudioReadinessOptions {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: (directory: string) => Promise<number>;
}

export function checkScriptStudioReadiness(
  options: CheckScriptStudioReadinessOptions,
): Promise<ScriptStudioReadiness> {
  return runSchemaUpgradeGate({
    scope: 'script-studio',
    backupRoot: options.backupRoot,
    lockDatabasePath: options.lockDatabasePath,
    auditFilePath: options.auditFilePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    now: options.now,
    messages: {
      current: '详情页智能脚本功能已就绪。',
      ready: '详情页智能脚本功能已完成安全升级。',
      lockUnavailable: '无法取得数据库升级锁，详情页智能脚本功能暂不可用。',
      auditUnavailable: '无法写入数据库升级记录，详情页智能脚本功能暂不可用。',
      auditFinishUnavailable: '数据库升级已结束，但无法保存审计结果，详情页智能脚本功能暂不可用。',
    },
    execute: async (now) => {
      const schema = await ensureScriptStudioSchemaReady({
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

export function scriptStudioReadinessUnavailable(
  readiness: ScriptStudioReadiness,
): { code: string; message: string } | null {
  if (readiness.available === false) {
    return { code: readiness.code, message: readiness.message };
  }
  return null;
}
