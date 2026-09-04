import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  createBatchProduction,
  createBatchProductionVersion,
  getBatchProduction,
  getBatchVersion,
  listBatchVersions,
  listPoolItems,
} from '../lib/batch-production/versions.ts';
import { createProjectScript, listScriptSnapshots, getScriptSnapshot, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion, listOutputPlans } from '../lib/batch-production/plans.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchSnapshot, getBatchSnapshotDetail, startBatchProduction } from '../lib/batch-production/batch-flow.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';
import { defaultTextStyle } from '../lib/media-core/cover-domain.ts';
import {
  createBatchTask,
  finishTaskAttempt,
  listTaskAttempts,
  startTaskAttempt,
} from '../lib/batch-production/tasks.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      storeCode TEXT NOT NULL DEFAULT '',
      productSubmodel TEXT NOT NULL DEFAULT '',
      productionType TEXT NOT NULL DEFAULT '',
      editorName TEXT NOT NULL DEFAULT '',
      namingDate TEXT NOT NULL DEFAULT '',
      currentExportIdentityId TEXT
    );
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
    INSERT INTO shot_sets (id, projectId, name, createdAt)
    VALUES ('ss-1', 'project-1', '分镜组一', '2026-08-02T00:00:00.000Z');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-flow-'));

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

  // --- 准备:两份项目脚本 + 一份外部文案 + 两份素材 ---
  const scriptA = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-a',
    title: '口播A',
    bodyText: '正文A',
    sourceVersion: '2',
    metadata: { coverTitleJson: { primary: '主A', secondary: '副A' }, shotSetId: 'ss-1', contentRevision: 'rev-a' },
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  const scriptB = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'draft-b',
    title: '口播B',
    bodyText: '正文B',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:01:00.000Z'),
  });
  const scriptP2 = createProjectScript(db, 'project-2', {
    sourceKind: 'script_draft',
    sourceId: 'draft-p2',
    title: '项目二脚本',
    bodyText: '项目二正文',
    sourceVersion: '2',
    now: () => new Date('2026-08-02T09:02:00.000Z'),
  });
  const asset1 = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v1', shotSetId: 'ss-1', relativePath: 'videos/a.mp4' },
    contentFingerprint: 'sha256:aaa',
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:03:00.000Z'),
  });
  const analysis1 = createAnalysisVersion(db, {
    assetId: asset1,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-02T09:04:00.000Z'),
  });
  const asset2 = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v2', shotSetId: 'ss-1', relativePath: 'videos/b.mp4' },
    contentFingerprint: 'sha256:bbb',
    mediaKind: 'video',
    now: () => new Date('2026-08-02T09:05:00.000Z'),
  });
  const analysis2 = createAnalysisVersion(db, {
    assetId: asset2,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
    now: () => new Date('2026-08-02T09:06:00.000Z'),
  });

  const batchId = createBatchProduction(db, 'project-1', '八月大促混剪', () => new Date('2026-08-02T10:00:00.000Z'));

  // --- 场景 1:多文案分别设置份数,A 2 份 + B 1 份 → 3 张成片卡片 ---
  const snapshot1 = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [
      { scriptId: scriptA, copyCount: 2 },
      { scriptId: scriptB, copyCount: 1 },
    ],
    assetSelections: [
      { assetId: asset1, analysisId: analysis1 },
      { assetId: asset2, analysisId: analysis2 },
    ],
    now: () => new Date('2026-08-02T10:10:00.000Z'),
  });
  assert.equal(snapshot1.batchVersionId, snapshot1.batchVersionId);
  assert.equal(snapshot1.totalPlans, 3, '份数总和必须精确决定成片计划数量');
  assert.equal(snapshot1.inputState, 'draft');
  assert.equal(listScriptSnapshots(db, snapshot1.batchVersionId).length, 2, '两份脚本各建一份快照');
  assert.equal(listPoolItems(db, snapshot1.batchVersionId).length, 2, '两个素材进入素材池');
  assert.equal(listOutputPlans(db, snapshot1.batchVersionId).length, 3, '3 张稳定成片计划');
  assert.deepEqual(
    getBatchSnapshotDetail(db, 'project-1', batchId).scriptSnapshots
      .map(({ sourceScriptId, copyCount }) => ({ sourceScriptId, copyCount }))
      .sort((left, right) => left.sourceScriptId.localeCompare(right.sourceScriptId)),
    [
      { sourceScriptId: scriptA, copyCount: 2 },
      { sourceScriptId: scriptB, copyCount: 1 },
    ].sort((left, right) => left.sourceScriptId.localeCompare(right.sourceScriptId)),
    '详情必须暴露稳定 sourceScriptId，供 UI 恢复脚本勾选和份数',
  );

  // 每份快照按自己的份数建计划
  const snapshots = listScriptSnapshots(db, snapshot1.batchVersionId);
  const snapshotA = snapshots.find((s) => s.sourceScriptId === scriptA);
  const snapshotB = snapshots.find((s) => s.sourceScriptId === scriptB);
  assert.equal(snapshotA?.copyCount, 2);
  assert.equal(snapshotB?.copyCount, 1);
  const plans = listOutputPlans(db, snapshot1.batchVersionId);
  assert.deepEqual(plans.map(({ seq }) => seq), [1, 2, 3]);

  // --- 场景 2:完全相同的整体输入重复确认幂等，不新建版本或计划 ---
  const snapshot2 = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [
      { scriptId: scriptA, copyCount: 2 },
      { scriptId: scriptB, copyCount: 1 },
    ],
    assetSelections: [
      { assetId: asset1, analysisId: analysis1 },
      { assetId: asset2, analysisId: analysis2 },
    ],
    now: () => new Date('2026-08-02T10:20:00.000Z'),
  });
  assert.equal(snapshot2.batchVersionId, snapshot1.batchVersionId, '相同整体输入必须复用当前版本');
  assert.deepEqual(snapshot2.planIds, snapshot1.planIds, '相同整体输入必须返回既有稳定计划');
  assert.equal(listBatchVersions(db, batchId).length, 1, '重复确认不得新增批次版本');
  assert.equal(listOutputPlans(db, snapshot1.batchVersionId).length, 3, '重复确认不得增加第 N+1 张卡片');

  const legacyStyleRepeat = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [
      { scriptId: scriptA, copyCount: 2 },
      { scriptId: scriptB, copyCount: 1 },
    ],
    assetSelections: [
      { assetId: asset1, analysisId: analysis1 },
      { assetId: asset2, analysisId: analysis2 },
    ],
    defaultsJson: { subtitleStyles: defaultTextStyle('subtitle', 1080) },
  });
  assert.equal(legacyStyleRepeat.batchVersionId, snapshot1.batchVersionId, '旧批次补带字幕默认样式不得误建新版本');

  // 真正失败重试发生在同一稳定计划的任务尝试层，不创建新 Revision 或第 N+1 张卡。
  const retryOutputVersion = createOutputVersion(db, snapshot1.planIds[0]!, {});
  const retryTask = createBatchTask(db, 'project-1', {
    batchId,
    workType: 'render',
    targetKind: 'output_version',
    targetId: retryOutputVersion,
  });
  const failedAttempt = startTaskAttempt(db, retryTask);
  finishTaskAttempt(db, retryTask, failedAttempt, { status: 'failed', errorCode: 'render_failed' });
  const successfulAttempt = startTaskAttempt(db, retryTask);
  finishTaskAttempt(db, retryTask, successfulAttempt, { status: 'succeeded' });
  assert.equal(listTaskAttempts(db, retryTask).length, 2, '失败重试只新增任务尝试');
  assert.deepEqual(listOutputPlans(db, snapshot1.batchVersionId).map(({ id }) => id), snapshot1.planIds);
  assert.equal(listBatchVersions(db, batchId).length, 1, '任务重试不得新建批次版本');

  // --- 场景 3:开跑后输入冻结 ---
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T10:30:00.000Z'));
  assert.equal(getBatchVersion(db, batchId, snapshot1.batchVersionId)?.inputState, 'frozen');
  const batchStatus = db.prepare(`SELECT status FROM batch_productions WHERE id = ?`).get(batchId) as { status: string };
  assert.equal(batchStatus.status, 'running');

  const frozenRepeat = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [
      { scriptId: scriptA, copyCount: 2 },
      { scriptId: scriptB, copyCount: 1 },
    ],
    assetSelections: [
      { assetId: asset1, analysisId: analysis1 },
      { assetId: asset2, analysisId: analysis2 },
    ],
  });
  assert.equal(frozenRepeat.batchVersionId, snapshot1.batchVersionId, '冻结后相同整体输入仍须幂等复用');
  assert.equal(frozenRepeat.inputState, 'frozen', '幂等响应必须暴露真实冻结态，避免客户端误判为 draft');
  assert.equal(getBatchProduction(db, 'project-1', batchId)?.status, 'running', '幂等确认不得把运行批次改回 draft');
  assert.equal(listBatchVersions(db, batchId).length, 1);

  // 开跑后修改输入:形成新版本,旧版本仍冻结
  const snapshot3 = createBatchSnapshot(db, 'project-1', batchId, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    now: () => new Date('2026-08-02T10:40:00.000Z'),
  });
  assert.equal(getBatchVersion(db, batchId, snapshot3.batchVersionId)?.versionNumber, 2, '开跑后修改必须新建版本');
  assert.equal(getBatchVersion(db, batchId, snapshot1.batchVersionId)?.inputState, 'frozen', '旧版本保持冻结');
  assert.equal(listOutputPlans(db, snapshot3.batchVersionId).length, 1);

  // --- 场景 4:开跑时锁定最新上游内容，冻结后不再漂移 ---
  const snapshot3Row = listScriptSnapshots(db, snapshot3.batchVersionId)[0]!;
  assert.equal(snapshot3Row.bodyText, '正文A', '确认阶段先保留可检查的草稿快照');
  assert.equal(snapshot3Row.copyCount, 1);
  const upstreamV3 = JSON.stringify({
    version: 3,
    title: '口播A新版',
    coverTitleParts: { primary: '新主A', secondary: '新副A', source: 'model' },
    platform: 'douyin',
    tone: 'promo',
    templateId: 't1',
    template: 't1',
    shotSetId: 'ss-1',
    targetDurationSec: 30,
    targetNarrationDurationSec: 28,
    contentCharacterCount: 20,
    estimatedNarrationDurationSec: 25,
    durationStatus: 'qualified',
    durationPolicyVersion: 'zh-tts-budget-v1',
    segments: [{ narration: '开跑前上游新版', subtitle: '开跑前上游新版', sellingPointRefs: [], visualIntent: '', visualKeywords: [] }],
    fullScript: '开跑前上游新版',
    fullSubtitle: '开跑前上游新版',
  });
  db.prepare(`
    INSERT INTO script_drafts (id, projectId, inputSnapshot, outputJson, createdAt)
    VALUES ('draft-a', 'project-1', '{}', ?, '2026-08-02T10:50:00.000Z')
  `).run(upstreamV3);
  startBatchProduction(db, 'project-1', batchId, () => new Date('2026-08-02T11:00:00.000Z'));
  const snapshotAtStart = getScriptSnapshot(db, snapshot3.batchVersionId, snapshot3Row.id);
  assert.equal(snapshotAtStart?.bodyText, '开跑前上游新版', 'start 必须锁定开跑瞬间的最新上游正文');
  assert.equal(snapshotAtStart?.sourceVersion, '3');
  assert.notEqual(snapshotAtStart?.contentRevision, 'rev-a', 'start 必须记录最新草稿的内容修订身份');
  const frozenDetail = getBatchSnapshotDetail(db, 'project-1', batchId);
  assert.equal(frozenDetail.version.inputState, 'frozen');
  assert.equal(frozenDetail.scriptSnapshots[0]?.bodyText, '开跑前上游新版', '批次详情必须返回冻结正文而非依赖当前项目脚本');
  assert.equal(frozenDetail.scriptSnapshots[0]?.sourceVersion, '3');
  assert.deepEqual(frozenDetail.scriptSnapshots[0]?.coverTitle, { primary: '新主A', secondary: '新副A' });
  db.prepare(`
    UPDATE batch_scripts SET bodyText = '冻结后更新', updatedAt = ? WHERE id = ?
  `).run('2026-08-02T11:10:00.000Z', scriptA);
  const snapshotAfterFreeze = getScriptSnapshot(db, snapshot3.batchVersionId, snapshot3Row.id);
  assert.equal(snapshotAfterFreeze?.bodyText, '开跑前上游新版', '冻结后上游更新不得改写快照');

  // --- 场景 5:项目隔离与归属校验 ---
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', batchId, {
      scriptSelections: [{ scriptId: scriptP2, copyCount: 1 }],
      assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    }),
    /不属于/,
    '项目 2 的脚本不得进入项目 1 的批次',
  );
  assert.throws(
    () => createBatchSnapshot(db, 'project-2', batchId, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
      assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    }),
    /不存在/,
    '其他项目的批次不得被快照',
  );

  // --- 场景 6:重复选择同一脚本拒绝;份数必须为正 ---
  const batch2 = createBatchProduction(db, 'project-1', '批次二', () => new Date('2026-08-02T12:00:00.000Z'));
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', batch2, {
      scriptSelections: [
        { scriptId: scriptA, copyCount: 1 },
        { scriptId: scriptA, copyCount: 1 },
      ],
      assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    }),
    /重复/,
    '同一脚本不能重复选择',
  );
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', batch2, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 0 }],
      assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    }),
    /份数/,
    '份数必须为正整数',
  );

  // --- 场景 6a:整体输入必须明确选择至少一份带分析版本的素材 ---
  const missingAssetsBatch = createBatchProduction(db, 'project-1', '缺少素材批次');
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', missingAssetsBatch, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    } as never),
    (error: unknown) => {
      assert.ok(error instanceof BatchDomainError);
      assert.equal(error.code, 'invalid_input');
      assert.match(error.message, /至少选择一份素材/);
      return true;
    },
    '省略素材池不得建立批次快照',
  );
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', missingAssetsBatch, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
      assetSelections: [],
    }),
    /至少选择一份素材/,
    '空素材池不得建立批次快照',
  );

  // --- 场景 6b:空批次不能启动,状态保持 draft ---
  const emptyBatch = createBatchProduction(db, 'project-1', '空批次', () => new Date('2026-08-02T11:30:00.000Z'));
  assert.throws(
    () => startBatchProduction(db, 'project-1', emptyBatch, () => new Date('2026-08-02T11:31:00.000Z')),
    (error: unknown) => {
      assert.ok(error instanceof BatchDomainError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /还没有/);
      return true;
    },
    '空批次不得被标记为 running',
  );
  assert.equal(
    (db.prepare(`SELECT status FROM batch_productions WHERE id = ?`).get(emptyBatch) as { status: string }).status,
    'draft',
    '启动失败后批次保持 draft',
  );

  const noPoolBatch = createBatchProduction(db, 'project-1', '无素材池批次');
  const noPoolVersion = createBatchProductionVersion(db, noPoolBatch, { copyCount: 1 });
  const noPoolSnapshot = snapshotScriptIntoBatch(db, noPoolVersion, { scriptId: scriptA, copyCount: 1 });
  createOutputPlansForSnapshot(db, noPoolVersion, noPoolSnapshot);
  assert.throws(
    () => startBatchProduction(db, 'project-1', noPoolBatch),
    /素材池/,
    '即使已有脚本快照与计划，空素材池也不得开跑',
  );

  // --- 场景 6c:开跑前必须逐份核对计划数，不能只判断“非空” ---
  const incompletePlansBatch = createBatchProduction(db, 'project-1', '计划不完整批次');
  const incompletePlans = createBatchSnapshot(db, 'project-1', incompletePlansBatch, {
    scriptSelections: [{ scriptId: scriptB, copyCount: 2 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
  });
  db.prepare(`DELETE FROM batch_output_plans WHERE id = ?`).run(incompletePlans.planIds[1]);
  assert.throws(
    () => startBatchProduction(db, 'project-1', incompletePlansBatch),
    /计划数量/,
    '缺少任意一张计划卡时不得开跑',
  );
  assert.equal(getBatchProduction(db, 'project-1', incompletePlansBatch)?.status, 'draft');
  assert.equal(getBatchVersion(db, incompletePlansBatch, incompletePlans.batchVersionId)?.inputState, 'draft');

  // --- 场景 6d:复用无快照 draft 时,份数与默认设置写回版本 ---
  const reuseBatch = createBatchProduction(db, 'project-1', '复用批次', () => new Date('2026-08-02T11:40:00.000Z'));
  const staleVersion = createBatchProductionVersion(db, reuseBatch, {
    copyCount: 99,
    defaultsJson: { stale: true },
    now: () => new Date('2026-08-02T11:41:00.000Z'),
  });
  const reuseResult = createBatchSnapshot(db, 'project-1', reuseBatch, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 2 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
    defaultsJson: { bgm: 'bgm-1' },
    now: () => new Date('2026-08-02T11:42:00.000Z'),
  });
  assert.equal(reuseResult.batchVersionId, staleVersion, '无快照的 draft 版本应被复用');
  const reusedVersion = getBatchVersion(db, reuseBatch, staleVersion);
  assert.equal(reusedVersion?.copyCount, 2, '复用 draft 必须写回实际确认的份数');
  assert.deepEqual(reusedVersion?.defaultsJson, { bgm: 'bgm-1' }, '复用 draft 必须写回本次默认设置');
  assert.equal(listOutputPlans(db, staleVersion).length, 2);

  // --- 场景 7:素材池只锁定本项目的素材与分析版本 ---
  const p2Asset = createAsset(db, {
    projectId: 'project-2',
    sourceKind: 'module4',
    locationJson: { kind: 'module4', videoJobId: 'v9', shotSetId: 'ss-9', relativePath: 'videos/x.mp4' },
    contentFingerprint: 'sha256:zzz',
    mediaKind: 'video',
    now: () => new Date('2026-08-02T12:10:00.000Z'),
  });
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', batch2, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
      assetSelections: [{ assetId: p2Asset, analysisId: analysis1 }],
    }),
    /不属于/,
    '其他项目的素材不得进入本项目的批次版本',
  );

  const archivedAsset = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'managed',
    locationJson: { kind: 'managed', relativePath: 'storage/batch-media/project-1/archived.mp4' },
    contentFingerprint: 'sha256:archived',
    mediaKind: 'video',
  });
  const archivedAnalysis = createAnalysisVersion(db, {
    assetId: archivedAsset,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
  });
  db.prepare(`UPDATE batch_assets SET status = 'archived' WHERE id = ?`).run(archivedAsset);
  const archivedBatch = createBatchProduction(db, 'project-1', '归档素材批次');
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', archivedBatch, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
      assetSelections: [{ assetId: archivedAsset, analysisId: archivedAnalysis }],
    }),
    /归档|不可用/,
    '归档素材不得通过领域 API 进入新批次',
  );

  const statusChangedAsset = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'managed',
    locationJson: { kind: 'managed', relativePath: 'storage/batch-media/project-1/status-changed.mp4' },
    contentFingerprint: 'sha256:status-changed',
    mediaKind: 'video',
  });
  const statusChangedAnalysis = createAnalysisVersion(db, {
    assetId: statusChangedAsset,
    analyzerVersion: '0.1.0',
    providerId: 'p',
    model: 'm',
  });
  const statusChangedBatch = createBatchProduction(db, 'project-1', '开跑前归档批次');
  createBatchSnapshot(db, 'project-1', statusChangedBatch, {
    scriptSelections: [{ scriptId: scriptA, copyCount: 1 }],
    assetSelections: [{ assetId: statusChangedAsset, analysisId: statusChangedAnalysis }],
  });
  db.prepare(`UPDATE batch_assets SET status = 'archived' WHERE id = ?`).run(statusChangedAsset);
  assert.throws(
    () => startBatchProduction(db, 'project-1', statusChangedBatch),
    /归档|不可用/,
    '确认后、开跑前归档的素材必须阻止批次冻结',
  );

  // --- 场景 8:素材池写入中途失败时，版本切换、快照、计划和池条目整体回滚 ---
  const rollbackBatch = createBatchProduction(db, 'project-1', '事务回滚批次');
  const rollbackBaseline = createBatchSnapshot(db, 'project-1', rollbackBatch, {
    scriptSelections: [{ scriptId: scriptB, copyCount: 1 }],
    assetSelections: [{ assetId: asset1, analysisId: analysis1 }],
  });
  db.exec(`
    CREATE TEMP TRIGGER inject_pool_failure
    BEFORE INSERT ON batch_asset_pool_items
    WHEN NEW.assetId = '${asset2}'
    BEGIN
      SELECT RAISE(ABORT, 'injected pool failure');
    END;
  `);
  assert.throws(
    () => createBatchSnapshot(db, 'project-1', rollbackBatch, {
      scriptSelections: [{ scriptId: scriptA, copyCount: 2 }],
      assetSelections: [
        { assetId: asset1, analysisId: analysis1 },
        { assetId: asset2, analysisId: analysis2 },
      ],
    }),
    /injected pool failure/,
    '第二个素材失败必须回滚此前已写入的新版本、脚本快照、计划和第一个素材',
  );
  db.exec(`DROP TRIGGER inject_pool_failure`);
  assert.equal(getBatchProduction(db, 'project-1', rollbackBatch)?.currentVersionId, rollbackBaseline.batchVersionId);
  assert.deepEqual(listBatchVersions(db, rollbackBatch).map(({ id }) => id), [rollbackBaseline.batchVersionId]);
  assert.equal(getBatchVersion(db, rollbackBatch, rollbackBaseline.batchVersionId)?.inputState, 'draft');
  assert.equal(listScriptSnapshots(db, rollbackBaseline.batchVersionId).length, 1);
  assert.equal(listOutputPlans(db, rollbackBaseline.batchVersionId).length, 1);
  assert.equal(listPoolItems(db, rollbackBaseline.batchVersionId).length, 1);

  assert.throws(
    () => startBatchProduction(db, 'project-1', 'missing-batch'),
    (error: unknown) => {
      assert.ok(error instanceof BatchDomainError);
      assert.equal(error.code, 'not_found');
      return true;
    },
    '不存在的批次必须通过稳定 not_found code 暴露',
  );

  db.close();
  console.log('batch flow tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
