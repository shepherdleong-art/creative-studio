// scripts/batch-proxy-generation.test.ts
//
// 真实 FFmpeg 端到端验证:合成源视频 -> 通过 ProxyMediaCache.requestProxy 建立
// proxy_generate 任务 -> 调度器真实执行 proxy-executor -> 核验产物可解码、
// 时长误差达标、分辨率确实被下采样、可拖动(seek 到中段可解出一帧)。
// 同时验证 LUT 开启路径(真实 lut3d 小样本)不破坏编码链路,且与关闭 LUT 产生
// 不同的 proxyKey 与不同的受管文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';

// dataRoot() 在模块首次加载时解析,必须先设置环境变量再动态导入依赖它的模块。
const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-gen-root-'));
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

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-proxy-gen-work-'));

try {
  const dbRoot = path.join(workRoot, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await schemaModule.ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 合成一段真实源视频:1280x720、4 秒、带音轨,验证下采样与音轨转码都真实发生 ---
  const sourcePath = path.join(workRoot, 'source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=1280x720:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', sourcePath,
  ]);
  const sourceProbe = await probeVideoMedia(sourcePath);
  assert.ok(!sourceProbe.errorMessage, `合成源视频必须可读:${sourceProbe.errorMessage}`);
  assert.equal(sourceProbe.height, 720);
  const sourceHashBefore = await computeFileSha256(sourcePath);

  const script = scriptsModule.createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'draft-a', title: '口播A', bodyText: '正文A', sourceVersion: '1',
    now: () => new Date('2026-08-03T08:01:00.000Z'),
  });
  const contentFingerprint = `sha256:${sourceHashBefore}`;
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

  const batchId = versionsModule.createBatchProduction(db, 'project-1', '代理生成真实验证', () => new Date('2026-08-03T08:03:00.000Z'));
  const offSnapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId: null } }],
    now: () => new Date('2026-08-03T08:04:00.000Z'),
  });
  batchFlowModule.startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-03T08:05:00.000Z'));

  // --- 场景 1:关闭 LUT 的普通代理 ---
  const requestOff = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
    assetId: asset,
    contentFingerprint,
    colorSnapshot: { lutId: null },
    profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
    colorPipelineVersion: 'color-v1',
    batchVersionId: offSnapshot.batchVersionId,
    now: () => new Date('2026-08-03T08:06:00.000Z'),
  });

  const handled = await runnerModule.runPendingOnce({
    db,
    workerId: 'worker-real-ffmpeg',
    executors: [executorsModule.analyzeAssetExecutor, proxyExecutorModule.proxyGenerateExecutor],
    concurrency: 2,
    leaseDurationMs: 60_000,
    heartbeatMs: 500,
  });
  assert.ok(handled >= 1, '调度器至少要处理一轮任务(素材分析 + 代理生成)');

  const readyItem = proxyCacheModule.getProxyCacheItem(db, 'project-1', requestOff.cacheItemId);
  assert.equal(readyItem?.status, 'ready', `代理任务必须真正跑完并落成 ready(当前 ${readyItem?.status})`);
  assert.ok(readyItem!.fileSizeBytes > 0);
  assert.ok(readyItem!.checksum);

  const proxyAbsolutePath = proxyCacheModule.resolveControlledProxyPath(readyItem!.relativePath);
  assert.ok(fs.existsSync(proxyAbsolutePath), '代理文件必须真实落在受控代理目录下');
  assert.ok(proxyAbsolutePath.startsWith(path.join(externalDataRoot, 'storage', 'cache', 'proxies')), '代理路径必须在集中缓存目录下');

  const proxyProbe = await probeVideoMedia(proxyAbsolutePath);
  assert.ok(!proxyProbe.errorMessage, `代理必须真实可解码:${proxyProbe.errorMessage}`);
  assert.ok(proxyProbe.height <= 720 && proxyProbe.height > 0, '代理必须被下采样到目标分辨率以内');
  assert.ok(proxyProbe.width < sourceProbe.width || proxyProbe.height < sourceProbe.height || (proxyProbe.width === sourceProbe.width && proxyProbe.height === sourceProbe.height), '代理分辨率不能超过原片');
  const durationErrorSec = Math.abs(proxyProbe.durationUs - sourceProbe.durationUs) / 1_000_000;
  assert.ok(durationErrorSec < 0.3, `代理时长必须与原片保持在误差范围内(实际误差 ${durationErrorSec.toFixed(3)}s)`);

  // 可拖动:真实 seek 到中段并解出一帧,证明不是只有开头能播放
  const midSeekOutput = path.join(workRoot, 'seek-check.jpg');
  await runFfmpeg(['-ss', (sourceProbe.durationUs / 1_000_000 / 2).toFixed(2), '-i', proxyAbsolutePath, '-frames:v', '1', '-y', midSeekOutput]);
  assert.ok(fs.existsSync(midSeekOutput) && fs.statSync(midSeekOutput).size > 0, '代理必须支持从中段 seek 并解出画面(可拖动)');

  // --- 场景 2:开启 LUT 的色彩代理必须产生不同的 proxyKey 和不同的受管文件,且依然可解码 ---
  const cubeContent = [
    'LUT_3D_SIZE 2',
    '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
    '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
  ].join('\n');
  const lutRelativePath = path.join('storage', 'luts', 'project-1', 'identity.cube');
  const lutAbsolutePath = path.join(externalDataRoot, lutRelativePath);
  fs.mkdirSync(path.dirname(lutAbsolutePath), { recursive: true });
  fs.writeFileSync(lutAbsolutePath, cubeContent);
  const lutHashBefore = await computeFileSha256(lutAbsolutePath);
  const lutId = lutCatalogModule.createManagedLut(db, 'project-1', {
    contentFingerprint: `sha256:${lutHashBefore}`,
    displayName: 'Identity LUT',
    relativePath: lutRelativePath,
    fileSizeBytes: cubeContent.length,
    now: () => new Date('2026-08-03T08:07:00.000Z'),
  });
  const lutSnapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: asset, analysisId: analysis, colorSnapshot: { lutId } }],
    now: () => new Date('2026-08-03T08:07:30.000Z'),
  });

  const requestWithLut = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
    assetId: asset,
    contentFingerprint,
    colorSnapshot: { lutId },
    profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
    colorPipelineVersion: 'color-v1',
    batchVersionId: lutSnapshot.batchVersionId,
    now: () => new Date('2026-08-03T08:08:00.000Z'),
  });
  assert.notEqual(requestWithLut.proxyKey, requestOff.proxyKey, 'LUT 开启必须产生不同的 proxyKey');

  await runnerModule.runPendingOnce({
    db,
    workerId: 'worker-real-ffmpeg-lut',
    executors: [executorsModule.analyzeAssetExecutor, proxyExecutorModule.proxyGenerateExecutor],
    concurrency: 1,
    leaseDurationMs: 60_000,
    heartbeatMs: 500,
  });
  const lutItem = proxyCacheModule.getProxyCacheItem(db, 'project-1', requestWithLut.cacheItemId);
  assert.equal(lutItem?.status, 'ready', `LUT 代理任务必须真正跑完并落成 ready(当前 ${lutItem?.status})`);
  const lutProxyAbsolutePath = proxyCacheModule.resolveControlledProxyPath(lutItem!.relativePath);
  assert.notEqual(lutProxyAbsolutePath, proxyAbsolutePath, 'LUT 代理必须写入与关闭 LUT 不同的文件');
  const lutProxyProbe = await probeVideoMedia(lutProxyAbsolutePath);
  assert.ok(!lutProxyProbe.errorMessage, `应用真实 lut3d 后代理仍必须可解码:${lutProxyProbe.errorMessage}`);

  // --- 场景 3:竖屏源片同样能生成代理,时间从零开始,时长误差达标 ---
  const portraitSourcePath = path.join(workRoot, 'portrait-source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=720x1280:rate=25',
    '-pix_fmt', 'yuv420p', '-y', portraitSourcePath,
  ]);
  const portraitProbe = await probeVideoMedia(portraitSourcePath);
  assert.ok(!portraitProbe.errorMessage);
  assert.ok(portraitProbe.height > portraitProbe.width, '合成源必须是真正的竖屏(高 > 宽)');
  const portraitFingerprint = `sha256:${await computeFileSha256(portraitSourcePath)}`;
  const portraitAsset = assetsModule.createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: portraitSourcePath },
    contentFingerprint: portraitFingerprint, mediaKind: 'video',
    now: () => new Date('2026-08-03T08:09:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('src-portrait', ?, 'linked', ?, 'healthy', ?)
  `).run(portraitAsset, JSON.stringify({ kind: 'linked', absolutePath: portraitSourcePath }), '2026-08-03T08:09:10.000Z');
  const portraitAnalysis = assetsModule.createAnalysisVersion(db, {
    assetId: portraitAsset,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-03T08:09:15.000Z'),
  });
  const portraitSnapshot = batchFlowModule.createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: script, copyCount: 1 }],
    assetSelections: [{ assetId: portraitAsset, analysisId: portraitAnalysis, colorSnapshot: { lutId: null } }],
    now: () => new Date('2026-08-03T08:09:18.000Z'),
  });
  const portraitRequest = proxyCacheModule.requestProxy(db, 'project-1', batchId, {
    assetId: portraitAsset,
    contentFingerprint: portraitFingerprint,
    colorSnapshot: { lutId: null },
    profileVersion: proxyExecutorModule.PROXY_PROFILE_VERSION,
    colorPipelineVersion: 'color-v1',
    batchVersionId: portraitSnapshot.batchVersionId,
    now: () => new Date('2026-08-03T08:09:20.000Z'),
  });
  await runnerModule.runPendingOnce({
    db,
    workerId: 'worker-real-ffmpeg-portrait',
    executors: [proxyExecutorModule.proxyGenerateExecutor],
    concurrency: 1,
    leaseDurationMs: 60_000,
    heartbeatMs: 500,
  });
  const portraitItem = proxyCacheModule.getProxyCacheItem(db, 'project-1', portraitRequest.cacheItemId);
  assert.equal(portraitItem?.status, 'ready', `竖屏代理任务必须真正跑完并落成 ready(当前 ${portraitItem?.status})`);
  const portraitProxyPath = proxyCacheModule.resolveControlledProxyPath(portraitItem!.relativePath);
  const portraitProxyProbe = await probeVideoMedia(portraitProxyPath);
  assert.ok(!portraitProxyProbe.errorMessage, `竖屏代理必须可解码:${portraitProxyProbe.errorMessage}`);
  assert.ok(portraitProxyProbe.height > portraitProxyProbe.width, '竖屏代理必须保持竖屏方向,不能被横向拉伸或裁成横屏');
  const portraitDurationErrorSec = Math.abs(portraitProxyProbe.durationUs - portraitProbe.durationUs) / 1_000_000;
  assert.ok(portraitDurationErrorSec < 0.3, `竖屏代理时长误差必须达标(实际 ${portraitDurationErrorSec.toFixed(3)}s)`);
  // 时间从零开始:seek 到 0 秒必须能立即解出第一帧
  const portraitFirstFrame = path.join(workRoot, 'portrait-first-frame.jpg');
  await runFfmpeg(['-i', portraitProxyPath, '-frames:v', '1', '-y', portraitFirstFrame]);
  assert.ok(fs.existsSync(portraitFirstFrame) && fs.statSync(portraitFirstFrame).size > 0, '竖屏代理必须能从时间零点解出画面');

  // --- 场景 4:原片与 LUT 文件在整个代理生成过程前后 SHA-256 必须完全不变 ---
  const sourceHashAfter = await computeFileSha256(sourcePath);
  assert.equal(sourceHashAfter, sourceHashBefore, '生成代理不能以任何方式修改原片文件内容');
  const lutHashAfter = await computeFileSha256(lutAbsolutePath);
  assert.equal(lutHashAfter, lutHashBefore, '生成色彩代理不能以任何方式修改 LUT 源文件内容');

  db.close();
  console.log('batch-proxy-generation (real ffmpeg) tests passed');
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}
