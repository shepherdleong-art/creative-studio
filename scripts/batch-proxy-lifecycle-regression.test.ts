// scripts/batch-proxy-lifecycle-regression.test.ts
//
// Phase D 修复回归(真实 FFmpeg):
// b. 完整 LUT 快照:服务端按受管 LUT 构建,拒绝空指纹绕过;
// c. LUT 文件被合法替换后 executor/preflight 都必须阻塞;
// d. cache 清理 → 用户再次明确请求 → 生成成功(清理不自动重建);
// e. succeeded/failed/cancelled 历史任务不会卡住重建;
// f. 生成写租约与 pending-delete 自动完成(释放租约即删除,不需要再点一次清理);
// g. 清理与 FFmpeg 并发取消不产生孤儿文件、不留下永久 pending 缓存;
// h. Windows 安全路径(文件名纯 hex,冒号不进文件名)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-lifecycle-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const schemaModule = await import('../lib/batch-production/schema.ts');
const versionsModule = await import('../lib/batch-production/versions.ts');
const assetsModule = await import('../lib/batch-production/assets.ts');
const scriptsModule = await import('../lib/batch-production/scripts.ts');
const batchFlowModule = await import('../lib/batch-production/batch-flow.ts');
const lutCatalogModule = await import('../lib/batch-production/lut-catalog.ts');
const proxyCacheModule = await import('../lib/batch-production/proxy-cache.ts');
const proxyExecutorModule = await import('../lib/batch-production/proxy-executor.ts');
const executorsModule = await import('../lib/batch-production/executors.ts');
const runnerModule = await import('../lib/batch-production/runner.ts');
const schedulerModule = await import('../lib/batch-production/scheduler.ts');
const preflightModule = await import('../lib/batch-production/export-preflight.ts');
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

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-lifecycle-work-'));

async function makeSourceVideo(filePath: string, seconds = 3): Promise<string> {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=640x360:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', filePath,
  ]);
  return `sha256:${await computeFileSha256(filePath)}`;
}

async function waitForTaskStatus(db: Database.Database, taskId: string, wanted: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(taskId) as { status: string } | undefined;
    if (row && row.status === wanted) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const row = db.prepare(`SELECT status, errorMessage FROM batch_tasks WHERE id = ?`).get(taskId) as { status: string; errorMessage?: string } | undefined;
  throw new Error(`任务未在 ${timeoutMs}ms 内到达 ${wanted}(当前 ${row?.status}${row?.errorMessage ? `, ${row.errorMessage}` : ''})`);
}

function listFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

