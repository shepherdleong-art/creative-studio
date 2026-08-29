/**
 * 验证批量成片导出的渲染新鲜度合同:
 * 1. 初始 editRevision=0 的成功候选审核后可以导出;
 * 2. 编辑到 editRevision=1 后,旧候选即使审核通过也不得导出;
 * 3. 重新渲染到 editRevision=1 后恢复导出;
 * 4. queued render 会让审核写入返回 pendingRender=true;
 * 5. 没有 editRevision 的历史候选在当前 revision=0 时仍可导出。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-freshness-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

// dataRoot() is intentionally frozen at module initialization. Load project
// modules only after pointing it at this test's isolated temporary root.
const { createAsset, createAnalysisVersion } = await import('../lib/batch-production/assets.ts');
const { computeFingerprintFromFile } = await import('../lib/batch-production/fingerprint.ts');
const { publishSelectedBatchOutputs } = await import('../lib/batch-production/phase-e.ts');
const { createOutputPlansForSnapshot, createOutputVersion } = await import('../lib/batch-production/plans.ts');
const { setBatchPlanReviews } = await import('../lib/batch-production/review.ts');
const { BATCH_SCHEMA_MIGRATIONS } = await import('../lib/batch-production/schema.ts');
const { createBatchTask } = await import('../lib/batch-production/tasks.ts');
const { addAssetToPool, createBatchProduction, createBatchProductionVersion } = await import('../lib/batch-production/versions.ts');
const { createProjectScript, snapshotScriptIntoBatch } = await import('../lib/batch-production/scripts.ts');

let db: Database.Database | null = null;

function resultFor(input: {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
  planSeq: number;
  outputVersionNumber: number;
  videoRelativePath: string;
  coverRelativePath: string;
  videoChecksum: string;
  coverChecksum: string;
  editRevision?: number;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    batchId: input.batchId,
    batchVersionId: input.batchVersionId,
    planId: input.planId,
    outputVersionId: input.outputVersionId,
    planSeq: input.planSeq,
    outputVersionNumber: input.outputVersionNumber,
    videoRelativePath: input.videoRelativePath,
    coverRelativePath: input.coverRelativePath,
    videoChecksum: input.videoChecksum,
    coverChecksum: input.coverChecksum,
    durationUs: 2_000_000,
    audioMode: 'narration',
    productionReady: true,
    subtitleCues: [],
    ...(input.editRevision === undefined ? {} : { editRevision: input.editRevision }),
  };
}

async function createSucceededRender(
  database: Database.Database,
  input: {
    projectId: string;
    batchId: string;
    batchVersionId: string;
    planId: string;
    outputVersionId: string;
    planSeq: number;
    outputVersionNumber: number;
    editRevision?: number;
    label: string;
    createdAt: string;
  },
): Promise<string> {
  const taskId = createBatchTask(database, input.projectId, {
    batchId: input.batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: input.outputVersionId,
    requestKey: `test-render:${input.outputVersionId}:${input.label}`,
    now: () => new Date(input.createdAt),
  });
  const renderDir = path.join(storageRoot, 'batch-renders', input.outputVersionId, input.label);
  fs.mkdirSync(renderDir, { recursive: true });
  const videoPath = path.join(renderDir, 'video.mp4');
  const coverPath = path.join(renderDir, 'cover.jpg');
  fs.writeFileSync(videoPath, Buffer.from(`video-${input.label}`));
  fs.writeFileSync(coverPath, Buffer.from(`cover-${input.label}`));
  const videoRelativePath = path.relative(storageRoot, videoPath);
  const coverRelativePath = path.relative(storageRoot, coverPath);
  const videoChecksum = await computeFingerprintFromFile(videoPath);
  const coverChecksum = await computeFingerprintFromFile(coverPath);
  const resultJson = JSON.stringify(resultFor({
    ...input,
    videoRelativePath,
    coverRelativePath,
    videoChecksum,
    coverChecksum,
  }));
  database.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(randomUUID(), taskId, resultJson, input.createdAt, input.createdAt, input.createdAt);
  database.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1, updatedAt = ? WHERE id = ?`)
    .run(input.createdAt, taskId);
  return taskId;
}

function createQueuedRender(
  database: Database.Database,
  input: {
    projectId: string;
    batchId: string;
    outputVersionId: string;
    createdAt: string;
    label: string;
  },
): string {
  return createBatchTask(database, input.projectId, {
    batchId: input.batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: input.outputVersionId,
    requestKey: `test-render:${input.outputVersionId}:queued:${input.label}`,
    now: () => new Date(input.createdAt),
  });
}

try {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      productCode TEXT NOT NULL DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    );
    INSERT INTO projects (id, name, productCode, createdAt)
    VALUES ('project-1', '导出新鲜度测试', 'SKU-FRESH', '2026-08-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
  `);
  for (const migration of BATCH_SCHEMA_MIGRATIONS) {
    db.exec(migration.sql);
    db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`)
      .run(migration.version, new Date().toISOString());
  }

  const projectId = 'project-1';
  const batchId = createBatchProduction(db, projectId, '导出新鲜度');
  const batchVersionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  const scriptId = createProjectScript(db, projectId, {
    sourceKind: 'script_draft',
    sourceId: 'script-source-1',
    title: '新鲜度脚本',
    bodyText: JSON.stringify({ segments: [{ id: 'segment-1', text: '正文', startUs: 0, endUs: 2_000_000 }] }),
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, batchVersionId, { scriptId, copyCount: 1 });
  const [planId] = createOutputPlansForSnapshot(db, batchVersionId, snapshotId);

  const sourcePath = path.join(root, 'source.mp4');
  fs.writeFileSync(sourcePath, Buffer.from('source-media-fixture'));
  const sourceFingerprint = await computeFingerprintFromFile(sourcePath);
  const assetId = createAsset(db, {
    projectId,
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: sourcePath },
    contentFingerprint: sourceFingerprint,
    mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run(randomUUID(), assetId, JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), '2026-08-01T00:00:00.000Z');
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'fixture',
    providerId: 'fixture',
    model: 'fixture',
    analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] },
  });
  addAssetToPool(db, batchVersionId, { assetId, analysisId });

  const arrangement = {
    schemaVersion: 'test-arrangement',
    preset: '3:4',
    fps: 24,
    targetDurationUs: 2_000_000,
    editRevision: 0,
    clips: [{
      clipId: 'clip-1',
      segmentId: 'segment-1',
      assetId,
      contentFingerprint: sourceFingerprint,
      sourceStartUs: 0,
      sourceEndUs: 2_000_000,
      timelineStartUs: 0,
      timelineEndUs: 2_000_000,
    }],
    cover: { assetId, timeUs: 500_000 },
    narration: { ready: true, productionReady: true, status: 'ready', durationUs: 2_000_000 },
    subtitle: { cues: [] },
    audio: { productionReady: true },
    productionReady: true,
    review: { decision: null },
  };
  const outputVersionId = createOutputVersion(db, planId, { arrangementJson: arrangement });
  db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = ? WHERE id = ?`)
    .run('2026-08-01T00:00:00.000Z', batchVersionId);
  db.prepare(`UPDATE batch_productions SET status = 'running', controlState = 'running', currentVersionId = ? WHERE id = ?`)
    .run(batchVersionId, batchId);
  const allocationRunId = randomUUID();
  db.prepare(`
    INSERT INTO batch_allocation_runs (id, batchVersionId, ruleVersion, seed, inputFingerprint, status, resultJson, createdAt)
    VALUES (?, ?, 'test', 'seed', 'fingerprint', 'completed', ?, ?)
  `).run(
    allocationRunId,
    batchVersionId,
    JSON.stringify({ status: 'completed', outputs: [{ planId, status: 'available', blockers: [] }] }),
    '2026-08-01T00:00:00.000Z',
  );
  db.prepare(`UPDATE batch_production_versions SET currentAllocationRunId = ? WHERE id = ?`)
    .run(allocationRunId, batchVersionId);

  await createSucceededRender(db, {
    projectId,
    batchId,
    batchVersionId,
    planId,
    outputVersionId,
    planSeq: 1,
    outputVersionNumber: 1,
    editRevision: 0,
    label: 'revision-0',
    createdAt: '2026-08-01T00:00:01.000Z',
  });
  const initialReview = setBatchPlanReviews(db, projectId, batchId, { planIds: [planId], decision: 'approved' });
  assert.equal(initialReview.pendingRender, false, '没有未完成渲染时审核结果应明确返回 false');
  const initialExport = await publishSelectedBatchOutputs(db, projectId, batchId, [planId], { storageRoot });
  assert.equal(initialExport.published, 1, 'revision 0 成功候选审核后应可导出');

  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(
    JSON.stringify({ ...arrangement, editRevision: 1, review: { decision: 'approved' } }),
    outputVersionId,
  );
  createQueuedRender(db, {
    projectId,
    batchId,
    outputVersionId,
    createdAt: '2026-08-01T00:00:02.000Z',
    label: 'stale',
  });
  const reviewWhileRendering = setBatchPlanReviews(db, projectId, batchId, { planIds: [planId], decision: 'approved' });
  assert.equal(reviewWhileRendering.pendingRender, true, 'queued render 应在审核写入结果中标记 pendingRender');
  const staleExport = await publishSelectedBatchOutputs(db, projectId, batchId, [planId], { storageRoot });
  assert.equal(staleExport.published, 0, '编辑后不能发布旧 revision 的候选');
  assert.equal(staleExport.skipped, 1);
  assert.match(staleExport.items[0]?.reason ?? '', /重新渲染/);
  db.prepare(`UPDATE batch_tasks SET status = 'failed' WHERE batchId = ? AND targetId = ? AND status = 'queued'`)
    .run(batchId, outputVersionId);

  await createSucceededRender(db, {
    projectId,
    batchId,
    batchVersionId,
    planId,
    outputVersionId,
    planSeq: 1,
    outputVersionNumber: 1,
    editRevision: 1,
    label: 'revision-1',
    createdAt: '2026-08-01T00:00:03.000Z',
  });
  const freshExport = await publishSelectedBatchOutputs(db, projectId, batchId, [planId], { storageRoot });
  assert.equal(freshExport.published, 1, '匹配 revision 的新候选应恢复导出');

  createQueuedRender(db, {
    projectId,
    batchId,
    outputVersionId,
    createdAt: '2026-08-01T00:00:04.000Z',
    label: 'pending',
  });
  const pendingExport = await publishSelectedBatchOutputs(db, projectId, batchId, [planId], { storageRoot });
  assert.equal(pendingExport.published, 0, '即使 revision 一致,仍在重渲染的成片也不得导出');
  assert.match(pendingExport.items[0]?.reason ?? '', /重新渲染/);
  db.prepare(`UPDATE batch_tasks SET status = 'failed' WHERE batchId = ? AND targetId = ? AND status = 'queued'`)
    .run(batchId, outputVersionId);

  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(
    JSON.stringify({ ...arrangement, editRevision: 0, review: { decision: 'approved' } }),
    outputVersionId,
  );
  const latestTask = db.prepare(`
    SELECT t.id
    FROM batch_tasks t
    WHERE t.batchId = ? AND t.workType = 'render' AND t.targetId = ? AND t.status = 'succeeded'
    ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
  `).get(batchId, outputVersionId) as { id: string };
  const latestAttempt = db.prepare(`SELECT resultJson FROM batch_task_attempts WHERE taskId = ?`).get(latestTask.id) as { resultJson: string };
  const legacyResult = JSON.parse(latestAttempt.resultJson) as Record<string, unknown>;
  delete legacyResult.editRevision;
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ?`).run(JSON.stringify(legacyResult), latestTask.id);
  const legacyExport = await publishSelectedBatchOutputs(db, projectId, batchId, [planId], { storageRoot });
  assert.equal(legacyExport.published, 1, '旧候选缺少 editRevision 且当前 revision=0 时应保持兼容');

  db.close();
  db = null;
  console.log('batch-output-export-freshness.test.ts: ok');
} finally {
  if (db) db.close();
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
