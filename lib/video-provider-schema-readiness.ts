import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  appendSchemaUpgradeAudit,
  recoverInterruptedSchemaUpgradeAudits,
} from './schema-upgrade/audit.ts';
import {
  acquireSchemaUpgradeLock,
  SchemaUpgradeLockTimeoutError,
} from './schema-upgrade/lock.ts';
import type { SchemaUpgradeDiskSpaceProbe } from './schema-upgrade/backup.ts';
import {
  ensureVideoProviderGatewaySchemaReady,
  type VideoProviderSchemaReadiness,
} from './video-provider-schema.ts';

export type VideoProviderGatewayReadiness =
  | {
      available: true;
      schemaState: 'current' | 'ready';
      message: string;
      checkedAt: string;
      auditId: string;
    }
  | {
      available: false;
      schemaState?: 'compatibility_only';
      code: 'upgrade_in_progress' | 'audit_unavailable' | Exclude<VideoProviderSchemaReadiness, { state: 'current' | 'ready' }>['code'];
      message: string;
      checkedAt: string;
      auditId: string;
    };

export async function checkVideoProviderGatewayReadiness(options: {
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<VideoProviderGatewayReadiness> {
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
    const result: VideoProviderGatewayReadiness = {
      available: false,
      code: error instanceof SchemaUpgradeLockTimeoutError ? 'upgrade_in_progress' : 'audit_unavailable',
      message: error instanceof SchemaUpgradeLockTimeoutError
        ? '另一个程序正在完成数据库升级，请稍后重试。'
        : '无法取得数据库升级锁。',
      checkedAt,
      auditId: attemptId,
    };
    try {
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'lock_timeout',
        attemptId,
        scope: 'video-provider-gateway',
        at: checkedAt,
        result: { available: false, mode: 'compatibility_only', code: result.code },
      });
    } catch {
      // The caller already receives an unavailable result.
    }
    return result;
  }

  try {
    try {
      await recoverInterruptedSchemaUpgradeAudits({
        auditFilePath: options.auditFilePath,
        scope: 'video-provider-gateway',
        recoveredByAttemptId: attemptId,
        at: checkedAt,
      });
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'started',
        attemptId,
        scope: 'video-provider-gateway',
        at: checkedAt,
      });
    } catch {
      return {
        available: false,
        code: 'audit_unavailable',
        message: '无法写入数据库升级记录。',
        checkedAt,
        auditId: attemptId,
      };
    }

    const schema = await ensureVideoProviderGatewaySchemaReady({
      db: options.db,
      backupRoot: options.backupRoot,
      now,
      diskSpaceProbe: options.diskSpaceProbe,
    });
    const result: VideoProviderGatewayReadiness = schema.state === 'compatibility_only'
      ? {
          available: false,
          schemaState: 'compatibility_only',
          code: schema.code,
          message: schema.message,
          checkedAt,
          auditId: attemptId,
        }
      : {
          available: true,
          schemaState: schema.state,
          message: schema.state === 'ready'
            ? '视频网关供应商数据结构已完成安全升级。'
            : '视频网关供应商数据结构已就绪。',
          checkedAt,
          auditId: attemptId,
        };

    try {
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'finished',
        attemptId,
        scope: 'video-provider-gateway',
        at: now().toISOString(),
        result: {
          available: result.available,
          mode: result.available ? 'ready' : 'compatibility_only',
          schemaState: result.schemaState,
          ...(!result.available ? { code: result.code } : {}),
          targetVersion: schema.targetVersion,
          backupCreated: schema.backupDirectory !== undefined,
        },
      });
    } catch {
      return {
        available: false,
        code: 'audit_unavailable',
        message: '数据库升级已结束，但无法保存审计结果。',
        checkedAt,
        auditId: attemptId,
      };
    }
    return result;
  } finally {
    lock.release();
  }
}
