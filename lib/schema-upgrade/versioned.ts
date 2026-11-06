import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  SchemaUpgradeBackupError,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
  type SchemaUpgradeScope,
} from './backup.ts';

export interface VersionedSchemaMigration {
  version: number;
  sql: string;
}

export type VersionedSchemaFailureCode =
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed'
  | 'schema_history_invalid'
  | 'schema_too_new';

export type VersionedSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: VersionedSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    };

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

export async function ensureVersionedSchemaReady(options: {
  db: Database.Database;
  scope: SchemaUpgradeScope;
  migrations: ReadonlyArray<VersionedSchemaMigration>;
  migrationTable: string;
  backupRoot: string;
  validate: (db: Database.Database) => void;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<VersionedSchemaReadiness> {
  const {
    db,
    migrations,
    migrationTable,
    now = () => new Date(),
  } = options;
  const targetVersion = migrations.at(-1)?.version ?? 0;
  let appliedVersions: number[];
  try {
    appliedVersions = tableExists(db, migrationTable)
      ? (db.prepare(`SELECT version FROM ${migrationTable} ORDER BY version`).all() as Array<{ version: number }>)
        .map(({ version }) => version)
      : [];
  } catch {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: `${options.scope} 的升级记录无法读取。`,
      appliedVersions: [],
      targetVersion,
    };
  }

  const knownVersions = migrations.map(({ version }) => version);
  const known = new Set(knownVersions);
  const highest = appliedVersions.at(-1) ?? 0;
  const historyFailure = appliedVersions.some((version) => version > targetVersion)
    ? 'schema_too_new'
    : appliedVersions.some((version) => !known.has(version))
      || knownVersions.some((version) => version <= highest && !appliedVersions.includes(version))
      ? 'schema_history_invalid'
      : null;
  if (historyFailure) {
    return {
      state: 'compatibility_only',
      code: historyFailure,
      message: historyFailure === 'schema_too_new'
        ? `${options.scope} 数据库来自更新版本。`
        : `${options.scope} 的升级记录不完整。`,
      appliedVersions: [],
      targetVersion,
    };
  }

  const applied = new Set(appliedVersions);
  const pending = migrations.filter(({ version }) => !applied.has(version));
  if (pending.length === 0) {
    try {
      options.validate(db);
    } catch {
      return {
        state: 'compatibility_only',
        code: 'schema_history_invalid',
        message: `${options.scope} 的数据结构与升级记录不一致。`,
        appliedVersions: [],
        targetVersion,
      };
    }
    return { state: 'current', appliedVersions: [], targetVersion };
  }

  let backupDirectory: string | undefined;
  let backupManifest: SchemaUpgradeBackupManifest | undefined;
  try {
    const backup = await createValidatedSchemaUpgradeBackup({
      db,
      backupRoot: options.backupRoot,
      scope: options.scope,
      sourceVersions: appliedVersions,
      targetVersion,
      now: now(),
      diskSpaceProbe: options.diskSpaceProbe,
    });
    backupDirectory = backup.directory;
    backupManifest = backup.manifest;
  } catch (error) {
    return {
      state: 'compatibility_only',
      code: error instanceof SchemaUpgradeBackupError ? error.code : 'backup_failed',
      message: '无法完成数据库安全备份，尚未执行迁移。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const newlyApplied: number[] = [];
  try {
    for (const migration of pending) {
      const apply = db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS ${migrationTable} (
            version INTEGER PRIMARY KEY,
            appliedAt TEXT NOT NULL
          )
        `);
        db.exec(migration.sql);
        db.prepare(`INSERT INTO ${migrationTable} (version, appliedAt) VALUES (?, ?)`)
          .run(migration.version, now().toISOString());
      });
      apply.immediate();
      newlyApplied.push(migration.version);
    }
    options.validate(db);
  } catch {
    return {
      state: 'compatibility_only',
      code: 'migration_failed',
      message: `${options.scope} 数据库迁移未完成。`,
      appliedVersions: newlyApplied,
      targetVersion,
      backupDirectory,
      backupManifest,
    };
  }

  return {
    state: 'ready',
    appliedVersions: newlyApplied,
    targetVersion,
    backupDirectory,
    backupManifest,
  };
}
