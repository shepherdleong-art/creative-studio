import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import packageMetadata from '../../package.json' with { type: 'json' };

export type SchemaUpgradeScope = 'batch-production' | 'batch-formula' | 'video-provider-gateway' | 'script-studio' | 'creative-canvas' | 'live-mixcut';

/** 备份目录 slug；新增 scope 必须同时更新这里与 cleanupInterruptedSchemaUpgradeBackups 的匹配。 */
export const SCOPE_SLUGS: Record<SchemaUpgradeScope, string> = {
  'batch-production': 'batch',
  'batch-formula': 'batch-formula',
  'video-provider-gateway': 'video-gateway',
  'script-studio': 'script-studio',
  'creative-canvas': 'canvas',
  'live-mixcut': 'live-mixcut',
};

export interface SchemaUpgradeBackupManifest {
  kind: 'schema-upgrade';
  scope: SchemaUpgradeScope;
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

export type SchemaUpgradeBackupFailureCode =
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space';

export type SchemaUpgradeDiskSpaceProbe = (directory: string) => Promise<number>;

export class SchemaUpgradeBackupError extends Error {
  readonly code: SchemaUpgradeBackupFailureCode;

  constructor(code: SchemaUpgradeBackupFailureCode, message: string) {
    super(message);
    this.name = 'SchemaUpgradeBackupError';
    this.code = code;
  }
}

class BackupValidationError extends Error {}

function mainDatabasePath(db: Database.Database): string {
  const row = db.prepare(`PRAGMA database_list`).all()
    .find((entry) => (entry as { name: string }).name === 'main') as { file: string } | undefined;
  if (!row?.file) throw new Error('schema 升级只支持文件数据库');
  return path.resolve(row.file);
}

function dataRootIdentity(sourcePath: string): string {
  const inferredDataRoot = path.dirname(path.dirname(sourcePath));
  return createHash('sha256').update(inferredDataRoot).digest('hex');
}

async function availableDiskBytes(directory: string): Promise<number> {
  const stat = await fsPromises.statfs(directory);
  return stat.bavail * stat.bsize;
}

function requiredBackupBytes(db: Database.Database): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const databaseBytes = pageCount * pageSize;
  return databaseBytes + Math.max(16 * 1024 * 1024, Math.ceil(databaseBytes * 0.1));
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

async function publishBackupDirectory(stagingDirectory: string, publishedDirectory: string): Promise<void> {
  // Windows 会短暂拒绝刚写好的目录重命名。只重试发布同一份已验证备份；持续失败仍阻止迁移。
  const retryDelaysMs = [20, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    try {
      await fsPromises.rename(stagingDirectory, publishedDirectory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
        || attempt >= retryDelaysMs.length) throw error;
      await delay(retryDelaysMs[attempt]);
    }
  }
}

export async function createValidatedSchemaUpgradeBackup(params: {
  db: Database.Database;
  backupRoot: string;
  scope: SchemaUpgradeScope;
  sourceVersions: number[];
  targetVersion: number;
  now: Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<{ directory: string; manifest: SchemaUpgradeBackupManifest }> {
  const {
    db,
    backupRoot,
    scope,
    sourceVersions,
    targetVersion,
    now,
    diskSpaceProbe = availableDiskBytes,
  } = params;
  const sourcePath = mainDatabasePath(db);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const uniqueSuffix = randomUUID().slice(0, 8);
  const scopeSlug = SCOPE_SLUGS[scope];
  const directoryName = `pre-${scopeSlug}-v${targetVersion}-${timestamp}-${uniqueSuffix}`;
  const stagingDirectory = path.join(backupRoot, `.${directoryName}`);
  const publishedDirectory = path.join(backupRoot, directoryName);
  const backupPath = path.join(stagingDirectory, 'workbench.db');

  await fsPromises.mkdir(backupRoot, { recursive: true });
  try {
    const availableBytes = await diskSpaceProbe(backupRoot);
    if (availableBytes < requiredBackupBytes(db)) {
      throw new SchemaUpgradeBackupError(
        'insufficient_disk_space',
        '项目盘空间不足，无法安全创建数据库升级备份',
      );
    }
  } catch (error) {
    if (error instanceof SchemaUpgradeBackupError) throw error;
    throw new SchemaUpgradeBackupError('backup_failed', '无法检查数据库备份所需空间');
  }

  await fsPromises.mkdir(stagingDirectory, { recursive: false });
  try {
    await db.backup(backupPath);
    validateBackupDatabase(backupPath);
    const stat = await fsPromises.stat(backupPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new BackupValidationError('数据库备份文件为空');
    }

    const manifest: SchemaUpgradeBackupManifest = {
      kind: 'schema-upgrade',
      scope,
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
    await publishBackupDirectory(stagingDirectory, publishedDirectory);
    return { directory: publishedDirectory, manifest };
  } catch (error) {
    await fsPromises.rm(stagingDirectory, { recursive: true, force: true });
    if (error instanceof SchemaUpgradeBackupError) throw error;
    throw new SchemaUpgradeBackupError(
      error instanceof BackupValidationError ? 'backup_validation_failed' : 'backup_failed',
      error instanceof BackupValidationError
        ? '数据库备份未通过完整性检查'
        : '无法完成数据库安全备份',
    );
  }
}

export async function cleanupInterruptedSchemaUpgradeBackups(backupRoot: string): Promise<number> {
  let entries;
  try {
    entries = await fsPromises.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const interrupted = entries.filter((entry) => (
    entry.isDirectory()
    && /^\.pre-(?:batch|batch-formula|video-gateway|script-studio|canvas|live-mixcut)-v\d+-/.test(entry.name)
  ));
  for (const entry of interrupted) {
    await fsPromises.rm(path.join(backupRoot, entry.name), { recursive: true, force: true });
  }
  return interrupted.length;
}
