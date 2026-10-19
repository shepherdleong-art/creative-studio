// scripts/batch-proxy-generation-abort.test.ts
//
// 真实 FFmpeg 端到端验证:任务级取消一个正在真实编码中的 proxy_generate 任务后,
// 底层 FFmpeg 子进程必须真正终止,不能留下正式的半成品代理(pending/临时文件都不行)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-abort-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const schemaModule = await import('../lib/batch-production/schema.ts');
const versionsModule = await import('../lib/batch-production/versions.ts');
const assetsModule = await import('../lib/batch-production/assets.ts');
const scriptsModule = await import('../lib/batch-production/scripts.ts');
const batchFlowModule = await import('../lib/batch-production/batch-flow.ts');
const proxyCacheModule = await import('../lib/batch-production/proxy-cache.ts');
const proxyExecutorModule = await import('../lib/batch-production/proxy-executor.ts');
const schedulerModule = await import('../lib/batch-production/scheduler.ts');
const runnerModule = await import('../lib/batch-production/runner.ts');

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

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-abort-work-'));

try {
  const dbRoot = path.join(workRoot, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await schemaModule.ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // 4K + testsrc2(比 testsrc 更复杂的图案)让真实下采样编码有约 1~2 秒可中途取消的窗口;
  // 普通 1080p/720p 源在这台机器上编码快到 <0.2s,不足以可靠验证"中途"取消。
  const sourcePath = path.join(workRoot, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=25:size=3840x2160:rate=30', '-pix_fmt', 'yuv420p', '-y', sourcePath]);
  const { computeFileSha256: computeAbortHash } = await import('../lib/batch-production/media-catalog.ts');
  const sourceHash = await computeAbortHash(sourcePath);

  const script = scriptsModule.createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'draft-a', title: '口播A', bodyText: '正文A', sourceVersion: '1',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const contentFingerprint = `sha256:${sourceHash}`;
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

  const batchId = versionsModule.createBatchProduction(db, 'project-1', '代理取消真实验证', () => new Date('2026-08-03T08:03:00.000Z'));
  batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: null } }],
    now: () => new Date('2026-08-03T08:04:00.000Z'),
  });
  batchFlowModule.startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:05:00.000Z'));

  const { taskId, cacheItemId } = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
    assetId: asset,
    contentFingerprint,
    colorSnapshot: { lutId: null },
    profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
    colorPipelineVersion: 'color-v1',
    now: () => new Date('2026-08-03T08:06:00.000Z'),
  });

  const runPromise = runnerModule.runPendingOnce({
    db,
    workerId: 'worker-abort-test',
    executors: [proxyExecutorModule.proxyGenerateExecutor],
    concurrency: 1,
    leaseDurationMs: 60_000,
    heartbeatMs: 200,
  });

  // 等任务真正进入 running(领取成功、执行器已经开始跑 locating/preflight/probing),
  // 再等一小段缓冲时间落在真实编码窗口内(4K 源下采样编码约 1~2 秒),然后触发取消。
  const claimDeadline = Date.now() + 15_000;
  let sawRunning = false;
  while (Date.now() < claimDeadline) {
    const row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(taskId) as { status: string } | undefined;
    if (row?.status === 'running') { sawRunning = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(sawRunning, '任务必须先被领取并进入 running,才能验证中途取消');
  await new Promise((resolve) => setTimeout(resolve, 400));

  schedulerModule.cancelTask(db, 'project-1', taskId);
  await runPromise;

  const finalTask = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(taskId) as { status: string };
  assert.equal(finalTask.status, 'cancelled', '被取消的代理任务必须进入 cancelled 终态');

  const finalCacheItem = proxyCacheModule.getProxyCacheItem(db, 'project-1', cacheItemId);
  assert.notEqual(finalCacheItem?.status, 'ready', '取消后不能把半成品代理标记为 ready');

  const proxiesAssetDir = path.dirname(proxyCacheModule.resolveControlledProxyPath(finalCacheItem!.relativePath));
  const leftoverFiles = fs.existsSync(proxiesAssetDir) ? fs.readdirSync(proxiesAssetDir) : [];
  assert.deepEqual(leftoverFiles, [], '取消后受控代理目录下不能残留任何临时文件或半成品正式文件');

  db.close();
  console.log('batch-proxy-generation-abort (real ffmpeg) tests passed');
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}
