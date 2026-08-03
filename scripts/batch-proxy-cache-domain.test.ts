// scripts/batch-proxy-cache-domain.test.ts
//
// D1 范围的 ProxyMediaCache 纯领域接口:computeProxyKey、pending 缓存项的
// 取或建、用量统计。真正的生成执行、原子发布、使用锁与安全清理属于 D2。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset } from '../lib/batch-production/assets.ts';
import {
  computeProxyKey,
  getOrCreatePendingProxyCacheItem,
  getProxyCacheItem,
  getProxyCacheUsage,
  listProjectProxyCacheItems,
  proxyRelativePath,
} from '../lib/batch-production/proxy-cache.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-cache-domain-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const asset = createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/proxy-cache-domain-asset.mp4' },
    contentFingerprint: 'sha256:proxy-cache-domain', mediaKind: 'video',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });

  const keyInput = {
    assetId: asset,
    contentFingerprint: 'sha256:proxy-cache-domain',
    profileVersion: 'proxy-v1',
    colorSnapshot: { lutId: null as string | null },
    colorPipelineVersion: 'color-v1',
  };
  const key = computeProxyKey(keyInput);
  assert.equal(key, computeProxyKey(keyInput), 'computeProxyKey 必须是确定性的纯函数');
  assert.ok(key.startsWith('sha256:'), 'proxyKey 应以 sha256: 开头');
  assert.equal(key.length, 71, 'proxyKey 应该是 sha256:<64 hex>(71 字符)');
  // 文件名必须是纯 hex(Windows 路径语义:冒号不能写进文件名),身份仍是规范 sha256:hex
  const fileName = proxyRelativePath('project-1', asset, key).split(/[\\/]/).at(-1)!;
  assert.equal(fileName, key.slice('sha256:'.length) + '.mp4', '代理文件名必须使用纯 hex(不带冒号)');
  assert.ok(!fileName.includes(':'), 'Windows 不允许冒号出现在文件名中');
  assert.equal(
    proxyRelativePath('project-1', asset, key),
    path.join('storage', 'cache', 'proxies', 'project-1', asset, `${key.slice('sha256:'.length)}.mp4`),
    '代理路径必须落在 storage/cache/proxies/<projectId>/<assetId>/ 下',
  );

  // --- 取或建:重复请求幂等返回同一行,不产生第二条 pending 记录 ---
  const first = getOrCreatePendingProxyCacheItem(db, 'project-1', {
    assetId: asset, proxyKey: key, profileVersion: 'proxy-v1', colorSnapshot: { lutId: null },
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  assert.equal(first.status, 'pending');
  const second = getOrCreatePendingProxyCacheItem(db, 'project-1', {
    assetId: asset, proxyKey: key, profileVersion: 'proxy-v1', colorSnapshot: { lutId: null },
    now: () => new Date('2026-08-03T08:03:00.000Z'),
  });
  assert.equal(second.id, first.id, '同一 proxyKey 重复请求必须复用同一缓存项,不产生重复行');
  assert.equal(listProjectProxyCacheItems(db, 'project-1').length, 1);

  assert.equal(getProxyCacheItem(db, 'project-1', first.id)?.status, 'pending');
  assert.equal(getProxyCacheUsage(db, 'project-1').count, 0, 'pending 状态不计入用量统计(只统计 ready)');

  db.prepare(`UPDATE batch_proxy_cache_items SET status = 'ready', fileSizeBytes = 5000 WHERE id = ?`).run(first.id);
  const usage = getProxyCacheUsage(db, 'project-1');
  assert.equal(usage.count, 1);
  assert.equal(usage.totalBytes, 5000);

  db.close();
  console.log('batch-proxy-cache-domain tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
