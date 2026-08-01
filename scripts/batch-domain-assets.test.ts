import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BATCH_SCHEMA_MIGRATIONS, ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  createAnalysisVersion,
  createAsset,
  getAsset,
  listAnalysisVersions,
  markAssetArchived,
  markAssetOffline,
  setAssetCurrentAnalysis,
} from '../lib/batch-production/assets.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
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
  return { db, databasePath };
}

function up(db: Database.Database, backupRoot: string) {
  return ensureBatchSchemaReady({ db, backupRoot, now: () => new Date('2026-08-01T08:00:00.000Z') });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-assets-'));

try {
  const healthyRoot = path.join(root, 'healthy');
  fs.mkdirSync(healthyRoot, { recursive: true });
  const healthy = createLegacyDatabase(healthyRoot, 'workbench.db');
  const backupRoot = path.join(healthyRoot, 'backups');

  const allVersions = BATCH_SCHEMA_MIGRATIONS.map(({ version }) => version);
  const migrated = await up(healthy.db, backupRoot);
  assert.equal(migrated.state, 'ready');
  assert.deepEqual(migrated.appliedVersions, allVersions);

  const assetTables = healthy.db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('batch_assets', 'batch_asset_analysis') ORDER BY name
  `).all() as Array<{ name: string }>;
  assert.deepEqual(assetTables.map(({ name }) => name), ['batch_asset_analysis', 'batch_assets']);

  const assetColumns = healthy.db.prepare(`PRAGMA table_info(batch_assets)`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const assetColumnNames = new Map(assetColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'projectId', 'sourceKind', 'locationJson', 'contentFingerprint', 'mediaKind', 'mediaJson', 'status', 'currentAnalysisId', 'createdAt', 'updatedAt']) {
    assert.ok(assetColumnNames.has(name), `batch_assets 缺少列 ${name}`);
  }
  assert.equal(assetColumnNames.get('id')?.pk, 1, 'batch_assets.id 必须是主键');
  assert.equal(assetColumnNames.get('projectId')?.notnull, 1);
  assert.equal(assetColumnNames.get('contentFingerprint')?.notnull, 1);
  assert.equal(assetColumnNames.get('status')?.notnull, 1);

  const assetForeignKeys = healthy.db.prepare(`PRAGMA foreign_key_list(batch_assets)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(assetForeignKeys.some((fk) => (
    fk.table === 'projects' && fk.from === 'projectId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), 'batch_assets 缺少指向 projects 的级联外键');

  const assetIndexes = healthy.db.prepare(`PRAGMA index_list(batch_assets)`).all() as Array<{ name: string; unique: number }>;
  assert.ok(assetIndexes.some(({ name, unique }) => name === 'idx_batch_assets_project' && unique === 0), '缺少 idx_batch_assets_project');
  assert.ok(assetIndexes.some(({ name, unique }) => name === 'idx_batch_assets_identity' && unique === 1), '缺少素材身份唯一索引');

  const analysisColumns = healthy.db.prepare(`PRAGMA table_info(batch_asset_analysis)`).all() as Array<{ name: string }>;
  const analysisNames = new Set(analysisColumns.map((c) => c.name));
  for (const name of ['id', 'assetId', 'analyzerVersion', 'providerId', 'model', 'analysisJson', 'status', 'errorCode', 'errorMessage', 'analyzedAt', 'createdAt']) {
    assert.ok(analysisNames.has(name), `batch_asset_analysis 缺少列 ${name}`);
  }
  const analysisForeignKeys = healthy.db.prepare(`PRAGMA foreign_key_list(batch_asset_analysis)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(analysisForeignKeys.some((fk) => (
    fk.table === 'batch_assets' && fk.from === 'assetId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), 'batch_asset_analysis 缺少指向 batch_assets 的级联外键');
  const analysisIndexes = healthy.db.prepare(`PRAGMA index_list(batch_asset_analysis)`).all() as Array<{ name: string }>;
  assert.ok(analysisIndexes.some(({ name }) => name === 'idx_batch_asset_analysis_asset'), '缺少分析版本索引');

  assert.deepEqual(
    healthy.db.prepare(`SELECT version FROM batch_schema_migrations ORDER BY version`).all(),
    allVersions.map((version) => ({ version })),
    '版本历史必须连续记录所有版本',
  );

  // --- 素材身份不依赖路径:同指纹不同路径是同一素材 ---
  const first = createAsset(healthy.db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { path: '/photos/clip-a.mp4', label: '手机原始视频' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    mediaJson: { durationUs: 1000, width: 1920, height: 1080 },
    now: () => new Date('2026-08-01T09:00:00.000Z'),
  });
  assert.ok(first, '素材必须返回稳定身份');
  const moved = createAsset(healthy.db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { path: '/photos/moved/clip-a.mp4', label: '移动后位置' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    mediaJson: { durationUs: 1000, width: 1920, height: 1080 },
    now: () => new Date('2026-08-01T09:30:00.000Z'),
  });
  assert.equal(moved, first, '同指纹必须复用同一素材身份,不能新建');
  assert.equal((healthy.db.prepare(`SELECT COUNT(*) AS n FROM batch_assets`).get() as { n: number }).n, 1);

  const located = getAsset(healthy.db, 'project-1', first);
  assert.equal(located?.contentFingerprint, 'sha256:aaa');
  assert.equal(located?.status, 'online');
  assert.equal((located?.locationJson as unknown as { path: string }).path, '/photos/moved/clip-a.mp4', '定位线索更新但身份不变');

  // --- 内容不同(指纹不同)是新素材,不能冒充 ---
  const other = createAsset(healthy.db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { path: '/photos/moved/clip-a.mp4', label: '同名不同内容' },
    contentFingerprint: 'sha256:bbb',
    mediaKind: 'video',
    mediaJson: { durationUs: 2000 },
    now: () => new Date('2026-08-01T10:00:00.000Z'),
  });
  assert.notEqual(other, first, '同名但内容不同的文件必须是新素材');
  assert.equal((healthy.db.prepare(`SELECT COUNT(*) AS n FROM batch_assets`).get() as { n: number }).n, 2);

  // --- 离线/归档是状态,不影响身份 ---
  markAssetOffline(healthy.db, 'project-1', other, () => new Date('2026-08-01T11:00:00.000Z'));
  assert.equal(getAsset(healthy.db, 'project-1', other)?.status, 'offline');
  markAssetArchived(healthy.db, 'project-1', other, () => new Date('2026-08-01T12:00:00.000Z'));
  assert.equal(getAsset(healthy.db, 'project-1', other)?.status, 'archived');

  // --- 分析版本独立存在,可跨批次复用,素材维护当前分析指向 ---
  const analysis = createAnalysisVersion(healthy.db, {
    assetId: first,
    analyzerVersion: '0.1.0',
    providerId: 'provider-1',
    model: 'model-a',
    analysisJson: { durationUs: 1000, orientation: 'horizontal', usableRanges: [[0, 800]] },
    now: () => new Date('2026-08-01T13:00:00.000Z'),
  });
  assert.ok(analysis, '分析版本必须返回稳定身份');
  setAssetCurrentAnalysis(healthy.db, 'project-1', first, analysis, () => new Date('2026-08-01T13:01:00.000Z'));
  assert.equal(getAsset(healthy.db, 'project-1', first)?.currentAnalysisId, analysis);

  const analysis2 = createAnalysisVersion(healthy.db, {
    assetId: first,
    analyzerVersion: '0.2.0',
    providerId: 'provider-1',
    model: 'model-b',
    analysisJson: { durationUs: 1000, orientation: 'vertical', usableRanges: [[100, 900]] },
    now: () => new Date('2026-08-01T14:00:00.000Z'),
  });
  assert.notEqual(analysis2, analysis);
  const analysisForOtherAsset = createAnalysisVersion(healthy.db, {
    assetId: other,
    analyzerVersion: '0.1.0',
    providerId: 'provider-1',
    model: 'model-a',
    now: () => new Date('2026-08-01T14:00:30.000Z'),
  });
  assert.deepEqual(listAnalysisVersions(healthy.db, first).map(({ id }) => id), [analysis, analysis2]);
  assert.equal(
    (healthy.db.prepare(`SELECT COUNT(*) AS n FROM batch_asset_analysis`).get() as { n: number }).n,
    3,
    '两份素材各有一份或多份分析版本',
  );

  // 新分析不覆盖旧分析;素材当前指向由显式调用更新
  assert.equal(getAsset(healthy.db, 'project-1', first)?.currentAnalysisId, analysis, '新分析版本不得自动改写素材当前指向');
  setAssetCurrentAnalysis(healthy.db, 'project-1', first, analysis2, () => new Date('2026-08-01T14:01:00.000Z'));
  assert.equal(getAsset(healthy.db, 'project-1', first)?.currentAnalysisId, analysis2);

  // 无效分析版本:先校验后更新,报错后不得留下脏指向
  assert.throws(
    () => setAssetCurrentAnalysis(healthy.db, 'project-1', first, 'no-such-analysis', () => new Date('2026-08-01T14:02:00.000Z')),
    /不属于/,
    '指向不存在的分析版本必须报错',
  );
  assert.equal(
    getAsset(healthy.db, 'project-1', first)?.currentAnalysisId,
    analysis2,
    '校验失败后不得把无效分析版本写入素材当前指向',
  );
  // 属于其他素材的分析版本:同样拒绝且不留脏数据
  assert.throws(
    () => setAssetCurrentAnalysis(healthy.db, 'project-1', first, analysisForOtherAsset, () => new Date('2026-08-01T14:03:00.000Z')),
    /不属于/,
  );
  assert.equal(getAsset(healthy.db, 'project-1', first)?.currentAnalysisId, analysis2);

  // --- 幂等:再次启动不重复备份、不报错 ---
  const again = await up(healthy.db, backupRoot);
  assert.equal(again.state, 'current');
  assert.deepEqual(again.appliedVersions, []);
  assert.deepEqual(healthy.db.prepare(`SELECT value FROM legacy_marker WHERE id = 'marker-1'`).get(), { value: '必须保留' });

  healthy.db.close();

  // --- 结构破坏检测:最新版本结构不符时进入兼容模式,旧数据不动 ---
  const brokenRoot = path.join(root, 'broken');
  fs.mkdirSync(brokenRoot, { recursive: true });
  const broken = createLegacyDatabase(brokenRoot, 'workbench.db');
  const latestVersion = BATCH_SCHEMA_MIGRATIONS.at(-1)?.version;
  broken.db.exec(`
    CREATE TABLE batch_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );
    INSERT INTO batch_schema_migrations (version, appliedAt) VALUES
      (${latestVersion}, '2026-08-01T08:00:00.000Z');
    CREATE TABLE batch_productions (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE batch_assets (id TEXT PRIMARY KEY);
  `);
  const brokenResult = await up(broken.db, path.join(brokenRoot, 'backups'));
  assert.equal(brokenResult.state, 'compatibility_only');
  if (brokenResult.state === 'compatibility_only') {
    assert.equal(brokenResult.code, 'schema_history_invalid');
  }
  assert.equal(
    (broken.db.prepare(`SELECT value FROM legacy_marker WHERE id = 'marker-1'`).get() as { value: string }).value,
    '必须保留',
    '结构破坏时不得改动旧数据',
  );
  broken.db.close();

  console.log('batch domain assets tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
