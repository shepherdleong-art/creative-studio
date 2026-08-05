import { randomUUID } from 'node:crypto';
import type { SchemaUpgradeBackupManifest, SchemaUpgradeScope } from './backup.ts';
import { cleanupInterruptedSchemaUpgradeBackups } from './backup.ts';
import {
  appendSchemaUpgradeAudit,
  appendSchemaUpgradeResultAudits,
  recoverInterruptedSchemaUpgradeAudits,
} from './audit.ts';
import {
  acquireSchemaUpgradeLock,
  SchemaUpgradeLockTimeoutError,
} from './lock.ts';

export interface SchemaUpgradeOperationResult {
  state: 'current' | 'ready' | 'compatibility_only';
  targetVersion: number;
  appliedVersions: number[];
  code?: string;
  message?: string;
  backupDirectory?: string;
  backupManifest?: SchemaUpgradeBackupManifest;
}

export type SchemaUpgradeGateReadiness =
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
      code: string;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      checkedAt: string;
      auditId: string;
    };

export interface SchemaUpgradeGateMessages {
  current: string;
  ready: string;
  lockUnavailable: string;
  auditUnavailable: string;
  auditFinishUnavailable: string;
}

function unavailable(params: {
  code: string;
  message: string;
  checkedAt: string;
  auditId: string;
  targetVersion?: number;
  appliedVersions?: number[];
  schemaState?: 'compatibility_only';
}): SchemaUpgradeGateReadiness {
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

export async function runSchemaUpgradeGate(options: {
  scope: SchemaUpgradeScope;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
  messages: SchemaUpgradeGateMessages;
  execute: (now: () => Date) => Promise<SchemaUpgradeOperationResult>;
}): Promise<SchemaUpgradeGateReadiness> {
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
      code: error instanceof SchemaUpgradeLockTimeoutError ? 'upgrade_in_progress' : 'lock_unavailable',
      message: error instanceof SchemaUpgradeLockTimeoutError
        ? '另一个程序正在完成数据库升级，请稍后重试。'
        : options.messages.lockUnavailable,
      checkedAt,
      auditId: attemptId,
    });
    try {
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'lock_timeout',
        attemptId,
        scope: options.scope,
        at: checkedAt,
        result,
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
        scope: options.scope,
        recoveredByAttemptId: attemptId,
        at: checkedAt,
      });
      const cleanedStagingDirectories = await cleanupInterruptedSchemaUpgradeBackups(options.backupRoot);
      await appendSchemaUpgradeAudit(options.auditFilePath, {
        version: 1,
        event: 'started',
        attemptId,
        scope: options.scope,
        at: checkedAt,
      });
      if (cleanedStagingDirectories > 0) {
        await appendSchemaUpgradeAudit(options.auditFilePath, {
          version: 1,
          event: 'staging_backups_cleaned',
          attemptId,
          scope: options.scope,
          at: checkedAt,
          details: { stagingDirectoryCount: cleanedStagingDirectories },
        });
      }
    } catch {
      return unavailable({
        code: 'audit_unavailable',
        message: options.messages.auditUnavailable,
        checkedAt,
        auditId: attemptId,
      });
    }

    const operation = await options.execute(now);
    const result: SchemaUpgradeGateReadiness = operation.state === 'compatibility_only'
      ? unavailable({
          code: operation.code ?? 'operation_failed',
          message: operation.message ?? '数据库升级未完成。',
          checkedAt,
          auditId: attemptId,
          targetVersion: operation.targetVersion,
          appliedVersions: operation.appliedVersions,
          schemaState: 'compatibility_only',
        })
      : {
          available: true,
          mode: 'ready',
          schemaState: operation.state,
          message: operation.state === 'ready' ? options.messages.ready : options.messages.current,
          appliedVersions: operation.appliedVersions,
          targetVersion: operation.targetVersion,
          checkedAt,
          auditId: attemptId,
        };

    try {
      await appendSchemaUpgradeResultAudits({
        auditFilePath: options.auditFilePath,
        scope: options.scope,
        attemptId,
        at: () => now().toISOString(),
        result: {
          available: result.available,
          mode: result.mode,
          schemaState: result.schemaState,
          ...(!result.available ? { code: result.code } : {}),
          appliedVersions: result.appliedVersions,
          targetVersion: result.targetVersion,
          backupCreated: operation.backupDirectory !== undefined,
        },
        ...(operation.backupDirectory && operation.backupManifest ? {
          backup: {
            directory: operation.backupDirectory,
            databaseBytes: operation.backupManifest.databaseBytes,
            sha256: operation.backupManifest.sha256,
          },
        } : {}),
      });
    } catch {
      return unavailable({
        code: 'audit_unavailable',
        message: options.messages.auditFinishUnavailable,
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
