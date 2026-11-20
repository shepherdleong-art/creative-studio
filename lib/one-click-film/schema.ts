import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
} from '../schema-upgrade/backup.ts';

/**
 * 一键成片模块的独立迁移流。
 *
 * 红线：只能追加新版本，绝不修改已发布条目。迁移前必须走共享备份/锁/审计 gate，
 * 不塞回会吞错误的 core runner。整条流水线共用同一个项目与成片身份：
 * F01、F02 是剪辑师看到的条目编号，脚本、视频任务、候选、包装和导出都挂在下面。
 */

export interface OneClickFilmMigration {
  version: number;
  sql: string;
}

export const ONE_CLICK_FILM_MIGRATIONS: ReadonlyArray<OneClickFilmMigration> = [
  {
    // v1：项目上下文、素材分析版本、成片条目、脚本版本。
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS one_click_film_runs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        ownerKey TEXT NOT NULL DEFAULT 'local',
        currentAnalysisId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_run_project
        ON one_click_film_runs(projectId);

      CREATE TABLE IF NOT EXISTS one_click_film_analyses (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        sourceImageIdsJson TEXT NOT NULL DEFAULT '[]',
        sourceFingerprint TEXT NOT NULL,
        productName TEXT NOT NULL DEFAULT '',
        appearance TEXT NOT NULL DEFAULT '',
        sceneClues TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
        errorCode TEXT,
        errorMessage TEXT,
        providerId TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        rawJson TEXT NOT NULL DEFAULT '{}',
        confirmedAt TEXT,
        confirmedProductName TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_analysis_version
        ON one_click_film_analyses(runId, versionNumber);
      CREATE INDEX IF NOT EXISTS idx_ocf_analysis_run
        ON one_click_film_analyses(runId, createdAt);

      CREATE TABLE IF NOT EXISTS one_click_film_selling_points (
        id TEXT PRIMARY KEY,
        analysisId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        originalText TEXT NOT NULL DEFAULT '',
        sourceImageId TEXT,
        sourceLabel TEXT NOT NULL DEFAULT '',
        evidenceRefsJson TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'claim' CHECK(kind IN ('appearance', 'usage', 'claim')),
        selected INTEGER NOT NULL DEFAULT 1 CHECK(selected IN (0, 1)),
        edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0, 1)),
        FOREIGN KEY(analysisId) REFERENCES one_click_film_analyses(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_point_seq
        ON one_click_film_selling_points(analysisId, seq);

      CREATE TABLE IF NOT EXISTS one_click_film_analysis_tasks (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        sourceFingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
        analysisId TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_analysis_task_request
        ON one_click_film_analysis_tasks(runId, requestKey);

      CREATE TABLE IF NOT EXISTS one_click_film_entries (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        code TEXT NOT NULL,
        structure TEXT NOT NULL,
        structureSource TEXT NOT NULL DEFAULT 'auto' CHECK(structureSource IN ('auto', 'batch', 'individual')),
        soundMode TEXT NOT NULL DEFAULT 'native' CHECK(soundMode IN ('native', 'tts', 'none')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'draft', 'confirmed')),
        outline TEXT NOT NULL DEFAULT '',
        narration TEXT NOT NULL DEFAULT '',
        promptText TEXT NOT NULL DEFAULT '',
        promptBaselineJson TEXT NOT NULL DEFAULT '[]',
        promptDurationSec INTEGER NOT NULL DEFAULT 15,
        promptAspectRatio TEXT NOT NULL DEFAULT '',
        scriptRevision INTEGER NOT NULL DEFAULT 0,
        scriptConfirmedAt TEXT,
        scriptConfirmedJson TEXT NOT NULL DEFAULT '{}',
        analysisId TEXT NOT NULL,
        productNameSnapshot TEXT NOT NULL DEFAULT '',
        sellingPointsSnapshotJson TEXT NOT NULL DEFAULT '[]',
        ttsProviderId TEXT NOT NULL DEFAULT '',
        ttsVoice TEXT NOT NULL DEFAULT '',
        ttsSpeed REAL NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_entry_code
        ON one_click_film_entries(runId, code);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_entry_ordinal
        ON one_click_film_entries(runId, ordinal);

      CREATE TABLE IF NOT EXISTS one_click_film_script_revisions (
        id TEXT PRIMARY KEY,
        entryId TEXT NOT NULL,
        revisionNumber INTEGER NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('generated', 'redraft', 'manual', 'structure_change')),
        outline TEXT NOT NULL,
        narration TEXT NOT NULL,
        promptText TEXT NOT NULL,
        promptBaselineJson TEXT NOT NULL DEFAULT '[]',
        promptDurationSec INTEGER NOT NULL,
        promptAspectRatio TEXT NOT NULL,
        structure TEXT NOT NULL,
        analysisId TEXT NOT NULL,
        sellingPointsSnapshotJson TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_script_revision
        ON one_click_film_script_revisions(entryId, revisionNumber);
    `,
  },
  {
    // v2：确认稿直出原片。每条成片提交一个整片生成任务，
    // 冻结脚本快照、参考图、模型与通道；切点识别与后续审片都消费这里保存的媒体。
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS one_click_film_video_jobs (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        shotSetId TEXT NOT NULL,
        shotId TEXT NOT NULL,
        videoJobId TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
        errorMessage TEXT,
        scriptSnapshotJson TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL DEFAULT '',
        providerId TEXT NOT NULL DEFAULT '',
        providerType TEXT NOT NULL DEFAULT '',
        generationMode TEXT NOT NULL DEFAULT 'image-to-video',
        aspectRatio TEXT NOT NULL DEFAULT '',
        durationSec INTEGER NOT NULL DEFAULT 15,
        resolution TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_video_request
        ON one_click_film_video_jobs(runId, requestKey);
      CREATE INDEX IF NOT EXISTS idx_ocf_video_entry
        ON one_click_film_video_jobs(entryId, createdAt);

      CREATE TABLE IF NOT EXISTS one_click_film_scene_cuts (
        id TEXT PRIMARY KEY,
        videoJobId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
        durationUs INTEGER NOT NULL DEFAULT 0,
        fps REAL NOT NULL DEFAULT 24,
        cutsJson TEXT NOT NULL DEFAULT '[]',
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(videoJobId) REFERENCES one_click_film_video_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_cuts_job
        ON one_click_film_scene_cuts(videoJobId);
    `,
  },
  {
    // v3：TTS 配音。音频与「口播文字 + 服务 + 音色 + 语速」绑定；
    // 文字或设置变化即视为旧版本，新稿不得误用旧配音。
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS one_click_film_narrations (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        signature TEXT NOT NULL,
        providerId TEXT NOT NULL,
        voice TEXT NOT NULL,
        speed REAL NOT NULL DEFAULT 1,
        text TEXT NOT NULL,
        relativePath TEXT NOT NULL DEFAULT '',
        durationUs INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'ready', 'failed')),
        listenedAt TEXT,
        confirmedAt TEXT,
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_narration_signature
        ON one_click_film_narrations(entryId, signature);
      CREATE INDEX IF NOT EXISTS idx_ocf_narration_entry
        ON one_click_film_narrations(entryId, createdAt);
    `,
  },
  {
    // v4：A 布局审片。源文件保持完整，这里只记录镜头区间与审片结论。
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS one_click_film_reviews (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        videoJobId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        durationUs INTEGER NOT NULL DEFAULT 0,
        fps REAL NOT NULL DEFAULT 24,
        cutsJson TEXT NOT NULL DEFAULT '[]',
        detection TEXT NOT NULL DEFAULT 'cuts' CHECK(detection IN ('cuts', 'single', 'failed')),
        detectionError TEXT,
        shotsJson TEXT NOT NULL DEFAULT '[]',
        approvedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_review_entry
        ON one_click_film_reviews(runId, entryCode);
    `,
  },
  {
    // v5：局部返工、等长采用与版本恢复。候选按镜头收录；
    // 采用只换选区的等长画面，原声与其他镜头位置不变。
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS one_click_film_candidates (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        reviewJobId TEXT NOT NULL,
        shotId TEXT NOT NULL,
        replaceStartUs INTEGER NOT NULL,
        replaceEndUs INTEGER NOT NULL,
        requestedRangeUs INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL DEFAULT '',
        referencesJson TEXT NOT NULL DEFAULT '[]',
        providerId TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        videoJobId TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'ready', 'failed')),
        trimStartUs INTEGER NOT NULL DEFAULT 0,
        localVideoPath TEXT NOT NULL DEFAULT '',
        durationUs INTEGER NOT NULL DEFAULT 0,
        errorMessage TEXT,
        adoptedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ocf_candidate_shot
        ON one_click_film_candidates(reviewJobId, shotId, createdAt);

      CREATE TABLE IF NOT EXISTS one_click_film_versions (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('original', 'candidate', 'redraw', 'restore')),
        stateJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_version_number
        ON one_click_film_versions(entryId, versionNumber);

      CREATE TABLE IF NOT EXISTS one_click_film_hd_sources (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        sourceVideoJobId TEXT NOT NULL,
        providerId TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        accountRef TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
        hdVideoJobId TEXT,
        localVideoPath TEXT NOT NULL DEFAULT '',
        rangeStartUs INTEGER NOT NULL DEFAULT 0,
        rangeEndUs INTEGER NOT NULL DEFAULT 0,
        estimatedCostMicros INTEGER NOT NULL DEFAULT 0,
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_hd_source
        ON one_click_film_hd_sources(entryId, sourceVideoJobId);
    `,
  },
  {
    // v6：包装、导出与交付。每次交付绑定当时的脚本、剪辑、音轨与包装版本；
    // 重复提交找回同一记录，重新导出形成独立记录。
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS one_click_film_packaging (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
        template TEXT NOT NULL DEFAULT '',
        optionsJson TEXT NOT NULL DEFAULT '{}',
        title TEXT NOT NULL DEFAULT '',
        subtitleCuesJson TEXT NOT NULL DEFAULT '[]',
        pointCuesJson TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        sourceSignature TEXT NOT NULL DEFAULT '',
        relativePath TEXT NOT NULL DEFAULT '',
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_packaging_entry
        ON one_click_film_packaging(entryId);

      CREATE TABLE IF NOT EXISTS one_click_film_exports (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        entryId TEXT NOT NULL,
        entryCode TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        relativePath TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL DEFAULT '',
        checksum TEXT NOT NULL DEFAULT '',
        versionJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        FOREIGN KEY(runId) REFERENCES one_click_film_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(entryId) REFERENCES one_click_film_entries(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ocf_export_request
        ON one_click_film_exports(runId, requestKey);
      CREATE INDEX IF NOT EXISTS idx_ocf_export_run
        ON one_click_film_exports(runId, createdAt);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE one_click_film_entries ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE one_click_film_candidates ADD COLUMN requestKey TEXT;
      CREATE UNIQUE INDEX idx_ocf_candidate_request ON one_click_film_candidates(runId, requestKey)
        WHERE requestKey IS NOT NULL;
      ALTER TABLE one_click_film_reviews ADD COLUMN hdApprovedSignature TEXT;
      UPDATE one_click_film_packaging SET status='pending', relativePath='', sourceSignature='';
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE one_click_film_reviews ADD COLUMN supersededAt TEXT;
      DROP INDEX idx_ocf_review_entry;
      CREATE UNIQUE INDEX idx_ocf_review_entry_current ON one_click_film_reviews(runId,entryCode)
        WHERE supersededAt IS NULL;
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE one_click_film_candidates ADD COLUMN reviewSourceId TEXT;
      ALTER TABLE one_click_film_candidates ADD COLUMN sceneJson TEXT;
      ALTER TABLE one_click_film_packaging ADD COLUMN audioSignature TEXT;
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE one_click_film_merge_history (
        id TEXT PRIMARY KEY,
        reviewJobId TEXT NOT NULL REFERENCES one_click_film_reviews(id) ON DELETE CASCADE,
        sourceKey TEXT NOT NULL,
        startUs INTEGER NOT NULL,
        endUs INTEGER NOT NULL,
        priorShotsJson TEXT NOT NULL
      );
      CREATE INDEX idx_ocf_merge_history_source ON one_click_film_merge_history(reviewJobId, sourceKey);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE one_click_film_entries ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE one_click_film_script_revisions ADD COLUMN title TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE one_click_film_candidates ADD COLUMN framesVerified INTEGER NOT NULL DEFAULT 0;
      UPDATE one_click_film_packaging SET audioSignature=NULL
        WHERE json_valid(optionsJson) AND json_extract(optionsJson,'$.subtitles')=0 AND subtitleCuesJson='[]';
      UPDATE one_click_film_packaging SET status='pending', sourceSignature='', relativePath='', revision=revision+1
        WHERE status='ready';
    `,
  },
];

export type OneClickFilmSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed';

export type OneClickFilmSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: OneClickFilmSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    };

