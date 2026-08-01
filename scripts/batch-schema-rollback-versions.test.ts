import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BATCH_SCHEMA_MIGRATIONS, ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';

/**
 * 逐版本故障注入:v2–v7 各自中途失败时,单条迁移事务必须整体回滚,
 * 不记录版本、不改动已存在数据、不应用后续版本,并进入兼容模式。
 */
const latestVersion = BATCH_SCHEMA_MIGRATIONS.at(-1)?.version;
assert.ok(latestVersion && latestVersion >= 8, '本测试要求 schema 至少到 v8');

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

  console.log('batch schema rollback version tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
