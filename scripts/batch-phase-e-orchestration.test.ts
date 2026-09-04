import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { resolveFullRenderContractHash } from '../lib/batch-production/cover-contract.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import {
  publishSelectedBatchOutputs,
  reallocateAndScheduleOutput,
  startOrResumePhaseE,
  updateBatchAssetExclusionAndSchedule,
} from '../lib/batch-production/phase-e.ts';
import { orchestrateBatchExport } from '../lib/batch-production/export-orchestrator.ts';
import { resolveBatchOutputMedia } from '../lib/batch-production/output-media.ts';
import { setBatchPlanReviews, readBatchPlanReview } from '../lib/batch-production/review.ts';
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
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT DEFAULT '', exportDirName TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT (datetime('now')), storeCode TEXT NOT NULL DEFAULT '', productSubmodel TEXT NOT NULL DEFAULT '', productionType TEXT NOT NULL DEFAULT '', editorName TEXT NOT NULL DEFAULT '', namingDate TEXT NOT NULL DEFAULT '', currentExportIdentityId TEXT);
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini', model TEXT,
      inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name, productCode, createdAt) VALUES ('project-1', '测试项目', 'SKU/E', '2026-08-03T00:00:00.000Z');
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

  db.exec(`
    CREATE TABLE final_edit_bgm_tracks (
      id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, fileFingerprint TEXT NOT NULL,
      durationUs INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      errorMessage TEXT, scannedAt TEXT NOT NULL, UNIQUE(fileFingerprint)
    );
    INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
    VALUES
      ('bgm-a', 'bgm/track-a.mp3', 'bgm-fingerprint-a', 12_000_000, 'mp3', 'ready', datetime('now')),
      ('bgm-b', 'bgm/track-b.mp3', 'bgm-fingerprint-b', 12_000_000, 'mp3', 'ready', datetime('now')),
      ('bgm-c', 'bgm/track-c.mp3', 'bgm-fingerprint-c', 12_000_000, 'mp3', 'ready', datetime('now'));
  `);
  fs.mkdirSync(path.join(storageRoot, 'bgm'), { recursive: true });
  for (const [id, fingerprint] of [['bgm-a', 'bgm-fingerprint-a'], ['bgm-b', 'bgm-fingerprint-b'], ['bgm-c', 'bgm-fingerprint-c']] as const) {
    fs.writeFileSync(path.join(storageRoot, 'bgm', `${id}.mp3`), Buffer.from(fingerprint));
  }

  // 口播先于分配(T6):首次 start 冻结并只建口播任务,口播未齐返回 narration_pending;
  // 口播全部终态后重入 start 才做联合分配并建封面任务(编辑器优先,不建整片渲染)。
  const pendingStart = startOrResumePhaseE(db, 'project-1', batchId);
  assert.equal(pendingStart.status, 'narration_pending');
  assert.equal(pendingStart.narrationPending, 1, '版本内 1 份脚本快照 = 1 条未完成口播任务');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions`).get() as { n: number }).n,
    0,
    '口播未齐时不得先建成片版本(不冻结分配运行)',
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render'`).get() as { n: number }).n,
    0,
    '口播未齐时不得建渲染任务',
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'narration'`).get() as { n: number }).n,
    1,
    '冻结后必须建一条口播任务',
  );
  // 口播失败或完成都能让 start 继续:这里先标记成功,重入应产出分配与封面任务。
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE workType = 'narration' AND targetId = ?`).run(snapshotId);
  const started = startOrResumePhaseE(db, 'project-1', batchId);
  assert.equal(started.status, 'running', '口播全部终态后重入 start 必须产出分配');
  assert.equal(Object.keys(started.outputVersionIds).length, 2);
  assert.equal(Object.keys(started.taskIds).length, 2, '口播任务已在冻结后建立,此处只建每条成片的封面任务');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'narration'`).get() as { n: number }).n,
    1,
    '同脚本多份成片只建立一条口播任务',
  );
  // 编辑器优先红线:生产阶段只建封面任务,绝不自动建整片 mp4 渲染任务。
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render' AND targetKind = 'output_version_cover'`).get() as { n: number }).n,
    2,
    '每个当前输出版本必须有一条独立封面任务',
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render' AND targetKind = 'output_version'`).get() as { n: number }).n,
    0,
    'Phase E 不得自动创建整片渲染任务',
  );
  const frozenPool = JSON.parse((db.prepare(`SELECT defaultsJson FROM batch_production_versions WHERE id = ?`).get(versionId) as { defaultsJson: string }).defaultsJson).batchMusicPool as Array<{ trackId: string }>;
  assert.equal(frozenPool.length, 3, '锁定时曲库池必须冻结进批次版本');
  // 导出身份也必须在 start 时冻结进版本快照（本项目身份不完整 → identity 留空，目录名仍冻结）。
  const frozenIdentity = (JSON.parse((db.prepare(`SELECT defaultsJson FROM batch_production_versions WHERE id = ?`).get(versionId) as { defaultsJson: string }).defaultsJson).batchExportIdentity) as { baseName: string | null; exportDirName: string; identity: unknown };
  assert.ok(frozenIdentity && typeof frozenIdentity.exportDirName === 'string' && frozenIdentity.exportDirName.length > 0, 'start 必须冻结导出目录名');
  assert.equal(frozenIdentity.identity, null, '生产身份不完整时身份字段留空，发布端走旧命名回退');
  const allocationArrangements = (db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE allocationRunId = ?`).all(started.allocationRunId) as Array<{ arrangementJson: string }>).map(({ arrangementJson }) => JSON.parse(arrangementJson));
  assert.deepEqual(
    allocationArrangements.map(({ music }) => music.trackId),
    [frozenPool[0].trackId, frozenPool[1].trackId],
    '两条成片依序分配不同的 BGM',
  );
  assert.equal((db.prepare(`SELECT inputState FROM batch_production_versions WHERE id = ?`).get(versionId) as { inputState: string }).inputState, 'frozen');
  assert.ok(
    (db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE allocationRunId = ?`).all(started.allocationRunId) as Array<{ arrangementJson: string }>)
      .every(({ arrangementJson }) => !arrangementJson.includes(offlineAssetId)),
    '离线池项应由 Phase E 分配器排除，而不是阻塞所有计划开跑',
  );
  const firstVersionCount = (db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions`).get() as { n: number }).n;
  const firstTaskCount = (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render'`).get() as { n: number }).n;
  const resumed = startOrResumePhaseE(db, 'project-1', batchId);
  if (resumed.status !== 'running') throw new Error(`expected running, got ${resumed.status}`);
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

  // 版本切换必须同时取消旧版本的封面任务与整片渲染任务。
  const otherBefore = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[1]) as { currentVersionId: string }).currentVersionId;
  const oldVersionOfPlan0 = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[0]) as { currentVersionId: string }).currentVersionId;
  const oldFullTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: oldVersionOfPlan0,
    requestKey: `test-old-full-render:${oldVersionOfPlan0}`,
  });
  reallocateAndScheduleOutput(db, 'project-1', batchId, planIds[0], 'fixture-reallocation');
  const targetAfterReallocation = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[0]) as { currentVersionId: string }).currentVersionId;
  assert.equal((db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planIds[1]) as { currentVersionId: string }).currentVersionId, otherBefore);
  const oldCoverTaskStatus = (db.prepare(`SELECT status FROM batch_tasks WHERE targetId = ? AND targetKind = 'output_version_cover'`).get(oldVersionOfPlan0) as { status: string }).status;
  const oldFullTaskStatus = (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(oldFullTaskId) as { status: string }).status;
  assert.equal(oldCoverTaskStatus, 'cancelled', '换画面必须取消旧版本的封面任务');
  assert.equal(oldFullTaskStatus, 'cancelled', '换画面必须取消旧版本的整片渲染任务');
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

  // 独立封面任务候选:封面墙/编辑器的封面来源,不依赖任何完整视频候选。
  const coverTask = db.prepare(`
    SELECT id FROM batch_tasks
    WHERE batchId = ? AND workType = 'render' AND targetKind = 'output_version_cover' AND targetId = ?
    ORDER BY createdAt DESC, id DESC LIMIT 1
  `).get(batchId, output.outputVersionId) as { id: string };
  const coverResultJson = JSON.stringify({
    projectId: 'project-1',
    batchId,
    batchVersionId: versionId,
    planId: publishPlanId,
    outputVersionId: output.outputVersionId,
    planSeq: output.seq,
    outputVersionNumber: output.versionNumber,
    coverRelativePath,
    coverChecksum,
    coverContractHash: resolveFullRenderContractHash(db, output.outputVersionId),
  });
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(randomUUID(), coverTask.id, coverResultJson, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(coverTask.id);
  const coverOnlyMedia = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'cover', 'candidate', storageRoot);
  assert.equal(coverOnlyMedia.absolutePath, coverPath, '封面任务成功后就该能读封面,不依赖完整视频候选');
  assert.throws(
    () => resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot),
    /没有可播放/,
    '封面任务结果绝不能被当成可播放的视频候选',
  );

  // 编排器按 arrangement.narration 判口播就绪;fixture 把口播已就绪写回 arrangement,
  // 对齐真实口播执行器行为(真实流里口播先于分配,渲染契约天然包含口播)。
  db.prepare(`
    UPDATE batch_output_versions
    SET arrangementJson = json_set(arrangementJson, '$.narration.productionReady', json('true'))
    WHERE id = ?
  `).run(output.outputVersionId);

  // 导出阶段按完整渲染契约创建整片渲染任务(export-orchestrator 的职责)。
  const renderTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: output.outputVersionId,
    requestKey: `render:${output.outputVersionId}:${resolveFullRenderContractHash(db, output.outputVersionId)}`,
  });
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
    editRevision: 0,
  });
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(randomUUID(), renderTaskId, resultJson, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(renderTaskId);

  const candidateMedia = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot);
  assert.equal(candidateMedia.absolutePath, videoPath);
  assert.equal(candidateMedia.productionReady, true);
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(
    JSON.stringify({ ...JSON.parse(resultJson), projectId: 'project-2' }),
    renderTaskId,
  );
  assert.throws(
    () => resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot),
    /没有可播放|不存在/,
    '候选媒体结果必须再次验证 project→batch→version→plan 谱系',
  );
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(resultJson, renderTaskId);

  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(
    JSON.stringify({ ...JSON.parse(resultJson), audioMode: 'silent_placeholder', productionReady: true }),
    renderTaskId,
  );
  assert.throws(
    () => resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'candidate', storageRoot),
    /没有可播放|不存在/,
    '候选媒体不得把 audioMode 与 productionReady 自相矛盾的结果标为正式可用',
  );
  db.prepare(`UPDATE batch_task_attempts SET resultJson = ? WHERE taskId = ? AND attemptNumber = 1`).run(resultJson, renderTaskId);

  // 审核门禁:未审核的成片即使渲染就绪也不能正式导出
  const reviewBefore = readBatchPlanReview(db, 'project-1', batchId, publishPlanId);
  assert.equal(reviewBefore.decision, null, '新渲染候选默认处于未审核态');
  const unapprovedPublish = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(unapprovedPublish.published, 0);
  assert.equal(unapprovedPublish.skipped, 1);
  assert.match(unapprovedPublish.items[0]?.reason ?? '', /审核/);
  const reviewWrite = setBatchPlanReviews(db, 'project-1', batchId, { planIds: [publishPlanId], decision: 'approved' });
  assert.deepEqual(reviewWrite.planIds, [publishPlanId]);
  assert.equal(readBatchPlanReview(db, 'project-1', batchId, publishPlanId).decision, 'approved');

  const published = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot, requireRenderContract: true });
  assert.equal(published.published, 1);
  assert.equal(published.skipped, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n, 2);
  const currentArtifactId = (db.prepare(`SELECT currentArtifactId FROM batch_output_plans WHERE id = ?`).get(publishPlanId) as { currentArtifactId: string | null }).currentArtifactId;
  assert.ok(currentArtifactId);
  const formalMedia = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'artifact', storageRoot);
  assert.equal(formalMedia.source, 'artifact');
  assert.ok(fs.existsSync(formalMedia.absolutePath));

  // 导出编排幂等:同一渲染契约重复 POST 返回 already_published,不复制新正式副本。
  const orchestrated = await orchestrateBatchExport(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(orchestrated.published, 0);
  assert.equal(orchestrated.items[0]?.status, 'already_published', '重复 POST 必须返回 already_published');
  assert.equal(orchestrated.items[0]?.videoArtifactId, currentArtifactId);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n,
    2,
    'already_published 不得复制新正式副本',
  );

  // 渲染契约 CAS:渲染期间内容又变化时,过期结果不得成为正式成片。
  db.prepare(`
    UPDATE batch_output_versions
    SET arrangementJson = json_set(arrangementJson, '$.editRevision', COALESCE(CAST(json_extract(arrangementJson, '$.editRevision') AS INTEGER), 0) + 1)
    WHERE id = ?
  `).run(output.outputVersionId);
  const staleContractPublish = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot, requireRenderContract: true });
  assert.equal(staleContractPublish.published, 0);
  assert.equal(staleContractPublish.skipped, 1);
  assert.match(staleContractPublish.items[0]?.reason ?? '', /变化|调整|重新导出/, '渲染契约 CAS 必须拒绝过期结果');
  assert.equal(
    (db.prepare(`SELECT currentArtifactId FROM batch_output_plans WHERE id = ?`).get(publishPlanId) as { currentArtifactId: string | null }).currentArtifactId,
    currentArtifactId,
    'CAS 失败不得切换当前正式成片指针',
  );
  // 恢复契约(发布函数的修订号门禁同样会拒绝旧结果,这里把 revision 复原继续后续断言)。
  db.prepare(`
    UPDATE batch_output_versions
    SET arrangementJson = json_set(arrangementJson, '$.editRevision', COALESCE(CAST(json_extract(arrangementJson, '$.editRevision') AS INTEGER), 0) - 1)
    WHERE id = ?
  `).run(output.outputVersionId);

  const secondPublish = await publishSelectedBatchOutputs(db, 'project-1', batchId, [publishPlanId], { storageRoot });
  assert.equal(secondPublish.published, 1);
  assert.notEqual(secondPublish.items[0]?.videoRelativePath, published.items[0]?.videoRelativePath, '重复导出必须追加新路径');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(publishPlanId) as { n: number }).n, 4);
  const latestFormalVideo = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'video', 'artifact', storageRoot);
  const latestFormalCover = resolveBatchOutputMedia(db, 'project-1', batchId, publishPlanId, 'cover', 'artifact', storageRoot);
  assert.equal(latestFormalVideo.absolutePath, path.join(storageRoot, secondPublish.items[0]!.videoRelativePath!));
  // 命名合约:封面比视频多一个「-封面」后缀,去掉后必须落到同一个发布序号
  assert.equal(
    latestFormalCover.absolutePath.replace(/-封面\.jpg$/u, ''),
    latestFormalVideo.absolutePath.replace(/\.mp4$/u, ''),
    '当前视频必须精确解析到同一发布序号的配对封面',
  );

  const silentPlanId = planIds[1];
  const silentVersion = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(silentPlanId) as { currentVersionId: string }).currentVersionId;
  const silentFullTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: silentVersion,
    requestKey: `render:${silentVersion}:${resolveFullRenderContractHash(db, silentVersion)}`,
  });
  const silentOutput = db.prepare(`SELECT versionNumber FROM batch_output_versions WHERE id = ?`).get(silentVersion) as { versionNumber: number };
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(
    randomUUID(),
    silentFullTaskId,
    JSON.stringify({
      projectId: 'project-1', batchId, batchVersionId: versionId, planId: silentPlanId,
      outputVersionId: silentVersion, planSeq: 2, outputVersionNumber: silentOutput.versionNumber,
      videoRelativePath, coverRelativePath, videoChecksum, coverChecksum, durationUs: 4_000_000,
      audioMode: 'silent_placeholder', productionReady: false,
    }),
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(silentFullTaskId);
  createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: silentVersion,
    requestKey: `test-silent-pending:${silentVersion}`,
  });
  const blocked = await publishSelectedBatchOutputs(db, 'project-1', batchId, [silentPlanId], { storageRoot });
  assert.equal(blocked.published, 0);
  assert.equal(blocked.skipped, 1);
  assert.match(blocked.items[0]?.reason ?? '', /静音|口播|正在重新渲染/, '静音候选即使有排队渲染任务也应先提示缺少口播');
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


  // 历史版本媒体(FR-S3-14):为计划新建 v2 并伪造成功渲染,可按 outputVersionId 读取任一版本
  const historicalPlanId = planIds[0];
  const historicalOldVersion = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(historicalPlanId) as { currentVersionId: string }).currentVersionId;
  const historicalNewVersion = createOutputVersion(db, historicalPlanId, { arrangementJson: { clips: [] } });
  const historicalTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: historicalNewVersion,
    requestKey: `render:${historicalNewVersion}:historical-fixture`,
  });
  db.prepare(`
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
    VALUES (?, ?, 1, 'succeeded', '{}', ?, ?, ?, ?)
  `).run(
    randomUUID(),
    historicalTaskId,
    JSON.stringify({
      projectId: 'project-1', batchId, batchVersionId: versionId, planId: historicalPlanId,
      outputVersionId: historicalNewVersion, planSeq: 1, outputVersionNumber: 2,
      videoRelativePath, coverRelativePath, videoChecksum, coverChecksum, durationUs: 4_000_000,
      audioMode: 'narration', productionReady: true,
    }),
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(historicalTaskId);
  const oldVersionMedia = resolveBatchOutputMedia(db, 'project-1', batchId, historicalPlanId, 'video', 'candidate', storageRoot, historicalOldVersion);
  assert.equal(oldVersionMedia.absolutePath, videoPath, '按 outputVersionId 必须能读取历史版本的候选媒体');
  const newVersionMedia = resolveBatchOutputMedia(db, 'project-1', batchId, historicalPlanId, 'video', 'candidate', storageRoot, historicalNewVersion);
  assert.equal(newVersionMedia.absolutePath, videoPath, '新版本的候选媒体同样可读');
  assert.throws(
    () => resolveBatchOutputMedia(db, 'project-1', batchId, historicalPlanId, 'video', 'candidate', storageRoot, 'ghost-version'),
    /版本不存在/,
    '指定不存在的版本必须拒绝',
  );

  // 审核态随版本重置:返工换画面后新版本没有 review 字段,必须回到未审核态。
  // 放在历史版本断言之后:恢复素材排除会重算联合分配,不应影响前面的发布断言。
  updateBatchAssetExclusionAndSchedule(db, 'project-1', batchId, assetId, false);
  setBatchPlanReviews(db, 'project-1', batchId, { planIds: [silentPlanId], decision: 'approved' });
  assert.equal(readBatchPlanReview(db, 'project-1', batchId, silentPlanId).decision, 'approved');
  const reviewResetVersion = reallocateAndScheduleOutput(db, 'project-1', batchId, silentPlanId, '审核返工换画面');
  assert.ok(reviewResetVersion.outputVersionIds[silentPlanId], '返工必须建立新候选版本');
  assert.equal(
    readBatchPlanReview(db, 'project-1', batchId, silentPlanId).decision,
    null,
    '换画面后新候选必须回到未审核态,需要重新审核',
  );
  // 撤销审核:已通过的成片可以撤销回到未审核态
  setBatchPlanReviews(db, 'project-1', batchId, { planIds: [publishPlanId], decision: 'approved' });
  setBatchPlanReviews(db, 'project-1', batchId, { planIds: [publishPlanId], decision: 'cancelled' });
  assert.equal(readBatchPlanReview(db, 'project-1', batchId, publishPlanId).decision, null, '撤销审核后回到未审核态');
  setBatchPlanReviews(db, 'project-1', batchId, { planIds: [publishPlanId], decision: 'approved' });

  db.close();
  console.log('batch Phase E orchestration tests passed');
} finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}