// scripts/batch-proxy-task-schema.test.ts
//
// Phase D 代理任务 schema 回归:覆盖 proxy_generate/proxy_request、稳定请求目标、
// requestKey 重建语义，以及 batch -> version -> request 的谱系隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  addAssetToPool,
  createBatchProduction,
  createBatchProductionVersion,
} from '../lib/batch-production/versions.ts';
import { createAnalysisVersion, createAsset } from '../lib/batch-production/assets.ts';
import { createBatchTask, getBatchTask } from '../lib/batch-production/tasks.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-task-schema-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const batchId = createBatchProduction(db, 'project-1', '代理任务测试批次', () => new Date('2026-08-03T08:01:00.000Z'));
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/fake-source.mp4' },
    contentFingerprint: 'sha256:proxy-schema-test',
    mediaKind: 'video',
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'proxy-schema-v1',
    providerId: 'local',
    model: 'none',
    now: () => new Date('2026-08-03T08:02:10.000Z'),
  });
  const batchVersionId = createBatchProductionVersion(db, batchId, {
    copyCount: 1,
    now: () => new Date('2026-08-03T08:02:20.000Z'),
  });
  addAssetToPool(db, batchVersionId, {
    assetId,
    analysisId,
    now: () => new Date('2026-08-03T08:02:25.000Z'),
  });

  // proxy_generate 任务的 target 是一个真实存在的持久化代理请求
  // (batch_proxy_requests.id,与 render 任务引用真实 output_version 同一模式),
  // 不是裸 proxyKey 也不是可删除的 cache 行。ProxyMediaCache.requestProxy 在
  // 正常流程会原子完成"取或建请求 + 取或建缓存项 + 建任务";这里直接造行,
  // 只聚焦 batch_tasks 本身的 schema 与 requestKey 语义。
  const proxyKey = `proxy:${assetId}:profile-v1:lut-off:pipeline-v1`;
  const cacheItemId = 'cache-item-1';
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES (?, ?, 'project-1', ?, 'profile-v1', '{"lutId":null}', ?, 'pending', '{}', 0, NULL, NULL, ?, ?)
  `).run(
    cacheItemId,
    proxyKey,
    assetId,
    `storage/cache/proxies/project-1/${assetId}/${proxyKey}.mp4`,
    '2026-08-03T08:02:30.000Z',
    '2026-08-03T08:02:30.000Z',
  );
  const requestId = 'proxy-request-1';
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES (?, 'project-1', ?, ?, ?, 'sha256:proxy-schema-test', '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}',
            'profile-v1', 'color-v1', ?, ?, 'requested', ?, ?)
  `).run(requestId, batchId, batchVersionId, assetId, proxyKey, cacheItemId, '2026-08-03T08:02:30.000Z', '2026-08-03T08:02:30.000Z');

  assert.throws(() => {
    db.prepare(`
      INSERT INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      VALUES ('request-missing-version', 'project-1', ?, 'missing-version', ?, 'sha256:proxy-schema-test',
              '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}',
              'profile-v1', 'color-v1', 'missing-version-key', NULL, 'requested', ?, ?)
    `).run(batchId, assetId, '2026-08-03T08:02:40.000Z', '2026-08-03T08:02:40.000Z');
  }, /FOREIGN KEY constraint failed/, '代理请求的 batchVersionId 必须有数据库外键保护');

  // --- 场景 1:workType = proxy_generate / targetKind = proxy_request 必须能被创建并读回 ---
  const requestKey = `proxy_generate:project-1:${proxyKey}`;
  let proxyTaskId = '';
  assert.doesNotThrow(() => {
    proxyTaskId = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: requestId,
      requestKey,
      now: () => new Date('2026-08-03T08:03:00.000Z'),
    });
  }, 'proxy_generate/proxy_request 任务必须能被 schema 接受(当前 CHECK 约束只允许 asset_prepare/render)');

  const proxyTask = getBatchTask(db, 'project-1', proxyTaskId);
  assert.equal(proxyTask?.workType, 'proxy_generate');
  assert.equal(proxyTask?.targetKind, 'proxy_request');
  assert.equal(proxyTask?.targetId, requestId);
  assert.equal(proxyTask?.status, 'queued');
  assert.notEqual(proxyTask?.targetId, cacheItemId, 'targetId 必须指向稳定请求,不能指向可删除的 cache 行');

  // --- 场景 2:同一 requestKey 重复提交必须幂等返回既有任务 ---
  const duplicateTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'proxy_generate',
    targetKind: 'proxy_request',
    targetId: requestId,
    requestKey,
    now: () => new Date('2026-08-03T08:04:00.000Z'),
  });
  assert.equal(duplicateTaskId, proxyTaskId, '同一 requestKey 重复提交必须返回既有任务,不产生重复任务');

  // --- 场景 3:任务进入 cancelled 终态后,不能让相同 requestKey 永久卡死;
  //             用户明确重新启用必须能在同一业务身份上形成新任务(新 id、新 attempt 链)。
  db.prepare(`UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped' WHERE id = ?`).run(proxyTaskId);

  let reEnabledTaskId = '';
  assert.doesNotThrow(() => {
    reEnabledTaskId = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: requestId,
      requestKey,
      now: () => new Date('2026-08-03T08:10:00.000Z'),
    });
  }, '取消后重新提交同一 requestKey 不能被历史 cancelled 记录卡死或触发 UNIQUE 冲突');
  assert.notEqual(reEnabledTaskId, proxyTaskId, '重新启用必须形成新任务,不能复用已取消的旧任务 id');

  const reEnabledTask = getBatchTask(db, 'project-1', reEnabledTaskId);
  assert.equal(reEnabledTask?.status, 'queued', '重新启用的新任务必须是可领取状态');

  const oldTask = getBatchTask(db, 'project-1', proxyTaskId);
  assert.equal(oldTask?.status, 'cancelled', '旧任务的取消历史必须保留,不能被覆盖或删除');

  // --- 场景 4:清理后旧 succeeded 任务不能永久占住 requestKey ---
  // 请求的 cache 被清理(FK ON DELETE SET NULL 把 currentCacheItemId 置空)后,
  // 即使旧任务处于 succeeded 终态,再次提交同一 requestKey 也必须形成新任务。
  const succeededTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'proxy_generate',
    targetKind: 'proxy_request',
    targetId: requestId,
    requestKey: 'proxy_generate:project-1:cleanup-rebuild-key',
    now: () => new Date('2026-08-03T08:11:00.000Z'),
  });
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded' WHERE id = ?`).run(succeededTaskId);
  db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ?`).run(cacheItemId);
  const rebuiltTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'proxy_generate',
    targetKind: 'proxy_request',
    targetId: requestId,
    requestKey: 'proxy_generate:project-1:cleanup-rebuild-key',
    now: () => new Date('2026-08-03T08:12:00.000Z'),
  });
  assert.notEqual(rebuiltTaskId, succeededTaskId, '缓存被清理后,succeeded 历史任务必须释放 requestKey,允许重新形成任务');
  assert.equal(getBatchTask(db, 'project-1', rebuiltTaskId)?.status, 'queued', '重建的任务必须是可领取状态');
  assert.equal(getBatchTask(db, 'project-1', succeededTaskId)?.status, 'succeeded', '历史成功任务本身必须保留');

  // --- 场景 5:批次 A 的任务不能指向批次 B 的稳定请求 ---
  const otherBatchId = createBatchProduction(db, 'project-1', '另一个批次', () => new Date('2026-08-03T08:13:00.000Z'));
  assert.throws(() => {
    createBatchTask(db, 'project-1', {
      batchId: otherBatchId,
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: requestId,
      requestKey: 'proxy_generate:project-1:cross-batch-lineage',
      now: () => new Date('2026-08-03T08:14:00.000Z'),
    });
  }, /不属于该批次|谱系/, '代理任务必须保持 batch → version → request 的批次谱系隔离');

  db.close();
  console.log('batch-proxy-task-schema tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
