import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import {
  publishSelectedBatchOutputs,
  reallocateAndScheduleOutput,
  startOrResumePhaseE,
  updateBatchAssetExclusionAndSchedule,
} from '../lib/batch-production/phase-e.ts';
import { resolveBatchOutputMedia } from '../lib/batch-production/output-media.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-phase-e-orchestration-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

try {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT DEFAULT '');
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini', model TEXT,
      inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name, productCode) VALUES ('project-1', '测试项目', 'SKU/E');
  `);
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.notEqual(ready.state, 'compatibility_only');

  const batchId = createBatchProduction(db, 'project-1', 'Phase E');
  const versionId = createBatchProductionVersion(db, batchId, {
    copyCount: 2,
    defaultsJson: { outputPreset: '3:4', preset: '3:4', fps: 24, targetDurationSec: 4 },
  });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-1',
    title: '脚本一',
    bodyText: JSON.stringify({ segments: [
      { id: 'segment-1', text: '开场', startUs: 0, endUs: 2_000_000 },
      { id: 'segment-2', text: '卖点', startUs: 2_000_000, endUs: 4_000_000 },
    ] }),
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 2 });
  const planIds = createOutputPlansForSnapshot(db, versionId, snapshotId);

  const originalPath = path.join(root, 'original.mp4');
  fs.writeFileSync(originalPath, Buffer.from('original-media-fixture'));
  const originalFingerprint = await computeFingerprintFromFile(originalPath);
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: originalPath },
    contentFingerprint: originalFingerprint,
    mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run(randomUUID(), assetId, JSON.stringify({ kind: 'linked', absolutePath: originalPath }), new Date().toISOString());
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'fixture',
    providerId: 'fixture',
    model: 'fixture',
    analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });

  const offlinePath = path.join(root, 'offline-but-intact.mp4');
  fs.writeFileSync(offlinePath, Buffer.from('offline-media-fixture'));
  const offlineFingerprint = await computeFingerprintFromFile(offlinePath);
  const offlineAssetId = createAsset(db, {
    projectId: 'project-1', sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: offlinePath },
    contentFingerprint: offlineFingerprint, mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run(randomUUID(), offlineAssetId, JSON.stringify({ kind: 'linked', absolutePath: offlinePath }), new Date().toISOString());
  const offlineAnalysisId = createAnalysisVersion(db, {
    assetId: offlineAssetId, analyzerVersion: 'fixture', providerId: 'fixture', model: 'fixture',
    analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] },
  });
  addAssetToPool(db, versionId, { assetId: offlineAssetId, analysisId: offlineAnalysisId });
  db.prepare(`UPDATE batch_assets SET status = 'offline' WHERE id = ?`).run(offlineAssetId);

  const started = startOrResumePhaseE(db, 'project-1', batchId);
  assert.equal(Object.keys(started.outputVersionIds).length, 2);
  assert.equal(Object.keys(started.taskIds).length, 2);
  assert.equal((db.prepare(`SELECT inputState FROM batch_production_versions WHERE id = ?`).get(versionId) as { inputState: string }).inputState, 'frozen');
  assert.ok(
    (db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE allocationRunId = ?`).all(started.allocationRunId) as Array<{ arrangementJson: string }>)
      .every(({ arrangementJson }) => !arrangementJson.includes(offlineAssetId)),
    '离线池项应由 Phase E 分配器排除，而不是阻塞所有计划开跑',
  );
  const firstVersionCount = (db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions`).get() as { n: number }).n;
  const firstTaskCount = (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render'`).get() as { n: number }).n;
  const resumed = startOrResumePhaseE(db, 'project-1', batchId);
  assert.equal(resumed.allocationRunId, started.allocationRunId);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions`).get() as { n: number }).n, firstVersionCount);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render'`).get() as { n: number }).n, firstTaskCount);

  const excluded = updateBatchAssetExclusionAndSchedule(
    db, 'project-1', batchId, assetId, true, '用户判断不适合本批次',
  );
  assert.equal(excluded.allocationStatus, 'blocked');
  const excludedReport = db.prepare(`SELECT resultJson FROM batch_allocation_runs WHERE id = ?`).get(excluded.allocationRunId) as { resultJson: string };
  assert.deepEqual(
    (JSON.parse(excludedReport.resultJson) as { exclusions: Array<{ assetId: string; reason: string }> }).exclusions,
    [
      { assetId, reason: '用户判断不适合本批次' },
      { assetId: offlineAssetId, reason: '素材状态为 offline' },
    ].sort((left, right) => left.assetId.localeCompare(right.assetId)),
  );
  const restoredAfterExclusion = updateBatchAssetExclusionAndSchedule(db, 'project-1', batchId, assetId, false);
  assert.equal(restoredAfterExclusion.allocationRunId, started.allocationRunId, '清除排除应命中原冻结输入的确定性运行');
  assert.deepEqual(
    (db.prepare(`SELECT currentVersionId FROM batch_output_plans ORDER BY seq`).all() as Array<{ currentVersionId: string }>).map(({ currentVersionId }) => currentVersionId),
    planIds.map((planId) => started.outputVersionIds[planId]),
    '输入排除恢复时应恢复对应联合运行的候选指针',
  );

  const otherBefore = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[1]) as { currentVersionId: string }).currentVersionId;
  reallocateAndScheduleOutput(db, 'project-1', batchId, planIds[0], 'fixture-reallocation');
  const targetAfterReallocation = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[0]) as { currentVersionId: string }).currentVersionId;
  assert.equal((db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[1]) as { currentVersionId: string }).currentVersionId, otherBefore);
  startOrResumePhaseE(db, 'project-1', batchId);
  assert.equal(
    (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[0]) as { currentVersionId: string }).currentVersionId,
    targetAfterReallocation,
    '幂等恢复原始联合分配不得回滚后续的单条重分配决定',
  );

  const publishPlanId = planIds[0];
  const output = db.prepare(`
    SELECT p.currentVersionId AS outputVersionId, p.seq, o.versionNumber
    FROM batch_output_plans p JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ?
  `).get(publishPlanId) as { outputVersionId: string; seq: number; versionNumber: number };
  const candidateDir = path.join(storageRoot, 'batch-renders', output.outputVersionId, 'fixture');
  fs.mkdirSync(candidateDir, { recursive: true });
  const videoPath = path.join(candidateDir, 'video.mp4');
  const coverPath = path.join(candidateDir, 'cover.jpg');
  fs.writeFileSync(videoPath, Buffer.from('candidate-video'));
  fs.writeFileSync(coverPath, Buffer.from('candidate-cover'));
  const videoRelativePath = path.relative(storageRoot, videoPath);
  const coverRelativePath = path.relative(storageRoot, coverPath);
  const videoChecksum = await computeFingerprintFromFile(videoPath);
  const coverChecksum = await computeFingerprintFromFile(coverPath);
  const renderTask = db.prepare(`
    SELECT id FROM batch_tasks
    WHERE batchId = ? AND workType = 'render' AND targetId = ?
    ORDER BY createdAt DESC, id DESC LIMIT 1
  `).get(batchId, output.outputVersionId) as { id: string };
  const resultJson = JSON.stringify({
    projectId: 'project-1',
    batchId,
    batchVersionId: versionId,
    planId: publishPlanId,
    outputVersionId: output.outputVersionId,
    planSeq: output.seq,
    outputVersionNumber: output.versionNumber,
    videoRelativePath,
    coverRelativePath,
    videoChecksum,
    coverChecksum,
    durationUs: 4_000_000,
    audioMode: 'narration',
    productionReady: true,
  });
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(randomUUID(), renderTask.id, resultJson, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(renderTask.id);

  const candidateMedia = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot);
  assert.equal(candidateMedia.absolutePath, videoPath);
  assert.equal(candidateMedia.productionReady, true);
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(
    JSON.stringify({ ...JSON.parse(resultJson), projectId: 'project-2' }),
    renderTask.id,
  );
  assert.throws(
    () => resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot),
    /没有可播放|不存在/,
    '候选媒体结果必须再次验证 project→batch→version→plan 谱系',
  );
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(resultJson, renderTask.id);

  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(
    JSON.stringify({ ...JSON.parse(resultJson), audioMode: 'silent_placeholder', productionReady: true }),
    renderTask.id,
  );
  assert.throws(
    () => resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot),
    /没有可播放|不存在/,
    '候选媒体不得把 audioMode 与 productionReady 自相矛盾的结果标为正式可用',
  );
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(resultJson, renderTask.id);

  const published = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(published.published, 1);
  assert.equal(published.skipped, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n, 2);
  const currentArtifactId = (db.prepare(`SELECT currentArtifactId FROM batch_output_plans WHERE id = ?`).get(publishPlanId) as { currentArtifactId: string | null }).currentArtifactId;
  assert.ok(currentArtifactId);
  const formalMedia = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'artifact', storageRoot);
  assert.equal(formalMedia.source, 'artifact');
  assert.ok(fs.existsSync(formalMedia.absolutePath));

  const secondPublish = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(secondPublish.published, 1);
  assert.notEqual(secondPublish.items[0]?.videoRelativePath, published.items[0]?.videoRelativePath, '重复导出必须追加新路径');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n, 4);
  const latestFormalVideo = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'artifact', storageRoot);
  const latestFormalCover = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'cover', 'artifact', storageRoot);
  assert.equal(latestFormalVideo.absolutePath, path.join(storageRoot, secondPublish.items[0]!.videoRelativePath!));
  assert.equal(
    latestFormalCover.absolutePath.replace(/\.jpg$/u, ''),
    latestFormalVideo.absolutePath.replace(/\.mp4$/u, ''),
    '当前视频必须精确解析到同一发布序号的配对封面',
  );

  const silentPlanId = planIds[1];
  const silentVersion = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(silentPlanId) as { currentVersionId: string }).currentVersionId;
  const silentTask = (db.prepare(`SELECT id FROM batch_tasks WHERE targetId = ?`).get(silentVersion) as { id: string }).id;
  const silentOutput = db.prepare(`SELECT versionNumber FROM batch_output_versions WHERE id = ?`).get(silentVersion) as { versionNumber: number };
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(
    randomUUID(),
    silentTask,
    JSON.stringify({
      projectId: 'project-1', batchId, batchVersionId: versionId, planId: silentPlanId,
      outputVersionId: silentVersion, planSeq: 2, outputVersionNumber: silentOutput.versionNumber,
      videoRelativePath, coverRelativePath, videoChecksum, coverChecksum, durationUs: 4_000_000,
      audioMode: 'silent_placeholder', productionReady: false,
    }),
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(silentTask);
  const blocked = await publishSelectedBatchOutputs(db, 'project-1', batchId, [silentPlanId], { storageRoot });
  assert.equal(blocked.published, 0);
  assert.equal(blocked.skipped, 1);
  assert.match(blocked.items[0]?.reason ?? '', /静音|口播/);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(silentPlanId) as { n: number }).n, 0);

  fs.appendFileSync(originalPath, Buffer.from('changed'));
  const preflightSkipped = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(preflightSkipped.published, 0);
  assert.equal(preflightSkipped.skipped, 1);
  assert.match(preflightSkipped.items[0]?.reason ?? '', /指纹|原片|内容/);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n,
    4,
    '正式前检失败必须逐条跳过且不得追加 artifact',
  );

  const blockedByLatestAllocation = updateBatchAssetExclusionAndSchedule(
    db, 'project-1', batchId, assetId, true, '正式发布前手工排除',
  );
  assert.equal(blockedByLatestAllocation.allocationStatus, 'blocked');
  const latestBlockedPublish = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(latestBlockedPublish.published, 0);
  assert.equal(latestBlockedPublish.skipped, 1);
  assert.match(latestBlockedPublish.items[0]?.reason ?? '', /最新联合分配已阻塞|no-legal-media/);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n,
    4,
    '最新分配已阻塞时不得绕过门禁重复发布旧候选',
  );

  db.close();
  console.log('batch Phase E orchestration tests passed');
} finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
