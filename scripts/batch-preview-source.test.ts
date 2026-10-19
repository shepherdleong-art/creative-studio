// scripts/batch-preview-source.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset } from '../lib/batch-production/assets.ts';
import { computeProxyKey } from '../lib/batch-production/proxy-cache.ts';
import { resolvePreviewSource } from '../lib/batch-production/preview.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-preview-source-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const fingerprint = 'sha256:preview-source-test';
  const asset = createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: '/tmp/preview-source-asset.mp4' },
    contentFingerprint: fingerprint, mediaKind: 'video',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('src-1', ?, 'linked', ?, 'healthy', ?)
  `).run(asset, JSON.stringify({ kind: 'linked', absolutePath: '/tmp/preview-source-asset.mp4' }), '2026-08-03T08:01:10.000Z');

  const baseInput = {
    assetId: asset,
    contentFingerprint: fingerprint,
    profileVersion: 'proxy-v1',
    colorPipelineVersion: 'color-v1',
  };

  // --- 场景 1:LUT 关闭、原片在线、没有代理 -> 直接用原片 ---
  const s1 = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: null } });
  assert.equal(s1.kind, 'original');
  assert.equal((s1 as { sourcePath: string }).sourcePath, '/tmp/preview-source-asset.mp4');

  // --- 场景 2:LUT 已启用、匹配代理尚未就绪、原片在线 -> 原片暂览 + 警告 ---
  const s2 = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: 'lut-1' } });
  assert.equal(s2.kind, 'original_pending_lut');
  assert.ok((s2 as { warning: string }).warning.includes('尚未应用'));

  // --- 场景 3:匹配代理就绪 -> 优先用代理,即使 LUT 已启用 ---
  const proxyKeyWithLut = computeProxyKey({ ...baseInput, colorSnapshot: { lutId: 'lut-1' } });
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-1', ?, 'project-1', ?, 'proxy-v1', '{"lutId":"lut-1"}', ?, 'ready', '{}', 1000, 'sha256:x', NULL, ?, ?)
  `).run(proxyKeyWithLut, asset, 'storage/cache/proxies/project-1/asset/key.mp4', '2026-08-03T08:02:00.000Z', '2026-08-03T08:02:00.000Z');
  const s3 = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: 'lut-1' } });
  assert.equal(s3.kind, 'proxy');
  assert.equal((s3 as { cacheItemId: string }).cacheItemId, 'cache-1');
  assert.equal((s3 as { originalOnline: boolean }).originalOnline, true, '原片在线时代理结果必须标注 originalOnline=true');

  // 关闭 LUT 的代理请求(不同 proxyKey)此时应该还没有就绪代理,回退到原片
  const s3Off = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: null } });
  assert.equal(s3Off.kind, 'original', 'LUT 快照不同的代理不能被跨快照复用');

  // --- 场景 4:原片离线,但匹配代理仍在 -> 继续用代理,标注原片离线 ---
  db.prepare(`UPDATE batch_asset_sources SET health = 'offline' WHERE id = 'src-1'`).run();
  const s4 = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: 'lut-1' } });
  assert.equal(s4.kind, 'proxy');
  assert.equal((s4 as { originalOnline: boolean }).originalOnline, false, '原片离线时必须明确标注,供前端提示正式导出不可用');

  // --- 场景 4b:pending-delete 已承诺删除的代理不能重新进入预览解析 ---
  db.prepare(`UPDATE batch_proxy_cache_items SET pendingDeleteAt = ? WHERE id = 'cache-1'`)
    .run('2026-08-03T08:03:00.000Z');
  const pendingDeletePreview = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: 'lut-1' } });
  assert.equal(pendingDeletePreview.kind, 'unavailable', 'pending-delete 代理必须从可用预览候选中排除');

  // --- 场景 5:原片离线、LUT 关闭且没有代理 -> 预览不可用 ---
  const s5 = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: null } });
  assert.equal(s5.kind, 'unavailable');

  // --- 场景 6:原片离线、LUT 启用但代理未就绪(换一个还没生成代理的新 LUT) -> 预览不可用 ---
  const s6 = resolvePreviewSource(db, 'project-1', { ...baseInput, colorSnapshot: { lutId: 'lut-2-never-generated' } });
  assert.equal(s6.kind, 'unavailable');

  db.close();
  console.log('batch-preview-source tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
