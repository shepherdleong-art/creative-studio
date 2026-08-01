import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  SchemaUpgradeBackupError,
  type SchemaUpgradeDiskSpaceProbe,
} from './schema-upgrade/backup.ts';

const TARGET_VERSION = 1;

const PROVIDER_COLUMNS = `
  id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel,
  enabled, defaultDurationSec, defaultCostPerVideo, baseUrl, apiKey, accessKey, secretKey
`;

export type VideoProviderSchemaReadiness =
  | {
      state: 'current' | 'ready';
      targetVersion: number;
      backupDirectory?: string;
    }
  | {
      state: 'compatibility_only';
      code: 'backup_failed' | 'backup_validation_failed' | 'insufficient_disk_space' | 'migration_failed';
      message: string;
      targetVersion: number;
      backupDirectory?: string;
    };

function videoProviderTableSql(db: Database.Database): string {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'video_providers'`,
  ).get() as { sql: string } | undefined;
  if (!row?.sql) throw new Error('video_providers 表不存在');
  return row.sql;
}

function supportsGatewayProvider(db: Database.Database): boolean {
  return videoProviderTableSql(db).includes('openai-video');
}

function providerRows(db: Database.Database): unknown[] {
  return db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM video_providers ORDER BY id`).all();
}

function validateGatewayProviderSchema(db: Database.Database, expectedRowsJson: string): void {
  if (!supportsGatewayProvider(db)) throw new Error('视频网关供应商约束未升级');
  if (JSON.stringify(providerRows(db)) !== expectedRowsJson) {
    throw new Error('视频供应商配置在迁移中发生变化');
  }
  const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyViolations.length > 0) throw new Error('视频供应商迁移后的外键检查未通过');
}

function rebuildVideoProviders(db: Database.Database, appliedAt: string): void {
  const expectedRowsJson = JSON.stringify(providerRows(db));
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE video_providers_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('kling','jimeng','openai-video')),
          baseUrlEnv TEXT NOT NULL,
          apiKeyEnv TEXT NOT NULL,
          modelEnv TEXT NOT NULL,
          defaultModel TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          defaultDurationSec INTEGER NOT NULL DEFAULT 5,
          defaultCostPerVideo REAL,
          baseUrl TEXT NOT NULL DEFAULT '',
          apiKey TEXT NOT NULL DEFAULT '',
          accessKey TEXT NOT NULL DEFAULT '',
          secretKey TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO video_providers_new (${PROVIDER_COLUMNS})
          SELECT ${PROVIDER_COLUMNS} FROM video_providers;
        DROP TABLE video_providers;
        ALTER TABLE video_providers_new RENAME TO video_providers;
        CREATE TABLE IF NOT EXISTS video_provider_schema_migrations (
          version INTEGER PRIMARY KEY,
          appliedAt TEXT NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO video_provider_schema_migrations (version, appliedAt)
        VALUES (?, ?)
      `).run(TARGET_VERSION, appliedAt);
      validateGatewayProviderSchema(db, expectedRowsJson);
    });
    migrate.immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export async function ensureVideoProviderGatewaySchemaReady(options: {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<VideoProviderSchemaReadiness> {
  const now = options.now ?? (() => new Date());
  try {
    if (supportsGatewayProvider(options.db)) {
      const expectedRowsJson = JSON.stringify(providerRows(options.db));
      validateGatewayProviderSchema(options.db, expectedRowsJson);
      return { state: 'current', targetVersion: TARGET_VERSION };
    }
  } catch {
    return {
      state: 'compatibility_only',
      code: 'migration_failed',
      message: '无法读取视频供应商数据结构，旧供应商仍可继续使用。',
      targetVersion: TARGET_VERSION,
    };
  }

  let backupDirectory: string | undefined;
  try {
    const backup = await createValidatedSchemaUpgradeBackup({
      db: options.db,
      backupRoot: options.backupRoot,
      scope: 'video-provider-gateway',
      sourceVersions: [],
      targetVersion: TARGET_VERSION,
      now: now(),
      diskSpaceProbe: options.diskSpaceProbe,
    });
    backupDirectory = backup.directory;
  } catch (error) {
    const code = error instanceof SchemaUpgradeBackupError ? error.code : 'backup_failed';
    return {
      state: 'compatibility_only',
      code,
      message: code === 'insufficient_disk_space'
        ? '项目盘空间不足，尚未升级视频供应商数据结构。'
        : code === 'backup_validation_failed'
          ? '数据库备份未通过检查，尚未升级视频供应商数据结构。'
          : '无法完成数据库安全备份，尚未升级视频供应商数据结构。',
      targetVersion: TARGET_VERSION,
    };
  }

  try {
    rebuildVideoProviders(options.db, now().toISOString());
    return { state: 'ready', targetVersion: TARGET_VERSION, backupDirectory };
  } catch {
    return {
      state: 'compatibility_only',
      code: 'migration_failed',
      message: '视频供应商数据结构升级失败，旧供应商仍可继续使用。',
      targetVersion: TARGET_VERSION,
      backupDirectory,
    };
  }
}