async function setupBatchWithSource(): Promise<{ db: Database.Database; sourcePath: string; fingerprint: string; assetId: string; analysisId: string; batchId: string; batchVersionId: string }> {
  const dbRoot = path.join(workRoot, `db-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await schemaModule.ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  const sourcePath = path.join(workRoot, `source-${Math.random().toString(36).slice(2)}.mp4`);
  const fingerprint = await makeSourceVideo(sourcePath);
  const script = scriptsModule.createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'draft-a', title: '口播A', bodyText: '正文A', sourceVersion: '1',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const assetId = assetsModule.createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: sourcePath },
    contentFingerprint: fingerprint, mediaKind: 'video',
    now: () => new Date('2026-08-03T08:02:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run(`src-${Math.random().toString(36).slice(2)}`, assetId, JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), '2026-08-03T08:02:10.000Z');
  const analysisId = assetsModule.createAnalysisVersion(db, {
    assetId, analyzerVersion: '0.1.0', providerId: 'p', model: 'm',
    now: () => new Date('2026-08-03T08:02:30.000Z'),
  });
  const batchId = versionsModule.createBatchProduction(db, 'project-1', '生命周期回归', () => new Date('2026-08-03T08:03:00.000Z'));
  const snapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId, colorSnapshot: { lutId: null } }],
    now: () => new Date('2026-08-03T08:04:00.000Z'),
  });
  batchFlowModule.startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:05:00.000Z'));
  return { db, sourcePath, fingerprint, assetId, analysisId, batchId, batchVersionId: snapshot.batchVersionId };
}

const cubeContent = [
  'LUT_3D_SIZE 2',
  '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
  '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
].join('\n');

try {
  // ================================================================
  // b. 完整 LUT 快照:resolveColorSnapshot 构建完整快照;空指纹绕过被拒绝
  // ================================================================
  {
    const { db, assetId, analysisId, batchId } = await setupBatchWithSource();
    const lutRelativePath = path.join('storage', 'luts', 'project-1', 'identity.cube');
    const lutAbsolutePath = path.join(externalDataRoot, lutRelativePath);
    fs.mkdirSync(path.dirname(lutAbsolutePath), { recursive: true });
    fs.writeFileSync(lutAbsolutePath, cubeContent);
    const lutId = lutCatalogModule.createManagedLut(db, 'project-1', {
      contentFingerprint: `sha256:${await computeFileSha256(lutAbsolutePath)}`,
      displayName: 'Identity LUT',
      relativePath: lutRelativePath,
      fileSizeBytes: cubeContent.length,
      now: () => new Date('2026-08-03T08:06:00.000Z'),
    });

    // 客户端只提交 lutId → 服务端 resolveColorSnapshot 补齐完整快照
    const snapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
      scriptSelections: [{ scriptId: (db.prepare(`SELECT id FROM batch_scripts LIMIT 1`).get() as { id: string }).id, copyCount: 1 }],
      assetSelections: [{ assetId, analysisId, colorSnapshot: { lutId } }],
      now: () => new Date('2026-08-03T08:07:00.000Z'),
    });
    const poolRow = db.prepare(`
      SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?
    `).get(snapshot.batchVersionId, assetId) as { colorJson: string };
    const parsed = JSON.parse(poolRow.colorJson) as Record<string, unknown>;
    assert.equal(parsed.lutId, lutId);
    assert.ok(typeof parsed.lutFingerprint === 'string' && parsed.lutFingerprint.length > 0, '服务端必须补齐非空 LUT 指纹');
    assert.equal(parsed.colorPipelineVersion, 'color-v1');
    assert.equal(parsed.interpolation, 'trilinear');
    assert.equal(parsed.outputContract, 'sdr-v1');

    // 空字符串指纹绕过:直接调 addAssetToPool 携带空指纹必须被拒绝
    assert.throws(() => {
      versionsModule.addAssetToPool(db, snapshot.batchVersionId, {
        assetId,
        analysisId,
        colorSnapshot: { lutId, lutFingerprint: '', colorPipelineVersion: 'color-v1', interpolation: 'trilinear', outputContract: 'sdr-v1' },
      });
    }, /指纹缺失或与受管内容不一致/, '引用 LUT 但空指纹的快照必须被拒绝');

    // 错误指纹也必须被拒绝
    assert.throws(() => {
      versionsModule.addAssetToPool(db, snapshot.batchVersionId, {
        assetId,
        analysisId,
        colorSnapshot: { lutId, lutFingerprint: `sha256:${'e'.repeat(64)}`, colorPipelineVersion: 'color-v1', interpolation: 'trilinear', outputContract: 'sdr-v1' },
      });
    }, /指纹缺失或与受管内容不一致/, '与受管内容不一致的指纹必须被拒绝');
    db.close();
  }

  // ================================================================
  // d/e/f:清理 → 重新请求 → 生成成功;历史终态不卡住;读租约释放自动完成删除
  // ================================================================
  {
    const { db, sourcePath, fingerprint, assetId, batchId, batchVersionId } = await setupBatchWithSource();
    void sourcePath;
    const first = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:06:00.000Z'),
    });
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-1',
      executors: [executorsModule.analyzeAssetExecutor, proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 2, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, first.taskId, 'succeeded');
    const readyCache = proxyCacheModule.getProxyCacheItem(db, 'project-1', first.cacheItemId);
    assert.equal(readyCache?.status, 'ready', '首次生成必须成功');

    // 同一素材/色彩/profile 在另一个批次版本中请求时应复用 ready cache。
    // 两个批次各自拥有可见/可控的任务，但后到任务只做 ready 复用，不能重复编码。
    const otherBatchId = versionsModule.createBatchProduction(
      db,
      'project-1',
      '跨批次复用回归',
      () => new Date('2026-08-03T08:05:30.000Z'),
    );
    const scriptId = (db.prepare(`SELECT id FROM batch_scripts LIMIT 1`).get() as { id: string }).id;
    const analysisId = (db.prepare(`SELECT currentAnalysisId FROM batch_assets WHERE id = ?`).get(assetId) as {
      currentAnalysisId: string;
    }).currentAnalysisId;
    const otherSnapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', otherBatchId, {
      scriptSelections: [{ scriptId, copyCount: 1 }],
      assetSelections: [{ assetId, analysisId, colorSnapshot: { lutId: null } }],
      now: () => new Date('2026-08-03T08:05:40.000Z'),
    });
    const readyProxyPath = proxyCacheModule.resolveControlledProxyPath(readyCache!.relativePath);
    const readyProxyMtimeMs = fs.statSync(readyProxyPath).mtimeMs;
    const taskCountBeforeReuse = (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'proxy_generate'`).get() as { n: number }).n;
    const reused = proxyCacheModule.requestProxy(db, 'project-1', otherBatchId, {
      assetId,
      contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId: otherSnapshot.batchVersionId,
      now: () => new Date('2026-08-03T08:05:50.000Z'),
    });
    assert.equal(reused.cacheItemId, first.cacheItemId, '跨批次相同 proxyKey 必须复用同一 cache');
    assert.equal(proxyCacheModule.getProxyCacheItem(db, 'project-1', reused.cacheItemId)?.status, 'ready', '复用 ready cache 不能把状态降回 pending');
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'proxy_generate'`).get() as { n: number }).n,
      taskCountBeforeReuse + 1,
      '跨批次请求必须建立该批次自己的可见/可控任务',
    );
    assert.notEqual(reused.taskId, first.taskId, '跨批次不得借用另一个批次的任务身份');
    assert.equal(
      (db.prepare(`SELECT batchId FROM batch_tasks WHERE id = ?`).get(reused.taskId) as { batchId: string }).batchId,
      otherBatchId,
      '复用任务必须能从当前批次任务列表查询到',
    );
    assert.equal(
      (db.prepare(`SELECT status FROM batch_proxy_requests WHERE id = ?`).get(reused.requestId) as { status: string }).status,
      'ready',
      '复用 ready cache 的新批次请求必须立即收敛为 ready',
    );
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-ready-reuse',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, reused.taskId, 'succeeded');
    assert.equal(fs.statSync(readyProxyPath).mtimeMs, readyProxyMtimeMs, 'ready 复用任务不得再次编码或覆盖文件');

    // f. 读租约:清理时跳过并标记 pending-delete,释放后自动完成删除(不再要求再点一次)
    const release = proxyCacheModule.acquireProxyReadLease(first.cacheItemId, db);
    const cleanupWhileLeased = proxyCacheModule.cleanupProxyCache(db, 'project-1', {});
    assert.equal(cleanupWhileLeased.deletedCount, 0);
    assert.equal(cleanupWhileLeased.skippedCount, 1);
    const pendingRow = db.prepare(`SELECT pendingDeleteAt FROM batch_proxy_cache_items WHERE id = ?`).get(first.cacheItemId) as { pendingDeleteAt: string | null };
    assert.ok(pendingRow.pendingDeleteAt, '使用中的缓存必须被持久化标记 pending-delete');
    const proxyFile = proxyCacheModule.resolveControlledProxyPath(readyCache!.relativePath);
    assert.ok(fs.existsSync(proxyFile), '租约释放前文件不能被删除');
    const requestAfterCleanup = db.prepare(`SELECT status FROM batch_proxy_requests WHERE id = ?`).get(first.requestId) as { status: string };
    assert.equal(requestAfterCleanup.status, 'cancelled', '清理必须把请求收敛为 cancelled');

    release(); // 自动完成删除
    assert.ok(!fs.existsSync(proxyFile), '最后一个租约释放后必须自动完成删除');
    assert.equal(proxyCacheModule.getProxyCacheItem(db, 'project-1', first.cacheItemId), undefined, '释放后缓存记录必须被删除');
    const requestRow = db.prepare(`SELECT currentCacheItemId, status FROM batch_proxy_requests WHERE id = ?`).get(first.requestId) as { currentCacheItemId: string | null; status: string };
    assert.equal(requestRow.currentCacheItemId, null, 'cache 删除后请求的 cache 引用必须清空(FK SET NULL)');
    assert.equal(requestRow.status, 'cancelled');
    // 清理绝不自动重建:此时没有任何新任务
    const tasksAfterCleanup = db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'proxy_generate'`).get() as { n: number };
    assert.equal(tasksAfterCleanup.n, 2, '清理后不得自动重建代理任务');

    // e + d. 用户再次明确请求:旧 succeeded 任务不卡 requestKey,新任务生成成功
    const second = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:07:00.000Z'),
    });
    assert.notEqual(second.taskId, first.taskId, '清理后重新请求必须形成新任务');
    assert.equal(second.requestId, first.requestId, '请求身份必须保持稳定');
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-2',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, second.taskId, 'succeeded');
    assert.equal(proxyCacheModule.getProxyCacheItem(db, 'project-1', second.cacheItemId)?.status, 'ready', '清理后重新请求必须生成成功');
    const requestAfterRebuild = db.prepare(`SELECT status, currentCacheItemId FROM batch_proxy_requests WHERE id = ?`).get(first.requestId) as { status: string; currentCacheItemId: string | null };
    assert.equal(requestAfterRebuild.status, 'ready');
    assert.equal(requestAfterRebuild.currentCacheItemId, second.cacheItemId);

    // e. succeeded/failed/cancelled 历史任务都不会卡住重建(缓存被清理后)。
    // e1:succeeded 历史 + 缓存被清理 → 重建。
    db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ?`).run(second.cacheItemId);
    const rebuiltAfterDelete = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:09:00.000Z'),
    });
    assert.notEqual(rebuiltAfterDelete.taskId, first.taskId, '缓存删除后 succeeded 历史任务不能卡住重建');
    assert.notEqual(rebuiltAfterDelete.taskId, second.taskId, '重建必须形成新任务');
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-3',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, rebuiltAfterDelete.taskId, 'succeeded');

    // e2:cancelled 历史 + 缓存被清理 → 重建。
    db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ?`).run(rebuiltAfterDelete.cacheItemId);
    const queued = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:10:00.000Z'),
    });
    schedulerModule.cancelTask(db, 'project-1', queued.taskId);
    await waitForTaskStatus(db, queued.taskId, 'cancelled');
    const afterCancel = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:11:00.000Z'),
    });
    assert.notEqual(afterCancel.taskId, queued.taskId, 'cancelled 历史任务不能卡住重建');
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-4',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, afterCancel.taskId, 'succeeded');

    // e3:failed 历史 + 缓存被清理 → 重建。
    db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ?`).run(afterCancel.cacheItemId);
    db.prepare(`UPDATE batch_tasks SET status = 'failed' WHERE id = ?`).run(afterCancel.taskId);
    const afterDeadCache = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:12:00.000Z'),
    });
    assert.notEqual(afterDeadCache.taskId, afterCancel.taskId, 'failed + 缓存已死的历史任务不能卡住重建');
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-5',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, afterDeadCache.taskId, 'succeeded');
    db.close();
  }

  // ================================================================
  // 跨批次生成中复用:各批次有独立任务；取消 A 后 B 仍能继续生成共享 cache
  // ================================================================
  {
    const { db, fingerprint, assetId, analysisId, batchId, batchVersionId } = await setupBatchWithSource();
    const first = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId,
      contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:13:00.000Z'),
    });

    const otherBatchId = versionsModule.createBatchProduction(
      db,
      'project-1',
      '生成中跨批次复用',
      () => new Date('2026-08-03T08:13:10.000Z'),
    );
    const scriptId = (db.prepare(`SELECT id FROM batch_scripts LIMIT 1`).get() as { id: string }).id;
    const otherSnapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', otherBatchId, {
      scriptSelections: [{ scriptId, copyCount: 1 }],
      assetSelections: [{ assetId, analysisId, colorSnapshot: { lutId: null } }],
      now: () => new Date('2026-08-03T08:13:20.000Z'),
    });
    const second = proxyCacheModule.requestProxy(db, 'project-1', otherBatchId, {
      assetId,
      contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId: otherSnapshot.batchVersionId,
      now: () => new Date('2026-08-03T08:13:30.000Z'),
    });

    assert.equal(second.cacheItemId, first.cacheItemId, '生成中相同 proxyKey 必须共享 cache');
    assert.notEqual(second.taskId, first.taskId, '不同批次必须各自拥有可控任务');
    assert.equal(
      (db.prepare(`SELECT batchId FROM batch_tasks WHERE id = ?`).get(second.taskId) as { batchId: string }).batchId,
      otherBatchId,
    );

    schedulerModule.cancelTask(db, 'project-1', first.taskId);
    assert.equal(
      (db.prepare(`SELECT status FROM batch_proxy_requests WHERE id = ?`).get(first.requestId) as { status: string }).status,
      'cancelled',
      '取消批次 A 的任务必须只取消 A 的稳定请求',
    );
    assert.equal(
      (db.prepare(`SELECT status FROM batch_proxy_requests WHERE id = ?`).get(second.requestId) as { status: string }).status,
      'requested',
      '批次 B 的请求不能被 A 的任务控制影响',
    );

    await runnerModule.runPendingOnce({
      db,
      workerId: 'worker-cross-batch-survivor',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1,
      leaseDurationMs: 60_000,
      heartbeatMs: 500,
    });
    await waitForTaskStatus(db, second.taskId, 'succeeded');
    assert.equal(proxyCacheModule.getProxyCacheItem(db, 'project-1', second.cacheItemId)?.status, 'ready');
    assert.equal(
      (db.prepare(`SELECT status FROM batch_proxy_requests WHERE id = ?`).get(second.requestId) as { status: string }).status,
      'ready',
      'A 取消后 B 必须仍能独立完成共享代理',
    );
    db.close();
  }

  // ================================================================
  // 请求冻结的原片指纹是 executor 权威输入；batch_assets 后续变化不能改写旧 proxyKey
  // ================================================================
  {
    const { db, sourcePath, fingerprint, assetId, batchId, batchVersionId } = await setupBatchWithSource();
    const request = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId,
      contentFingerprint: fingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:20:00.000Z'),
    });
    await makeSourceVideo(sourcePath, 4);
    const replacementFingerprint = `sha256:${await computeFileSha256(sourcePath)}`;
    assert.notEqual(replacementFingerprint, fingerprint, '测试前提:替换后的原片内容必须变化');
    db.prepare(`UPDATE batch_assets SET contentFingerprint = ? WHERE id = ?`).run(replacementFingerprint, assetId);

    await runnerModule.runPendingOnce({
      db,
      workerId: 'worker-frozen-source-fingerprint',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1,
      leaseDurationMs: 60_000,
      heartbeatMs: 500,
    });
    await waitForTaskStatus(db, request.taskId, 'failed');
    assert.equal(
      proxyCacheModule.getProxyCacheItem(db, 'project-1', request.cacheItemId)?.status,
      'failed',
      '原片变化后即使 batch_assets 行也被改写，旧请求仍必须按冻结指纹失败',
    );
    db.close();
  }

  // ================================================================
  // g. 生成写租约与清理并发:清理只标记 pending-delete;executor 放弃发布;
  //     取消/清理后不留下正式文件、孤儿文件或永久 pending 缓存
  // ================================================================
  {
    const { db, sourcePath, assetId, batchId, batchVersionId } = await setupBatchWithSource();
    // 4K 长源:留出可中途取消的编码窗口
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=25:size=3840x2160:rate=30', '-pix_fmt', 'yuv420p', '-y', sourcePath]);
    const bigFingerprint = `sha256:${await computeFileSha256(sourcePath)}`;
    db.prepare(`UPDATE batch_assets SET contentFingerprint = ? WHERE id = ?`).run(bigFingerprint, assetId);
    db.prepare(`UPDATE batch_asset_sources SET locationJson = ? WHERE assetId = ?`).run(
      JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), assetId,
    );

    const request = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: bigFingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:09:00.000Z'),
    });

    const runPromise = runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-abort',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 200,
    });
    // 等任务真正开始编码,再并发执行清理(清理会取消相关任务,不能停止整个批次)
    const claimDeadline = Date.now() + 15_000;
    let sawRunning = false;
    while (Date.now() < claimDeadline) {
      const row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(request.taskId) as { status: string } | undefined;
      if (row?.status === 'running') { sawRunning = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(sawRunning, '任务必须先进入 running 才能验证并发清理');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const cleanup = proxyCacheModule.cleanupProxyCache(db, 'project-1', {});
    assert.equal(cleanup.deletedCount, 0, '写租约持有期间清理不能物理删除');
    assert.equal(cleanup.skippedCount, 1, '正在生成的缓存必须跳过并标记 pending-delete');
    await runPromise;

    await waitForTaskStatus(db, request.taskId, 'cancelled', 90_000);
    // 写租约释放 → 自动完成删除:不留下正式文件、孤儿文件或永久 pending 缓存
    const rowAfter = db.prepare(`SELECT * FROM batch_proxy_cache_items WHERE id = ?`).get(request.cacheItemId) as {
      pendingDeleteAt: string | null;
    } | undefined;
    assert.ok(!rowAfter, '并发清理+取消后不得留下永久 pending 缓存记录');

    const cacheRowBefore = db.prepare(`SELECT relativePath FROM batch_proxy_cache_items WHERE id = ?`).get(request.cacheItemId) as { relativePath: string } | undefined;
    const proxiesDir = cacheRowBefore
      ? path.dirname(proxyCacheModule.resolveControlledProxyPath(cacheRowBefore.relativePath))
      : path.join(externalDataRoot, 'storage', 'cache', 'proxies', 'project-1', assetId);
    if (listFilesUnder(proxiesDir).length > 0) {
      console.log('LEFTOVER FILES:', listFilesUnder(proxiesDir).map((f) => path.basename(f)));
    }
    assert.deepEqual(listFilesUnder(proxiesDir), [], '取消+清理后受控代理目录下不得残留正式文件或孤儿临时文件');

    // 批次本身没有被停止:批次 controlState 仍为 running
    const batchState = db.prepare(`SELECT controlState FROM batch_productions WHERE id = ?`).get(batchId) as { controlState: string };
    assert.equal(batchState.controlState, 'running', '清理只能取消相关代理任务,不能停止整个批次');

    // 清理后重新请求仍能再次生成成功
    const again = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: bigFingerprint,
      colorSnapshot: { lutId: null },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId,
      now: () => new Date('2026-08-03T08:10:00.000Z'),
    });
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-abort-2',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, again.taskId, 'succeeded', 120_000);
    db.close();
  }

  // ================================================================
  // c. LUT 文件被合法替换:executor 与 export preflight 都必须阻塞
  // ================================================================
  {
    const { db, fingerprint, assetId, analysisId, batchId } = await setupBatchWithSource();
    const lutRelativePath = path.join('storage', 'luts', 'project-1', 'replaced.cube');
    const lutAbsolutePath = path.join(externalDataRoot, lutRelativePath);
    fs.mkdirSync(path.dirname(lutAbsolutePath), { recursive: true });
    fs.writeFileSync(lutAbsolutePath, cubeContent);
    const lutId = lutCatalogModule.createManagedLut(db, 'project-1', {
      contentFingerprint: `sha256:${await computeFileSha256(lutAbsolutePath)}`,
      displayName: 'Replaced LUT',
      relativePath: lutRelativePath,
      fileSizeBytes: cubeContent.length,
      now: () => new Date('2026-08-03T08:11:00.000Z'),
    });
    const snapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
      scriptSelections: [{ scriptId: (db.prepare(`SELECT id FROM batch_scripts LIMIT 1`).get() as { id: string }).id, copyCount: 1 }],
      assetSelections: [{ assetId, analysisId, colorSnapshot: { lutId } }],
      now: () => new Date('2026-08-03T08:12:00.000Z'),
    });
    batchFlowModule.startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:13:00.000Z'));

    // 合法替换:受管路径上的文件内容被换成另一份真实 .cube(目录记录未更新)
    fs.writeFileSync(lutAbsolutePath, cubeContent.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\n# replaced'));

    // executor 阻塞:请求色彩代理必须失败,且不留下临时文件
    const request = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
      assetId, contentFingerprint: fingerprint,
      colorSnapshot: { lutId },
      profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
      colorPipelineVersion: 'color-v1',
      batchVersionId: snapshot.batchVersionId,
      now: () => new Date('2026-08-03T08:14:00.000Z'),
    });
    await runnerModule.runPendingOnce({
      db, workerId: 'worker-lifecycle-lut',
      executors: [proxyExecutorModule.proxyGenerateExecutor],
      concurrency: 1, leaseDurationMs: 60_000, heartbeatMs: 500,
    });
    await waitForTaskStatus(db, request.taskId, 'failed');
    const failedCache = proxyCacheModule.getProxyCacheItem(db, 'project-1', request.cacheItemId);
    assert.equal(failedCache?.status, 'failed', 'LUT 内容变化时代理任务必须进入明确失败状态');
    const failedRequest = db.prepare(`SELECT status FROM batch_proxy_requests WHERE id = ?`).get(request.requestId) as { status: string };
    assert.equal(failedRequest.status, 'failed', '请求必须同步进入失败状态');
    const lutProxiesDir = path.dirname(proxyCacheModule.resolveControlledProxyPath(failedCache!.relativePath));
    assert.deepEqual(listFilesUnder(lutProxiesDir), [], '失败路径不得留下任何临时文件');

    // export preflight 阻塞:实际文件指纹与冻结快照/目录记录不一致
    const preflight = await preflightModule.checkFormalExportPreflight(db, snapshot.batchVersionId);
    assert.equal(preflight.ready, false);
    if (!preflight.ready) {
      assert.ok(
        preflight.blockers.some((blocker) => blocker.code === 'lut_content_changed'),
        `必须报告 lut_content_changed:${JSON.stringify(preflight.blockers)}`,
      );
    }
    db.close();
  }

  // ================================================================
  // h. Windows 安全路径:身份保留 sha256:hex,文件名用纯 hex
  // ================================================================
  {
    const key = proxyCacheModule.computeProxyKey({
      assetId: 'asset-1',
      contentFingerprint: `sha256:${'a'.repeat(64)}`,
      profileVersion: 'proxy-v1',
      colorSnapshot: { lutId: null },
      colorPipelineVersion: 'color-v1',
    });
    assert.ok(key.startsWith('sha256:'), 'proxyKey 身份必须保留规范 sha256:hex 格式');
    const fileName = proxyCacheModule.proxyFileName(key);
    assert.equal(fileName, key.slice('sha256:'.length), '文件名必须是 key 的纯 hex 部分');
    assert.match(fileName, /^[a-f0-9]{64}$/, '文件名只允许 64 位小写 hex');
    const relative = proxyCacheModule.proxyRelativePath('project-1', 'asset-1', key);
    assert.ok(!relative.includes(':'), 'Windows 语义:任何路径段都不得包含冒号');
    // 非规范 key(脏数据)也必须得到安全文件名
    const dirty = proxyCacheModule.proxyFileName('proxy:with:colons');
    assert.match(dirty, /^[a-f0-9]{64}$/, '非规范 key 必须回退为 sha256 纯 hex 文件名');
  }

  console.log('batch-proxy-lifecycle-regression (real ffmpeg) tests passed');
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}
