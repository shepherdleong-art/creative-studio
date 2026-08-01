import type Database from 'better-sqlite3';
import {
  BatchSchemaBackupError,
  createValidatedBatchSchemaBackup,
  type BatchSchemaBackupManifest,
  type BatchSchemaDiskSpaceProbe,
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
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_assets (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('linked', 'managed')),
        locationJson TEXT NOT NULL,
        contentFingerprint TEXT NOT NULL,
        mediaKind TEXT NOT NULL CHECK(mediaKind IN ('video', 'image')),
        mediaJson TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'archived')),
        currentAnalysisId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(projectId, contentFingerprint),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_assets_identity
        ON batch_assets(projectId, contentFingerprint);
      CREATE INDEX IF NOT EXISTS idx_batch_assets_project
        ON batch_assets(projectId, updatedAt);

      CREATE TABLE IF NOT EXISTS batch_asset_analysis (
        id TEXT PRIMARY KEY,
        assetId TEXT NOT NULL,
        analyzerVersion TEXT NOT NULL,
        providerId TEXT NOT NULL,
        model TEXT NOT NULL,
        analysisJson TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
        errorCode TEXT,
        errorMessage TEXT,
        analyzedAt TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_analysis_asset
        ON batch_asset_analysis(assetId, createdAt);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE batch_productions ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
      ALTER TABLE batch_productions ADD COLUMN currentVersionId TEXT;
      ALTER TABLE batch_productions ADD COLUMN progressJson TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS batch_production_versions (
        id TEXT PRIMARY KEY,
        batchId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        copyCount INTEGER NOT NULL,
        defaultsJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        UNIQUE(batchId, versionNumber),
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_production_versions_batch
        ON batch_production_versions(batchId, versionNumber);

      CREATE TABLE IF NOT EXISTS batch_asset_pool_items (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        analysisId TEXT NOT NULL,
        selectionState TEXT NOT NULL DEFAULT 'selected',
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, assetId),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE RESTRICT,
        FOREIGN KEY(analysisId) REFERENCES batch_asset_analysis(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_pool_items_version
        ON batch_asset_pool_items(batchVersionId, assetId);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_scripts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('script_draft', 'external')),
        sourceId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyText TEXT NOT NULL,
        sourceVersion TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(projectId, sourceId),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS batch_script_snapshots (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        sourceScriptId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyText TEXT NOT NULL,
        sourceVersion TEXT NOT NULL,
        copyCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, sourceScriptId),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(sourceScriptId) REFERENCES batch_scripts(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_script_snapshots_version
        ON batch_script_snapshots(batchVersionId, sourceScriptId);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_output_plans (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        scriptSnapshotId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        planJson TEXT NOT NULL DEFAULT '{}',
        currentVersionId TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, seq),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(scriptSnapshotId) REFERENCES batch_script_snapshots(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_output_plans_version
        ON batch_output_plans(batchVersionId, seq);

      CREATE TABLE IF NOT EXISTS batch_output_versions (
        id TEXT PRIMARY KEY,
        planId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        arrangementJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        UNIQUE(planId, versionNumber),
        FOREIGN KEY(planId) REFERENCES batch_output_plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_output_versions_plan
        ON batch_output_versions(planId, versionNumber);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_tasks (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        workType TEXT NOT NULL CHECK(workType IN ('asset_prepare', 'render')),
        targetKind TEXT NOT NULL,
        targetId TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        progressJson TEXT NOT NULL DEFAULT '{}',
        attemptCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch
        ON batch_tasks(batchId, status, createdAt);

      CREATE TABLE IF NOT EXISTS batch_task_attempts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        attemptNumber INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
        progressJson TEXT NOT NULL DEFAULT '{}',
        resultJson TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(taskId, attemptNumber),
        FOREIGN KEY(taskId) REFERENCES batch_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_task_attempts_task
        ON batch_task_attempts(taskId, attemptNumber);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_artifacts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        batchVersionId TEXT NOT NULL,
        outputPlanId TEXT NOT NULL,
        outputVersionId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('video', 'cover')),
        relativePath TEXT NOT NULL,
        checksum TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(outputPlanId, outputVersionId, kind),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(outputPlanId) REFERENCES batch_output_plans(id) ON DELETE CASCADE,
        FOREIGN KEY(outputVersionId) REFERENCES batch_output_versions(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_artifacts_plan
        ON batch_artifacts(outputPlanId, createdAt);

      ALTER TABLE batch_output_plans ADD COLUMN currentArtifactId TEXT;
    `,
  },
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
      backupManifest?: BatchSchemaBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: BatchSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: BatchSchemaBackupManifest;
    };

export interface EnsureBatchSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: BatchSchemaDiskSpaceProbe;
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

function validateBatchProductionTable(db: Database.Database): void {
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
}

function validateAssetsTables(db: Database.Database): void {
  const assetColumns = db.prepare(`PRAGMA table_info(batch_assets)`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const assetByName = new Map(assetColumns.map((column) => [column.name, column]));
  if (
    assetByName.get('id')?.pk !== 1
    || assetByName.get('projectId')?.notnull !== 1
    || assetByName.get('sourceKind')?.notnull !== 1
    || assetByName.get('locationJson')?.notnull !== 1
    || assetByName.get('contentFingerprint')?.notnull !== 1
    || assetByName.get('mediaKind')?.notnull !== 1
    || assetByName.get('status')?.notnull !== 1
    || assetByName.get('createdAt')?.notnull !== 1
    || assetByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('素材表结构检查未通过');
  }

  const assetForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_assets)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!assetForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材表项目外键检查未通过');
  }

  const assetIndexes = db.prepare(`PRAGMA index_list(batch_assets)`).all() as Array<{ name: string; unique: number }>;
  if (!assetIndexes.some(({ name, unique }) => name === 'idx_batch_assets_identity' && unique === 1)) {
    throw new Error('素材身份唯一索引检查未通过');
  }
  if (!assetIndexes.some(({ name }) => name === 'idx_batch_assets_project')) {
    throw new Error('素材项目索引检查未通过');
  }

  const analysisColumns = db.prepare(`PRAGMA table_info(batch_asset_analysis)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const analysisByName = new Map(analysisColumns.map((column) => [column.name, column]));
  if (
    analysisByName.get('id')?.pk !== 1
    || analysisByName.get('assetId')?.notnull !== 1
    || analysisByName.get('analyzerVersion')?.notnull !== 1
    || analysisByName.get('providerId')?.notnull !== 1
    || analysisByName.get('model')?.notnull !== 1
    || analysisByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('素材分析表结构检查未通过');
  }

  const analysisForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_analysis)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!analysisForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets'
    && foreignKey.from === 'assetId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材分析表素材外键检查未通过');
  }

  const analysisIndexes = db.prepare(`PRAGMA index_list(batch_asset_analysis)`).all() as Array<{ name: string }>;
  if (!analysisIndexes.some(({ name }) => name === 'idx_batch_asset_analysis_asset')) {
    throw new Error('素材分析索引检查未通过');
  }
}

function validateProductionVersionTables(db: Database.Database): void {
  const productionColumns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const productionByName = new Map(productionColumns.map((column) => [column.name, column]));
  if (
    productionByName.get('status')?.notnull !== 1
    || productionByName.get('progressJson')?.notnull !== 1
  ) {
    throw new Error('批次表扩展列检查未通过');
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const versionByName = new Map(versionColumns.map((column) => [column.name, column]));
  if (
    versionByName.get('id')?.pk !== 1
    || versionByName.get('batchId')?.notnull !== 1
    || versionByName.get('versionNumber')?.notnull !== 1
    || versionByName.get('copyCount')?.notnull !== 1
    || versionByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('批次版本表结构检查未通过');
  }

  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_production_versions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!versionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_productions'
    && foreignKey.from === 'batchId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('批次版本表批次外键检查未通过');
  }

  const versionIndexes = db.prepare(`PRAGMA index_list(batch_production_versions)`).all() as Array<{ name: string }>;
  if (!versionIndexes.some(({ name }) => name === 'idx_batch_production_versions_batch')) {
    throw new Error('批次版本索引检查未通过');
  }

  const poolColumns = db.prepare(`PRAGMA table_info(batch_asset_pool_items)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const poolByName = new Map(poolColumns.map((column) => [column.name, column]));
  if (
    poolByName.get('id')?.pk !== 1
    || poolByName.get('batchVersionId')?.notnull !== 1
    || poolByName.get('assetId')?.notnull !== 1
    || poolByName.get('analysisId')?.notnull !== 1
    || poolByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('素材池表结构检查未通过');
  }

  const poolForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_pool_items)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!poolForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材池表版本外键检查未通过');
  }
  if (!poolForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets'
    && foreignKey.from === 'assetId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('素材池表必须限制被引用素材删除');
  }

  const poolIndexes = db.prepare(`PRAGMA index_list(batch_asset_pool_items)`).all() as Array<{ name: string }>;
  if (!poolIndexes.some(({ name }) => name === 'idx_batch_asset_pool_items_version')) {
    throw new Error('素材池索引检查未通过');
  }
}

function validateScriptTables(db: Database.Database): void {
  const scriptColumns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const scriptByName = new Map(scriptColumns.map((column) => [column.name, column]));
  if (
    scriptByName.get('id')?.pk !== 1
    || scriptByName.get('projectId')?.notnull !== 1
    || scriptByName.get('sourceId')?.notnull !== 1
    || scriptByName.get('title')?.notnull !== 1
    || scriptByName.get('bodyText')?.notnull !== 1
    || scriptByName.get('sourceVersion')?.notnull !== 1
    || scriptByName.get('createdAt')?.notnull !== 1
    || scriptByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('项目脚本表结构检查未通过');
  }

  const scriptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_scripts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!scriptForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('项目脚本表项目外键检查未通过');
  }

  const snapshotColumns = db.prepare(`PRAGMA table_info(batch_script_snapshots)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const snapshotByName = new Map(snapshotColumns.map((column) => [column.name, column]));
  if (
    snapshotByName.get('id')?.pk !== 1
    || snapshotByName.get('batchVersionId')?.notnull !== 1
    || snapshotByName.get('sourceScriptId')?.notnull !== 1
    || snapshotByName.get('title')?.notnull !== 1
    || snapshotByName.get('bodyText')?.notnull !== 1
    || snapshotByName.get('copyCount')?.notnull !== 1
    || snapshotByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('脚本快照表结构检查未通过');
  }

  const snapshotForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_script_snapshots)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!snapshotForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('脚本快照表批次版本外键检查未通过');
  }
  if (!snapshotForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_scripts'
    && foreignKey.from === 'sourceScriptId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('脚本快照表必须限制来源脚本删除');
  }

  const snapshotIndexes = db.prepare(`PRAGMA index_list(batch_script_snapshots)`).all() as Array<{ name: string }>;
  if (!snapshotIndexes.some(({ name }) => name === 'idx_batch_script_snapshots_version')) {
    throw new Error('脚本快照索引检查未通过');
  }
}

function validatePlanTables(db: Database.Database): void {
  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const planByName = new Map(planColumns.map((column) => [column.name, column]));
  if (
    planByName.get('id')?.pk !== 1
    || planByName.get('batchVersionId')?.notnull !== 1
    || planByName.get('scriptSnapshotId')?.notnull !== 1
    || planByName.get('seq')?.notnull !== 1
    || planByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('成片计划表结构检查未通过');
  }

  const planForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_plans)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!planForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('成片计划表批次版本外键检查未通过');
  }
  if (!planForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_script_snapshots'
    && foreignKey.from === 'scriptSnapshotId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('成片计划表脚本快照外键检查未通过');
  }

  const planIndexes = db.prepare(`PRAGMA index_list(batch_output_plans)`).all() as Array<{ name: string }>;
  if (!planIndexes.some(({ name }) => name === 'idx_batch_output_plans_version')) {
    throw new Error('成片计划索引检查未通过');
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_output_versions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const versionByName = new Map(versionColumns.map((column) => [column.name, column]));
  if (
    versionByName.get('id')?.pk !== 1
    || versionByName.get('planId')?.notnull !== 1
    || versionByName.get('versionNumber')?.notnull !== 1
    || versionByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('成片版本表结构检查未通过');
  }

  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_versions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!versionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_output_plans'
    && foreignKey.from === 'planId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('成片版本表计划外键检查未通过');
  }

  const versionIndexes = db.prepare(`PRAGMA index_list(batch_output_versions)`).all() as Array<{ name: string }>;
  if (!versionIndexes.some(({ name }) => name === 'idx_batch_output_versions_plan')) {
    throw new Error('成片版本索引检查未通过');
  }
}

