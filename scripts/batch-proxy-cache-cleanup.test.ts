// scripts/batch-proxy-cache-cleanup.test.ts
//
// Phase D ProxyMediaCache 清理回归(交接文档 §6.1、§10):
//   - 代理集中写入 dataRoot()/storage/cache/proxies/<projectId>/<assetId>/<proxyKey>.mp4。
//   - 清理只删除受控代理目录中的已核验缓存,拒绝符号链接、越界路径和任意绝对路径。
//   - 正在被读取租约占用的缓存先跳过并标记 pending-delete,释放后才真正删除。
//   - 项目 A 不能清理或统计到项目 B 的代理。
//   - 清理返回准确的实际删除数量、实际释放空间与跳过数量。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// dataRoot() 在模块首次加载时解析:必须先设置 CREATIVE_STUDIO_DATA_ROOT,
// 再动态导入依赖 dataRoot 的模块。
const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-cache-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

// 动态导入保证 dataRoot 环境变量在模块首次解析前已经设置。
const proxyCache = await import('../lib/batch-production/proxy-cache.ts');
const schemaModule = await import('../lib/batch-production/schema.ts');
const versionsModule = await import('../lib/batch-production/versions.ts');
const assetsModule = await import('../lib/batch-production/assets.ts');

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-cache-db-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await schemaModule.ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const assetP1 = assetsModule.createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/fake-p1.mp4' },
    contentFingerprint: 'sha256:proxy-cache-p1',
    mediaKind: 'video',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const assetP2 = assetsModule.createAsset(db, {
    projectId: 'project-2',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/fake-p2.mp4' },
    contentFingerprint: 'sha256:proxy-cache-p2',
    mediaKind: 'video',
    now: () => new Date('2026-08-03T08:01:30.000Z'),
  });
  void versionsModule;

  const proxiesRoot = path.join(externalDataRoot, 'storage', 'cache', 'proxies');

  function writeProxyFile(relativePath: string, bytes: number): string {
    const absolute = path.join(externalDataRoot, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.alloc(bytes, 1));
    return absolute;
  }

  // --- 场景 1:proxyKey 必须由原片指纹、profile、色彩快照和色彩链版本共同决定,
  //             任一变化都必须形成不同的 key(旧代理不会被新请求误用)。
  const baseInput = {
    assetId: assetP1,
    contentFingerprint: 'sha256:proxy-cache-p1',
    profileVersion: 'proxy-v1',
    colorSnapshot: { lutId: null as string | null },
    colorPipelineVersion: 'color-v1',
  };
  const keyOff = proxyCache.computeProxyKey(baseInput);
  const keyWithLut = proxyCache.computeProxyKey({ ...baseInput, colorSnapshot: { lutId: 'lut-1' } });
  const keyNewProfile = proxyCache.computeProxyKey({ ...baseInput, profileVersion: 'proxy-v2' });
  assert.notEqual(keyOff, keyWithLut, 'LUT 选择变化必须产生不同的 proxyKey');
  assert.notEqual(keyOff, keyNewProfile, '代理规格版本变化必须产生不同的 proxyKey');

  // --- 场景 2:清理必须拒绝越界/绝对路径,只删除受控代理根下的文件 ---
  const goodRelative = path.join('storage', 'cache', 'proxies', 'project-1', assetP1, `${keyOff}.mp4`);
  writeProxyFile(goodRelative, 1024);
  const outsideTarget = path.join(os.tmpdir(), 'creative-studio-proxy-cache-outside-victim.mp4');
  fs.writeFileSync(outsideTarget, Buffer.alloc(512, 2));
  const maliciousRelative = path.join('storage', 'cache', 'proxies', 'project-1', assetP1, '..', '..', '..', '..', path.relative(externalDataRoot, outsideTarget));

  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES (?, ?, 'project-1', ?, 'proxy-v1', '{"lutId":null}', ?, 'ready', '{}', 1024, 'sha256:good', NULL, ?, ?)
  `).run('cache-good', keyOff, assetP1, goodRelative, '2026-08-03T08:02:00.000Z', '2026-08-03T08:02:00.000Z');
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES (?, 'proxy-key-malicious', 'project-1', ?, 'proxy-v1', '{"lutId":null}', ?, 'ready', '{}', 512, 'sha256:bad', NULL, ?, ?)
  `).run('cache-malicious', assetP1, maliciousRelative, '2026-08-03T08:02:10.000Z', '2026-08-03T08:02:10.000Z');

  const cleanup1 = proxyCache.cleanupProxyCache(db, 'project-1', {});
  assert.ok(fs.existsSync(outsideTarget), '越界路径必须被拒绝,不能删除受控代理根之外的任何文件');
  assert.equal(fs.existsSync(outsideTarget) && fs.statSync(outsideTarget).size, 512, '越界目标文件内容不能被清理动作影响');
  assert.equal(cleanup1.deletedCount, 1, '本轮只应该真正删除受控根内的合法缓存项');
  assert.equal(cleanup1.skippedCount, 1, '越界记录必须被拒绝处理(不删文件也不删记录),计入 skipped 供排查');
  assert.ok(!fs.existsSync(path.join(externalDataRoot, goodRelative)), '受控根内的合法缓存文件必须被删除');
  // 越界记录本身的处理行为已经验证完毕;清掉这条测试专用脏数据,
  // 避免它在后续场景里持续计入 skippedCount 造成断言噪音。
  db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = 'cache-malicious'`).run();

  // --- 场景 3:正在被读取租约占用的缓存必须跳过并标记 pending-delete,释放后才真正删除 ---
  const leasedRelative = path.join('storage', 'cache', 'proxies', 'project-1', assetP1, 'leased.mp4');
  writeProxyFile(leasedRelative, 2048);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-leased', 'proxy-key-leased', 'project-1', ?, 'proxy-v1', '{"lutId":null}', ?, 'ready', '{}', 2048, 'sha256:leased', NULL, ?, ?)
  `).run(assetP1, leasedRelative, '2026-08-03T08:03:00.000Z', '2026-08-03T08:03:00.000Z');

  const release = proxyCache.acquireProxyReadLease('cache-leased');
  const cleanupWhileLeased = proxyCache.cleanupProxyCache(db, 'project-1', {});
  assert.equal(cleanupWhileLeased.skippedCount, 1, '正在使用中的代理必须被跳过,不能一边使用一边删除');
  assert.ok(fs.existsSync(path.join(externalDataRoot, leasedRelative)), '使用中的代理文件在释放前不能被物理删除');
  const leasedRowWhileHeld = db.prepare(`SELECT pendingDeleteAt FROM batch_proxy_cache_items WHERE id = 'cache-leased'`).get() as {
    pendingDeleteAt: string | null;
  };
  assert.ok(leasedRowWhileHeld.pendingDeleteAt, '使用中的缓存必须被标记 pending-delete,以便释放后完成清理');

  release();
  const cleanupAfterRelease = proxyCache.cleanupProxyCache(db, 'project-1', {});
  assert.equal(cleanupAfterRelease.deletedCount, 1, '释放读取租约后,pending-delete 的缓存必须在下一轮清理中真正删除');
  assert.ok(!fs.existsSync(path.join(externalDataRoot, leasedRelative)), '释放后代理文件必须被物理删除');

  // --- 场景 3b:pending-delete 必须能跨进程重启恢复收尾 ---
  const restartRelative = path.join('storage', 'cache', 'proxies', 'project-1', assetP1, 'restart-pending.mp4');
  writeProxyFile(restartRelative, 1536);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-restart-pending', 'proxy-key-restart-pending', 'project-1', ?, 'proxy-v1', '{"lutId":null}', ?, 'ready', '{}', 1536, 'sha256:restart', ?, ?, ?)
  `).run(
    assetP1,
    restartRelative,
    '2026-08-03T08:03:20.000Z',
    '2026-08-03T08:03:10.000Z',
    '2026-08-03T08:03:20.000Z',
  );
  proxyCache.resetProxyLeasesForTests(); // 模拟进程重启：内存租约已经消失
  assert.equal(proxyCache.completePendingProxyDeletions(db), 1, '重启恢复必须自动完成持久化 pending-delete');
  assert.ok(!fs.existsSync(path.join(externalDataRoot, restartRelative)), '重启恢复必须删除待清理文件');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_proxy_cache_items WHERE id = 'cache-restart-pending'`).get() as { n: number }).n,
    0,
    '文件删除成功后必须同时删除缓存记录',
  );

  // --- 场景 4:项目隔离——项目 2 的清理不能影响项目 1,项目 1 的清理也统计不到项目 2 ---
  const p2Relative = path.join('storage', 'cache', 'proxies', 'project-2', assetP2, 'p2-proxy.mp4');
  writeProxyFile(p2Relative, 4096);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-p2', 'proxy-key-p2', 'project-2', ?, 'proxy-v1', '{"lutId":null}', ?, 'ready', '{}', 4096, 'sha256:p2', NULL, ?, ?)
  `).run(assetP2, p2Relative, '2026-08-03T08:04:00.000Z', '2026-08-03T08:04:00.000Z');

  const usageProject1 = proxyCache.getProxyCacheUsage(db, 'project-1');
  assert.equal(usageProject1.count, 0, '项目 1 清理干净后,用量统计不应该看到项目 2 的缓存');

  const cleanupProject1Again = proxyCache.cleanupProxyCache(db, 'project-1', {});
  assert.equal(cleanupProject1Again.deletedCount, 0, '项目 1 已经没有可清理项时不应该误删');
  assert.ok(fs.existsSync(path.join(externalDataRoot, p2Relative)), '清理项目 1 绝不能删除项目 2 的代理文件');

  const usageProject2 = proxyCache.getProxyCacheUsage(db, 'project-2');
  assert.equal(usageProject2.count, 1, '项目 2 的用量统计必须看到自己的缓存');
  assert.equal(usageProject2.totalBytes, 4096);

  // --- 场景 5:符号链接必须被真实拒绝,不能借符号链接删除受控目录之外的文件 ---
  const symlinkVictim = path.join(os.tmpdir(), 'creative-studio-proxy-cache-symlink-victim.mp4');
  fs.writeFileSync(symlinkVictim, Buffer.alloc(256, 3));
  const symlinkRelative = path.join('storage', 'cache', 'proxies', 'project-1', assetP1, 'symlinked.mp4');
  const symlinkAbsolute = path.join(externalDataRoot, symlinkRelative);
  fs.mkdirSync(path.dirname(symlinkAbsolute), { recursive: true });
  fs.symlinkSync(symlinkVictim, symlinkAbsolute);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-symlink', 'proxy-key-symlink', 'project-1', ?, 'proxy-v1', '{"lutId":null}', ?, 'ready', '{}', 256, 'sha256:symlink', NULL, ?, ?)
  `).run(assetP1, symlinkRelative, '2026-08-03T08:05:00.000Z', '2026-08-03T08:05:00.000Z');

  const cleanupSymlink = proxyCache.cleanupProxyCache(db, 'project-1', {});
  assert.equal(cleanupSymlink.skippedCount, 1, '符号链接缓存项必须被拒绝处理,计入 skipped');
  assert.ok(fs.existsSync(symlinkVictim), '绝不能通过符号链接删除受控代理根之外的真实文件');
  assert.equal(fs.readFileSync(symlinkVictim).length, 256, '符号链接指向的外部文件内容不能被清理动作影响');
  fs.rmSync(symlinkVictim, { force: true });

  void proxiesRoot;
  db.close();
  console.log('batch-proxy-cache-cleanup tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}
