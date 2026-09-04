/**
 * 成片最终发布的并发与最终事务 CAS 回归:
 * 1. 复制期间撤销审核:最终事务内重查审核态,不得切换当前正式成片指针,
 *    本次复制的一对文件必须清理,旧正式产物不受影响;
 * 2. 并发重复 POST:两个编排请求同时跑同一份渲染结果时,只注册一对
 *    artifact、只留一份正式文件,败者返回 already_published 并清理自己
 *    多复制的文件;
 * 3. 并发下当前指针唯一且可播放。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-export-concurrency-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

// dataRoot() 在模块初始化时冻结:先指向隔离的临时根再加载项目模块。
const { createAsset, createAnalysisVersion } = await import('../lib/batch-production/assets.ts');
const { computeFingerprintFromFile } = await import('../lib/batch-production/fingerprint.ts');
const { publishSelectedBatchOutputs } = await import('../lib/batch-production/phase-e.ts');
const { orchestrateBatchExport } = await import('../lib/batch-production/export-orchestrator.ts');
const { createOutputPlansForSnapshot, createOutputVersion } = await import('../lib/batch-production/plans.ts');
const { setBatchPlanReviews } = await import('../lib/batch-production/review.ts');
const { BATCH_SCHEMA_MIGRATIONS } = await import('../lib/batch-production/schema.ts');
const { createBatchTask } = await import('../lib/batch-production/tasks.ts');
const { addAssetToPool, createBatchProduction, createBatchProductionVersion } = await import('../lib/batch-production/versions.ts');
const { createProjectScript, snapshotScriptIntoBatch } = await import('../lib/batch-production/scripts.ts');
const { resolveFullRenderContractHash } = await import('../lib/batch-production/cover-contract.ts');

let db: Database.Database | null = null;

function walk(rootPath: string, extension: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(extension)) found.push(full);
    }
  };
  visit(rootPath);
  return found;
}

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
  editRevision: number;
  coverTimeUs: number;
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
    editRevision: input.editRevision,
    coverTimeUs: input.coverTimeUs,
  };
}

/** 创建一条 requestKey 携带完整渲染契约哈希的成功整片渲染任务(编辑器优先正式流程)。 */
async function createSucceededRenderWithContractKey(
  database: Database.Database,
  input: {
    projectId: string;
    batchId: string;
    batchVersionId: string;
    planId: string;
    outputVersionId: string;
    planSeq: number;
    outputVersionNumber: number;
    editRevision: number;
    coverTimeUs: number;
    label: string;
    createdAt: string;
  },
): Promise<string> {
  const requestKey = `render:${input.outputVersionId}:${resolveFullRenderContractHash(database, input.outputVersionId)}`;
  const taskId = createBatchTask(database, input.projectId, {
    batchId: input.batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: input.outputVersionId,
    requestKey,
    now: () => new Date(input.createdAt),
  });
  const renderDir = path.join(storageRoot, 'batch-renders', input.outputVersionId, input.label);
  fs.mkdirSync(renderDir, { recursive: true });
  const videoPath = path.join(renderDir, 'video.mp4');
  const coverPath = path.join(renderDir, 'cover.jpg');
  fs.writeFileSync(videoPath, Buffer.from(`video-${input.label}`));
  fs.writeFileSync(coverPath, Buffer.from(`cover-${input.label}`));
  const resultJson = JSON.stringify(resultFor({
    ...input,
    videoRelativePath: path.relative(storageRoot, videoPath),
    coverRelativePath: path.relative(storageRoot, coverPath),
    videoChecksum: await computeFingerprintFromFile(videoPath),
    coverChecksum: await computeFingerprintFromFile(coverPath),
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

try {
  db = new Database(':memory:');
  // 闭包内使用非空别名:TS 对 try 块里的赋值不向回调闭包传播收窄。
  const conn: Database.Database = db;
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      productCode TEXT NOT NULL DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      storeCode TEXT NOT NULL DEFAULT '',
      productSubmodel TEXT NOT NULL DEFAULT '',
      productionType TEXT NOT NULL DEFAULT '',
      editorName TEXT NOT NULL DEFAULT '',
      namingDate TEXT NOT NULL DEFAULT '',
      currentExportIdentityId TEXT
    );
    INSERT INTO projects (id, name, productCode, createdAt)
    VALUES ('project-1', '导出并发测试', 'SKU-RACE', '2026-08-01T00:00:00.000Z');
    CREATE TABLE IF NOT EXISTS batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
  `);
  for (const migration of BATCH_SCHEMA_MIGRATIONS) {
    db.exec(migration.sql);
    db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`)
      .run(migration.version, new Date().toISOString());
  }

  const projectId = 'project-1';
  const batchId = createBatchProduction(db, projectId, '导出并发');
  const batchVersionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  const scriptId = createProjectScript(db, projectId, {
    sourceKind: 'script_draft',
    sourceId: 'script-source-race',
    title: '并发脚本',
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
    cover: { assetId, timeUs: 1_000_000 },
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

  await createSucceededRenderWithContractKey(db, {
    projectId,
    batchId,
    batchVersionId,
    planId,
    outputVersionId,
    planSeq: 1,
    outputVersionNumber: 1,
    editRevision: 0,
    coverTimeUs: 1_000_000,
    label: 'contract-0',
    createdAt: '2026-08-01T00:00:01.000Z',
  });
  setBatchPlanReviews(db, projectId, batchId, { planIds: [planId], decision: 'approved' });

  const mp4sBefore = walk(storageRoot, '.mp4').length;
  const jpgsBefore = walk(storageRoot, '.jpg').length;
  assert.equal(mp4sBefore, 1, 'fixture:只有渲染候选一份 mp4');
  assert.equal(jpgsBefore, 1, 'fixture:只有渲染候选一份封面');

  // --- 回归 1:复制期间撤销审核,最终事务内 CAS 必须拒绝发布 ---
  const revoked = await publishSelectedBatchOutputs(db, projectId, batchId, [planId], {
    storageRoot,
    requireRenderContract: true,
    beforeRegister: () => {
      // 文件已复制完成、最终注册事务前撤销审核(撤销审核不递增 editRevision)。
      conn.prepare(`UPDATE batch_output_versions SET arrangementJson = json_remove(arrangementJson, '$.review') WHERE id = ?`)
        .run(outputVersionId);
    },
  });
  assert.equal(revoked.published, 0, '复制期间撤销审核不得发布');
  assert.equal(revoked.skipped, 1);
  assert.match(revoked.items[0]?.reason ?? '', /审核/, '拒绝原因必须点明审核状态');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(planId) as { n: number }).n,
    0,
    '审核 CAS 失败不得注册 artifact',
  );
  assert.equal(
    (db.prepare(`SELECT currentArtifactId FROM batch_output_plans WHERE id = ?`).get(planId) as { currentArtifactId: string | null }).currentArtifactId,
    null,
    '审核 CAS 失败不得切换当前正式成片指针',
  );
  assert.equal(walk(storageRoot, '.mp4').length, mp4sBefore, '审核 CAS 失败必须清理本次复制的文件');
  assert.equal(walk(storageRoot, '.jpg').length, jpgsBefore, '审核 CAS 失败必须清理本次复制的封面文件');

  // 恢复审核,回到可发布状态。
  setBatchPlanReviews(db, projectId, batchId, { planIds: [planId], decision: 'approved' });

  // --- 回归 2:并发重复 POST 只注册一对 artifact、只留一份正式文件 ---
  // 用屏障保证两个请求都已复制完文件、即将进入最终注册事务，再同时放行。
  // 这样测试命中的一定是最终事务竞态，而不是第二个请求较晚启动后在前置
  // already_published 检查处提前返回。
  let releaseRegistration!: () => void;
  const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
  let arrivals = 0;
  let resolveBothArrived!: () => void;
  let arrivalTimeout: ReturnType<typeof setTimeout>;
  const bothArrived = new Promise<void>((resolve, reject) => {
    resolveBothArrived = resolve;
    arrivalTimeout = setTimeout(() => reject(new Error('两个并发请求没有同时到达最终注册屏障')), 2_000);
  });
  const raceOptions = {
    storageRoot,
    wakeScheduler: () => undefined,
    beforeRegister: async () => {
      arrivals += 1;
      if (arrivals === 2) {
        clearTimeout(arrivalTimeout);
        resolveBothArrived();
      }
      await registrationGate;
    },
  } as Parameters<typeof orchestrateBatchExport>[4] & { beforeRegister: () => Promise<void> };
  const raceAPromise = orchestrateBatchExport(db, projectId, batchId, [planId], raceOptions);
  const raceBPromise = orchestrateBatchExport(db, projectId, batchId, [planId], raceOptions);
  await bothArrived;
  releaseRegistration();
  const [raceA, raceB] = await Promise.all([raceAPromise, raceBPromise]);
  const statuses = [raceA.items[0]?.status, raceB.items[0]?.status].sort();
  assert.deepEqual(
    statuses,
    ['already_published', 'published'],
    '并发重复 POST:一个注册成功、一个幂等命中,不允许两个都 published',
  );
  const publishCount = [raceA, raceB].reduce((sum, result) => sum + result.published, 0);
  assert.equal(publishCount, 1);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(planId) as { n: number }).n,
    2,
    '并发重复 POST 只允许注册一对 artifact(视频+封面)',
  );
  const currentArtifactId = (db.prepare(`SELECT currentArtifactId FROM batch_output_plans WHERE id = ?`).get(planId) as { currentArtifactId: string | null }).currentArtifactId;
  assert.ok(currentArtifactId, '并发发布后必须有唯一当前正式指针');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ? AND id = ?`).get(planId, currentArtifactId) as { n: number }).n,
    1,
    '当前指针必须指向已注册的 artifact',
  );
  assert.equal(
    walk(storageRoot, '.mp4').length,
    mp4sBefore + 1,
    '并发重复 POST 败者必须清理自己多复制的视频文件,只留一份正式发布',
  );
  assert.equal(walk(storageRoot, '.jpg').length, jpgsBefore + 1, '并发重复 POST 只留一份正式封面文件');

  // --- 回归 3:并发发布后的后续 POST 依旧幂等,不新增文件 ---
  const afterRace = await orchestrateBatchExport(db, projectId, batchId, [planId], { storageRoot, wakeScheduler: () => undefined });
  assert.equal(afterRace.items[0]?.status, 'already_published');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(planId) as { n: number }).n, 2);
  assert.equal(walk(storageRoot, '.mp4').length, mp4sBefore + 1);

  // --- 回归 4:当前视频相同但配套封面指纹损坏时，不得误判 already_published ---
  const currentCoverArtifact = db.prepare(`
    SELECT id FROM batch_artifacts
    WHERE outputPlanId = ? AND kind = 'cover'
    ORDER BY createdAt DESC, id DESC LIMIT 1
  `).get(planId) as { id: string };
  db.prepare(`UPDATE batch_artifacts SET checksum = 'sha256:wrong-formal-cover' WHERE id = ?`).run(currentCoverArtifact.id);
  const repairedPair = await orchestrateBatchExport(db, projectId, batchId, [planId], {
    storageRoot,
    wakeScheduler: () => undefined,
  });
  assert.equal(repairedPair.items[0]?.status, 'published', '正式封面指纹不匹配时必须重新发布完整产物对');
  assert.equal(repairedPair.published, 1);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_artifacts WHERE outputPlanId = ?`).get(planId) as { n: number }).n,
    4,
    '修复损坏配对时应追加一对新 artifact，并保留旧历史',
  );
  assert.notEqual(repairedPair.items[0]?.videoArtifactId, currentArtifactId, '修复后当前指针必须切到新视频 artifact');
  assert.equal(walk(storageRoot, '.mp4').length, mp4sBefore + 2);
  assert.equal(walk(storageRoot, '.jpg').length, jpgsBefore + 2);

  // --- 回归 5:任务已排队但调度器唤醒失败必须显式报错，重试还会再次唤醒 ---
  const editedArrangement = JSON.parse((db.prepare(`
    SELECT arrangementJson FROM batch_output_versions WHERE id = ?
  `).get(outputVersionId) as { arrangementJson: string }).arrangementJson) as Record<string, unknown>;
  editedArrangement.editRevision = 1;
  editedArrangement.review = { decision: 'approved' };
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`)
    .run(JSON.stringify(editedArrangement), outputVersionId);
  let failedWakeAttempts = 0;
  await assert.rejects(
    () => orchestrateBatchExport(db!, projectId, batchId, [planId], {
      storageRoot,
      wakeScheduler: async () => {
        failedWakeAttempts += 1;
        throw new Error('fixture wake failure');
      },
    }),
    /调度器|唤醒|启动/,
    '唤醒失败不能仍返回 render_queued 假装任务会自动运行',
  );
  assert.equal(failedWakeAttempts, 1);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE targetId = ? AND status = 'queued'`).get(outputVersionId) as { n: number }).n,
    1,
    '唤醒失败时已持久化的排队任务应保留，供用户重试',
  );
  let retryWakeAttempts = 0;
  const wakeRetry = await orchestrateBatchExport(db, projectId, batchId, [planId], {
    storageRoot,
    wakeScheduler: () => { retryWakeAttempts += 1; },
  });
  assert.equal(wakeRetry.items[0]?.status, 'rendering', '重试应复用既有排队任务');
  assert.equal(retryWakeAttempts, 1, '复用既有排队任务时仍必须再次唤醒调度器');

  // --- 回归 6:较新的旧契约失败任务不得遮住当前契约的排队任务 ---
  const currentQueuedTaskId = wakeRetry.items[0]?.taskId;
  assert.ok(currentQueuedTaskId);
  const staleFailedTaskId = createBatchTask(db, projectId, {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: outputVersionId,
    requestKey: `render:${outputVersionId}:rnd_${'f'.repeat(32)}`,
    now: () => new Date('2099-08-01T00:00:10.000Z'),
  });
  db.prepare(`UPDATE batch_tasks SET status = 'failed', expectedState = 'stopped' WHERE id = ?`).run(staleFailedTaskId);
  const currentTaskWins = await orchestrateBatchExport(db, projectId, batchId, [planId], {
    storageRoot,
    wakeScheduler: () => undefined,
  });
  assert.equal(currentTaskWins.items[0]?.status, 'rendering', '编排状态必须来自当前完整渲染契约');
  assert.equal(currentTaskWins.items[0]?.taskId, currentQueuedTaskId, '必须返回当前契约已有任务，而非旧失败任务');

  db.close();
  db = null;
  console.log('batch-export-concurrency.test.ts: ok');
} finally {
  if (db) db.close();
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
