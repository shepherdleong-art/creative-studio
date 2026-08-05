import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import type { MediaTransport } from '../lib/media-transport.ts';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-asset-prep-data-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;

const schema = await import('../lib/batch-production/schema.ts');
const assets = await import('../lib/batch-production/assets.ts');
const mediaCatalog = await import('../lib/batch-production/media-catalog.ts');
const versions = await import('../lib/batch-production/versions.ts');
const scripts = await import('../lib/batch-production/scripts.ts');
const flow = await import('../lib/batch-production/batch-flow.ts');
const preparation = await import('../lib/batch-production/asset-preparation.ts');
const prepare = await import('../lib/batch-production/prepare.ts');
const executors = await import('../lib/batch-production/executors.ts');
const runner = await import('../lib/batch-production/runner.ts');
const tasks = await import('../lib/batch-production/tasks.ts');
const media = await import('../lib/batch-production/project-asset-media.ts');
const mediaResponse = await import('../lib/batch-production/project-asset-media-response.ts');
const providerGate = await import('../lib/provider-execution-gate.ts');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-asset-prep-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini', model TEXT,
    inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, shotSetId TEXT, sourceImageId TEXT NOT NULL,
    providerId TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL,
    durationSec INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'pending',
    localVideoPath TEXT, filename TEXT, createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE script_providers (
    id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
    supportsVision INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '', defaultModel TEXT NOT NULL DEFAULT '',
    baseUrl TEXT NOT NULL DEFAULT '', defaultBaseUrl TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '',
    executionScope TEXT NOT NULL DEFAULT 'external'
  );
  INSERT INTO projects (id, name) VALUES ('project-1', '一号项目');
  INSERT INTO projects (id, name) VALUES ('project-2', '二号项目');
