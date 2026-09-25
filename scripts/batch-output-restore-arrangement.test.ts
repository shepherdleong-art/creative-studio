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
  type BatchOutputClipEditView,
} from '../lib/batch-production/output-arrangement.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';
import { setBatchPlanReviews } from '../lib/batch-production/review.ts';

/**
 * 撤销/重做回放命令 restore_arrangement 的领域验证:
 * 1. 实质编辑(修剪/音频移动)撤销后内容回滚、revision 递增、审核保持已清状态;
 * 2. expectedEditRevision 过期时拒绝覆盖(conflict);
 * 3. 纯结构操作(split)撤销沿用等价语义:不递增 revision、不清 review;
 * 4. 重放到 after 快照内容还原;
 * 5. 非法快照(重叠片段/未知素材)被拒绝。
 */

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
  copyCount: 1,
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
const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
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
      narration: {
        clips: [
          { clipId: 'narr-1', sourceStartUs: 0, sourceEndUs: 5_000_000, timelineStartUs: 0, timelineEndUs: 5_000_000 },
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

/** 与前端 buildRestoreSnapshot 相同的快照派生逻辑。 */
function snapshotOfView(view: BatchOutputClipEditView): Record<string, unknown> {
  return {
    clips: view.clips,
    ...(view.audio !== undefined ? { audio: view.audio } : {}),
    preserveGaps: view.preserveGaps === true,
    subtitleOverride: view.subtitleOverride,
    subtitleCues: view.subtitleCues,
    subtitleStyle: view.subtitleStyle,
    subtitleStyleOverride: view.subtitleStyleOverride,
    coverAssetId: view.coverAssetId,
    coverTimeUs: view.coverTimeUs,
    coverFraming: view.coverFraming,
    coverTitle: view.coverTitle,
    coverTitleOverride: view.coverTitleOverride,
    musicTrackId: view.music.trackId,
    musicGainDb: view.music.gainDb,
    musicFadeInSec: view.music.fadeInSec,
    musicFadeOutSec: view.music.fadeOutSec,
    narrationGainDb: view.narration.gainDb,
  };
}

function readArrangement(): Record<string, unknown> {
  const row = db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = ?`).get(outputVersionId) as { arrangementJson: string };
  return JSON.parse(row.arrangementJson) as Record<string, unknown>;
}

setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });

console.log('✓ 1. 实质编辑撤销:内容回滚 + revision 递增');
const beforeView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
const beforeSnapshot = snapshotOfView(beforeView);
assert.equal(beforeView.editRevision, 0);

const trimmed = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'trim_variable',
  clipId: 'c1',
  sourceStartUs: 0,
  sourceEndUs: 2_000_000,
});
assert.equal(trimmed.changed, true);
assert.equal(trimmed.visualChanged, true);
assert.equal(trimmed.reviewCleared, true);
assert.equal(trimmed.editRevision, 1);

const afterView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
const afterSnapshot = snapshotOfView(afterView);
assert.equal(afterView.clips[0].sourceEndUs, 2_000_000);
assert.equal(afterView.editRevision, 1);

// 撤销:回放编辑前快照(带当前修订号,应通过冲突门禁)
const undone = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'restore_arrangement',
  snapshot: beforeSnapshot,
  expectedEditRevision: 1,
});
assert.equal(undone.changed, true);
assert.equal(undone.visualChanged, true);
assert.equal(undone.editRevision, 2);

const undoneView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
assert.equal(undoneView.clips.length, 2);
assert.equal(undoneView.clips[0].sourceEndUs, 3_000_000);
assert.equal(undoneView.clips[0].timelineEndUs, 3_000_000);
assert.equal(undoneView.clips[1].timelineStartUs, 3_000_000);
assert.equal(undoneView.editRevision, 2);
// 撤销本身是新的正式修订:不恢复已被前一次编辑清除的审核态
assert.equal(undone.reviewCleared, false);

console.log('✓ 2. 冲突门禁:过期 expectedEditRevision 拒绝覆盖');
assert.throws(
  () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'restore_arrangement',
    snapshot: beforeSnapshot,
    expectedEditRevision: 1, // 当前已是 2
  }),
  (err: unknown) => err instanceof BatchDomainError && err.code === 'conflict',
);
// 冲突拒绝不得改写数据
assert.equal(getBatchOutputArrangementView(db, projectId, batchId, plans[0]).editRevision, 2);

console.log('✓ 3. 纯结构撤销(split):不递增 revision、不清 review');
setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });
const preSplitView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
const preSplitSnapshot = snapshotOfView(preSplitView);

const split = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'split',
  clipId: 'c1',
  offsetUs: 1_500_000,
});
assert.equal(split.changed, true);
assert.equal(split.visualChanged, false);
assert.equal(split.editRevision, 2); // split 不递增
assert.equal(getBatchOutputArrangementView(db, projectId, batchId, plans[0]).clips.length, 3);

// 撤销 split:画面流等价 → 纯结构恢复
const undoSplit = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'restore_arrangement',
  snapshot: preSplitSnapshot,
  expectedEditRevision: 2,
});
assert.equal(undoSplit.changed, true);
assert.equal(undoSplit.visualChanged, false);
assert.equal(undoSplit.reviewCleared, false);
assert.equal(undoSplit.editRevision, 2);

const postUndoSplitView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
assert.equal(postUndoSplitView.clips.length, 2);
assert.equal(postUndoSplitView.editRevision, 2);
// review 保留
const arrangementAfterSplitUndo = readArrangement();
assert.ok(arrangementAfterSplitUndo.review, '纯结构撤销后 review 必须保留');

console.log('✓ 4. 重做:回放 after 快照还原编辑结果');
const redone = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'restore_arrangement',
  snapshot: afterSnapshot,
  expectedEditRevision: 2,
});
assert.equal(redone.changed, true);
assert.equal(redone.visualChanged, true);
assert.equal(redone.editRevision, 3);

const redoneView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
assert.equal(redoneView.clips[0].sourceEndUs, 2_000_000);
assert.equal(redoneView.clips[0].timelineEndUs, 2_000_000);
assert.equal(redoneView.editRevision, 3);

console.log('✓ 5. 音频撤销:timeline 位置随快照还原');
const audioMoved = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'move_audio_clip',
  track: 'narration',
  clipId: 'narr-1',
  timelineStartUs: 1_000_000,
});
assert.equal(audioMoved.editRevision, 4);
const movedView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
assert.equal(movedView.audio?.narration?.[0]?.timelineStartUs, 1_000_000);

const undoAudioMove = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
  type: 'restore_arrangement',
  snapshot: afterSnapshot, // 音频仍在 0-5s 的快照
  expectedEditRevision: 4,
});
assert.equal(undoAudioMove.changed, true);
assert.equal(undoAudioMove.editRevision, 5);
const audioRestoredView = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
assert.equal(audioRestoredView.audio?.narration?.[0]?.timelineStartUs, 0);
assert.equal(audioRestoredView.audio?.narration?.[0]?.sourceStartUs, 0);

console.log('✓ 6. 非法快照拒绝');
// 重叠片段
assert.throws(
  () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'restore_arrangement',
    snapshot: {
      ...afterSnapshot,
      clips: [
        { ...afterSnapshot.clips as object[], clipId: 'x1', timelineStartUs: 0, timelineEndUs: 3_000_000 },
        { ...(afterSnapshot.clips as object[])[1], clipId: 'x2', timelineStartUs: 2_000_000, timelineEndUs: 5_000_000 },
      ],
    },
    expectedEditRevision: 5,
  }),
  (err: unknown) => err instanceof BatchDomainError && err.code === 'invalid_input',
);
// 未知素材
assert.throws(
  () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'restore_arrangement',
    snapshot: {
      ...afterSnapshot,
      clips: [{ clipId: 'x1', assetId: 'not-exist', sourceStartUs: 0, sourceEndUs: 3_000_000, timelineStartUs: 0, timelineEndUs: 3_000_000 }],
    },
    expectedEditRevision: 5,
  }),
  (err: unknown) => err instanceof BatchDomainError && err.code === 'invalid_input',
);
// 非法快照不得改写数据
assert.equal(getBatchOutputArrangementView(db, projectId, batchId, plans[0]).editRevision, 5);

console.log('✓ All restore_arrangement undo/redo replay tests passed');
