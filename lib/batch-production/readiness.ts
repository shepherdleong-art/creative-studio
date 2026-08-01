import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  appendSchemaUpgradeAudit,
  recoverInterruptedSchemaUpgradeAudits,
} from '../schema-upgrade/audit.ts';
import {
  acquireSchemaUpgradeLock,
  SchemaUpgradeLockTimeoutError,
} from '../schema-upgrade/lock.ts';
import {
  ensureBatchSchemaReady,
  type BatchSchemaFailureCode,
} from './schema.ts';
import type { BatchSchemaDiskSpaceProbe } from './backup.ts';

export type BatchProductionReadinessFailureCode =
  | BatchSchemaFailureCode
  | 'upgrade_in_progress'
  | 'audit_unavailable';

export type BatchProductionReadiness =
  | {
      available: true;
      mode: 'ready';
      schemaState: 'current' | 'ready';
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      checkedAt: string;
      auditId: string;
    }
  | {
      available: false;
      mode: 'compatibility_only';
      schemaState?: 'compatibility_only';
      code: BatchProductionReadinessFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      checkedAt: string;
      auditId: string;
    };

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

function unavailable(params: {
  code: BatchProductionReadinessFailureCode;
  message: string;
  checkedAt: string;
  auditId: string;
  targetVersion?: number;
  appliedVersions?: number[];
  schemaState?: 'compatibility_only';
}): BatchProductionReadiness {
  return {
    available: false,
    mode: 'compatibility_only',
    code: params.code,
    message: params.message,
    appliedVersions: params.appliedVersions ?? [],
    targetVersion: params.targetVersion ?? 0,
    checkedAt: params.checkedAt,
    auditId: params.auditId,
    ...(params.schemaState ? { schemaState: params.schemaState } : {}),
  };
}

export async function checkBatchProductionReadiness(
  options: CheckBatchProductionReadinessOptions,
): Promise<BatchProductionReadiness> {
  const now = options.now ?? (() => new Date());
  const attemptId = randomUUID();
  const checkedAt = now().toISOString();
  let lock;

  try {
    lock = await acquireSchemaUpgradeLock({
      lockDatabasePath: options.lockDatabasePath,
      timeoutMs: options.lockTimeoutMs,
      pollIntervalMs: options.lockPollIntervalMs,
    });
  } catch (error) {
    const result = unavailable({
      code: error instanceof SchemaUpgradeLockTimeoutError ? 'upgrade_in_progress' : 'audit_unavailable',
      message: error instanceof SchemaUpgradeLockTimeoutError
        ? '另一个程序正在完成数据库升级，请稍后重试。'
        : '无法取得数据库升级锁，批量功能暂不可用。',
      checkedAt,
      auditId: attemptId,
    });
    try {
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'lock_timeout',
        attemptId,
        scope: 'batch-production',
        at: checkedAt,
        result,
      });
    } catch {
      // The result already reports that batch production is unavailable.
    }
    return result;
  }

  try {
    try {
      await recoverInterruptedSchemaUpgradeAudits({
        auditFilePath: options.auditFilePath,
        scope: 'batch-production',
        recoveredByAttemptId: attemptId,
        at: checkedAt,
      });
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'started',
        attemptId,
        scope: 'batch-production',
        at: checkedAt,
      });
    } catch {
      return unavailable({
        code: 'audit_unavailable',
        message: '无法写入数据库升级记录，批量功能暂不可用。',
        checkedAt,
        auditId: attemptId,
      });
    }

    const schema = await ensureBatchSchemaReady({
      db: options.db,
      backupRoot: options.backupRoot,
      now,
      diskSpaceProbe: options.diskSpaceProbe,
    });
    const result: BatchProductionReadiness = schema.state === 'compatibility_only'
      ? unavailable({
          code: schema.code,
          message: schema.message,
          checkedAt,
          auditId: attemptId,
          targetVersion: schema.targetVersion,
          appliedVersions: schema.appliedVersions,
          schemaState: 'compatibility_only',
        })
      : {
          available: true,
          mode: 'ready',
          schemaState: schema.state,
          message: schema.state === 'ready' ? '批量功能已完成安全升级。' : '批量功能已就绪。',
          appliedVersions: schema.appliedVersions,
          targetVersion: schema.targetVersion,
          checkedAt,
          auditId: attemptId,
        };

    try {
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'finished',
        attemptId,
        scope: 'batch-production',
        at: now().toISOString(),
        result: {
          available: result.available,
          mode: result.mode,
          schemaState: result.schemaState,
          ...(!result.available ? { code: result.code } : {}),
          appliedVersions: result.appliedVersions,
          targetVersion: result.targetVersion,
          backupCreated: schema.backupDirectory !== undefined,
        },
      });
    } catch {
      return unavailable({
        code: 'audit_unavailable',
        message: '数据库升级已结束，但无法保存审计结果，批量功能暂不可用。',
        checkedAt,
        auditId: attemptId,
        targetVersion: result.targetVersion,
        appliedVersions: result.appliedVersions,
      });
    }
    return result;
  } finally {
    lock.release();
  }
}
