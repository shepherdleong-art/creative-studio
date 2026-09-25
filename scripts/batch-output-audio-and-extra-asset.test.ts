import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { BATCH_SCHEMA_MIGRATIONS } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion, addAssetToPool } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import {
  applyBatchOutputClipEdit,
  getBatchOutputArrangementView,
} from '../lib/batch-production/output-arrangement.ts';
import { checkFormalExportPreflight } from '../lib/batch-production/export-preflight.ts';
import { resolveFullRenderContract } from '../lib/batch-production/cover-contract.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('proj-test', '测试项目');`);
db.exec(`CREATE TABLE IF NOT EXISTS batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
for (const migration of BATCH_SCHEMA_MIGRATIONS) {
  db.exec(migration.sql);
  db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(migration.version, new Date().toISOString());
}
db.exec(`
  CREATE TABLE IF NOT EXISTS final_edit_bgm_tracks (
    id TEXT PRIMARY KEY,
    relativePath TEXT NOT NULL,
    fileFingerprint TEXT NOT NULL,
    durationUs INTEGER NOT NULL,
    bpm REAL,
    status TEXT NOT NULL,
    name TEXT NOT NULL,
    tagsJson TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
db.prepare(`
  INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, bpm, status, name, tagsJson, createdAt, updatedAt)
  VALUES ('bgm-1', 'bgm/bgm-1.mp3', 'fp-bgm-1', 30000000, 120, 'ready', 'Track 1', '[]', datetime('now'), datetime('now'))
`).run();

const projectId = 'proj-test';
const batchId = createBatchProduction(db, projectId, '批次1');
const versionId = createBatchProductionVersion(db, batchId, {
  copyCount: 2,
  defaultsJson: {
    batchBgmParams: { gainDb: -12, fadeInSec: 2, fadeOutSec: 3 },
    batchMusicPool: [
      { trackId: 'bgm-1', relativePath: 'bgm/bgm-1.mp3', fileFingerprint: 'fp-bgm-1', durationUs: 30_000_000 },
    ],
  },
});
const scriptId = createProjectScript(db, projectId, {
  sourceKind: 'script_draft',
  sourceId: 'script-1',
  title: '脚本',
  bodyText: JSON.stringify({ segments: [
    { id: 's1', text: '开场', startUs: 0, endUs: 3_000_000 },
    { id: 's2', text: '正文', startUs: 3_000_000, endUs: 6_000_000 },
  ] }),
  sourceVersion: 'v1',
});
const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 2 });
const plans = createOutputPlansForSnapshot(db, versionId, snapshotId);

function fingerprintOf(name: string): string {
  return `sha256:${crypto.createHash('sha256').update(name).digest('hex')}`;
}

function addPoolAsset(name: string, durationUs: number) {
  const assetId = createAsset(db, {
    projectId,
    sourceKind: 'managed',
    locationJson: { key: name },
    contentFingerprint: fingerprintOf(name),
    mediaKind: 'video',
    mediaJson: { durationUs },
  });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'test',
    providerId: 'local',
    model: 'none',
    analysisJson: { durationUs, usableRanges: [{ startUs: 0, endUs: durationUs, qualityScore: 1 }] },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });
  return assetId;
}

const poolAsset1 = addPoolAsset('video-1', 10_000_000);
const poolAsset2 = addPoolAsset('video-2', 10_000_000);

