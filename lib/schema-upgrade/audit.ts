import fsPromises from 'node:fs/promises';
import path from 'node:path';

export type SchemaUpgradeAuditEvent =
  | 'started'
  | 'finished'
  | 'lock_timeout'
  | 'interrupted_recovered';

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
  scope: 'batch-production' | 'video-provider-gateway';
  at: string;
  recoveredByAttemptId?: string;
  result?: SchemaUpgradeAuditResult;
}

function isAuditRecord(value: unknown): value is SchemaUpgradeAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SchemaUpgradeAuditRecord>;
  return record.version === 1
    && typeof record.event === 'string'
    && typeof record.attemptId === 'string'
    && typeof record.at === 'string'
    && (record.scope === 'batch-production' || record.scope === 'video-provider-gateway');
}

export async function appendSchemaUpgradeAudit(
  auditFilePath: string,
  record: SchemaUpgradeAuditRecord,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(auditFilePath), { recursive: true });
  const handle = await fsPromises.open(auditFilePath, 'a', 0o600);
  try {
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
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .map((value) => {
      if (!isAuditRecord(value)) throw new Error('数据库升级审计记录格式无效');
      return value;
    });
}

export async function recoverInterruptedSchemaUpgradeAudits(options: {
  auditFilePath: string;
  scope: SchemaUpgradeAuditRecord['scope'];
  recoveredByAttemptId: string;
  at: string;
}): Promise<string[]> {
  const records = await readSchemaUpgradeAudit(options.auditFilePath);
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
