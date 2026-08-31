import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type SchemaUpgradeAuditEvent =
  | 'started'
  | 'finished'
  | 'lock_timeout'
  | 'interrupted_recovered'
  | 'corrupt_records_recovered'
  | 'backup_completed'
  | 'migration_completed'
  | 'validation_completed'
  | 'compatibility_entered'
  | 'staging_backups_cleaned';

export interface SchemaUpgradeAuditDetails {
  backup?: {
    backupId: string;
    databaseBytes: number;
    sha256: string;
    validated: true;
  };
  migration?: {
    appliedVersions: number[];
    targetVersion: number;
  };
  validation?: {
    status: 'passed';
  };
  compatibility?: {
    code: string;
  };
  corruptRecordCount?: number;
  stagingDirectoryCount?: number;
}

export interface SchemaUpgradeAuditResult {
  available: boolean;
  mode: 'ready' | 'compatibility_only';
  schemaState?: 'current' | 'ready' | 'compatibility_only';
  code?: string;
  appliedVersions?: number[];
  targetVersion?: number;
  backupCreated?: boolean;
}

export interface SchemaUpgradeAuditRecord {
  version: 1;
  event: SchemaUpgradeAuditEvent;
  attemptId: string;
  scope: 'batch-production' | 'video-provider-gateway' | 'script-studio';
  at: string;
  recoveredByAttemptId?: string;
  result?: SchemaUpgradeAuditResult;
  details?: SchemaUpgradeAuditDetails;
}

function isAuditRecord(value: unknown): value is SchemaUpgradeAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SchemaUpgradeAuditRecord>;
  return record.version === 1
    && typeof record.event === 'string'
    && typeof record.attemptId === 'string'
    && typeof record.at === 'string'
    && (record.scope === 'batch-production' || record.scope === 'video-provider-gateway' || record.scope === 'script-studio');
}

export async function appendSchemaUpgradeAudit(
  auditFilePath: string,
  record: SchemaUpgradeAuditRecord,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(auditFilePath), { recursive: true });
  const handle = await fsPromises.open(auditFilePath, 'a+', 0o600);
  try {
    const stat = await handle.stat();
    if (stat.size > 0) {
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, stat.size - 1);
      if (lastByte[0] !== 10) await handle.appendFile('\n', 'utf8');
    }
    await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readSchemaUpgradeAudit(
  auditFilePath: string,
): Promise<SchemaUpgradeAuditRecord[]> {
  let text: string;
  try {
    text = await fsPromises.readFile(auditFilePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return inspectSchemaUpgradeAuditText(text).records;
}

function inspectSchemaUpgradeAuditText(text: string): {
  records: SchemaUpgradeAuditRecord[];
  corruptRecordCount: number;
} {
  const records: SchemaUpgradeAuditRecord[] = [];
  let corruptRecordCount = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (!isAuditRecord(value)) throw new Error('invalid audit record');
      records.push(value);
    } catch {
      corruptRecordCount += 1;
    }
  }
  return { records, corruptRecordCount };
}

async function inspectSchemaUpgradeAudit(auditFilePath: string): Promise<{
  records: SchemaUpgradeAuditRecord[];
  corruptRecordCount: number;
}> {
  try {
    return inspectSchemaUpgradeAuditText(await fsPromises.readFile(auditFilePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], corruptRecordCount: 0 };
    }
    throw error;
  }
}

async function rewriteValidAuditRecords(
  auditFilePath: string,
  records: SchemaUpgradeAuditRecord[],
): Promise<void> {
  const tempPath = `${auditFilePath}.${randomUUID()}.tmp`;
  const handle = await fsPromises.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsPromises.rename(tempPath, auditFilePath);
}

export async function recoverInterruptedSchemaUpgradeAudits(options: {
  auditFilePath: string;
  scope: SchemaUpgradeAuditRecord['scope'];
  recoveredByAttemptId: string;
  at: string;
}): Promise<string[]> {
  const inspected = await inspectSchemaUpgradeAudit(options.auditFilePath);
  const records = inspected.records;
  if (inspected.corruptRecordCount > 0) {
    await rewriteValidAuditRecords(options.auditFilePath, records);
    await appendSchemaUpgradeAudit(options.auditFilePath, {
      version: 1,
      event: 'corrupt_records_recovered',
      attemptId: options.recoveredByAttemptId,
      scope: options.scope,
      at: options.at,
      details: { corruptRecordCount: inspected.corruptRecordCount },
    });
  }
  const started = new Set(
    records
      .filter((record) => record.scope === options.scope && record.event === 'started')
      .map(({ attemptId }) => attemptId),
  );
  for (const record of records) {
    if (
      record.scope === options.scope
      && (record.event === 'finished' || record.event === 'interrupted_recovered')
    ) {
      started.delete(record.attemptId);
    }
  }

  for (const attemptId of started) {
    await appendSchemaUpgradeAudit(options.auditFilePath, {
      version: 1,
      event: 'interrupted_recovered',
      attemptId,
      scope: options.scope,
      at: options.at,
      recoveredByAttemptId: options.recoveredByAttemptId,
    });
  }
  return [...started];
}

export async function appendSchemaUpgradeResultAudits(options: {
  auditFilePath: string;
  scope: SchemaUpgradeAuditRecord['scope'];
  attemptId: string;
  at: () => string;
  result: SchemaUpgradeAuditResult;
  backup?: {
    directory: string;
    databaseBytes: number;
    sha256: string;
  };
}): Promise<void> {
  const base = {
    version: 1 as const,
    attemptId: options.attemptId,
    scope: options.scope,
  };
  if (options.backup) {
    await appendSchemaUpgradeAudit(options.auditFilePath, {
      ...base,
      event: 'backup_completed',
      at: options.at(),
      details: {
        backup: {
          backupId: path.basename(options.backup.directory),
          databaseBytes: options.backup.databaseBytes,
          sha256: options.backup.sha256,
          validated: true,
        },
      },
    });
  }
  if ((options.result.appliedVersions?.length ?? 0) > 0) {
    await appendSchemaUpgradeAudit(options.auditFilePath, {
      ...base,
      event: 'migration_completed',
      at: options.at(),
      details: {
        migration: {
          appliedVersions: options.result.appliedVersions ?? [],
          targetVersion: options.result.targetVersion ?? 0,
        },
      },
    });
  }
  if (options.result.available) {
    await appendSchemaUpgradeAudit(options.auditFilePath, {
      ...base,
      event: 'validation_completed',
      at: options.at(),
      details: { validation: { status: 'passed' } },
    });
  } else {
    await appendSchemaUpgradeAudit(options.auditFilePath, {
      ...base,
      event: 'compatibility_entered',
      at: options.at(),
      details: { compatibility: { code: options.result.code ?? 'unknown' } },
    });
  }
  await appendSchemaUpgradeAudit(options.auditFilePath, {
    ...base,
    event: 'finished',
    at: options.at(),
    result: options.result,
  });
}
