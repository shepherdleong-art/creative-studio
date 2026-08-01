import type Database from 'better-sqlite3';
import {
  BatchSchemaBackupError,
  createValidatedBatchSchemaBackup,
} from './backup.ts';

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
  const knownSet = new Set(knownVersions);
  if (appliedVersions.some((version) => version > (knownVersions.at(-1) ?? 0))) {
    return 'schema_too_new';
  }
  if (appliedVersions.some((version) => !knownSet.has(version))) {
    return 'schema_history_invalid';
  }
  const appliedSet = new Set(appliedVersions);
  const highestApplied = appliedVersions.at(-1) ?? 0;
  if (knownVersions.some((version) => version <= highestApplied && !appliedSet.has(version))) {
    return 'schema_history_invalid';
  }
  return null;
}

function validateBatchSchema(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (
    byName.get('id')?.pk !== 1
    || byName.get('projectId')?.notnull !== 1
    || byName.get('name')?.notnull !== 1
    || byName.get('createdAt')?.notnull !== 1
    || byName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('批量 schema 结构检查未通过');
  }

  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(batch_productions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!foreignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('批量 schema 项目外键检查未通过');
  }

  const indexes = db.prepare(`PRAGMA index_list(batch_productions)`).all() as Array<{ name: string }>;
  if (!indexes.some(({ name }) => name === 'idx_batch_productions_project')) {
    throw new Error('批量 schema 索引检查未通过');
  }

  const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new Error('批量 schema 迁移后的完整性检查未通过');
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
    validateBatchSchema(db);
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
    try {
      validateBatchSchema(db);
    } catch {
      return {
        state: 'compatibility_only',
        code: 'schema_history_invalid',
        message: '批量功能的数据结构与升级记录不一致，旧功能仍可继续使用。',
        appliedVersions: [],
        targetVersion,
      };
    }
    return { state: 'current', appliedVersions: [], targetVersion };
  }

  const startedAt = now();
  let backupDirectory: string | undefined;
  try {
    const backup = await createValidatedBatchSchemaBackup({
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
      code: error instanceof BatchSchemaBackupError ? error.code : 'backup_failed',
      message: error instanceof BatchSchemaBackupError && error.code === 'backup_validation_failed'
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
