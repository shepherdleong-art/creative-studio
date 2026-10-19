// scripts/batch-export-preflight.test.ts
//
// 正式输出前置检查(交接文档 §4.3):只读校验,不建立 render 任务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-preflight-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const schemaModule = await import('../lib/batch-production/schema.ts');
const versionsModule = await import('../lib/batch-production/versions.ts');
const assetsModule = await import('../lib/batch-production/assets.ts');
const scriptsModule = await import('../lib/batch-production/scripts.ts');
const batchFlowModule = await import('../lib/batch-production/batch-flow.ts');
const lutCatalogModule = await import('../lib/batch-production/lut-catalog.ts');
const preflightModule = await import('../lib/batch-production/export-preflight.ts');
const proxyCacheModule = await import('../lib/batch-production/proxy-cache.ts');
const { computeFileSha256 } = await import('../lib/batch-production/media-catalog.ts');

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini', model TEXT,
      inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-03T00:00:00.000Z');
  `);
  return db;
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-preflight-work-'));

try {
  const dbRoot = path.join(workRoot, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await schemaModule.ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const sourcePath = path.join(workRoot, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', sourcePath]);

  const script = scriptsModule.createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'draft-a', title: '口播A', bodyText: '正文A', sourceVersion: '1',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  // 前置检查会重新对真实文件计算 SHA-256 并与登记的身份比较,
  // 因此这里必须使用文件的真实指纹,而不是像其他测试那样用占位字符串。
  const contentFingerprint = `sha256:${await computeFileSha256(sourcePath)}`;
  const asset = assetsModule.createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: sourcePath },
    contentFingerprint, mediaKind: 'video',
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('src-1', ?, 'linked', ?, 'healthy', ?)
  `).run(asset, JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), '2026-08-03T08:02:10.000Z');
  const analysis = assetsModule.createAnalysisVersion(db, {
    assetId: asset, analyzerVersion: '0.1.0', providerId: 'p', model: 'm',
    now: () => new Date('2026-08-03T08:02:30.000Z'),
  });

  const cubeContent = [
    'LUT_3D_SIZE 2',
    '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
    '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
  ].join('\n');
  const lutRelativePath = path.join('storage', 'luts', 'project-1', 'preflight.cube');
  const lutAbsolutePath = path.join(externalDataRoot, lutRelativePath);
  fs.mkdirSync(path.dirname(lutAbsolutePath), { recursive: true });
  fs.writeFileSync(lutAbsolutePath, cubeContent);
  const lutId = lutCatalogModule.createManagedLut(db, 'project-1', {
    contentFingerprint: `sha256:${await computeFileSha256(lutAbsolutePath)}`,
    displayName: 'Preflight LUT',
    relativePath: lutRelativePath,
    fileSizeBytes: cubeContent.length,
    now: () => new Date('2026-08-03T08:03:00.000Z'),
  });

  const batchId = versionsModule.createBatchProduction(db, 'project-1', '前置检查测试', () => new Date('2026-08-03T08:04:00.000Z'));
  const snapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId } }],
    now: () => new Date('2026-08-03T08:05:00.000Z'),
  });
  batchFlowModule.startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:06:00.000Z'));

  // --- 场景 1:原片在线、内容匹配、LUT 完整、FFmpeg 支持 lut3d -> 通过 ---
  const ready = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(ready.ready, true, `应该通过前置检查:${JSON.stringify(ready)}`);

  // --- 场景 2:原片内容变化(重新核验发现指纹不一致)-> 阻塞,不回退到代理或旧路径 ---
  fs.appendFileSync(sourcePath, 'tampered-bytes');
  const afterTamper = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(afterTamper.ready, false);
  if (!afterTamper.ready) {
    assert.ok(afterTamper.blockers.some((b) => b.code === 'source_content_changed'));
  }
  // 恢复原片内容,回到通过状态,证明检查是实时重新核验而不是缓存了失败结果
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', sourcePath]);
  const restored = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(restored.ready, true, '原片内容核验回真实指纹一致后必须恢复通过');

  // --- 场景 3:原片离线 -> 阻塞 ---
  db.prepare(`UPDATE batch_asset_sources SET health = 'offline' WHERE id = 'src-1'`).run();
  fs.unlinkSync(sourcePath);
  const offline = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(offline.ready, false);
  if (!offline.ready) {
    assert.ok(offline.blockers.some((b) => b.code === 'source_offline'));
  }
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', sourcePath]);
  db.prepare(`UPDATE batch_asset_sources SET health = 'healthy' WHERE id = 'src-1'`).run();

  // --- 场景 4:冻结 LUT 文件内容被篡改 -> 阻塞,不允许静默使用新内容或同名文件 ---
  fs.appendFileSync(lutAbsolutePath, '\n# tampered');
  const lutTampered = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(lutTampered.ready, false);
  if (!lutTampered.ready) {
    assert.ok(lutTampered.blockers.some((b) => b.code === 'lut_content_changed'));
  }

  // --- 场景 5:冻结 LUT 文件缺失 -> 阻塞 ---
  fs.writeFileSync(lutAbsolutePath, cubeContent); // restore then remove to isolate this case
  fs.unlinkSync(lutAbsolutePath);
  const lutMissing = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(lutMissing.ready, false);
  if (!lutMissing.ready) {
    assert.ok(lutMissing.blockers.some((b) => b.code === 'lut_missing'));
  }
  fs.writeFileSync(lutAbsolutePath, cubeContent);

  // --- 场景 6:清空全部代理缓存后,前置检查仍然只看原片与受管 LUT,结果不受影响 ---
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-unrelated', 'proxy-key-unrelated', 'project-1', ?, 'proxy-v1', '{"lutId":null}', 'storage/cache/proxies/project-1/x/y.mp4', 'ready', '{}', 10, 'sha256:x', NULL, ?, ?)
  `).run(asset, '2026-08-03T08:07:00.000Z', '2026-08-03T08:07:00.000Z');
  const cleanup = proxyCacheModule.cleanupProxyCache(db, 'project-1', {});
  assert.equal(proxyCacheModule.getProxyCacheUsage(db, 'project-1').count, 0, '代理缓存必须清空');
  void cleanup;
  const afterCleanup = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
  assert.equal(afterCleanup.ready, true, '清空全部代理后,前置检查仍必须只依据原片与受管 LUT 通过,不受代理状态影响');

  db.close();
  console.log('batch-export-preflight tests passed');
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}