db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = '2026-09-25T00:00:00.000Z' WHERE id = ?`).run(versionId);
db.prepare(`UPDATE batch_productions SET status = 'running', currentVersionId = ? WHERE id = ?`).run(versionId, batchId);

const outputVersionId = createOutputVersion(db, plans[0], {
  arrangementJson: {
    schemaVersion: 'test-v1',
    preset: '3:4',
    fps: 24,
    targetDurationUs: 6_000_000,
    clips: [
      {
        clipId: 'c1',
        segmentId: 's1',
        assetId: poolAsset1,
        contentFingerprint: fingerprintOf('video-1'),
        sourceStartUs: 0,
        sourceEndUs: 3_000_000,
        timelineStartUs: 0,
        timelineEndUs: 3_000_000,
      },
      {
        clipId: 'c2',
        segmentId: 's2',
        assetId: poolAsset2,
        contentFingerprint: fingerprintOf('video-2'),
        sourceStartUs: 0,
        sourceEndUs: 3_000_000,
        timelineStartUs: 3_000_000,
        timelineEndUs: 6_000_000,
      },
    ],
    cover: { assetId: poolAsset1, timeUs: 500_000 },
    audio: {
      ready: true,
      productionReady: true,
      narration: {
        track: 'narration',
        clips: [
          {
            clipId: 'narr-1',
            sourceStartUs: 0,
            sourceEndUs: 5_000_000,
            timelineStartUs: 0,
            timelineEndUs: 5_000_000,
            sourceDurationUs: 5_000_000,
          },
        ],
      },
      bgm: {
        track: 'bgm',
        clips: [
          {
            clipId: 'bgm-clip-1',
            sourceStartUs: 0,
            sourceEndUs: 6_000_000,
            timelineStartUs: 0,
            timelineEndUs: 6_000_000,
            sourceDurationUs: 30_000_000,
          },
        ],
      },
    },
    narration: {
      ready: true,
      productionReady: true,
      durationUs: 5_000_000,
      audioRelativePath: 'batch-narration/test/narr.wav',
    },
    music: { trackId: 'bgm-1' },
  },
});

import { setBatchPlanReviews } from '../lib/batch-production/review.ts';

setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });

console.log('✓ 1. 测试 trim_audio_clip');
// 正常裁剪 narration
const trimmed = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'trim_audio_clip',
  track: 'narration',
  clipId: 'narr-1',
  sourceStartUs: 500_000,
  sourceEndUs: 5_000_000,
  timelineStartUs: 500_000,
  timelineEndUs: 5_000_000,
});
assert.equal(trimmed.reviewCleared, true);
let view = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
let narrClips = view.audio?.narration;
assert.ok(narrClips && narrClips.length === 1);
assert.equal(narrClips[0].sourceStartUs, 500_000);
assert.equal(narrClips[0].timelineStartUs, 500_000);
assert.equal(narrClips[0].timelineEndUs, 5_000_000);

// 裁剪过短（小于 0.5s）应拒绝
assert.throws(
  () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim_audio_clip',
    track: 'narration',
    clipId: 'narr-1',
    sourceStartUs: 4_700_000,
    sourceEndUs: 5_000_000, // 0.3s < 0.5s
  }),
  (err: unknown) => err instanceof BatchDomainError && err.code === 'invalid_input' && /0\.5/.test(err.message),
);

console.log('✓ 2. 测试 move_audio_clip');
setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });
// 移动 narration 片段
const moved = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'move_audio_clip',
  track: 'narration',
  clipId: 'narr-1',
  timelineStartUs: 1_000_000,
});
assert.equal(moved.reviewCleared, true);
view = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
narrClips = view.audio?.narration;
assert.ok(narrClips && narrClips.length === 1);
assert.equal(narrClips[0].sourceStartUs, 500_000); // source 不变
assert.equal(narrClips[0].timelineStartUs, 1_000_000); // timeline 变了
assert.equal(narrClips[0].timelineEndUs, 5_500_000);

// 移动位置为负数应拒绝
assert.throws(
  () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'move_audio_clip',
    track: 'narration',
    clipId: 'narr-1',
    timelineStartUs: -100,
  }),
  (err: unknown) => err instanceof BatchDomainError && err.code === 'invalid_input',
);

console.log('✓ 3. 测试 M-04 编辑新增素材合法引用');
// 在批次冻结后，创建一个新的属于该项目的可用素材（例如用户在审片页新增导入的素材）
const extraAssetId = createAsset(db, {
  projectId,
  sourceKind: 'managed',
  locationJson: { key: 'extra-imported-video' },
  contentFingerprint: fingerprintOf('extra-imported-video'),
  mediaKind: 'video',
  mediaJson: { durationUs: 8_000_000 },
});
createAnalysisVersion(db, {
  assetId: extraAssetId,
  analyzerVersion: 'test',
  providerId: 'local',
  model: 'none',
  analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] },
});

// 验证冻结池表 batch_asset_pool_items 没有增加此素材
const poolCountBefore = (db.prepare('SELECT count(*) AS c FROM batch_asset_pool_items WHERE batchVersionId = ?').get(versionId) as { c: number }).c;
assert.equal(poolCountBefore, 2);

setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });
// 使用 extraAssetId 替换 c1
const replaced = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'replace',
  clipId: 'c1',
  assetId: extraAssetId,
});
assert.equal(replaced.reviewCleared, true);

// 验证冻结池表依然未被篡改
const poolCountAfter = (db.prepare('SELECT count(*) AS c FROM batch_asset_pool_items WHERE batchVersionId = ?').get(versionId) as { c: number }).c;
assert.equal(poolCountAfter, 2);

// 验证视图中 poolAssets 包含了 extraAssetId 并且注明使用计划
view = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
const extraInView = view.poolAssets.find((p) => p.assetId === extraAssetId);
assert.ok(extraInView, 'extraAsset 应出现在视图的 poolAssets 中');
assert.deepEqual(extraInView?.usedByPlanIds, [plans[0]]);

// 验证 FullRenderContract 能够正常解析该成片
const fullRender = resolveFullRenderContract(db, outputVersionId);
assert.equal(fullRender.clips[0].assetId, extraAssetId);
assert.ok(fullRender.audio, '音频数据保留在 FullRenderContract 中');

// 验证 checkFormalExportPreflight 能够识别 extraAssetId（不会因不在池中而直接报错引用非法原片）
const preflightResult = await checkFormalExportPreflight(db, versionId, { assetIds: [extraAssetId] });
assert.ok(!preflightResult.ready);
assert.ok(preflightResult.blockers.some((b) => b.assetId === extraAssetId && b.code === 'source_offline'));

// 验证如果传入真正不存在或跨项目的 assetId，preflight 会明确报错不属于该冻结素材池或项目可用素材
const invalidPreflight = await checkFormalExportPreflight(db, versionId, { assetIds: ['completely-invalid-id'] });
assert.ok(!invalidPreflight.ready);
if (!invalidPreflight.ready) {
  assert.ok(invalidPreflight.blockers.some((b) => b.message.includes('成片安排引用了不属于该冻结素材池或项目可用素材的原片')));
}

console.log('✓ All batch output audio edit and extra asset tests passed');