export interface EnsureOneClickFilmSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}

const MIGRATION_TABLE = 'one_click_film_schema_migrations';

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

function validateMigrationHistory(appliedVersions: number[]): OneClickFilmSchemaFailureCode | null {
  const knownVersions = ONE_CLICK_FILM_MIGRATIONS.map(({ version }) => version);
  const knownSet = new Set(knownVersions);
  if (appliedVersions.some((version) => version > (knownVersions.at(-1) ?? 0))) return 'schema_too_new';
  if (appliedVersions.some((version) => !knownSet.has(version))) return 'schema_history_invalid';
  const appliedSet = new Set(appliedVersions);
  const highestApplied = appliedVersions.at(-1) ?? 0;
  if (knownVersions.some((version) => version <= highestApplied && !appliedSet.has(version))) {
    return 'schema_history_invalid';
  }
  return null;
}

function applyMigration(db: Database.Database, migration: OneClickFilmMigration, appliedAt: string): void {
  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      )
    `);
    db.exec(migration.sql);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) throw new Error('一键成片 schema 迁移后的外键检查未通过');
    db.prepare(`INSERT INTO ${MIGRATION_TABLE} (version, appliedAt) VALUES (?, ?)`)
      .run(migration.version, appliedAt);
  });
  apply.immediate();
}

function assertTablesExist(db: Database.Database): void {
  for (const table of [
    'one_click_film_runs',
    'one_click_film_analyses',
    'one_click_film_selling_points',
    'one_click_film_analysis_tasks',
    'one_click_film_entries',
    'one_click_film_script_revisions',
    'one_click_film_video_jobs',
    'one_click_film_scene_cuts',
    'one_click_film_narrations',
    'one_click_film_reviews',
    'one_click_film_merge_history',
    'one_click_film_candidates',
    'one_click_film_versions',
    'one_click_film_hd_sources',
    'one_click_film_packaging',
    'one_click_film_exports',
  ]) {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) {
      throw new Error(`一键成片 schema 缺少表 ${table}`);
    }
  }
}

export async function ensureOneClickFilmSchemaReady(
  options: EnsureOneClickFilmSchemaOptions,
): Promise<OneClickFilmSchemaReadiness> {
  const { db, backupRoot, now = () => new Date(), diskSpaceProbe } = options;
  const targetVersion = ONE_CLICK_FILM_MIGRATIONS.at(-1)?.version ?? 0;
  let appliedVersions: number[];

  try {
    appliedVersions = readAppliedVersions(db);
  } catch {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: '一键成片的升级记录无法读取，旧功能仍可继续使用。',
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
        ? '当前数据库来自更新版本，一键成片功能暂不可用。'
        : '一键成片的升级记录不完整，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const appliedSet = new Set(appliedVersions);
  const pendingMigrations = ONE_CLICK_FILM_MIGRATIONS.filter(({ version }) => !appliedSet.has(version));
  if (pendingMigrations.length === 0) {
    try {
      assertTablesExist(db);
    } catch {
      return {
        state: 'compatibility_only',
        code: 'schema_history_invalid',
        message: '一键成片的数据结构与升级记录不一致，旧功能仍可继续使用。',
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
      scope: 'one-click-film',
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
      message: error instanceof Error ? error.message : '无法完成一键成片数据库安全备份。',
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
      message: '一键成片数据库升级未完成，旧功能仍可继续使用。',
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
