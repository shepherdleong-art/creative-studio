import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import {
  addAssetToPool,
  createBatchProduction,
  createBatchProductionVersion,
  getBatchProduction,
  getBatchVersion,
  listPoolItems,
} from '../lib/batch-production/versions.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '旧项目');
  `);
  return { db, databasePath };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-versions-'));

try {
  const dbRoot = path.join(root, 'healthy');
  fs.mkdirSync(dbRoot, { recursive: true });
  const { db } = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-01T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 结构:批次表扩展列 + 版本表 + 素材池表 ---
  const productionColumns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{
    name: string; notnull: number; dflt_value: string | null;
  }>;
  const productionNames = new Set(productionColumns.map((c) => c.name));
  for (const name of ['status', 'currentVersionId', 'progressJson']) {
    assert.ok(productionNames.has(name), `batch_productions 缺少扩展列 ${name}`);
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{
    name: string; notnull: number; pk: number; dflt_value: string | null;
  }>;
  const versionNames = new Map(versionColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'batchId', 'versionNumber', 'copyCount', 'defaultsJson', 'createdAt']) {
    assert.ok(versionNames.has(name), `batch_production_versions 缺少列 ${name}`);
  }
  assert.equal(versionNames.get('id')?.pk, 1);
  assert.equal(versionNames.get('versionNumber')?.notnull, 1);
  assert.equal(versionNames.get('copyCount')?.notnull, 1);

  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_production_versions)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(versionForeignKeys.some((fk) => (
    fk.table === 'batch_productions' && fk.from === 'batchId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '批次版本表缺少指向批次的级联外键');
  const versionIndexes = db.prepare(`PRAGMA index_list(batch_production_versions)`).all() as Array<{ name: string; unique: number }>;
  assert.ok(versionIndexes.some(({ name, unique }) => name === 'idx_batch_production_versions_batch' && unique === 0), '缺少批次版本索引');

  const poolColumns = db.prepare(`PRAGMA table_info(batch_asset_pool_items)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const poolNames = new Set(poolColumns.map((c) => c.name));
  for (const name of ['id', 'batchVersionId', 'assetId', 'analysisId', 'selectionState', 'createdAt']) {
    assert.ok(poolNames.has(name), `batch_asset_pool_items 缺少列 ${name}`);
  }
  const poolForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_pool_items)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(poolForeignKeys.some((fk) => (
    fk.table === 'batch_production_versions' && fk.from === 'batchVersionId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '素材池表缺少指向批次版本的级联外键');
  assert.ok(poolForeignKeys.some((fk) => (
    fk.table === 'batch_assets' && fk.from === 'assetId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'RESTRICT'
  )), '素材池表必须限制被引用素材被删除(归档而非删除)');
  const poolIndexes = db.prepare(`PRAGMA index_list(batch_asset_pool_items)`).all() as Array<{ name: string; unique: number }>;
  assert.ok(poolIndexes.some(({ name, unique }) => name === 'idx_batch_asset_pool_items_version' && unique === 0), '缺少素材池版本索引');

  // --- 创建批次与版本 ---
  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-01T09:00:00.000Z'));
  assert.ok(batchId);
  const batch = getBatchProduction(db, 'project-1', batchId);
  assert.equal(batch?.name, '八月大促混剪');
  assert.equal(batch?.status, 'draft');

  const version1 = createBatchProductionVersion(db, batchId, {
    copyCount: 3,
    defaultsJson: { bgmPath: '/bgm/a.mp3' },
    now: () => new Date('2026-08-01T09:30:00.000Z'),
  });
  assert.equal(getBatchProduction(db, 'project-1', batchId)?.currentVersionId, version1);
  assert.equal(getBatchVersion(db, batchId, version1)?.versionNumber, 1);

  // --- 修改整体输入形成新批次版本,旧版本保留 ---
  const version2 = createBatchProductionVersion(db, batchId, {
    copyCount: 5,
    defaultsJson: { bgmPath: '/bgm/b.mp3' },
    now: () => new Date('2026-08-01T10:00:00.000Z'),
  });
  assert.notEqual(version2, version1);
  assert.equal(getBatchVersion(db, batchId, version1)?.copyCount, 3, '旧批次版本必须保留');
  assert.equal(getBatchVersion(db, batchId, version2)?.copyCount, 5);
  assert.equal(getBatchProduction(db, 'project-1', batchId)?.currentVersionId, version2, '当前版本指向最新');

  // --- 素材池:锁定素材与采用的分析版本 ---
  const assetA = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { path: '/photos/a.mp4' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    now: () => new Date('2026-08-01T10:30:00.000Z'),
  });
  const analysisA = createAnalysisVersion(db, {
    assetId: assetA,
    analyzerVersion: '0.1.0',
    providerId: 'provider-1',
    model: 'model-a',
    now: () => new Date('2026-08-01T10:31:00.000Z'),
  });
  const assetB = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { path: '/photos/b.mp4' },
    contentFingerprint: 'sha256:bbb',
    mediaKind: 'video',
    now: () => new Date('2026-08-01T10:32:00.000Z'),
  });
  const analysisB = createAnalysisVersion(db, {
    assetId: assetB,
    analyzerVersion: '0.1.0',
    providerId: 'provider-1',
    model: 'model-a',
    now: () => new Date('2026-08-01T10:33:00.000Z'),
  });

  addAssetToPool(db, version2, { assetId: assetA, analysisId: analysisA, now: () => new Date('2026-08-01T10:34:00.000Z') });
  addAssetToPool(db, version2, { assetId: assetB, analysisId: analysisB, now: () => new Date('2026-08-01T10:35:00.000Z') });

  const pool = listPoolItems(db, version2);
  assert.equal(pool.length, 2);
  assert.ok(pool.some((item) => item.assetId === assetA && item.analysisId === analysisA), '素材池必须锁定素材与分析版本');
  assert.ok(pool.some((item) => item.assetId === assetB && item.analysisId === analysisB));

  // 同素材重复加入同一版本:拒绝(同一版本素材唯一)
  assert.throws(
    () => addAssetToPool(db, version2, { assetId: assetA, analysisId: analysisA }),
    /重复/,
    '同一批次版本不能重复加入同一素材',
  );

  // 分析版本不属于该素材:拒绝
  assert.throws(
    () => addAssetToPool(db, version2, { assetId: assetA, analysisId: analysisB }),
    /不属于/,
    '素材池必须锁定属于该素材的分析版本',
  );

  // 池引用的是素材与分析 id,不复制内容:素材归档不影响历史批次追溯
  db.prepare(`UPDATE batch_assets SET status = 'archived' WHERE id = ?`).run(assetA);
  assert.equal(listPoolItems(db, version2).filter((item) => item.assetId === assetA).length, 1, '素材归档后历史池引用仍可追溯');

  // 旧版本没有素材池:新版本的内容不影响旧版本
  assert.equal(listPoolItems(db, version1).length, 0, '批次版本之间素材池必须隔离');

  // --- 项目归属防串线:项目 2 的素材不能挂进项目 1 的批次 ---
  db.prepare(`INSERT INTO projects (id, name) VALUES ('project-2', '项目二')`).run();
  const project2Asset = createAsset(db, {
    projectId: 'project-2',
    sourceKind: 'linked',
    locationJson: { path: '/photos/p2.mp4' },
    contentFingerprint: 'sha256:ppp',
    mediaKind: 'video',
    now: () => new Date('2026-08-01T10:40:00.000Z'),
  });
  const project2Analysis = createAnalysisVersion(db, {
    assetId: project2Asset,
    analyzerVersion: '0.1.0',
    providerId: 'provider-1',
    model: 'model-a',
    now: () => new Date('2026-08-01T10:41:00.000Z'),
  });
  assert.throws(
    () => addAssetToPool(db, version2, { assetId: project2Asset, analysisId: project2Analysis }),
    /不属于/,
    '其他项目的素材不得加入本项目的批次版本',
  );
  assert.equal(listPoolItems(db, version2).length, 2, '串线尝试不得写入任何池条目');

  // --- 批次开始后输入冻结:不能再向批次版本追加素材 ---
  db.prepare(`UPDATE batch_productions SET status = 'running', updatedAt = ? WHERE id = ?`)
    .run('2026-08-01T10:50:00.000Z', batchId);
  assert.throws(
    () => addAssetToPool(db, version2, { assetId: assetB, analysisId: analysisB }),
    /冻结/,
    '批次开始后不得向既有批次版本追加素材',
  );
  assert.equal(listPoolItems(db, version2).length, 2);

  // --- 重复启动幂等 ---
  const again = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-01T11:00:00.000Z'),
  });
  assert.equal(again.state, 'current');
  assert.deepEqual(again.appliedVersions, []);
  assert.equal(getBatchVersion(db, batchId, version2)?.copyCount, 5, '幂等升级不得改动业务数据');

  db.close();
  console.log('batch domain versions tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
