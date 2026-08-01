import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BATCH_SCHEMA_MIGRATIONS, ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';

/**
 * 逐版本故障注入:v2–v9 各自中途失败时,单条迁移事务必须整体回滚,
 * 不记录版本、不改动已存在数据、不应用后续版本,并进入兼容模式。
 */
const latestVersion = BATCH_SCHEMA_MIGRATIONS.at(-1)?.version;
assert.ok(latestVersion && latestVersion >= 9, '本测试要求 schema 至少到 v9');

/** 每个版本引入的一张表;预建其残缺结构使该版本的结构校验失败 */
const FIRST_TABLE_BY_VERSION: Record<number, string> = {
  2: 'batch_assets',
  3: 'batch_production_versions',
  4: 'batch_scripts',
  5: 'batch_output_plans',
  6: 'batch_tasks',
  7: 'batch_artifacts',
};

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE legacy_marker (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '旧项目');
    INSERT INTO legacy_marker (id, value) VALUES ('marker-1', '必须保留');
  `);
  return db;
}

/** 手工应用 v1..upTo(不含失败版本),模拟"已发布到 N-1"的数据库 */
function applyMigrationsUpTo(db: Database.Database, upToExclusive: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    )
  `);
  for (const migration of BATCH_SCHEMA_MIGRATIONS) {
    if (migration.version >= upToExclusive) break;
    db.exec(migration.sql);
    db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`)
      .run(migration.version, '2026-08-02T00:00:00.000Z');
  }
}

function listPublishedBackups(backupRoot: string): string[] {
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot).filter((name) => !name.startsWith('.'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-rollback-'));

try {
  const failures = FIRST_TABLE_BY_VERSION;
  for (const [versionText, tableName] of Object.entries(failures)) {
    const version = Number(versionText);
    const caseRoot = path.join(root, `fail-v${version}`);
    fs.mkdirSync(caseRoot, { recursive: true });
    const db = createLegacyDatabase(caseRoot, 'workbench.db');
    applyMigrationsUpTo(db, version);
    // 预建该版本引入的第一张表的残缺结构:IF NOT EXISTS 会跳过建表,结构校验失败
    db.exec(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`);

    const backupRoot = path.join(caseRoot, 'backups');
    const result = await ensureBatchSchemaReady({
      db,
      backupRoot,
      now: () => new Date(`2026-08-02T0${version}:00:00.000Z`),
    });
    assert.equal(result.state, 'compatibility_only', `v${version} 失败后必须进入兼容模式`);
    if (result.state === 'compatibility_only') {
      assert.equal(result.code, 'migration_failed', `v${version} 失败原因必须是 migration_failed`);
    }

    // 版本 N 未记录,后续版本未应用
    const recorded = db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all() as Array<{ version: number }>;
    assert.deepEqual(recorded.map(({ version: v }) => v), BATCH_SCHEMA_MIGRATIONS.map((m) => m.version).filter((v) => v < version), `v${version} 失败时版本表必须回滚到 ${version - 1}`);

    // 残缺表未被半修复(结构保持原样)
    assert.deepEqual(
      (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((c) => c.name),
      ['id'],
      `v${version} 失败不得半修改冲突表`,
    );

    // v3 的 ALTER 扩展列已回滚
    if (version === 3) {
      const cols = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{ name: string }>;
      assert.ok(!cols.some(({ name }) => name === 'status'), 'v3 失败时批次表扩展列必须回滚');
    }
    if (version === 7) {
      const cols = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{ name: string }>;
      assert.ok(!cols.some(({ name }) => name === 'currentArtifactId'), 'v7 失败时当前成片指向列必须回滚');
    }

    // 后续版本的表未出现
    const laterTable = FIRST_TABLE_BY_VERSION[version + 1];
    if (laterTable) {
      const found = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(laterTable);
      assert.equal(found, undefined, `v${version} 失败后后续版本的表 ${laterTable} 不得存在`);
    }

    // 旧数据原样保留
    assert.deepEqual(
      db.prepare(`SELECT value FROM legacy_marker WHERE id = 'marker-1'`).get(),
      { value: '必须保留' },
    );

    // 失败迁移发布了且仅发布一份备份
    assert.equal(listPublishedBackups(backupRoot).length, 1, `v${version} 失败只应发布一份备份`);

    // 再次调用仍是兼容模式,版本表不被推进,旧数据不受影响
    const again = await ensureBatchSchemaReady({ db, backupRoot });
    assert.equal(again.state, 'compatibility_only');
    if (again.state === 'compatibility_only') {
      assert.equal(again.code, 'migration_failed');
    }
    const recordedAfterRetry = db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all() as Array<{ version: number }>;
    assert.deepEqual(
      recordedAfterRetry.map(({ version: v }) => v),
      BATCH_SCHEMA_MIGRATIONS.map((m) => m.version).filter((v) => v < version),
      '重试不得推进版本表',
    );

    db.close();
  }

  // v7 在 CREATE TABLE/INDEX 之后的 ALTER 失败：本版本新建的产物表也必须回滚。
  {
    const caseRoot = path.join(root, 'fail-v7-after-create');
    fs.mkdirSync(caseRoot, { recursive: true });
    const db = createLegacyDatabase(caseRoot, 'workbench.db');
    applyMigrationsUpTo(db, 7);
    db.exec(`ALTER TABLE batch_output_plans ADD COLUMN currentArtifactId TEXT`);

    const result = await ensureBatchSchemaReady({
      db,
      backupRoot: path.join(caseRoot, 'backups'),
      now: () => new Date('2026-08-02T07:30:00.000Z'),
    });
    assert.equal(result.state, 'compatibility_only');
    if (result.state === 'compatibility_only') assert.equal(result.code, 'migration_failed');
    assert.equal(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'batch_artifacts'`).get(),
      undefined,
      'v7 尾部 ALTER 失败时，前面新建的正式产物表必须一起回滚',
    );
    assert.deepEqual(
      (db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all() as Array<{ version: number }>)
        .map(({ version }) => version),
      [1, 2, 3, 4, 5, 6],
    );
    db.close();
  }

  // v8 复制旧数据时撞上新路径唯一约束：旧表、旧数据与版本记录必须原样保留。
  {
    const caseRoot = path.join(root, 'fail-v8-during-copy');
    fs.mkdirSync(caseRoot, { recursive: true });
    const db = createLegacyDatabase(caseRoot, 'workbench.db');
    applyMigrationsUpTo(db, 8);
    db.exec(`
      INSERT INTO batch_productions
        (id, projectId, name, createdAt, updatedAt, status, currentVersionId, progressJson)
      VALUES ('batch-1', 'project-1', '批次', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'draft', 'batch-version-1', '{}');
      INSERT INTO batch_production_versions
        (id, batchId, versionNumber, copyCount, defaultsJson, createdAt)
      VALUES ('batch-version-1', 'batch-1', 1, 1, '{}', '2026-08-02T00:00:00.000Z');
      INSERT INTO batch_scripts
        (id, projectId, sourceKind, sourceId, title, bodyText, sourceVersion, createdAt, updatedAt)
      VALUES ('script-1', 'project-1', 'script_draft', 'draft-1', '标题', '正文', 'v1', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
      INSERT INTO batch_script_snapshots
        (id, batchVersionId, sourceScriptId, title, bodyText, sourceVersion, copyCount, createdAt)
      VALUES ('snapshot-1', 'batch-version-1', 'script-1', '标题', '正文', 'v1', 1, '2026-08-02T00:00:00.000Z');
      INSERT INTO batch_output_plans
        (id, batchVersionId, scriptSnapshotId, seq, planJson, currentVersionId, createdAt, currentArtifactId)
      VALUES ('plan-1', 'batch-version-1', 'snapshot-1', 1, '{}', 'output-version-2', '2026-08-02T00:00:00.000Z', NULL);
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES
        ('output-version-1', 'plan-1', 1, '{}', '2026-08-02T00:00:00.000Z'),
        ('output-version-2', 'plan-1', 2, '{}', '2026-08-02T00:01:00.000Z');
      INSERT INTO batch_artifacts
        (id, projectId, batchId, batchVersionId, outputPlanId, outputVersionId, kind, relativePath, checksum, createdAt)
      VALUES
        ('artifact-1', 'project-1', 'batch-1', 'batch-version-1', 'plan-1', 'output-version-1', 'video', 'same.mp4', 'sha256:one', '2026-08-02T00:02:00.000Z'),
        ('artifact-2', 'project-1', 'batch-1', 'batch-version-1', 'plan-1', 'output-version-2', 'video', 'same.mp4', 'sha256:two', '2026-08-02T00:03:00.000Z');
    `);

    const result = await ensureBatchSchemaReady({
      db,
      backupRoot: path.join(caseRoot, 'backups'),
      now: () => new Date('2026-08-02T08:00:00.000Z'),
    });
    assert.equal(result.state, 'compatibility_only');
    if (result.state === 'compatibility_only') assert.equal(result.code, 'migration_failed');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts`).get() as { n: number }).n, 2);
    assert.equal(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'batch_artifacts_new'`).get(),
      undefined,
      'v8 复制失败不得留下临时新表',
    );
    assert.deepEqual(
      (db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all() as Array<{ version: number }>)
        .map(({ version }) => version),
      [1, 2, 3, 4, 5, 6, 7],
    );
    db.close();
  }

  // v9 在多个 ALTER 已执行后失败：此前新增的生命周期列必须全部回滚。
  {
    const caseRoot = path.join(root, 'fail-v9-after-alters');
    fs.mkdirSync(caseRoot, { recursive: true });
    const db = createLegacyDatabase(caseRoot, 'workbench.db');
    applyMigrationsUpTo(db, 9);
    db.exec(`ALTER TABLE batch_scripts ADD COLUMN externalSourceId TEXT`);

    const result = await ensureBatchSchemaReady({
      db,
      backupRoot: path.join(caseRoot, 'backups'),
      now: () => new Date('2026-08-02T09:00:00.000Z'),
    });
    assert.equal(result.state, 'compatibility_only');
    if (result.state === 'compatibility_only') assert.equal(result.code, 'migration_failed');
    const productionColumns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{ name: string }>;
    assert.ok(!productionColumns.some(({ name }) => name === 'deletedAt'));
    const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{ name: string }>;
    assert.ok(!versionColumns.some(({ name }) => name === 'inputState'));
    assert.ok(!versionColumns.some(({ name }) => name === 'frozenAt'));
    const scriptColumns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{ name: string }>;
    assert.ok(!scriptColumns.some(({ name }) => name === 'ownerBatchVersionId'));
    assert.ok(scriptColumns.some(({ name }) => name === 'externalSourceId'), '故障注入前已有列必须保留');
    assert.equal(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_batch_scripts_owner_version'`).get(),
      undefined,
    );
    assert.deepEqual(
      (db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all() as Array<{ version: number }>)
        .map(({ version }) => version),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    db.close();
  }

  console.log('batch schema rollback version tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
