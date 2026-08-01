import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface BatchSchemaMigration {
  version: number;
  sql: string;
}

export const BATCH_SCHEMA_MIGRATIONS: ReadonlyArray<BatchSchemaMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_productions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_productions_project
        ON batch_productions(projectId, updatedAt);
    `,
  },
];

export interface BatchSchemaBackupManifest {
  kind: 'batch-schema-upgrade';
  createdAt: string;
  sourceDatabaseFile: string;
  sourceVersions: number[];
  targetVersion: number;
  databaseBytes: number;
  sha256: string;
  integrityCheck: 'ok';
  foreignKeyViolations: 0;
}

export type BatchSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'migration_failed';

export type BatchSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
    }
  | {
      state: 'compatibility_only';
      code: BatchSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
    };

export interface EnsureBatchSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
}

class BackupValidationError extends Error {}

const MIGRATION_TABLE = 'batch_schema_migrations';

function migrationTableExists(db: Database.Database): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(MIGRATION_TABLE));
}

function readAppliedVersions(db: Database.Database): number[] {
  if (!migrationTableExists(db)) return [];
  return (db.prepare(
    `SELECT version FROM batch_schema_migrations ORDER BY version`,
  ).all() as Array<{ version: number }>).map(({ version }) => version);
}

function validateMigrationHistory(appliedVersions: number[]): BatchSchemaFailureCode | null {
  const knownVersions = BATCH_SCHEMA_MIGRATIONS.map(({ version }) => version);
  if (appliedVersions.some((version) => version > (knownVersions.at(-1) ?? 0))) {
    return 'schema_too_new';
  }
  const appliedSet = new Set(appliedVersions);
  const highestApplied = appliedVersions.at(-1) ?? 0;
  if (knownVersions.some((version) => version <= highestApplied && !appliedSet.has(version))) {
    return 'schema_history_invalid';
  }
  return null;
}

function mainDatabasePath(db: Database.Database): string {
  const row = db.prepare(`PRAGMA database_list`).all()
    .find((entry) => (entry as { name: string }).name === 'main') as { file: string } | undefined;
  if (!row?.file) {
    throw new Error('批量 schema 升级只支持文件数据库');
  }
  return path.resolve(row.file);
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

async function createValidatedBackup(params: {
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
      createdAt: now.toISOString(),
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
    throw error;
  }
}

function applyMigration(db: Database.Database, migration: BatchSchemaMigration, appliedAt: string): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      )
    `);
    db.exec(migration.sql);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error('批量 schema 迁移后的外键检查未通过');
    }
    db.prepare(
      `INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`,
    ).run(migration.version, appliedAt);
  })();
}

export async function ensureBatchSchemaReady(
  options: EnsureBatchSchemaOptions,
): Promise<BatchSchemaReadiness> {
  const { db, backupRoot, now = () => new Date() } = options;
  const targetVersion = BATCH_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
  let appliedVersions: number[];

  try {
    appliedVersions = readAppliedVersions(db);
  } catch {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: '批量功能的升级记录无法读取，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const historyFailure = validateMigrationHistory(appliedVersions);
  if (historyFailure) {
    return {
      state: 'compatibility_only',
      code: historyFailure,
      message: historyFailure === 'schema_too_new'
        ? '当前数据库来自更新版本，批量功能暂不可用。'
        : '批量功能的升级记录不完整，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const appliedSet = new Set(appliedVersions);
  const pendingMigrations = BATCH_SCHEMA_MIGRATIONS.filter(({ version }) => !appliedSet.has(version));
  if (pendingMigrations.length === 0) {
    return { state: 'current', appliedVersions: [], targetVersion };
  }

  const startedAt = now();
  let backupDirectory: string | undefined;
  try {
    const backup = await createValidatedBackup({
      db,
      backupRoot,
      sourceVersions: appliedVersions,
      targetVersion,
      now: startedAt,
    });
    backupDirectory = backup.directory;
  } catch (error) {
    return {
      state: 'compatibility_only',
      code: error instanceof BackupValidationError ? 'backup_validation_failed' : 'backup_failed',
      message: error instanceof BackupValidationError
        ? '数据库备份未通过完整性检查，尚未执行批量升级。'
        : '无法完成数据库安全备份，尚未执行批量升级。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const newlyApplied: number[] = [];
  try {
    for (const migration of pendingMigrations) {
      applyMigration(db, migration, now().toISOString());
      newlyApplied.push(migration.version);
    }
  } catch {
    return {
      state: 'compatibility_only',
      code: 'migration_failed',
      message: '批量数据库升级未完成，旧功能仍可继续使用。',
      appliedVersions: newlyApplied,
      targetVersion,
      backupDirectory,
    };
  }

  return {
    state: 'ready',
    appliedVersions: newlyApplied,
    targetVersion,
    backupDirectory,
  };
}
