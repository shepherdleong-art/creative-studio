import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import { allocateBatch, type FrozenBatchInput } from '../lib/batch-production/allocator.ts';
import { resolveAllocationMusicTrackIds } from '../lib/batch-production/bgm.ts';
import { startOrResumePhaseE } from '../lib/batch-production/phase-e.ts';
import { createBatchNarrationExecutor } from '../lib/batch-production/narration-executor.ts';
import { resolveBatchBgm } from '../lib/batch-production/batch-renderer.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-m2-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'bgm'), { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

function setupDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
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
    CREATE TABLE final_edit_tts_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL DEFAULT '', keyEnv TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, isBuiltin INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE final_edit_bgm_tracks (
      id TEXT PRIMARY KEY, relativePath TEXT NOT NULL, fileFingerprint TEXT NOT NULL,
      durationUs INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      errorMessage TEXT, scannedAt TEXT NOT NULL, UNIQUE(fileFingerprint)
    );
    INSERT INTO projects (id, name, productCode) VALUES ('project-1', '测试项目', 'SKU');
    INSERT INTO final_edit_tts_providers
      (id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, createdAt, updatedAt)
    VALUES ('vapi-qwen3-tts', 'V-API Qwen3 TTS Flash', 'vapi-qwen-json-url', 'https://api.v3.cm', 'test-key', '', 'qwen3-tts-flash', 1, 1, datetime('now'), datetime('now'));
  `);
  return db;
}

async function seedBgmLibrary(db: Database.Database, trackNames: string[]): Promise<Array<{ trackId: string; fingerprint: string; relativePath: string }>> {
  const seeded: Array<{ trackId: string; fingerprint: string; relativePath: string }> = [];
  for (const name of trackNames) {
    const absolutePath = path.join(storageRoot, 'bgm', name);
    fs.writeFileSync(absolutePath, Buffer.from(`bgm-content:${name}`));
    const fingerprint = await computeFingerprintFromFile(absolutePath);
    const trackId = `track-${name}`;
    const relativePath = path.relative(storageRoot, absolutePath).split(path.sep).join('/');
    db.prepare(`
      INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt)
      VALUES (?, ?, ?, 12_000_000, 'mp3', 'ready', ?)
    `).run(trackId, relativePath, fingerprint.slice('sha256:'.length), new Date().toISOString());
    seeded.push({ trackId, fingerprint, relativePath });
  }
  return seeded;
}

async function addAssetPoolItem(db: Database.Database, versionId: string, assetId: string): Promise<void> {
  const originalPath = path.join(root, `${assetId}.mp4`);
  fs.writeFileSync(originalPath, Buffer.from(`media-${assetId}`));
  const fingerprint = await computeFingerprintFromFile(originalPath);
  const createdAssetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: originalPath },
    contentFingerprint: fingerprint,
    mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run(randomUUID(), createdAssetId, JSON.stringify({ kind: 'linked', absolutePath: originalPath }), new Date().toISOString());
  const analysisId = createAnalysisVersion(db, {
    assetId: createdAssetId,
    analyzerVersion: 'fixture',
    providerId: 'fixture',
    model: 'fixture',
    analysisJson: { durationUs: 40_000_000, usableRanges: [{ startUs: 0, endUs: 40_000_000, qualityScore: 1 }] },
  });
  addAssetToPool(db, versionId, { assetId: createdAssetId, analysisId });
}

/** 生成合法静音 PCM WAV(48kHz 16bit mono,指定秒数),供 ffprobe 探测时长。 */
function silentWavBytes(durationSec: number): Buffer {
  const sampleRate = 48_000;
  const sampleCount = sampleRate * durationSec;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

try {
  // ---------- A. 时长链路:计划自身脚本快照的时长优先,整批值兜底 ----------
  {
    const input: FrozenBatchInput = {
      projectId: 'p',
      batchId: 'b',
      batchVersionId: 'v',
      fps: 24,
      preset: '3:4',
      targetDurationSec: 15,
      plans: [
        { planId: 'plan-15', scriptSnapshotId: 's15', bodyText: '第一句介绍。第二句卖点！', scriptSnapshot: { targetDurationSec: 15 } },
        { planId: 'plan-30', scriptSnapshotId: 's30', bodyText: '第一句介绍。第二句卖点！', scriptSnapshot: { targetDurationSec: 30 } },
        { planId: 'plan-fallback', scriptSnapshotId: 's-old', bodyText: '第一句介绍。第二句卖点！', scriptSnapshot: {} },
      ],
      assets: [{ assetId: 'asset-1', contentFingerprint: 'sha256:' + 'a'.repeat(64), analysisJson: { durationUs: 40_000_000 } }],
    };
    const result = allocateBatch(input);
    const byPlan = new Map(result.outputs.map(({ planId, arrangement }) => [planId, arrangement]));
    assert.equal(byPlan.get('plan-15')?.targetDurationUs, 15_000_000, '15s 脚本的成片时长必须是 15s');
    assert.equal(byPlan.get('plan-30')?.targetDurationUs, 30_000_000, '30s 脚本的成片时长必须是 30s');
    assert.equal(byPlan.get('plan-fallback')?.targetDurationUs, 15_000_000, '历史快照无时长字段时回落整批默认值');
  }

  // ---------- B. 配音执行器:同脚本 N 份共用一条配音;按脚本音色 ----------
  const db = setupDb(path.join(root, 'workbench.db'));
  await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });

  const batchId = createBatchProduction(db, 'project-1', '配音批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 10, defaultsJson: {} });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-a',
    title: '脚本A',
    bodyText: '第一句介绍产品。第二句说明优势！',
    sourceVersion: 'v1',
    metadata: {
      targetDurationSec: 15,
      narrationConfigJson: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1.2 },
    },
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 10 });
  const planIds = createOutputPlansForSnapshot(db, versionId, snapshotId);
  assert.equal(planIds.length, 10, '一份脚本 10 份 = 10 张成片计划');
  for (const planId of planIds) {
    db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES (?, ?, 1, '{}', ?)
    `).run(randomUUID(), planId, new Date().toISOString());
  }

  const synthesizeCalls: Array<{ providerId: string; voice: string; speed: number; segmentCount: number }> = [];
  const executor = createBatchNarrationExecutor({
    storageRoot,
    synthesize: async (providerId, input) => {
      synthesizeCalls.push({ providerId, voice: input.voice, speed: input.speed, segmentCount: input.segments.length });
      fs.mkdirSync(path.dirname(path.join(input.outputDir, 'narration.wav')), { recursive: true });
      fs.writeFileSync(path.join(input.outputDir, 'narration.wav'), silentWavBytes(15));
      return {
        relativePath: input.relativeOutputPath,
        absolutePath: path.join(input.outputDir, 'narration.wav'),
        durationUs: 15_000_000,
        segmentTimings: input.segments.map((segment, index) => ({
          segmentId: segment.segmentId,
          startUs: index * 7_000_000,
          endUs: index === input.segments.length - 1 ? 15_000_000 : (index + 1) * 7_000_000,
        })),
      };
    },
  });

  const taskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'narration',
    targetKind: 'script_snapshot',
    targetId: snapshotId,
    requestKey: `narration:${versionId}:${snapshotId}`,
  });
  const idempotentTaskId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'narration',
    targetKind: 'script_snapshot',
    targetId: snapshotId,
    requestKey: `narration:${versionId}:${snapshotId}`,
  });
  assert.equal(idempotentTaskId, taskId, '同一脚本快照重复提交只保留一条口播任务');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'narration'`).get() as { n: number }).n,
    1,
    '一份脚本 10 份成片只建立一条口播任务',
  );

  const claim = {
    task: { id: taskId, batchId, workType: 'narration' as const, targetKind: 'script_snapshot' as const, targetId: snapshotId },
    attempt: { id: 'attempt-1', attemptNumber: 1 },
  };
  const execution = await executor.execute({
    db,
    claim,
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  });
  execution.commit?.();
  assert.equal(synthesizeCalls.length, 1, '同脚本所有成片只调用一次 TTS');
  assert.equal(synthesizeCalls[0]?.voice, 'Cherry');
  assert.equal(synthesizeCalls[0]?.speed, 1.2);
  assert.equal(synthesizeCalls[0]?.segmentCount, 2);

  const storedNarration = db.prepare(`
    SELECT narrationJson, audioRelativePath, audioFingerprint FROM batch_script_narrations WHERE scriptSnapshotId = ?
  `).get(snapshotId) as { narrationJson: string; audioRelativePath: string; audioFingerprint: string };
  const narrationJson = JSON.parse(storedNarration.narrationJson) as { productionReady: boolean; mode: string; durationUs: number };
  assert.equal(narrationJson.productionReady, true, '口播快照必须是 productionReady');
  assert.equal(narrationJson.mode, 'local_ready');
  assert.equal(narrationJson.durationUs, 15_000_000);
  assert.ok(storedNarration.audioRelativePath.startsWith('batch-narration/'));
  assert.ok(storedNarration.audioFingerprint.startsWith('sha256:'));

  const arrangementRows = db.prepare(`
    SELECT o.arrangementJson FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    WHERE p.scriptSnapshotId = ?
  `).all(snapshotId) as Array<{ arrangementJson: string }>;
  assert.ok(arrangementRows.length >= 1);
  assert.ok(arrangementRows.every(({ arrangementJson }) => {
    const narration = JSON.parse(arrangementJson).narration as { productionReady?: boolean };
    return narration?.productionReady === true;
  }), '每条成片版本的 arrangement 都就地升级为已核验口播');

  // 复用路径:同一快照再次执行不得再次调用 TTS(音频已存在于复用键路径)
  const reusedExecution = await executor.execute({
    db,
    claim,
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  });
  reusedExecution.commit?.();
  assert.equal(synthesizeCalls.length, 1, '复用键范围内音频已存在时不得重复调用 TTS');

  // 渲染闸门(问题 3-A)取代了"口播落账后自动补排重渲染"的事后补丁:
  // 口播落账只升级 arrangement seam,不再创建任何 narration-upgrade 渲染任务,
  // render 由领取端闸门在口播成功后自动放行。
  {
    const upgradeTasks = db.prepare(`
      SELECT id FROM batch_tasks
      WHERE workType = 'render' AND requestKey LIKE '%narration-upgrade%'
    `).all() as Array<{ id: string }>;
    assert.equal(upgradeTasks.length, 0, '口播落账不得再自动补排重渲染(领取端闸门负责顺序)');
  }

  // 按脚本设置音色:第二份脚本用不同音色
  const scriptBId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-b',
    title: '脚本B',
    bodyText: '另一份脚本的第一句。第二句！',
    sourceVersion: 'v1',
    metadata: {
      targetDurationSec: 30,
      narrationConfigJson: { providerId: 'vapi-qwen3-tts', voice: 'Zhino', speed: 0.9 },
    },
  });
  const snapshotBId = snapshotScriptIntoBatch(db, versionId, { scriptId: scriptBId, copyCount: 1 });
  const taskBId = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'narration',
    targetKind: 'script_snapshot',
    targetId: snapshotBId,
    requestKey: `narration:${versionId}:${snapshotBId}`,
  });
  await executor.execute({
    db,
    claim: {
      task: { id: taskBId, batchId, workType: 'narration' as const, targetKind: 'script_snapshot' as const, targetId: snapshotBId },
      attempt: { id: 'attempt-b', attemptNumber: 1 },
    },
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  }).then((executionB) => executionB.commit?.());
  assert.equal(synthesizeCalls.length, 2);
  assert.equal(synthesizeCalls[1]?.voice, 'Zhino', '不同脚本必须使用各自设置的不同音色');
  assert.equal(synthesizeCalls[1]?.speed, 0.9);

  // ---------- C. BGM:锁定时冻结曲库;确定性分配;均匀使用;指纹校验 ----------
  const bgmTracks = await seedBgmLibrary(db, ['a.mp3', 'b.mp3', 'c.mp3']);
  const bgmBatchId = createBatchProduction(db, 'project-1', 'BGM 批次');
  const bgmVersionId = createBatchProductionVersion(db, bgmBatchId, { copyCount: 9, defaultsJson: {} });
  const bgmScriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-c',
    title: 'BGM脚本',
    bodyText: '第一句。第二句！第三句。',
    sourceVersion: 'v1',
    metadata: { targetDurationSec: 15 },
  });
  const bgmSnapshotId = snapshotScriptIntoBatch(db, bgmVersionId, { scriptId: bgmScriptId, copyCount: 9 });
  const bgmPlanIds = createOutputPlansForSnapshot(db, bgmVersionId, bgmSnapshotId);
  assert.equal(bgmPlanIds.length, 9, '一份脚本 9 份 = 9 张成片计划');
  await addAssetPoolItem(db, bgmVersionId, 'bgm-asset');

  // 口播先于分配:首次 start 只建口播任务,返回 narration_pending;
  // 口播完成后重入才做联合分配(见 T6 顺序反转)。
  const firstStart = startOrResumePhaseE(db, 'project-1', bgmBatchId);
  assert.equal(firstStart.status, 'narration_pending', '口播未完成时 start 必须返回 narration_pending');
  const bgmNarrationTask = db.prepare(`SELECT id FROM batch_tasks WHERE workType = 'narration' AND targetId = ?`).get(bgmSnapshotId) as { id: string };
  await executor.execute({
    db,
    claim: {
      task: { id: bgmNarrationTask.id, batchId: bgmBatchId, workType: 'narration' as const, targetKind: 'script_snapshot' as const, targetId: bgmSnapshotId },
      attempt: { id: 'attempt-bgm', attemptNumber: 1 },
    },
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  }).then((executionBgm) => executionBgm.commit?.());
  // 手动执行 executor 不会经过 runner 的状态流转,这里补上终态;
  // 真实链路由 runner 在 commit 后统一置 succeeded。
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(bgmNarrationTask.id);

  const started = startOrResumePhaseE(db, 'project-1', bgmBatchId);
  assert.equal(started.status, 'running', '口播全部终态后重入 start 必须产出分配');
  const versionDefaults = JSON.parse(
    (db.prepare(`SELECT defaultsJson FROM batch_production_versions WHERE id = ?`).get(bgmVersionId) as { defaultsJson: string }).defaultsJson,
  ) as { batchMusicPool?: Array<{ trackId: string; relativePath: string; fileFingerprint: string }> };
  assert.equal(versionDefaults.batchMusicPool?.length, 3, '锁定时曲库池必须冻结进批次版本');
  const arrangements = (db.prepare(`
    SELECT o.arrangementJson FROM batch_output_versions o WHERE o.allocationRunId = ?
  `).all(started.allocationRunId) as Array<{ arrangementJson: string }>).map(({ arrangementJson }) => JSON.parse(arrangementJson) as { music?: { trackId?: string | null } });
  assert.equal(arrangements.length, 9);
  const trackCounts = new Map<string, number>();
  for (const arrangement of arrangements) {
    const trackId = arrangement.music?.trackId ?? '';
    assert.ok(trackId, '每条成片都必须分配到 BGM');
    trackCounts.set(trackId, (trackCounts.get(trackId) ?? 0) + 1);
  }
  assert.deepEqual(
    [...trackCounts.entries()].sort(),
    bgmTracks.map(({ trackId }) => [trackId, 3]),
    '3 首曲子出 9 条成片,每首恰好用 3 次',
  );

  const resumed = startOrResumePhaseE(db, 'project-1', bgmBatchId);
  if (resumed.status !== 'running') throw new Error(`expected running, got ${resumed.status}`);
  assert.equal(resumed.allocationRunId, started.allocationRunId, '同种子重跑必须命中同一确定性分配运行');
  const resumedArrangements = (db.prepare(`SELECT arrangementJson FROM batch_output_versions o WHERE o.allocationRunId = ?`).all(resumed.allocationRunId) as Array<{ arrangementJson: string }>).map(({ arrangementJson }) => JSON.parse(arrangementJson) as { music?: { trackId?: string | null } });
  assert.deepEqual(
    resumedArrangements.map(({ music }) => music?.trackId),
    arrangements.map(({ music }) => music?.trackId),
    '同种子重跑每条成片分到的曲目完全相同',
  );

  // 指纹校验:曲目内容变化后渲染前检必须失败并给出可读原因
  const firstTrack = bgmTracks[0]!;
  const firstArrangement = arrangements[0]!;
  const resolved = await resolveBatchBgm(
    { clips: [], music: { trackId: firstArrangement.music?.trackId ?? '' } },
    versionDefaults,
    storageRoot,
  );
  assert.ok(resolved, '曲库池内曲目必须能被渲染前检解析');
  assert.equal(resolved.absolutePath, path.join(storageRoot, firstTrack.relativePath));
  fs.appendFileSync(path.join(storageRoot, firstTrack.relativePath), Buffer.from('changed'));
  await assert.rejects(
    resolveBatchBgm({ clips: [], music: { trackId: firstArrangement.music?.trackId ?? '' } }, versionDefaults, storageRoot),
    /内容已变化|缺失/,
    '曲目指纹不一致时必须给出可读失败原因',
  );
  fs.writeFileSync(path.join(storageRoot, firstTrack.relativePath), Buffer.from(`bgm-content:${firstTrack.trackId.replace('track-', '')}.mp3`));

  // 手动指定:只在这几首之间分配;取消全部勾选恢复全库自动
  const manualBatchId = createBatchProduction(db, 'project-1', '手动指定批次');
  const manualVersionId = createBatchProductionVersion(db, manualBatchId, {
    copyCount: 3,
    defaultsJson: {
      batchMusicSelection: { mode: 'manual', trackIds: [bgmTracks[0]!.trackId] },
    },
  });
  const manualScriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-manual',
    title: '手动BGM脚本',
    bodyText: '第一句。第二句！第三句。',
    sourceVersion: 'v1',
    metadata: { targetDurationSec: 15 },
  });
  const manualSnapshotId = snapshotScriptIntoBatch(db, manualVersionId, { scriptId: manualScriptId, copyCount: 3 });
  createOutputPlansForSnapshot(db, manualVersionId, manualSnapshotId);
  await addAssetPoolItem(db, manualVersionId, 'manual-asset');
  const manualFirst = startOrResumePhaseE(db, 'project-1', manualBatchId);
  assert.equal(manualFirst.status, 'narration_pending');
  const manualNarrationTask = db.prepare(`SELECT id FROM batch_tasks WHERE workType = 'narration' AND targetId = ?`).get(manualSnapshotId) as { id: string };
  await executor.execute({
    db,
    claim: {
      task: { id: manualNarrationTask.id, batchId: manualBatchId, workType: 'narration' as const, targetKind: 'script_snapshot' as const, targetId: manualSnapshotId },
      attempt: { id: 'attempt-manual', attemptNumber: 1 },
    },
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  }).then((executionManual) => executionManual.commit?.());
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(manualNarrationTask.id);
  const manualStarted = startOrResumePhaseE(db, 'project-1', manualBatchId);
  assert.equal(manualStarted.status, 'running');
  const manualArrangements = (db.prepare(`SELECT arrangementJson FROM batch_output_versions o WHERE o.allocationRunId = ?`).all(manualStarted.allocationRunId) as Array<{ arrangementJson: string }>)
    .map(({ arrangementJson }) => JSON.parse(arrangementJson) as { music?: { trackId?: string | null } });
  assert.equal(manualArrangements.length, 3);
  assert.ok(
    manualArrangements.every(({ music }) => music?.trackId === bgmTracks[0]!.trackId),
    '手动指定 1 首时,全部成片只能使用这一首',
  );

  // 曲库为空 → 禁止启动
  const emptyBatchId = createBatchProduction(db, 'project-1', '空曲库批次');
  const emptyVersionId = createBatchProductionVersion(db, emptyBatchId, { copyCount: 1, defaultsJson: {} });
  const emptyScriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-source-d',
    title: '空曲库脚本',
    bodyText: '第一句。',
    sourceVersion: 'v1',
    metadata: { targetDurationSec: 15 },
  });
  const emptySnapshotId = snapshotScriptIntoBatch(db, emptyVersionId, { scriptId: emptyScriptId, copyCount: 1 });
  createOutputPlansForSnapshot(db, emptyVersionId, emptySnapshotId);
  await addAssetPoolItem(db, emptyVersionId, 'empty-asset');
  db.prepare(`DELETE FROM final_edit_bgm_tracks`).run();
  assert.throws(
    () => startOrResumePhaseE(db, 'project-1', emptyBatchId),
    /曲库为空/,
    '曲库为空时必须拦住启动并给出可读原因',
  );

  // 分配范围解析:手动指定 ∩ 冻结池;池外 id 被忽略;自动模式 = 全池
  {
    const pool = [{ trackId: 'a', relativePath: 'bgm/a.mp3', fileFingerprint: 'f1', durationUs: 1_000_000 }];
    const defaults = { batchMusicPool: pool, batchMusicSelection: { mode: 'manual', trackIds: ['a', 'ghost'] } };
    const resolved = resolveAllocationMusicTrackIds(defaults);
    assert.deepEqual(resolved, ['a'], '手动指定中的池外曲目必须被忽略');
    assert.deepEqual(
      resolveAllocationMusicTrackIds({ batchMusicPool: pool, batchMusicSelection: { mode: 'auto', trackIds: [] } }),
      ['a'],
      '自动模式必须使用整个冻结池',
    );
    assert.deepEqual(resolveAllocationMusicTrackIds({ batchMusicPool: pool }), ['a'], '未设置选择时默认全库自动');
  }

  db.close();
  console.log('batch M2 narration/bgm tests passed');
} finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
