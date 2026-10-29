/**
 * 实拍混剪独立迁移流。照创作画布的写法：只用自己的表，迁移只能追加，
 * 必须经过 lib/schema-upgrade/ 的共享备份、锁与审计（见 readiness.ts）。
 * 导出名沿用批量的 ensureBatchSchemaReady / BatchSchemaFailureCode，复制过来的 readiness.ts 不用改。
 */
import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
} from '../schema-upgrade/backup.ts';
import { LIVE_MIXCUT_SCHEMA_V1_SQL } from './schema-v1-sql.ts';
import { LIVE_MIXCUT_SCHEMA_V2_SQL } from './schema-v2-sql.ts';
import { LIVE_MIXCUT_SCHEMA_V3_SQL } from './schema-v3-sql.ts';
import { LIVE_MIXCUT_SCHEMA_V4_SQL } from './schema-v4-sql.ts';
import { LIVE_MIXCUT_SCHEMA_V5_SQL } from './schema-v5-sql.ts';
import { LIVE_MIXCUT_SCHEMA_V6_SQL } from './schema-v6-sql.ts';
import { LIVE_MIXCUT_SCHEMA_V7_SQL } from './schema-v7-sql.ts';

export interface LiveMixcutMigration {
  version: number;
  sql: string;
}

export const LIVE_MIXCUT_MIGRATIONS: ReadonlyArray<LiveMixcutMigration> = [
  { version: 1, sql: LIVE_MIXCUT_SCHEMA_V1_SQL },
  { version: 2, sql: LIVE_MIXCUT_SCHEMA_V2_SQL },
  { version: 3, sql: LIVE_MIXCUT_SCHEMA_V3_SQL },
  { version: 4, sql: LIVE_MIXCUT_SCHEMA_V4_SQL },
  { version: 5, sql: LIVE_MIXCUT_SCHEMA_V5_SQL },
  { version: 6, sql: LIVE_MIXCUT_SCHEMA_V6_SQL },
  { version: 7, sql: LIVE_MIXCUT_SCHEMA_V7_SQL },
];

export type BatchSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed';

export type BatchSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: BatchSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    };

export interface EnsureLiveMixcutSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}

const MIGRATION_TABLE = 'live_mixcut_schema_migrations';
const CORE_TABLES = ['live_mixcut_projects', 'live_mixcut_productions', 'live_mixcut_output_plans', 'live_mixcut_formula_generation_requests'];

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function readLiveMixcutAppliedVersions(db: Database.Database): number[] {
  if (!tableExists(db, MIGRATION_TABLE)) return [];
  return (db.prepare(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`).all() as Array<{ version: number }>)
    .map(({ version }) => version);
}

/** 是否已经存在实拍混剪的表；开关关闭时不得产生这些表。 */
export function liveMixcutTablesPresent(db: Database.Database): boolean {
  return CORE_TABLES.some(table => tableExists(db, table));
}

function validateMigrationHistory(applied: number[]): BatchSchemaFailureCode | null {
  const known = LIVE_MIXCUT_MIGRATIONS.map(({ version }) => version);
  if (applied.some(version => version > (known.at(-1) ?? 0))) return 'schema_too_new';
  if (applied.some(version => !known.includes(version))) return 'schema_history_invalid';
  const highest = applied.at(-1) ?? 0;
  if (known.some(version => version <= highest && !applied.includes(version))) return 'schema_history_invalid';
  return null;
}

function applyMigration(db: Database.Database, migration: LiveMixcutMigration, appliedAt: string): void {
  const apply = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
    db.exec(migration.sql);
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error('实拍混剪迁移后的外键检查未通过');
    db.prepare(`INSERT INTO ${MIGRATION_TABLE} (version, appliedAt) VALUES (?, ?)`).run(migration.version, appliedAt);
  });
  apply.immediate();
}

function unavailable(code: BatchSchemaFailureCode, message: string, targetVersion: number,
  extra: Partial<Pick<Extract<BatchSchemaReadiness, { state: 'compatibility_only' }>, 'appliedVersions' | 'backupDirectory' | 'backupManifest'>> = {}): BatchSchemaReadiness {
  return { state: 'compatibility_only', code, message, appliedVersions: [], targetVersion, ...extra };
}

export async function ensureBatchSchemaReady(options: EnsureLiveMixcutSchemaOptions): Promise<BatchSchemaReadiness> {
  const { db, backupRoot, now = () => new Date(), diskSpaceProbe } = options;
  const targetVersion = LIVE_MIXCUT_MIGRATIONS.at(-1)?.version ?? 0;
  let applied: number[];
  try {
    applied = readLiveMixcutAppliedVersions(db);
  } catch {
    return unavailable('schema_history_invalid', '实拍混剪的升级记录无法读取，其他功能不受影响。', targetVersion);
  }
  const historyFailure = validateMigrationHistory(applied);
  if (historyFailure) {
    return unavailable(historyFailure, historyFailure === 'schema_too_new'
      ? '当前数据库来自更新版本，实拍混剪暂不可用。' : '实拍混剪的升级记录不完整，其他功能不受影响。', targetVersion);
  }
  if (applied.length > 0 && !CORE_TABLES.every(table => tableExists(db, table))) {
    return unavailable('schema_history_invalid', '实拍混剪的数据结构与升级记录不一致，其他功能不受影响。', targetVersion);
  }
  const pending = LIVE_MIXCUT_MIGRATIONS.filter(({ version }) => !applied.includes(version));
  if (pending.length === 0) return { state: 'current', appliedVersions: applied, targetVersion };

  let backupDirectory: string | undefined;
  let backupManifest: SchemaUpgradeBackupManifest | undefined;
  try {
    const backup = await createValidatedSchemaUpgradeBackup({
      db, backupRoot, scope: 'live-mixcut', sourceVersions: applied, targetVersion, now: now(), diskSpaceProbe,
    });
    backupDirectory = backup.directory;
    backupManifest = backup.manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法完成实拍混剪数据库安全备份。';
    return unavailable(message.includes('空间不足') ? 'insufficient_disk_space'
      : message.includes('完整性') ? 'backup_validation_failed' : 'backup_failed', message, targetVersion);
  }
  const newlyApplied: number[] = [];
  try {
    for (const migration of pending) {
      applyMigration(db, migration, now().toISOString());
      newlyApplied.push(migration.version);
    }
  } catch {
    return unavailable('migration_failed', '实拍混剪数据库升级未完成，其他功能不受影响。', targetVersion,
      { appliedVersions: newlyApplied, backupDirectory, backupManifest });
  }
  return { state: 'ready', appliedVersions: newlyApplied, targetVersion, backupDirectory, backupManifest };
}
