// scripts/batch-proxy-asset-request.test.ts
//
// 素材级代理请求(共识 2/13)领域测试:
// A. requestProxy 素材级路径(批次参数为 null):无批次创建、请求行批次字段为空、
//    固定 LUT 关闭快照、项目归属与指纹校验;
// B. 幂等:重复/并发重复请求返回现存请求(部分唯一索引兜底,不是先查后插);
// C. tasks.ts 谱系校验双分支:素材级只校验 projectId + assetId 归属,
//    批次绑定请求仍走完整 project→batch→version→request 校验;
// D. 素材级任务可被调度器正常领取与完成(batch_tasks.batchId 可空);
// E. v25 迁移对含存量行的库重建正确:数据保留、可空列、两个部分唯一索引、
//    表级 CHECK 半空拒绝、结构校验断言通过。本地库为空,这里按旧结构造库验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  BATCH_SCHEMA_MIGRATIONS,
  ensureBatchSchemaReady,
} from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { requestProxy, getProxyRequest, getProxyCacheItem, computeProxyKey } from '../lib/batch-production/proxy-cache.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import { claimNextTask, completeTaskAttempt } from '../lib/batch-production/scheduler.ts';
import { PROXY_PROFILE_VERSION } from '../lib/batch-production/proxy-executor.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