function validateTaskTables(db: Database.Database): void {
  const taskColumns = db.prepare(`PRAGMA table_info(batch_tasks)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const taskByName = new Map(taskColumns.map((column) => [column.name, column]));
  if (
    taskByName.get('id')?.pk !== 1
    || taskByName.get('projectId')?.notnull !== 1
    || taskByName.get('batchId')?.notnull !== 1
    || taskByName.get('workType')?.notnull !== 1
    || taskByName.get('targetKind')?.notnull !== 1
    || taskByName.get('targetId')?.notnull !== 1
    || taskByName.get('status')?.notnull !== 1
    || taskByName.get('createdAt')?.notnull !== 1
    || taskByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('生产任务表结构检查未通过');
  }

  const taskForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_tasks)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!taskForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_productions'
    && foreignKey.from === 'batchId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('生产任务表批次外键检查未通过');
  }

  const taskIndexes = db.prepare(`PRAGMA index_list(batch_tasks)`).all() as Array<{ name: string }>;
  if (!taskIndexes.some(({ name }) => name === 'idx_batch_tasks_batch')) {
    throw new Error('生产任务索引检查未通过');
  }

  const attemptColumns = db.prepare(`PRAGMA table_info(batch_task_attempts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const attemptByName = new Map(attemptColumns.map((column) => [column.name, column]));
  if (
    attemptByName.get('id')?.pk !== 1
    || attemptByName.get('taskId')?.notnull !== 1
    || attemptByName.get('attemptNumber')?.notnull !== 1
    || attemptByName.get('status')?.notnull !== 1
    || attemptByName.get('startedAt')?.notnull !== 1
    || attemptByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('任务尝试表结构检查未通过');
  }

  const attemptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_task_attempts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!attemptForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_tasks'
    && foreignKey.from === 'taskId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('任务尝试表任务外键检查未通过');
  }

  const attemptIndexes = db.prepare(`PRAGMA index_list(batch_task_attempts)`).all() as Array<{ name: string }>;
  if (!attemptIndexes.some(({ name }) => name === 'idx_batch_task_attempts_task')) {
    throw new Error('任务尝试索引检查未通过');
  }
}

function validateArtifactTables(db: Database.Database): void {
  const artifactColumns = db.prepare(`PRAGMA table_info(batch_artifacts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const artifactByName = new Map(artifactColumns.map((column) => [column.name, column]));
  if (
    artifactByName.get('id')?.pk !== 1
    || artifactByName.get('projectId')?.notnull !== 1
    || artifactByName.get('batchId')?.notnull !== 1
    || artifactByName.get('batchVersionId')?.notnull !== 1
    || artifactByName.get('outputPlanId')?.notnull !== 1
    || artifactByName.get('outputVersionId')?.notnull !== 1
    || artifactByName.get('kind')?.notnull !== 1
    || artifactByName.get('relativePath')?.notnull !== 1
    || artifactByName.get('checksum')?.notnull !== 1
    || artifactByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('正式产物表结构检查未通过');
  }

  const artifactForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_artifacts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!artifactForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_output_versions'
    && foreignKey.from === 'outputVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('正式产物表必须限制成片版本删除');
  }

  const artifactIndexes = db.prepare(`PRAGMA index_list(batch_artifacts)`).all() as Array<{ name: string }>;
  if (!artifactIndexes.some(({ name }) => name === 'idx_batch_artifacts_plan')) {
    throw new Error('正式产物索引检查未通过');
  }

  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{ name: string }>;
  if (!planColumns.some(({ name }) => name === 'currentArtifactId')) {
    throw new Error('成片计划当前成片指向列检查未通过');
  }
}

const SCHEMA_VALIDATORS: ReadonlyArray<(db: Database.Database) => void> = [
  validateBatchProductionTable,
  validateAssetsTables,
  validateProductionVersionTables,
  validateScriptTables,
  validatePlanTables,
  validateTaskTables,
  validateArtifactTables,
];

function validateBatchSchema(db: Database.Database): void {
  for (const validate of SCHEMA_VALIDATORS) {
    validate(db);
  }
  assertIntegrity(db);
}

function validateBatchSchemaUpTo(db: Database.Database, version: number): void {
  for (let index = 0; index < version && index < SCHEMA_VALIDATORS.length; index += 1) {
    SCHEMA_VALIDATORS[index]?.(db);
  }
  assertIntegrity(db);
}

function assertIntegrity(db: Database.Database): void {
  const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new Error('批量 schema 迁移后的完整性检查未通过');
  }
}

function applyMigration(db: Database.Database, migration: BatchSchemaMigration, appliedAt: string): void {
  const apply = db.transaction(() => {
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
    validateBatchSchemaUpTo(db, migration.version);
  });
  apply.immediate();
}

export async function ensureBatchSchemaReady(
  options: EnsureBatchSchemaOptions,
): Promise<BatchSchemaReadiness> {
  const {
    db,
    backupRoot,
    now = () => new Date(),
    diskSpaceProbe,
  } = options;
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
  let backupManifest: BatchSchemaBackupManifest | undefined;
  try {
    const backup = await createValidatedBatchSchemaBackup({
      db,
      backupRoot,
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
      code: error instanceof BatchSchemaBackupError ? error.code : 'backup_failed',
      message: error instanceof BatchSchemaBackupError && error.code === 'backup_validation_failed'
        ? '数据库备份未通过完整性检查，尚未执行批量升级。'
        : error instanceof BatchSchemaBackupError && error.code === 'insufficient_disk_space'
          ? '项目盘空间不足，尚未执行批量升级。'
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
