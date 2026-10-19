import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { computeFileSha256 } from '../lib/batch-production/media-catalog.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset } from '../lib/batch-production/assets.ts';
import { createBatchProduction } from '../lib/batch-production/versions.ts';
import { createProjectScript } from '../lib/batch-production/scripts.ts';
import { createBatchSnapshot, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import { queueAssetPreparation } from '../lib/batch-production/asset-preparation.ts';
import { analyzeAssetExecutor, type BatchTaskExecutor } from '../lib/batch-production/executors.ts';
import { runPendingOnce } from '../lib/batch-production/runner.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-02T00:00:00.000Z');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-executors-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // 真实小视频(ffmpeg 合成)作为素材来源
  const videoDir = path.join(root, 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, 'clip.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:duration=0.4:size=64x64:rate=12', '-pix_fmt', 'yuv420p', '-y', videoPath]);
  const videoFingerprint = await computeFileSha256(videoPath);

  // --- 准备:素材(带 healthy 链接来源)→ 批次 → 快照 → 开跑 → 分析任务 ---
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: videoPath },
    contentFingerprint: `sha256:${videoFingerprint}`,
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run('source-1', assetId, JSON.stringify({ kind: 'linked', absolutePath: videoPath }), '2026-08-02T09:01:00.000Z');

  const scriptA = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-a',
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:05:00.000Z'),
  });
  const batchId = createBatchProduction(db, 'project-1', '批次', () => new Date('2026-08-02T09:10:00.000Z'));
  // assetSelections 里的 analysisId 必须存在:先建一份基础分析
  const analysisId = db.prepare(`
    INSERT INTO batch_asset_analysis (id, assetId, analyzerVersion, providerId, model, analysisJson, status, createdAt)
    VALUES (?, ?, 'v0', 'p', 'm', '{}', 'ready', '2026-08-02T09:14:00.000Z')
  `).run('analysis-0', assetId);
  void analysisId;
  createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 2 }],
    assetSelections: [{ assetId, analysisId: 'analysis-0' }],
    now: () => new Date('2026-08-02T09:16:00.000Z'),
  });
  queueAssetPreparation(db, 'project-1', batchId, [assetId]);
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T09:20:00.000Z'));

  // snapshot 前分析入口为素材建立任务(requestKey 幂等);start 不重复创建
  const autoTask = db.prepare(`
    SELECT id, requestKey FROM batch_tasks
    WHERE batchId = ? AND workType = 'asset_prepare'
  `).get(batchId) as { id: string; requestKey: string | null };
  assert.ok(autoTask, 'snapshot 前必须建立素材分析任务');
  assert.equal(autoTask.requestKey, `asset_prepare:${batchId}:${assetId}`, '分析任务必须带稳定 requestKey');
  const task1 = autoTask.id;

  // --- 场景 1:素材分析执行器真实执行,写入分析版本并更新当前指向 ---
  const handled = await runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [analyzeAssetExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  assert.equal(handled, 1, '一轮必须处理一个任务');
  const task1Row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task1) as { status: string };
  assert.equal(task1Row.status, 'succeeded', '分析任务必须成功');
  const analysis = db.prepare(`
    SELECT analyzerVersion, analysisJson FROM batch_asset_analysis
    WHERE assetId = ? AND analyzerVersion = 'batch-analysis-v1'
  `).get(assetId) as { analyzerVersion: string; analysisJson: string } | undefined;
  assert.ok(analysis, '执行器必须写入分析版本');
  assert.ok(Number.isFinite((JSON.parse(analysis.analysisJson) as { durationUs: number }).durationUs), '分析结果包含真实时长');
  const asset = db.prepare(`SELECT currentAnalysisId FROM batch_assets WHERE id = ?`).get(assetId) as { currentAnalysisId: string };
  assert.ok(asset.currentAnalysisId, '执行器必须更新素材当前分析指向');
  // currentAnalysisId 必须真实指向一条分析记录,不能是 lastInsertRowid 之类的损坏值
  const pointedAnalysis = db.prepare(`
    SELECT id FROM batch_asset_analysis WHERE id = ?
  `).get(asset.currentAnalysisId) as { id: string } | undefined;
  assert.ok(pointedAnalysis, 'currentAnalysisId 必须能真实查询到对应分析记录');
  assert.equal(pointedAnalysis.id, asset.currentAnalysisId, '指向必须与分析记录 id 完全一致');
  const attempt = db.prepare(`
    SELECT status, progressJson, resultJson FROM batch_task_attempts WHERE taskId = ?
  `).get(task1) as { status: string; progressJson: string; resultJson: string };
  assert.equal(attempt.status, 'succeeded');
  assert.equal((JSON.parse(attempt.progressJson) as { phase: string }).phase, 'analyzed', '进度必须报告最终阶段');
  const attemptResult = JSON.parse(attempt.resultJson ?? '{}') as { analysisId?: string };
  assert.equal(attemptResult.analysisId, asset.currentAnalysisId, 'resultJson 的分析 ID 必须与当前指向一致');

  // --- 场景 2:执行器抛错 → 任务失败并记录原因 ---
  const failingExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute() {
      throw new Error('渲染引擎不可用');
    },
  };
  const batch2 = createBatchProduction(db, 'project-1', '批次二', () => new Date('2026-08-02T10:00:00.000Z'));
  const snapshot2 = createBatchSnapshot(db, 'project-1', batch2, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId: 'analysis-0' }],
    now: () => new Date('2026-08-02T10:05:00.000Z'),
  });
  const v2 = db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T10:06:00.000Z')
  `).run('ov-b2', snapshot2.planIds[0]!);
  void v2;
  const task2 = createBatchTask(db, 'project-1', {
    batchId: batch2,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b2',
    now: () => new Date('2026-08-02T10:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch2, () => new Date('2026-08-02T10:08:00.000Z'));
  await runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [analyzeAssetExecutor, failingExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
  });
  const task2Row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task2) as { status: string };
  assert.equal(task2Row.status, 'failed', '执行器失败必须落账为失败');
  const attempt2 = db.prepare(`
    SELECT errorCode, errorMessage FROM batch_task_attempts WHERE taskId = ?
  `).get(task2) as { errorCode: string; errorMessage: string };
  assert.equal(attempt2.errorCode, 'executor_error');
  assert.equal(attempt2.errorMessage, '渲染引擎不可用', '失败原因必须保留在尝试记录');

  // --- 场景 3:中止信号 → 尝试标记 cancelled ---
  const batch3 = createBatchProduction(db, 'project-1', '批次三', () => new Date('2026-08-02T11:00:00.000Z'));
  const snapshot3 = createBatchSnapshot(db, 'project-1', batch3, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId: 'analysis-0' }],
    now: () => new Date('2026-08-02T11:05:00.000Z'),
  });
  const v3 = db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T11:06:00.000Z')
  `).run('ov-b3', snapshot3.planIds[0]!);
  void v3;
  const task3 = createBatchTask(db, 'project-1', {
    batchId: batch3,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b3',
    now: () => new Date('2026-08-02T11:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch3, () => new Date('2026-08-02T11:08:00.000Z'));
  const abortController = new AbortController();
  const slowExecutor: BatchTaskExecutor = {
    workTypes: ['render'],
    async execute({ signal }) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('任务已中止');
    },
  };
  const runPromise = runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [analyzeAssetExecutor, slowExecutor],
    concurrency: 1,
    progressThrottleMs: 0,
    signal: abortController.signal,
  });
  // 等待领取发生后再中止
  await new Promise((resolve) => setTimeout(resolve, 50));
  abortController.abort();
  await runPromise;
  const task3Row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task3) as { status: string };
  assert.equal(task3Row.status, 'cancelled', '中止的执行必须落账为 cancelled');

  // --- 场景 4:未注册执行器 → 明确失败,不挂起 ---
  const batch4 = createBatchProduction(db, 'project-1', '批次四', () => new Date('2026-08-02T12:00:00.000Z'));
  const snapshot4 = createBatchSnapshot(db, 'project-1', batch4, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId, analysisId: 'analysis-0' }],
    now: () => new Date('2026-08-02T12:05:00.000Z'),
  });
  const v4 = db.prepare(`
    INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
    VALUES (?, ?, 1, '{}', '2026-08-02T12:06:00.000Z')
  `).run('ov-b4', snapshot4.planIds[0]!);
  void v4;
  const task4 = createBatchTask(db, 'project-1', {
    batchId: batch4,
    workType: 'render',
    targetKind: 'output_version',
    targetId: 'ov-b4',
    now: () => new Date('2026-08-02T12:07:00.000Z'),
  });
  startBatchProduction(db, 'project-1', batch4, () => new Date('2026-08-02T12:08:00.000Z'));
  await runPendingOnce({
    db,
    workerId: 'worker-1',
    executors: [analyzeAssetExecutor], // 没有 render 执行器
    concurrency: 1,
    progressThrottleMs: 0,
  });
  const task4Row = db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(task4) as { status: string };
  assert.equal(task4Row.status, 'failed', '未注册执行器的任务必须失败而不是挂起');

  db.close();
  console.log('batch executors tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