`);

try {
  const readiness = await schema.ensureBatchSchemaReady({
    db,
    backupRoot: path.join(root, 'backups'),
    now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(readiness.state, 'ready');

  const sourcePath = path.join(root, 'source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:duration=0.4:size=64x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', sourcePath,
  ]);
  const fingerprint = await mediaCatalog.computeFileSha256(sourcePath);
  const assetId = assets.createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: sourcePath },
    contentFingerprint: `sha256:${fingerprint}`,
    mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('source-1', ?, 'linked', ?, 'healthy', ?)
  `).run(assetId, JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), new Date().toISOString());
  const batchId = versions.createBatchProduction(db, 'project-1', '分析批次');

  const first = preparation.queueAssetPreparation(db, 'project-1', batchId, [assetId]);
  const second = preparation.queueAssetPreparation(db, 'project-1', batchId, [assetId]);
  assert.equal(first.items[0]?.status, 'queued');
  assert.equal(first.items[0]?.taskId, second.items[0]?.taskId, '相同 requestKey 必须幂等');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE batchId = ?`).get(batchId) as { n: number }).n, 1);

  const retryAsset = assets.createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: sourcePath },
    contentFingerprint: 'sha256:fixture-retry', mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('retry-source', ?, 'linked', ?, 'healthy', ?)
  `).run(retryAsset, JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), new Date().toISOString());
  const retryQueued = preparation.queueAssetPreparation(db, 'project-1', batchId, [retryAsset]);
  const failedAttempt = tasks.startTaskAttempt(db, retryQueued.items[0]!.taskId!);
  tasks.finishTaskAttempt(db, retryQueued.items[0]!.taskId!, failedAttempt, { status: 'failed', errorCode: 'probe_failed' });
  const retried = preparation.queueAssetPreparation(db, 'project-1', batchId, [retryAsset]);
  assert.equal(retried.items[0]?.taskId, retryQueued.items[0]?.taskId, 'failed 任务重排队应沿用任务身份');
  assert.equal(retried.items[0]?.status, 'queued');
  const cancelledAttempt = tasks.startTaskAttempt(db, retried.items[0]!.taskId!);
  tasks.finishTaskAttempt(db, retried.items[0]!.taskId!, cancelledAttempt, { status: 'cancelled' });
  const reenabled = preparation.queueAssetPreparation(db, 'project-1', batchId, [retryAsset]);
  assert.notEqual(reenabled.items[0]?.taskId, retried.items[0]?.taskId, 'cancelled 任务必须允许建立新任务');

  assert.throws(
    () => preparation.queueAssetPreparation(db, 'project-2', batchId, [assetId]),
    /批次不存在/,
    '跨项目批次不能触碰项目素材',
  );
  const offline = assets.createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: sourcePath },
    contentFingerprint: 'sha256:offline',
    mediaKind: 'video',
  });
  assets.markAssetOffline(db, 'project-1', offline);
  assert.throws(
    () => preparation.queueAssetPreparation(db, 'project-1', batchId, [offline]),
    /离线/,
  );

  const offlineSourcePath = path.join(root, 'offline-source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=gray:duration=0.4:size=64x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', offlineSourcePath,
  ]);
  const offlineWithSource = await mediaCatalog.registerLinkedSource(db, 'project-1', {
    filePath: offlineSourcePath,
    displayName: '离线素材',
  });
  assets.markAssetOffline(db, 'project-1', offlineWithSource);
  await assert.rejects(
    () => media.resolveVerifiedProjectAssetMedia(db, 'project-1', offlineWithSource),
    /离线/,
    '显式离线的素材即使文件仍存在也不能被预览或分析',
  );

  await runner.runPendingOnce({
    db,
    workerId: 'asset-preparation-test',
    executors: [executors.analyzeAssetExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  const ready = preparation.queueAssetPreparation(db, 'project-1', batchId, [assetId]);
  assert.equal(ready.items[0]?.ready, true);
  assert.equal(ready.items[0]?.analysisLevel, 'technical');

  db.prepare(`
    INSERT INTO script_providers (id, enabled, supportsVision, model, baseUrl, apiKey, executionScope)
    VALUES ('vision-provider', 1, 1, 'vision-model', 'https://vision.example/v1', 'vision-key', 'external')
  `).run();
  const contentQueued = preparation.queueAssetPreparation(
    db,
    'project-1',
    batchId,
    [assetId],
    undefined,
    { mode: 'content', providerId: 'vision-provider', model: 'vision-model', executionScope: 'external' },
  );
  assert.equal(contentQueued.items[0]?.ready, false, 'technical 结果不能冒充内容分析');
  const oldDirectIdentity = createHash('sha256')
    .update('vision-provider\u0000vision-model')
    .digest('hex')
    .slice(0, 20);
  assert.equal(
    (db.prepare(`SELECT requestKey FROM batch_tasks WHERE id = ?`).get(contentQueued.items[0]!.taskId!) as { requestKey: string }).requestKey,
    `asset_content:${batchId}:${assetId}:${createHash('sha256').update(`sha256:${fingerprint}`).digest('hex').slice(0, 20)}:${oldDirectIdentity}`,
    'v18 仍须沿用 v17 直连 requestKey，避免旧任务升级后重复排队',
  );
  const contentRequest = db.prepare(`
    SELECT assetId, contentFingerprint, providerId, model, executionScope
    FROM batch_asset_analysis_requests WHERE taskId = ?
  `).get(contentQueued.items[0]!.taskId!) as {
    assetId: string;
    contentFingerprint: string;
    providerId: string;
    model: string;
    executionScope: string;
  };
  assert.deepEqual(contentRequest, {
    assetId,
    contentFingerprint: `sha256:${fingerprint}`,
    providerId: 'vision-provider',
    model: 'vision-model',
    executionScope: 'external',
  }, '内容分析任务必须冻结素材指纹和供应商模型');
  let directGateCalls = 0;
  const contentExecutor = executors.createAnalyzeAssetExecutor({
    assertProviderReady: async (provider, options) => {
      directGateCalls += 1;
      assert.equal(provider.executionScope, 'external');
      assert.equal(options.capability, 'media');
    },
    analyzeContent: async () => ({
      summary: '红色视频素材',
      sellingPoints: ['红色'],
      semanticTags: ['产品'],
      usableRanges: [{ startUs: 0, endUs: 400_000, qualityScore: 0.9 }],
      qualityIssues: [],
      coverFrameTimesUs: [120_000],
      scenes: [{ startUs: 0, endUs: 400_000, description: '红色画面', labels: ['产品'], qualityScore: 0.9 }],
    }),
  });
  for (let index = 0; index < 4; index += 1) {
    await runner.runPendingOnce({
      db,
      workerId: 'asset-content-analysis-test',
      executors: [contentExecutor],
      concurrency: 1,
      progressThrottleMs: 0,
    });
    if (preparation.getCurrentAssetAnalysis(db, 'project-1', assetId)?.analysisLevel === 'content') break;
  }
  const contentReady = preparation.getCurrentAssetAnalysis(db, 'project-1', assetId);
  assert.equal(directGateCalls, 1, '内容分析必须在调用视觉 Adapter 前经过统一供应商门禁');
  assert.equal(contentReady?.analysisLevel, 'content');
  assert.deepEqual(
    (contentReady?.analysisJson as { semanticTags?: string[] }).semanticTags,
    ['产品'],
    '内容分析结果必须成为素材当前分析版本',
  );

  const companySourcePath = path.join(root, 'company-source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=magenta:duration=0.6:size=80x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', companySourcePath,
  ]);
  const companyFingerprint = await mediaCatalog.computeFileSha256(companySourcePath);
  const companyAsset = assets.createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: companySourcePath },
    contentFingerprint: `sha256:${companyFingerprint}`, mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('company-source', ?, 'linked', ?, 'healthy', ?)
  `).run(companyAsset, JSON.stringify({ kind: 'linked', absolutePath: companySourcePath }), new Date().toISOString());
  db.prepare(`
    INSERT INTO script_providers (id, enabled, supportsVision, model, baseUrl, apiKey, executionScope)
    VALUES ('company-vision', 1, 1, 'company-model', 'http://127.0.0.1:4000/v1', 'company-key', 'company')
  `).run();
  const companyQueued = preparation.queueAssetPreparation(
    db,
    'project-1',
    batchId,
    [companyAsset],
    undefined,
    { mode: 'content', providerId: 'company-vision', model: 'company-model', executionScope: 'company' },
  );
  let companyAnalyzeCalls = 0;
  const blockedCompanyExecutor = executors.createAnalyzeAssetExecutor({
    assertProviderReady: async () => {
      throw new Error('公司媒体传输未就绪');
    },
    analyzeContent: async () => {
      companyAnalyzeCalls += 1;
      throw new Error('供应商调用不应发生');
    },
  });
  await runner.runPendingOnce({
    db,
    workerId: 'company-content-gate-test',
    executors: [blockedCompanyExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  assert.equal(companyAnalyzeCalls, 0, '公司门禁失败时不得调用视觉供应商');
  assert.deepEqual(
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(companyQueued.items[0]!.taskId!),
    { status: 'failed' },
  );
  const companyRetried = preparation.queueAssetPreparation(
    db,
    'project-1',
    batchId,
    [companyAsset],
    undefined,
    { mode: 'content', providerId: 'company-vision', model: 'company-model', executionScope: 'company' },
  );
  assert.equal(companyRetried.items[0]!.taskId, companyQueued.items[0]!.taskId);
  db.prepare(`UPDATE script_providers SET apiKey = '' WHERE id = 'company-vision'`).run();
  const transportEvents: string[] = [];
  const fixtureTransport: MediaTransport = {
    id: 'fixture-transport',
    async prepare(input) {
      transportEvents.push(`prepare:${input.attemptId}`);
      assert.equal(input.projectId, 'project-1');
      assert.equal(input.batchId, batchId);
      assert.equal(input.assetId, companyAsset);
      assert.equal(input.absolutePath, companySourcePath);
      assert.equal(input.contentFingerprint, `sha256:${companyFingerprint}`);
      const issuedAt = Date.now() - 60_000;
      return {
        id: 'company-media-lease',
        transportId: 'fixture-transport',
        opaqueUrl: 'https://media.invalid/company-media-lease',
        contentFingerprint: input.contentFingerprint,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + 5 * 60_000).toISOString(),
      };
    },
    async release(lease) {
      transportEvents.push(`release:${lease.id}`);
    },
  };
  const transportedCompanyExecutor = executors.createAnalyzeAssetExecutor({
    mediaTransport: fixtureTransport,
    assertProviderReady: async (provider, options) => {
      await providerGate.assertProviderExecutionAvailable(provider, {
        ...options,
        inspectRuntime: async () => ({
          status: 'ready', reason: 'fixture ready', proxyAvailable: true, tunnelAvailable: true,
          startedAt: null, tunnelEngine: 'cloudflared',
        }),
      });
    },
    analyzeContent: async (input) => {
      assert.equal(input.mediaLease?.opaqueUrl, 'https://media.invalid/company-media-lease');
      return {
        summary: '公司供应商分析结果',
        sellingPoints: ['公司分析'],
        semanticTags: ['租约'],
        usableRanges: [{ startUs: 0, endUs: 400_000, qualityScore: 0.8 }],
        qualityIssues: [],
        coverFrameTimesUs: [100_000],
        scenes: [{ startUs: 0, endUs: 400_000, description: '租约画面', labels: ['租约'], qualityScore: 0.8 }],
      };
    },
  });
  await runner.runPendingOnce({
    db,
    workerId: 'company-content-transport-test',
    executors: [transportedCompanyExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  assert.deepEqual(transportEvents, [], 'API Key 被清空后必须在 prepare 媒体租约前失败');
  assert.deepEqual(
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(companyQueued.items[0]!.taskId!),
    { status: 'failed' },
  );
  db.prepare(`UPDATE script_providers SET apiKey = 'company-key' WHERE id = 'company-vision'`).run();
  preparation.queueAssetPreparation(
    db,
    'project-1',
    batchId,
    [companyAsset],
    undefined,
    { mode: 'content', providerId: 'company-vision', model: 'company-model', executionScope: 'company' },
  );
  await runner.runPendingOnce({
    db,
    workerId: 'company-content-transport-test-2',
    executors: [transportedCompanyExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  assert.match(transportEvents[0] ?? '', /^prepare:/);
  assert.equal(transportEvents[1], 'release:company-media-lease');
  assert.deepEqual(
    db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(companyQueued.items[0]!.taskId!),
    { status: 'succeeded' },
    '注入受控 MediaTransport 后公司内容分析才允许完成',
  );

  const scriptId = scripts.createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'fixture-script', title: '素材分析脚本', bodyText: '正文', sourceVersion: '1',
  });
  const snapshotBatch = versions.createBatchProduction(db, 'project-1', '已分析批次');
  const snapshot = flow.createBatchSnapshot(db, 'project-1', snapshotBatch, {
    scriptSelections: [{ scriptId, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId: contentReady!.id }],
  });
  flow.startBatchProduction(db, 'project-1', snapshotBatch);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE batchId = ? AND workType = 'asset_prepare'`).get(snapshotBatch) as { n: number }).n,
    0,
    '当前分析已锁定时 start 不应重复创建 asset_prepare 任务',
  );
  assert.equal(snapshot.totalPlans, 1);

  const prepared = await prepare.prepareBatchProductionInputs(db, 'project-1');
  const preparedAsset = prepared.assets.find(({ id }) => id === assetId)!;
  assert.equal(preparedAsset.analysisLevel, 'content');
  assert.match(preparedAsset.thumbnailUrl, new RegExp(`/api/batch-production/assets/${assetId}/thumbnail`));
  assert.match(preparedAsset.previewUrl, new RegExp(`/api/batch-production/assets/${assetId}/preview`));
  assert.equal('location' in preparedAsset.sources[0]!, false, '准备接口不得返回任何本地来源路径');

  const thumbnail = await media.materializeProjectAssetThumbnail(db, 'project-1', assetId);
  assert.ok(fs.statSync(thumbnail.absolutePath).size > 0, '缩略图必须真实生成');
  const thumbnailMetadata = await sharp(thumbnail.absolutePath).metadata();
  assert.equal(thumbnailMetadata.format, 'jpeg', '缩略图必须是 JPEG');
  assert.equal(thumbnailMetadata.width, 960, '缩略图宽度必须稳定为 960');
  assert.equal(thumbnailMetadata.height, 540, '缩略图高度必须稳定为 540');
  const thumbnailAgain = await media.materializeProjectAssetThumbnail(db, 'project-1', assetId);
  assert.equal(thumbnailAgain.absolutePath, thumbnail.absolutePath, '缓存命中必须复用同一确定性缩略图');
  assert.equal(thumbnailAgain.fingerprint, thumbnail.fingerprint, '缓存命中必须复用同一内容指纹');
  const preview = await media.resolveVerifiedProjectAssetMedia(db, 'project-1', assetId);
  await assert.rejects(
    () => media.resolveVerifiedProjectAssetMedia(db, 'project-2', assetId),
    /素材不存在/,
    '媒体解析必须按项目隔离',
  );
  const range = mediaResponse.projectAssetMediaResponse(
    new Request('http://localhost/preview', { headers: { Range: 'bytes=0-7' } }),
    preview.filePath,
    media.projectAssetMimeType(preview.filePath),
    {},
    preview.fileIdentity,
  );
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${fs.statSync(sourcePath).size}`);
  assert.equal((await range.arrayBuffer()).byteLength, 8, 'Range 预览不能整文件读入返回');
  const invalidRange = mediaResponse.projectAssetMediaResponse(
    new Request('http://localhost/preview', { headers: { Range: 'bytes=-0' } }),
    preview.filePath,
    media.projectAssetMimeType(preview.filePath),
  );
  assert.equal(invalidRange.status, 416, 'bytes=-0 必须拒绝');
  const sourceSize = fs.statSync(sourcePath).size;
  const oversizedRange = mediaResponse.projectAssetMediaResponse(
    new Request('http://localhost/preview', { headers: { Range: `bytes=0-${sourceSize + 1000}` } }),
    preview.filePath,
    media.projectAssetMimeType(preview.filePath),
    {},
    preview.fileIdentity,
  );
  assert.equal(oversizedRange.status, 206, '超出文件尾的 Range 应截断而不是返回 416');
  assert.equal(oversizedRange.headers.get('content-range'), `bytes 0-${sourceSize - 1}/${sourceSize}`);
  assert.equal((await oversizedRange.arrayBuffer()).byteLength, sourceSize);

  const symlinkPath = path.join(root, 'source-link.mp4');
  const symlinkTargetPath = path.join(root, 'symlink-target.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:duration=0.4:size=64x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', symlinkTargetPath,
  ]);
  const symlinkFingerprint = await mediaCatalog.computeFileSha256(symlinkTargetPath);
  fs.symlinkSync(symlinkTargetPath, symlinkPath);
  const symlinkAsset = assets.createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: symlinkPath },
    contentFingerprint: `sha256:${symlinkFingerprint}`, mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('symlink-source', ?, 'linked', ?, 'healthy', ?)
  `).run(symlinkAsset, JSON.stringify({ kind: 'linked', absolutePath: symlinkPath }), new Date().toISOString());
  await assert.rejects(
    () => media.resolveVerifiedProjectAssetMedia(db, 'project-1', symlinkAsset),
    /离线|符号链接/,
    '符号链接原片必须拒绝',
  );

  const managedSourcePath = path.join(root, 'managed-source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=green:duration=0.4:size=64x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', managedSourcePath,
  ]);
  const managedAsset = await mediaCatalog.registerManagedCopy(db, 'project-1', { sourcePath: managedSourcePath });
  const managedMedia = await media.resolveVerifiedProjectAssetMedia(db, 'project-1', managedAsset);
  assert.equal(managedMedia.source.sourceKind, 'managed', '托管副本来源必须可安全解析');
  const managedThumbnail = await media.materializeProjectAssetThumbnail(db, 'project-1', managedAsset);
  const managedThumbnailMetadata = await sharp(managedThumbnail.absolutePath).metadata();
  assert.deepEqual(
    { format: managedThumbnailMetadata.format, width: managedThumbnailMetadata.width, height: managedThumbnailMetadata.height },
    { format: 'jpeg', width: 960, height: 540 },
    '托管来源必须生成真实 960×540 JPEG 缩略图',
  );

  const legacyRangeAnalysis = assets.createAnalysisVersion(db, {
    assetId: managedAsset,
    analyzerVersion: 'legacy-v1',
    providerId: 'legacy-provider',
    model: 'legacy-model',
    analysisJson: { usableRanges: [{ startUs: 0, endUs: 1000 }] },
  });
  assets.setAssetCurrentAnalysis(db, 'project-1', managedAsset, legacyRangeAnalysis);
  assert.equal(
    preparation.getCurrentAssetAnalysis(db, 'project-1', managedAsset)?.analysisLevel,
    'technical',
    '历史分析不能只因存在 usableRanges 字段就被升级成内容分析',
  );

  const module4RelativePath = path.join('videos', 'module4-source.mp4');
  const module4Path = path.join(dataRoot, 'storage', module4RelativePath);
  fs.mkdirSync(path.dirname(module4Path), { recursive: true });
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=yellow:duration=0.4:size=64x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', module4Path,
  ]);
  db.prepare(`INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES (?, ?, ?, ?)`).run(
    'module4-shot-set', 'project-1', '模块 4 分镜', new Date().toISOString(),
  );
  db.prepare(`
    INSERT INTO video_jobs
      (id, projectId, shotSetId, sourceImageId, providerId, model, prompt, status, localVideoPath, filename, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)
  `).run(
    'module4-video-job', 'project-1', 'module4-shot-set', 'source-image', 'fixture-provider',
    'fixture-model', 'fixture prompt', module4RelativePath, 'module4-source.mp4', new Date().toISOString(),
  );
  const module4Asset = await mediaCatalog.registerModule4Video(db, { videoJobId: 'module4-video-job' });
  const module4Media = await media.resolveVerifiedProjectAssetMedia(db, 'project-1', module4Asset.assetId);
  assert.equal(module4Media.source.sourceKind, 'module4', '模块 4 来源必须可安全解析');
  const module4Thumbnail = await media.materializeProjectAssetThumbnail(db, 'project-1', module4Asset.assetId);
  const module4ThumbnailMetadata = await sharp(module4Thumbnail.absolutePath).metadata();
  assert.deepEqual(
    { format: module4ThumbnailMetadata.format, width: module4ThumbnailMetadata.width, height: module4ThumbnailMetadata.height },
    { format: 'jpeg', width: 960, height: 540 },
    '模块 4 来源必须生成真实 960×540 JPEG 缩略图',
  );

  fs.appendFileSync(sourcePath, 'changed');
  await assert.rejects(
    () => media.resolveVerifiedProjectAssetMedia(db, 'project-1', assetId),
    /内容已变化/,
    '内容指纹变化必须拒绝媒体访问',
  );
  console.log('batch asset preparation tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
