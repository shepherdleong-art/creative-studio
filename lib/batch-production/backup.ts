import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import packageMetadata from '../../package.json' with { type: 'json' };

export interface BatchSchemaBackupManifest {
  kind: 'batch-schema-upgrade';
  applicationVersion: string;
  createdAt: string;
  dataRootIdentity: string;
  sourceDatabaseFile: string;
  sourceVersions: number[];
  targetVersion: number;
  databaseBytes: number;
  sha256: string;
  integrityCheck: 'ok';
  foreignKeyViolations: 0;
}

export type BatchSchemaBackupFailureCode = 'backup_failed' | 'backup_validation_failed';

export class BatchSchemaBackupError extends Error {
  readonly code: BatchSchemaBackupFailureCode;

  constructor(code: BatchSchemaBackupFailureCode, message: string) {
    super(message);
    this.name = 'BatchSchemaBackupError';
    this.code = code;
  }
}

class BackupValidationError extends Error {}

function mainDatabasePath(db: Database.Database): string {
  const row = db.prepare(`PRAGMA database_list`).all()
    .find((entry) => (entry as { name: string }).name === 'main') as { file: string } | undefined;
  if (!row?.file) {
    throw new Error('批量 schema 升级只支持文件数据库');
  }
  return path.resolve(row.file);
}

function dataRootIdentity(sourcePath: string): string {
  const inferredDataRoot = path.dirname(path.dirname(sourcePath));
  return createHash('sha256').update(inferredDataRoot).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function validateBackupDatabase(backupPath: string): void {
  const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
      throw new BackupValidationError('数据库完整性检查未通过');
    }
    const foreignKeyViolations = backupDb.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new BackupValidationError('数据库外键检查未通过');
    }
  } finally {
    backupDb.close();
  }
}

export async function createValidatedBatchSchemaBackup(params: {
  db: Database.Database;
  backupRoot: string;
  sourceVersions: number[];
  targetVersion: number;
  now: Date;
}): Promise<{ directory: string; manifest: BatchSchemaBackupManifest }> {
  const { db, backupRoot, sourceVersions, targetVersion, now } = params;
  const sourcePath = mainDatabasePath(db);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const uniqueSuffix = randomUUID().slice(0, 8);
  const directoryName = `pre-batch-v${targetVersion}-${timestamp}-${uniqueSuffix}`;
  const stagingDirectory = path.join(backupRoot, `.${directoryName}`);
  const publishedDirectory = path.join(backupRoot, directoryName);
  const backupPath = path.join(stagingDirectory, 'workbench.db');

  await fsPromises.mkdir(backupRoot, { recursive: true });
  await fsPromises.mkdir(stagingDirectory, { recursive: false });
  try {
    await db.backup(backupPath);
    validateBackupDatabase(backupPath);
    const stat = await fsPromises.stat(backupPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new BackupValidationError('数据库备份文件为空');
    }

    const manifest: BatchSchemaBackupManifest = {
      kind: 'batch-schema-upgrade',
      applicationVersion: packageMetadata.version,
      createdAt: now.toISOString(),
      dataRootIdentity: dataRootIdentity(sourcePath),
      sourceDatabaseFile: path.basename(sourcePath),
      sourceVersions,
      targetVersion,
      databaseBytes: stat.size,
      sha256: await sha256File(backupPath),
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
    };
    await fsPromises.writeFile(
      path.join(stagingDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await fsPromises.rename(stagingDirectory, publishedDirectory);
    return { directory: publishedDirectory, manifest };
  } catch (error) {
    await fsPromises.rm(stagingDirectory, { recursive: true, force: true });
    throw new BatchSchemaBackupError(
      error instanceof BackupValidationError ? 'backup_validation_failed' : 'backup_failed',
      error instanceof BackupValidationError
        ? '数据库备份未通过完整性检查'
        : '无法完成数据库安全备份',
    );
  }
}