function applyMigrationsUpTo(db: Database.Database, upToExclusive: number): void {
  db.exec(`
    CREATE TABLE batch_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    )
  `);
  for (const migration of BATCH_SCHEMA_MIGRATIONS) {
    if (migration.version >= upToExclusive) break;
    db.exec(migration.sql);
    db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`)
      .run(migration.version, '2026-09-01T00:00:00.000Z');
  }
}

function assertPrimaryKeyByIndex(db: Database.Database, indexName: string): { name: string; unique: number } | undefined {
  return (db.prepare(`PRAGMA index_list(batch_proxy_requests)`).all() as Array<{ name: string; unique: number }>)
    .find(({ name }) => name === indexName);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-asset-request-'));

try {
  await tryLegacyMigrationTest();
  await tryMaterialRequestFlowTest();
  console.log('batch-proxy-asset-request tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ================================================================
// E. v25 迁移(含存量行)
// ================================================================
async function tryLegacyMigrationTest(): Promise<void> {
  const dbRoot = path.join(root, 'legacy-db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  // 先按 v24 之前的旧结构建库(含代理请求/任务的存量行),再跑迁移
  applyMigrationsUpTo(db, 25);
  db.pragma('foreign_keys = ON');

  // 存量:批次/版本/素材/代理请求/代理任务/一次尝试
  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES ('batch-1', 'project-1', '存量批次', 'draft', NULL, '{}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_production_versions (id, batchId, versionNumber, copyCount, defaultsJson, createdAt)
    VALUES ('version-1', 'batch-1', 1, 1, '{}', '2026-09-01T00:01:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_assets (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt)
    VALUES ('asset-1', 'project-1', 'linked', '{}', 'sha256:legacy', 'video', 'online', '2026-09-01T00:02:00.000Z', '2026-09-01T00:02:00.000Z')
  `).run();
  const closedSnapshot = '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}';
  db.prepare(`
    INSERT INTO batch_asset_analysis (id, assetId, analyzerVersion, providerId, model, status, analyzedAt, createdAt)
    VALUES ('analysis-1', 'asset-1', 'v1', 'local', 'none', 'ready', '2026-09-01T00:02:30.000Z', '2026-09-01T00:02:30.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, selectionState, colorJson, createdAt)
    VALUES ('pool-1', 'version-1', 'asset-1', 'analysis-1', 'selected', ?, '2026-09-01T00:02:40.000Z')
  `).run(closedSnapshot);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-1', 'sha256:legacy-cache-key', 'project-1', 'asset-1', 'proxy-v1', ?, 'storage/cache/proxies/project-1/asset-1/legacy.mp4', 'ready', '{}', 1000, 'sha256:checksum', NULL, '2026-09-01T00:03:00.000Z', '2026-09-01T00:03:00.000Z')
  `).run(closedSnapshot);
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES
      ('request-1', 'project-1', 'batch-1', 'version-1', 'asset-1', 'sha256:legacy', ?,
       'proxy-v1', 'color-v1', 'sha256:legacy-cache-key', 'cache-1', 'ready', '2026-09-01T00:04:00.000Z', '2026-09-01T00:04:00.000Z'),
      ('request-2', 'project-1', 'batch-1', 'version-1', 'asset-1', 'sha256:legacy', ?,
       'proxy-v1', 'color-v1', 'sha256:legacy-cache-key-2', NULL, 'failed', '2026-09-01T00:05:00.000Z', '2026-09-01T00:05:00.000Z')
  `).run(closedSnapshot, closedSnapshot);
  db.prepare(`
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES ('task-1', 'project-1', 'batch-1', 'proxy_generate', 'proxy_request', 'request-1', 'succeeded', 'proxy_generate:project-1:request-1', 'running', '{}', 1, '2026-09-01T00:04:10.000Z', '2026-09-01T00:04:20.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, startedAt, finishedAt, createdAt)
    VALUES ('attempt-1', 'task-1', 1, 'succeeded', '{}', '2026-09-01T00:04:11.000Z', '2026-09-01T00:04:20.000Z', '2026-09-01T00:04:11.000Z')
  `).run();

  const migratedV25 = await ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-09-01T09:00:00.000Z'),
  });
  assert.equal(migratedV25.state, 'ready', `v25 迁移必须成功(当前 ${migratedV25.state}: ${migratedV25.state === 'compatibility_only' ? (migratedV25 as { message: string }).message : ''})`);

  // 存量行原样搬迁
  const request1 = db.prepare(`SELECT * FROM batch_proxy_requests WHERE id = 'request-1'`).get() as Record<string, unknown>;
  assert.equal(request1.projectId, 'project-1');
  assert.equal(request1.batchId, 'batch-1', '存量批次请求的批次字段必须保留');
  assert.equal(request1.batchVersionId, 'version-1');
  assert.equal(request1.proxyKey, 'sha256:legacy-cache-key');
  assert.equal(request1.status, 'ready');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_proxy_requests`).get() as { n: number }).n, 2, '全部存量请求必须保留');
  const task1 = db.prepare(`SELECT * FROM batch_tasks WHERE id = 'task-1'`).get() as Record<string, unknown>;
  assert.equal(task1.batchId, 'batch-1');
  assert.equal(task1.targetId, 'request-1');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_task_attempts WHERE taskId = 'task-1'`).get() as { n: number }).n, 1, '存量尝试必须随任务表重建保留');

  // 可空列
  const requestColumns = db.prepare(`PRAGMA table_info(batch_proxy_requests)`).all() as Array<{ name: string; notnull: number }>;
  const requestByName = new Map(requestColumns.map((column) => [column.name, column]));
  assert.equal(requestByName.get('batchId')?.notnull, 0, 'v25 后 batchId 必须可空');
  assert.equal(requestByName.get('batchVersionId')?.notnull, 0, 'v25 后 batchVersionId 必须可空');
  assert.equal(requestByName.get('projectId')?.notnull, 1, 'projectId 仍必须必填');
  assert.equal(requestByName.get('colorJson')?.notnull, 1, 'colorJson 列保留且 NOT NULL');
  const taskColumns = db.prepare(`PRAGMA table_info(batch_tasks)`).all() as Array<{ name: string; notnull: number }>;
  assert.equal(taskColumns.find((column) => column.name === 'batchId')?.notnull, 0, 'v25 后 batch_tasks.batchId 必须可空');

  // 两个部分唯一索引
  assert.equal(assertPrimaryKeyByIndex(db, 'idx_batch_proxy_requests_version_identity')?.unique, 1, '批次版本部分唯一索引必须存在且唯一');
  assert.equal(assertPrimaryKeyByIndex(db, 'idx_batch_proxy_requests_asset_identity')?.unique, 1, '素材部分唯一索引必须存在且唯一');

  // 素材级唯一索引幂等:同 projectId+assetId+proxyKey 且 batchVersionId 为 NULL 只能一行
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES ('material-request-1', 'project-1', NULL, NULL, 'asset-1', 'sha256:legacy', ?,
            'proxy-v1', 'color-v1', 'sha256:material-key', NULL, 'requested', '2026-09-01T09:01:00.000Z', '2026-09-01T09:01:00.000Z')
  `).run(closedSnapshot);
  assert.throws(() => {
    db.prepare(`
      INSERT INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      VALUES ('material-request-dup', 'project-1', NULL, NULL, 'asset-1', 'sha256:legacy', ?,
              'proxy-v1', 'color-v1', 'sha256:material-key', NULL, 'requested', '2026-09-01T09:02:00.000Z', '2026-09-01T09:02:00.000Z')
    `).run(closedSnapshot);
  }, /UNIQUE constraint failed/, '素材级请求幂等必须由部分唯一索引强制(应用层不做先查后插)');

  // 批次级唯一语义不变:同 batchVersionId+assetId+proxyKey 也仍唯一
  assert.throws(() => {
    db.prepare(`
      INSERT INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      VALUES ('request-1-dup', 'project-1', 'batch-1', 'version-1', 'asset-1', 'sha256:legacy', ?,
              'proxy-v1', 'color-v1', 'sha256:legacy-cache-key-2', NULL, 'requested', '2026-09-01T09:03:00.000Z', '2026-09-01T09:03:00.000Z')
    `).run(closedSnapshot);
  }, /UNIQUE constraint failed/, '批次版本唯一索引必须保留(批次绑定行为不变)');

  // 表级 CHECK:batchId/batchVersionId 半空必须被拒绝
  assert.throws(() => {
    db.prepare(`
      INSERT INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      VALUES ('half-empty-1', 'project-1', 'batch-1', NULL, 'asset-1', 'sha256:legacy', ?,
              'proxy-v1', 'color-v1', 'sha256:half-empty-1', NULL, 'requested', '2026-09-01T09:04:00.000Z', '2026-09-01T09:04:00.000Z')
    `).run(closedSnapshot);
  }, /CHECK constraint failed/, 'batchId 非空而 batchVersionId 为空的半空绑定必须被拒绝');
  assert.throws(() => {
    db.prepare(`
      INSERT INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      VALUES ('half-empty-2', 'project-1', NULL, 'version-1', 'asset-1', 'sha256:legacy', ?,
              'proxy-v1', 'color-v1', 'sha256:half-empty-2', NULL, 'requested', '2026-09-01T09:05:00.000Z', '2026-09-01T09:05:00.000Z')
    `).run(closedSnapshot);
  }, /CHECK constraint failed/, 'batchVersionId 非空而 batchId 为空的半空绑定必须被拒绝');

  // 素材级任务可建:batch_tasks.batchId 为 NULL
  db.prepare(`
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES ('material-task-1', 'project-1', NULL, 'proxy_generate', 'proxy_request', 'material-request-1', 'queued', NULL, 'running', '{}', 0, '2026-09-01T09:06:00.000Z', '2026-09-01T09:06:00.000Z')
  `).run();

  // 迁移后无待执行迁移时结构校验断言(含 v25 新断言)必须通过
  const again = await ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-09-01T10:00:00.000Z'),
  });
  assert.equal(again.state, 'current', 'v25 后结构校验断言必须通过(迁移后无待执行迁移时应为 current)');
  db.close();
}

// ================================================================
// A–D. 素材级请求流
// ================================================================
async function tryMaterialRequestFlowTest(): Promise<void> {
  const dbRoot = path.join(root, 'material-db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-09-01T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');
  db.prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`).run('project-2', '项目二');

  const assetId = createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/material-asset.mp4' },
    contentFingerprint: `sha256:${'a'.repeat(64)}`, mediaKind: 'video',
    now: () => new Date('2026-09-01T08:01:00.000Z'),
  });
  const otherAssetId = createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/other-asset.mp4' },
    contentFingerprint: `sha256:${'b'.repeat(64)}`, mediaKind: 'video',
    now: () => new Date('2026-09-01T08:01:30.000Z'),
  });

  // --- A1: 素材级请求:无批次创建、请求行批次字段为空、固定关闭快照 ---
  const batchesBefore = (db.prepare(`SELECT COUNT(*) AS n FROM batch_productions`).get() as { n: number }).n;
  const first = requestProxy(db, 'project-1', null, {
    assetId,
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    profileVersion: PROXY_PROFILE_VERSION,
    now: () => new Date('2026-09-01T08:02:00.000Z'),
  });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_productions`).get() as { n: number }).n, batchesBefore, '素材级请求不得创建任何批次');
  const materialRequest = getProxyRequest(db, 'project-1', first.requestId);
  assert.equal(materialRequest?.batchId, null, '素材级请求行 batchId 必须为 NULL');
  assert.equal(materialRequest?.batchVersionId, null, '素材级请求行 batchVersionId 必须为 NULL');
  assert.equal(materialRequest?.assetId, assetId);
  const colorJson = JSON.parse(materialRequest!.colorJson) as Record<string, unknown>;
  assert.equal(colorJson.lutId, null, '素材级请求必须写入 LUT 关闭的默认快照(共识 13)');
  assert.equal(colorJson.colorPipelineVersion, 'color-v1');
  assert.equal((getProxyRequest(db, 'project-1', first.requestId) as { proxyKey: string }).proxyKey,
    computeProxyKey({ assetId, contentFingerprint: `sha256:${'a'.repeat(64)}`, profileVersion: PROXY_PROFILE_VERSION }),
    '请求必须持有素材级简化 proxyKey');
  const cacheItem = getProxyCacheItem(db, 'project-1', first.cacheItemId);
  assert.equal(cacheItem?.status, 'pending');
  const taskRow = db.prepare(`SELECT batchId, workType, targetId FROM batch_tasks WHERE id = ?`).get(first.taskId) as { batchId: string | null; workType: string; targetId: string };
  assert.equal(taskRow.batchId, null, '素材级任务的 batchId 必须为 NULL');
  assert.equal(taskRow.workType, 'proxy_generate');
  assert.equal(taskRow.targetId, first.requestId, '任务目标必须指向稳定请求');

  // --- B: 幂等:重复请求(含索引冲突路径)返回现存请求与任务,不新增行 ---
  const second = requestProxy(db, 'project-1', null, {
    assetId,
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    profileVersion: PROXY_PROFILE_VERSION,
    now: () => new Date('2026-09-01T08:03:00.000Z'),
  });
  assert.equal(second.requestId, first.requestId, '重复请求必须返回现存请求');
  assert.equal(second.taskId, first.taskId, '重复请求必须复用既有任务(requestKey 幂等)');
  assert.equal(second.cacheItemId, first.cacheItemId, '重复请求必须复用既有缓存项');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_proxy_requests WHERE batchId IS NULL`).get() as { n: number }).n, 1, '重复请求不得新增行');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'proxy_generate'`).get() as { n: number }).n, 1);

  // 直接违反唯一索引的 INSERT 必须被约束本身拒绝(证明幂等不是靠应用层先查后插)
  assert.throws(() => {
    db.prepare(`
      INSERT INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      VALUES ('manual-dup', 'project-1', NULL, NULL, ?, ?, '{}',
              'proxy-v1', 'color-v1', ?, NULL, 'requested', '2026-09-01T08:04:00.000Z', '2026-09-01T08:04:00.000Z')
    `).run(assetId, `sha256:${'a'.repeat(64)}`, first.proxyKey);
  }, /UNIQUE constraint failed/, '素材级请求唯一性必须由部分唯一索引强制');

  // --- A2: 项目归属与指纹校验 ---
  assert.throws(() => {
    requestProxy(db, 'project-1', null, {
      assetId: 'missing-asset',
      contentFingerprint: `sha256:${'f'.repeat(64)}`,
      profileVersion: PROXY_PROFILE_VERSION,
      now: () => new Date('2026-09-01T08:05:00.000Z'),
    });
  }, /素材不存在/, '不存在的素材必须被拒绝');
  assert.throws(() => {
    requestProxy(db, 'project-2', null, {
      assetId,
      contentFingerprint: `sha256:${'a'.repeat(64)}`,
      profileVersion: PROXY_PROFILE_VERSION,
      now: () => new Date('2026-09-01T08:06:00.000Z'),
    });
  }, /不属于该项目/, '跨项目素材必须被拒绝');
  assert.throws(() => {
    requestProxy(db, 'project-1', null, {
      assetId,
      contentFingerprint: `sha256:${'c'.repeat(64)}`,
      profileVersion: PROXY_PROFILE_VERSION,
      now: () => new Date('2026-09-01T08:07:00.000Z'),
    });
  }, /指纹与项目素材身份不一致/, '与项目素材身份不一致的指纹必须被拒绝');

  // --- C: tasks.ts 双分支 ---
  // 素材级请求经 createBatchTask(batchId 为空)创建任务:上面已走通;
  // 这里验证批次绑定请求拒绝素材级请求 target,反之亦然。
  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES ('batch-1', 'project-1', '绑定批次', 'draft', NULL, '{}', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_production_versions (id, batchId, versionNumber, copyCount, defaultsJson, createdAt)
    VALUES ('version-1', 'batch-1', 1, 1, '{}', '2026-09-01T09:01:00.000Z')
  `).run();
  const closedSnapshot = '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}';
  const materialAnalysisId = createAnalysisVersion(db, {
    assetId, analyzerVersion: 'v1', providerId: 'local', model: 'none',
    now: () => new Date('2026-09-01T09:01:20.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES ('binding-request', 'project-1', 'batch-1', 'version-1', ?, ?, ?,
            'proxy-v1', 'color-v1', 'sha256:binding-key', NULL, 'requested', '2026-09-01T09:02:00.000Z', '2026-09-01T09:02:00.000Z')
  `).run(assetId, `sha256:${'a'.repeat(64)}`, closedSnapshot);
  db.prepare(`
    INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, selectionState, colorJson, createdAt)
    VALUES ('pool-1', 'version-1', ?, ?, 'selected', ?, '2026-09-01T09:01:30.000Z')
  `).run(assetId, materialAnalysisId, closedSnapshot);

  // 素材级请求 + 批次绑定任务 → 拒绝(批次绑定的完整谱系校验找不到可行请求)
  assert.throws(() => {
    createBatchTask(db, 'project-1', {
      batchId: 'batch-1',
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: first.requestId,
      requestKey: 'proxy_generate:project-1:material-vs-binding',
      now: () => new Date('2026-09-01T09:03:00.000Z'),
    });
  }, /不存在/, '批次绑定任务不允许指向素材级请求');
  // 批次绑定请求 + 素材级任务(无批次) → 拒绝
  assert.throws(() => {
    createBatchTask(db, 'project-1', {
      batchId: null,
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: 'binding-request',
      requestKey: 'proxy_generate:project-1:binding-vs-material',
      now: () => new Date('2026-09-01T09:04:00.000Z'),
    });
  }, /不存在/, '素材级任务不允许指向批次绑定请求');
  // 批次绑定请求 + 正确批次 → 通过(完整谱系校验维持)
  const bindingTaskId = createBatchTask(db, 'project-1', {
    batchId: 'batch-1',
    workType: 'proxy_generate',
    targetKind: 'proxy_request',
    targetId: 'binding-request',
    requestKey: 'proxy_generate:project-1:binding-ok',
    now: () => new Date('2026-09-01T09:05:00.000Z'),
  });
  assert.ok(bindingTaskId.length > 0);
  // 素材级请求 + 无批次 → 通过(只校验 projectId + assetId 归属)
  const materialTaskId = createBatchTask(db, 'project-1', {
    batchId: null,
    workType: 'proxy_generate',
    targetKind: 'proxy_request',
    targetId: first.requestId,
    requestKey: 'proxy_generate:project-1:material-ok',
    now: () => new Date('2026-09-01T09:06:00.000Z'),
  });
  assert.ok(materialTaskId.length > 0);
  // 跨项目归属:project-2 不能给 project-1 的素材级请求建任务
  assert.throws(() => {
    createBatchTask(db, 'project-2', {
      batchId: null,
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: first.requestId,
      requestKey: 'proxy_generate:project-2:material-cross',
      now: () => new Date('2026-09-01T09:07:00.000Z'),
    });
  }, /不属于该项目/, '素材级任务必须校验项目归属');

  // --- D: 素材级任务可被调度器领取并完成(batch_tasks.batchId 可空) ---
  let claimedMaterial = false;
  for (let i = 0; i < 5; i += 1) {
    const claim = claimNextTask(db, { workerId: 'worker-material', now: () => new Date('2026-09-01T09:08:00.000Z') });
    if (!claim) break;
    if (claim.task.id === materialTaskId) {
      claimedMaterial = true;
    }
    completeTaskAttempt(db, claim.attempt.id, {
      workerId: 'worker-material',
      status: 'succeeded',
      now: () => new Date('2026-09-01T09:09:00.000Z'),
    });
    if (claimedMaterial) break;
  }
  assert.ok(claimedMaterial, '无批次代理任务必须可被调度器领取并完成');
  const completed = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(materialTaskId) as { status: string };
  assert.equal(completed.status, 'succeeded', '无批次任务必须能正常完成落账');

  // 素材级请求归属校验以 batch_assets 当前行为准:素材移出项目后请求被拒绝
  db.prepare(`UPDATE batch_assets SET projectId = 'project-2' WHERE id = ?`).run(otherAssetId);
  assert.throws(() => {
    requestProxy(db, 'project-1', null, {
      assetId: otherAssetId,
      contentFingerprint: `sha256:${'b'.repeat(64)}`,
      profileVersion: PROXY_PROFILE_VERSION,
      now: () => new Date('2026-09-01T09:10:00.000Z'),
    });
  }, /不属于该项目/, '素材移出项目后素材级请求必须被拒绝');
  db.close();
}
