/**
 * 创作画布独立迁移流（技术约定 C2）。
 *
 * 红线：
 * - 画布只用自己的表，绝不写入旧 jobs / video_jobs / projects / shot_sets。
 * - 迁移只能追加；已发布条目不得修改。
 * - 画布迁移必须经过 lib/schema-upgrade/ 的共享备份、锁与审计 gate（见 readiness.ts），
 *   不许塞回会吞掉错误的旧 core runner。
 */

import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
} from '../schema-upgrade/backup.ts';

export interface CanvasMigration {
  version: number;
  sql: string;
}

export const CREATIVE_CANVAS_MIGRATIONS: ReadonlyArray<CanvasMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS creative_canvases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        graphRevision INTEGER NOT NULL DEFAULT 0,
        graphJson TEXT NOT NULL,
        viewportJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creative_canvas_assets (
        id TEXT PRIMARY KEY,
        canvasId TEXT NOT NULL,
        mediaKind TEXT NOT NULL CHECK(mediaKind IN ('image','video','audio')),
        relativePath TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        byteSize INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        durationSec REAL,
        sourceTaskId TEXT,
        ready INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(canvasId) REFERENCES creative_canvases(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cca_canvas ON creative_canvas_assets(canvasId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_cca_hash ON creative_canvas_assets(canvasId, contentHash);

      -- 当前结果与执行状态由服务端维护，独立于自动保存的图 JSON。
      CREATE TABLE IF NOT EXISTS creative_canvas_node_states (
        canvasId TEXT NOT NULL,
        nodeId TEXT NOT NULL,
        nodeEpoch INTEGER NOT NULL DEFAULT 0,
        deletedAt TEXT,
        activeTaskId TEXT,
        currentAssetId TEXT,
        resultTaskId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (canvasId, nodeId),
        FOREIGN KEY(canvasId) REFERENCES creative_canvases(id) ON DELETE CASCADE,
        FOREIGN KEY(currentAssetId) REFERENCES creative_canvas_assets(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ccns_canvas ON creative_canvas_node_states(canvasId);
      CREATE INDEX IF NOT EXISTS idx_ccns_active_task ON creative_canvas_node_states(activeTaskId);

      CREATE TABLE IF NOT EXISTS creative_canvas_runs (
        id TEXT PRIMARY KEY,
        canvasId TEXT NOT NULL,
        requestKey TEXT NOT NULL,
        requestHash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('single','branch')),
        planSnapshot TEXT NOT NULL,
        status TEXT NOT NULL,
        resumeRequired INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(canvasId, requestKey),
        FOREIGN KEY(canvasId) REFERENCES creative_canvases(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ccr_canvas ON creative_canvas_runs(canvasId, createdAt);

      CREATE TABLE IF NOT EXISTS creative_canvas_tasks (
        id TEXT PRIMARY KEY,
        runId TEXT,
        canvasId TEXT NOT NULL,
        nodeId TEXT NOT NULL,
        nodeEpoch INTEGER NOT NULL,
        mediaKind TEXT NOT NULL CHECK(mediaKind IN ('image','video')),
        phase TEXT NOT NULL,
        providerSnapshot TEXT NOT NULL DEFAULT '{}',
        parameterSnapshot TEXT NOT NULL DEFAULT '{}',
        providerTaskId TEXT,
        submissionState TEXT NOT NULL DEFAULT 'not_sent'
          CHECK(submissionState IN ('not_sent','maybe_sent','accepted','terminal')),
        slotHeld INTEGER NOT NULL DEFAULT 0,
        quotaKey TEXT,
        leaseOwner TEXT,
        leaseUntil TEXT,
        fence INTEGER NOT NULL DEFAULT 0,
        cancelRequestedAt TEXT,
        outputAssetId TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        lastPolledAt TEXT,
        pollCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(canvasId) REFERENCES creative_canvases(id) ON DELETE CASCADE,
        FOREIGN KEY(runId) REFERENCES creative_canvas_runs(id) ON DELETE SET NULL,
        FOREIGN KEY(outputAssetId) REFERENCES creative_canvas_assets(id)
      );
      -- 同一节点至多一个未结束任务；数据库约束兜底，不只靠应用层检查。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cct_node_active
        ON creative_canvas_tasks(canvasId, nodeId)
        WHERE phase NOT IN ('succeeded','failed','blocked','cancelled');
      -- 同一次任务只关联一个正式输出。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cct_output
        ON creative_canvas_tasks(outputAssetId)
        WHERE outputAssetId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cct_phase ON creative_canvas_tasks(phase, createdAt);
      CREATE INDEX IF NOT EXISTS idx_cct_canvas ON creative_canvas_tasks(canvasId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_cct_run ON creative_canvas_tasks(runId);

      CREATE TABLE IF NOT EXISTS creative_canvas_task_inputs (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        refId TEXT NOT NULL,
        orderIndex INTEGER NOT NULL,
        role TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        sourceNodeId TEXT,
        assetId TEXT,
        upstreamTaskId TEXT,
        textContent TEXT,
        resolvedAssetId TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(taskId, refId),
        FOREIGN KEY(taskId) REFERENCES creative_canvas_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES creative_canvas_assets(id),
        FOREIGN KEY(upstreamTaskId) REFERENCES creative_canvas_tasks(id),
        FOREIGN KEY(resolvedAssetId) REFERENCES creative_canvas_assets(id),
        -- 输入必须恰好是「已有素材」「等待上游任务」「固定文本」之一。
        CHECK(assetId IS NOT NULL OR upstreamTaskId IS NOT NULL OR textContent IS NOT NULL),
        CHECK(NOT (assetId IS NOT NULL AND upstreamTaskId IS NOT NULL)),
        CHECK(NOT (assetId IS NOT NULL AND textContent IS NOT NULL)),
        CHECK(NOT (upstreamTaskId IS NOT NULL AND textContent IS NOT NULL)),
        -- 只有等待上游的输入才可能有解析结果。
        CHECK(resolvedAssetId IS NULL OR upstreamTaskId IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_ccti_task ON creative_canvas_task_inputs(taskId, orderIndex);
      CREATE INDEX IF NOT EXISTS idx_ccti_upstream ON creative_canvas_task_inputs(upstreamTaskId);

      CREATE TABLE IF NOT EXISTS creative_canvas_exports (
        id TEXT PRIMARY KEY,
        canvasId TEXT NOT NULL,
        manifestJson TEXT NOT NULL,
        status TEXT NOT NULL,
        zipRelativePath TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(canvasId) REFERENCES creative_canvases(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cce_canvas ON creative_canvas_exports(canvasId, createdAt);

      -- 粘贴幂等：同一画布同一粘贴操作重试返回同一结果。
      CREATE TABLE IF NOT EXISTS creative_canvas_copy_operations (
        id TEXT PRIMARY KEY,
        canvasId TEXT NOT NULL,
        snapshotKey TEXT NOT NULL,
        resultJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(canvasId, snapshotKey),
        FOREIGN KEY(canvasId) REFERENCES creative_canvases(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- 并发多变体（LibTV 式一次生成 N 个候选）：
      -- 1) 放开「同一节点至多一个未结束任务」。发布门禁由 node_states.nodeEpoch
      --    独自承担（见 repository.publishCanvasNodeResult）；currentAssetId 语义变为
      --    「最后完成者胜」。若未来需要恢复单任务约束，必须先清理多出的活跃任务
      --    再重建该唯一索引（加法迁移不可逆的部分仅此一处）。
      DROP INDEX IF EXISTS idx_cct_node_active;

      -- 2) 变体编号：同一次 run 内从 0 递增；branch 与历史任务恒为 0。
      ALTER TABLE creative_canvas_tasks ADD COLUMN variantIndex INTEGER NOT NULL DEFAULT 0;

      -- 3) 候选投影：按节点列出成功任务（repository.listCanvasNodeCandidates 消费）。
      CREATE INDEX IF NOT EXISTS idx_cct_node_results
        ON creative_canvas_tasks(canvasId, nodeId, phase, createdAt);
    `,
  },
  {
    version: 3,
    sql: `CREATE TABLE creative_canvas_rate_limits (bucket TEXT PRIMARY KEY, nextAt INTEGER NOT NULL);
      ALTER TABLE creative_canvas_assets ADD COLUMN videoCodec TEXT;
      ALTER TABLE creative_canvas_assets ADD COLUMN pixelFormat TEXT;
      CREATE TABLE creative_canvas_video_metadata (
      taskId TEXT PRIMARY KEY REFERENCES creative_canvas_tasks(id) ON DELETE CASCADE,
      metadataJson TEXT NOT NULL
    );`,
  },
  {
    version: 4,
    sql: `CREATE TABLE creative_canvas_logs (
      id TEXT PRIMARY KEY,
      canvasId TEXT NOT NULL REFERENCES creative_canvases(id) ON DELETE CASCADE,
      jobId TEXT REFERENCES creative_canvas_tasks(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX idx_ccl_canvas ON creative_canvas_logs(canvasId, createdAt);
    CREATE INDEX idx_ccl_task ON creative_canvas_logs(jobId, createdAt);`,
  },
];

export type CanvasSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed';

export type CanvasSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: CanvasSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    };

export interface EnsureCanvasSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}

const MIGRATION_TABLE = 'creative_canvas_schema_migrations';

const CANVAS_TABLES = [
  'creative_canvas_logs',
  'creative_canvases',
  'creative_canvas_assets',
  'creative_canvas_node_states',
  'creative_canvas_runs',
  'creative_canvas_tasks',
  'creative_canvas_task_inputs',
  'creative_canvas_exports',
  'creative_canvas_copy_operations',
];

function migrationTableExists(db: Database.Database): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(MIGRATION_TABLE));
}

export function readCanvasAppliedVersions(db: Database.Database): number[] {
  if (!migrationTableExists(db)) return [];
  return (db.prepare(
    `SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`,
  ).all() as Array<{ version: number }>).map(({ version }) => version);
}

function validateMigrationHistory(appliedVersions: number[]): CanvasSchemaFailureCode | null {
  const knownVersions = CREATIVE_CANVAS_MIGRATIONS.map(({ version }) => version);
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

function applyMigration(db: Database.Database, migration: CanvasMigration, appliedAt: string): void {
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
      throw new Error('creative-canvas schema 迁移后的外键检查未通过');
    }
    db.prepare(
      `INSERT INTO ${MIGRATION_TABLE} (version, appliedAt) VALUES (?, ?)`,
    ).run(migration.version, appliedAt);
  });
  apply.immediate();
}

function assertTablesExist(db: Database.Database): void {
  for (const table of CANVAS_TABLES) {
    const row = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table);
    if (!row) throw new Error(`creative-canvas schema 缺少表 ${table}`);
  }
}

/** 是否已经存在画布表；用于「开关关闭时不得产生画布副作用」的检查与测试。 */
export function canvasTablesPresent(db: Database.Database): boolean {
  return CANVAS_TABLES.some((table) => Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table)));
}

export async function ensureCreativeCanvasSchemaReady(
  options: EnsureCanvasSchemaOptions,
): Promise<CanvasSchemaReadiness> {
  const { db, backupRoot, now = () => new Date(), diskSpaceProbe } = options;
  const targetVersion = CREATIVE_CANVAS_MIGRATIONS.at(-1)?.version ?? 0;
  let appliedVersions: number[];

  try {
    appliedVersions = readCanvasAppliedVersions(db);
  } catch {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: 'creative-canvas 的升级记录无法读取，旧功能仍可继续使用。',
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
        ? '当前数据库来自更新版本，创作画布功能暂不可用。'
        : 'creative-canvas 的升级记录不完整，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const appliedSet = new Set(appliedVersions);
  // 已有升级记录但核心表缺失：结构不一致，不做迁移尝试（避免对残缺库执行 DDL）
  if (appliedVersions.length > 0 && !canvasTablesPresent(db)) {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: 'creative-canvas 的数据结构与升级记录不一致，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }
  const pendingMigrations = CREATIVE_CANVAS_MIGRATIONS.filter(({ version }) => !appliedSet.has(version));
  if (pendingMigrations.length === 0) {
    try {
      assertTablesExist(db);
    } catch {
      return {
        state: 'compatibility_only',
        code: 'schema_history_invalid',
        message: 'creative-canvas 的数据结构与升级记录不一致，旧功能仍可继续使用。',
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
      scope: 'creative-canvas',
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
      message: error instanceof Error ? error.message : '无法完成 creative-canvas 数据库安全备份。',
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
      message: 'creative-canvas 数据库升级未完成，旧功能仍可继续使用。',
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
