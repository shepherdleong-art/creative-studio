import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
} from '../schema-upgrade/backup.ts';

export interface ScriptStudioMigration {
  version: number;
  sql: string;
}

export const SCRIPT_STUDIO_MIGRATIONS: ReadonlyArray<ScriptStudioMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS script_studio_source_sets (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        contentFingerprint TEXT NOT NULL,
        imageAssetIdsJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sss_project ON script_studio_source_sets(projectId, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sss_fingerprint ON script_studio_source_sets(projectId, contentFingerprint);

      CREATE TABLE IF NOT EXISTS script_studio_libraries (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        currentRevisionId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ssl_project ON script_studio_libraries(projectId);

      CREATE TABLE IF NOT EXISTS script_studio_library_revisions (
        id TEXT PRIMARY KEY,
        libraryId TEXT NOT NULL,
        revisionNumber INTEGER NOT NULL,
        sourceSetId TEXT NOT NULL,
        sourceFingerprint TEXT NOT NULL,
        productName TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        brand TEXT NOT NULL DEFAULT '',
        extractProviderId TEXT NOT NULL DEFAULT '',
        extractModel TEXT NOT NULL DEFAULT '',
        promptContractVersion INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(libraryId) REFERENCES script_studio_libraries(id) ON DELETE CASCADE,
        FOREIGN KEY(sourceSetId) REFERENCES script_studio_source_sets(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sslr_number ON script_studio_library_revisions(libraryId, revisionNumber);

      CREATE TABLE IF NOT EXISTS script_studio_selling_points (
        id TEXT PRIMARY KEY,
        revisionId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        factText TEXT NOT NULL,
        pointType TEXT NOT NULL,
        evidenceQuote TEXT NOT NULL DEFAULT '',
        sourcePageIndex INTEGER,
        tileRefsJson TEXT NOT NULL DEFAULT '[]',
        modelConfidence TEXT NOT NULL DEFAULT '',
        riskLevel TEXT NOT NULL DEFAULT 'low',
        evidenceGate TEXT NOT NULL,
        usable INTEGER NOT NULL DEFAULT 0,
        disabledByUser INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(revisionId) REFERENCES script_studio_library_revisions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ssp_revision ON script_studio_selling_points(revisionId, seq);

      CREATE TABLE IF NOT EXISTS script_studio_tasks (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        mode TEXT NOT NULL,
        sourceSetId TEXT,
        libraryRevisionId TEXT,
        inputSnapshotJson TEXT NOT NULL,
        requestedCount INTEGER NOT NULL,
        succeededCount INTEGER NOT NULL DEFAULT 0,
        failedCount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        currentStage TEXT NOT NULL DEFAULT '',
        errorCode TEXT,
        errorMessage TEXT,
        leaseUntil TEXT,
        attemptCount INTEGER NOT NULL DEFAULT 0,
        parentTaskId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sst_request ON script_studio_tasks(projectId, requestKey);
      CREATE INDEX IF NOT EXISTS idx_sst_status ON script_studio_tasks(status, leaseUntil);

      CREATE TABLE IF NOT EXISTS script_studio_task_stages (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        payloadJson TEXT NOT NULL DEFAULT '{}',
        startedAt TEXT,
        finishedAt TEXT,
        errorCode TEXT,
        FOREIGN KEY(taskId) REFERENCES script_studio_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ssts_task ON script_studio_task_stages(taskId, seq);

      CREATE TABLE IF NOT EXISTS project_scripts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        shotSetId TEXT,
        currentRevisionId TEXT,
        generationTaskId TEXT,
        archivedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(shotSetId) REFERENCES shot_sets(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ps_project ON project_scripts(projectId, archivedAt, updatedAt);

      CREATE TABLE IF NOT EXISTS project_script_revisions (
        id TEXT PRIMARY KEY,
        scriptId TEXT NOT NULL,
        revisionNumber INTEGER NOT NULL,
        generationTaskId TEXT,
        libraryRevisionId TEXT,
        templateId TEXT NOT NULL DEFAULT '',
        templateVersion INTEGER NOT NULL DEFAULT 0,
        templateRationale TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL,
        contentJson TEXT NOT NULL,
        targetDurationSec INTEGER NOT NULL,
        estimatedDurationSec REAL,
        validationJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        FOREIGN KEY(scriptId) REFERENCES project_scripts(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_psr_number ON project_script_revisions(scriptId, revisionNumber);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE script_studio_selling_points ADD COLUMN themeKey TEXT NOT NULL DEFAULT '';
      ALTER TABLE script_studio_selling_points ADD COLUMN themeTitle TEXT NOT NULL DEFAULT '';
      ALTER TABLE script_studio_selling_points ADD COLUMN hierarchyRole TEXT NOT NULL DEFAULT 'supporting';
      ALTER TABLE script_studio_selling_points ADD COLUMN importance INTEGER NOT NULL DEFAULT 50;
      UPDATE script_studio_selling_points SET themeTitle = title WHERE themeTitle = '';
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE script_studio_selling_points ADD COLUMN evidenceRefsJson TEXT NOT NULL DEFAULT '[]';
      UPDATE script_studio_selling_points
      SET evidenceRefsJson = (
        SELECT json_group_array(json_object('pageIndex', script_studio_selling_points.sourcePageIndex, 'tileRef', TRIM(je.value)))
        FROM json_each(script_studio_selling_points.tileRefsJson) AS je
        WHERE TRIM(je.value) <> ''
      )
      WHERE json_valid(script_studio_selling_points.tileRefsJson)
        AND json_array_length(script_studio_selling_points.tileRefsJson) > 0;
      UPDATE script_studio_selling_points
      SET evidenceRefsJson = json_array(json_object('pageIndex', sourcePageIndex, 'tileRef', ''))
      WHERE evidenceRefsJson = '[]' AND sourcePageIndex IS NOT NULL;
      UPDATE script_studio_selling_points
      SET themeKey = 'p' || COALESCE(CAST(sourcePageIndex AS TEXT), 'na') || ':' || TRIM(themeTitle)
      WHERE TRIM(themeTitle) <> '';
    `,
  },
];

export type ScriptStudioSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed';

export type ScriptStudioSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: ScriptStudioSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    };

export interface EnsureScriptStudioSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}

const MIGRATION_TABLE = 'script_studio_schema_migrations';

function migrationTableExists(db: Database.Database): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(MIGRATION_TABLE));
}

function readAppliedVersions(db: Database.Database): number[] {
  if (!migrationTableExists(db)) return [];
  return (db.prepare(
    `SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`,
  ).all() as Array<{ version: number }>).map(({ version }) => version);
}

function validateMigrationHistory(appliedVersions: number[]): ScriptStudioSchemaFailureCode | null {
  const knownVersions = SCRIPT_STUDIO_MIGRATIONS.map(({ version }) => version);
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

function applyMigration(
  db: Database.Database,
  migration: ScriptStudioMigration,
  appliedAt: string,
): void {
  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      )
    `);
    db.exec(migration.sql);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error('script-studio schema 迁移后的外键检查未通过');
    }
    db.prepare(
      `INSERT INTO ${MIGRATION_TABLE} (version, appliedAt) VALUES (?, ?)`,
    ).run(migration.version, appliedAt);
  });
  apply.immediate();
}

function assertTablesExist(db: Database.Database): void {
  const tables = [
    'script_studio_source_sets',
    'script_studio_libraries',
    'script_studio_library_revisions',
    'script_studio_selling_points',
    'script_studio_tasks',
    'script_studio_task_stages',
    'project_scripts',
    'project_script_revisions',
  ];
  for (const table of tables) {
    const row = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table);
    if (!row) throw new Error(`script-studio schema 缺少表 ${table}`);
  }
}

export async function ensureScriptStudioSchemaReady(
  options: EnsureScriptStudioSchemaOptions,
): Promise<ScriptStudioSchemaReadiness> {
  const {
    db,
    backupRoot,
    now = () => new Date(),
    diskSpaceProbe,
  } = options;
  const targetVersion = SCRIPT_STUDIO_MIGRATIONS.at(-1)?.version ?? 0;
  let appliedVersions: number[];

  try {
    appliedVersions = readAppliedVersions(db);
  } catch {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: 'script-studio 的升级记录无法读取，旧功能仍可继续使用。',
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
        ? '当前数据库来自更新版本，script-studio 功能暂不可用。'
        : 'script-studio 的升级记录不完整，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const appliedSet = new Set(appliedVersions);
  const pendingMigrations = SCRIPT_STUDIO_MIGRATIONS.filter(({ version }) => !appliedSet.has(version));
  if (pendingMigrations.length === 0) {
    try {
      assertTablesExist(db);
    } catch {
      return {
        state: 'compatibility_only',
        code: 'schema_history_invalid',
        message: 'script-studio 的数据结构与升级记录不一致，旧功能仍可继续使用。',
        appliedVersions: [],
        targetVersion,
      };
    }
    return { state: 'current', appliedVersions, targetVersion };
  }

  const startedAt = now();
  let backupDirectory: string | undefined;
  let backupManifest: SchemaUpgradeBackupManifest | undefined;
  try {
    const backup = await createValidatedSchemaUpgradeBackup({
      db,
      backupRoot,
      scope: 'script-studio',
      sourceVersions: appliedVersions,
      targetVersion,
      now: startedAt,
      diskSpaceProbe,
    });
    backupDirectory = backup.directory;
    backupManifest = backup.manifest;
  } catch (error) {
    return {
      state: 'compatibility_only',
      code: error instanceof Error && error.message.includes('空间不足') ? 'insufficient_disk_space'
        : error instanceof Error && error.message.includes('完整性') ? 'backup_validation_failed'
        : 'backup_failed',
      message: error instanceof Error ? error.message : '无法完成 script-studio 数据库安全备份。',
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
      message: 'script-studio 数据库升级未完成，旧功能仍可继续使用。',
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
