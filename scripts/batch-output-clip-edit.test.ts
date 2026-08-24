/**
 * 检查成片片段级编辑(等长 trim / 等长 replace)与编辑器数据视图。
 *
 * 覆盖契约:
 * 1. 视图:clips / narration / subtitleCues / cover / music / poolAssets(含
 *    excluded 与全批次维度 usedByPlanIds)、editable / editRevision;
 * 2. trim:等长校验(±1 帧取整误差内规整回原长度)、长度不符拒绝、越素材时长拒绝、
 *    无变化幂等短路;
 * 3. replace:成功(窗口从 0 起、assetId 与 contentFingerprint 同步为池记录)、
 *    非池素材/已排除/时长不足拒绝、同素材同窗口幂等短路;
 * 4. 生效编辑删除 $.review(审核重置)且 editRevision 递增;
 * 5. 门禁:stopped / draft(未冻结)批次拒绝,跨批次/不存在计划拒绝;
 * 6. renderRequestKey 含 editRevision:编辑后既有 succeeded 渲染任务不会吞掉
 *    新渲染(同 key 幂等去重,新 key 建新任务);
 * 7. 口播音频解析:有口播出绝对路径,无口播 404 领域错误。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { BATCH_SCHEMA_MIGRATIONS } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion, addAssetToPool } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { setBatchAssetExclusion } from '../lib/batch-production/allocation-store.ts';
import { setBatchPlanReviews, readBatchPlanReview } from '../lib/batch-production/review.ts';
import {
  applyBatchOutputClipEdit,
  getBatchOutputArrangementView,
} from '../lib/batch-production/output-arrangement.ts';
import { scheduleRenderAfterClipEdit } from '../lib/batch-production/phase-e.ts';
import { resolveBatchOutputNarrationAudio } from '../lib/batch-production/output-media.ts';
import { BatchDomainError } from '../lib/batch-production/errors.ts';

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-clip-edit-'));

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);
db.exec(`CREATE TABLE IF NOT EXISTS batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
for (const migration of BATCH_SCHEMA_MIGRATIONS) {
  db.exec(migration.sql);
  db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(migration.version, new Date().toISOString());
}

const projectId = 'project-1';
const batchId = createBatchProduction(db, projectId, '片段编辑批次');
const versionId = createBatchProductionVersion(db, batchId, {
  copyCount: 2,
  defaultsJson: { batchBgmParams: { gainDb: -12, fadeInSec: 2, fadeOutSec: 3 } },
});
const scriptId = createProjectScript(db, projectId, {
  sourceKind: 'script_draft',
  sourceId: 'script-1',
  title: '脚本一',
  bodyText: JSON.stringify({ segments: [
    { id: 'segment-1', text: '开场', startUs: 0, endUs: 2_000_000 },
    { id: 'segment-2', text: '卖点', startUs: 2_000_000, endUs: 4_000_000 },
  ] }),
  sourceVersion: 'v1',
});
const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 2 });
const plans = createOutputPlansForSnapshot(db, versionId, snapshotId);

function fingerprintOf(key: string): string {
  return `sha256:${key.repeat(64).slice(0, 64)}`;
}

function addPoolAsset(key: string, durationUs: number, mediaJson?: Record<string, unknown>): string {
  const assetId = createAsset(db, {
    projectId,
    sourceKind: 'managed',
    locationJson: { key },
    contentFingerprint: fingerprintOf(key),
    mediaKind: 'video',
    mediaJson,
  });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'test',
    providerId: 'test',
    model: 'test',
    analysisJson: { durationUs, usableRanges: [{ startUs: 0, endUs: durationUs, qualityScore: 1 }] },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });
  return assetId;
}

const assetA = addPoolAsset('aa', 8_000_000, { displayName: '素材甲', durationSec: 8 });
const assetB = addPoolAsset('bb', 8_000_000, { filename: '素材乙.mp4', durationSec: 8 });
const assetC = addPoolAsset('cc', 8_000_000);
const assetD = addPoolAsset('dd', 1_500_000);
const assetE = addPoolAsset('ee', 8_000_000);
const assetShort = addPoolAsset('gh', 400_000);
// 项目内存在但未进冻结池的素材:replace 必须拒绝。
const assetNotInPool = createAsset(db, {
  projectId,
  sourceKind: 'managed',
  locationJson: { key: 'ff' },
  contentFingerprint: fingerprintOf('ff'),
  mediaKind: 'video',
});

db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = '2026-08-24T00:00:00.000Z' WHERE id = ?`).run(versionId);
db.prepare(`UPDATE batch_productions SET status = 'running', currentVersionId = ? WHERE id = ?`).run(versionId, batchId);
setBatchAssetExclusion(db, projectId, versionId, assetE, '测试排除');

function makeClip(clipId: string, segmentId: string, assetId: string, sourceStartUs: number, sourceEndUs: number, timelineStartUs: number, timelineEndUs: number) {
  return {
    clipId,
    segmentId,
    sourceSegmentId: segmentId,
    assetId,
    contentFingerprint: fingerprintOf(assetId === assetA ? 'aa' : assetId === assetB ? 'bb' : 'cc'),
    sourceStartUs,
    sourceEndUs,
    timelineStartUs,
    timelineEndUs,
    locked: false,
    reason: 'test',
    semanticScore: 0.9,
  };
}

const outputVersionId = createOutputVersion(db, plans[0], {
  arrangementJson: {
    schemaVersion: 'test-arrangement',
    preset: '3:4',
    fps: 24,
    targetDurationUs: 4_000_000,
    clips: [
      makeClip('clip-1', 'segment-1', assetA, 1_000_000, 3_000_000, 0, 2_000_000),
      makeClip('clip-2', 'segment-2', assetB, 0, 2_000_000, 2_000_000, 4_000_000),
    ],
    cover: { assetId: assetA, timeUs: 1_500_000 },
    colorSnapshots: {},
    audio: { ready: true, productionReady: true, status: 'ready', reason: '' },
    narration: {
      ready: true,
      productionReady: true,
      status: 'ready',
      durationUs: 4_000_000,
      reason: '',
      mode: 'local_ready',
      audioRelativePath: 'batch-narration/test/narration.wav',
    },
    subtitle: {
      ready: true,
      productionReady: false,
      status: 'estimated',
      cues: [{ id: 'cue-1', sourceSegmentId: 'segment-1', text: '开场', startUs: 0, endUs: 2_000_000, timingSource: 'estimated' }],
    },
    music: { trackId: 'bgm-a' },
    warnings: [],
    blockers: [],
  },
});
createOutputVersion(db, plans[1], {
  arrangementJson: {
    clips: [makeClip('clip-9', 'segment-1', assetC, 0, 2_000_000, 0, 2_000_000)],
    cover: { assetId: null, timeUs: null },
    narration: { ready: false, productionReady: false, status: 'pending', durationUs: null, reason: '' },
    subtitle: { ready: false, productionReady: false, status: 'pending', cues: [] },
    music: { trackId: null },
  },
});

function currentArrangement(planId: string): Record<string, unknown> {
  const row = db.prepare(`
    SELECT o.arrangementJson
    FROM batch_output_plans p JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ?
  `).get(planId) as { arrangementJson: string };
  return JSON.parse(row.arrangementJson) as Record<string, unknown>;
}

function clipOf(planId: string, clipId: string): Record<string, unknown> {
  const arrangement = currentArrangement(planId);
  const clip = (arrangement.clips as Array<Record<string, unknown>>).find((entry) => entry.clipId === clipId);
  assert.ok(clip, `片段 ${clipId} 必须存在`);
  return clip;
}

function resetPlan0Arrangement(): void {
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(JSON.stringify({
    schemaVersion: 'test-arrangement',
    preset: '3:4',
    fps: 24,
    targetDurationUs: 4_000_000,
    clips: [
      makeClip('clip-1', 'segment-1', assetA, 1_000_000, 3_000_000, 0, 2_000_000),
      makeClip('clip-2', 'segment-2', assetB, 0, 2_000_000, 2_000_000, 4_000_000),
    ],
    cover: { assetId: assetA, timeUs: 1_500_000 },
    colorSnapshots: {},
    audio: { ready: true, productionReady: true, status: 'ready', reason: '' },
    narration: {
      ready: true,
      productionReady: true,
      status: 'ready',
      durationUs: 4_000_000,
      reason: '',
      mode: 'local_ready',
      audioRelativePath: 'batch-narration/test/narration.wav',
    },
    subtitle: {
      ready: true,
      productionReady: false,
      status: 'estimated',
      cues: [{ id: 'cue-1', sourceSegmentId: 'segment-1', text: '开场', startUs: 0, endUs: 2_000_000, timingSource: 'estimated' }],
    },
    music: { trackId: 'bgm-a' },
    warnings: [],
    blockers: [],
  }), outputVersionId);
}

function assertDomainError(fn: () => unknown, code: 'not_found' | 'invalid_input' | 'conflict', pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BatchDomainError, `期望 BatchDomainError,实际:${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  });
}

try {
  // 1. 编辑器数据视图
  const view = getBatchOutputArrangementView(db, projectId, batchId, plans[0]);
  assert.equal(view.planId, plans[0]);
  assert.equal(view.batchVersionId, versionId);
  assert.equal(view.outputVersionId, outputVersionId);
  assert.equal(view.versionNumber, 1);
  assert.equal(view.editable, true);
  assert.equal(view.editRevision, 0);
  assert.equal(view.visualDurationUs, 4_000_000);
  assert.equal(view.clips.length, 2);
  assert.deepEqual(
    view.clips.map((clip) => [clip.clipId, clip.assetId, clip.sourceStartUs, clip.sourceEndUs, clip.timelineStartUs, clip.timelineEndUs, clip.locked]),
    [
      ['clip-1', assetA, 1_000_000, 3_000_000, 0, 2_000_000, false],
      ['clip-2', assetB, 0, 2_000_000, 2_000_000, 4_000_000, false],
    ],
  );
  assert.deepEqual(view.narration, { audioRelativePath: 'batch-narration/test/narration.wav', durationUs: 4_000_000 });
  assert.deepEqual(view.subtitleCues, [{ startUs: 0, endUs: 2_000_000, text: '开场' }]);
  assert.equal(view.coverAssetId, assetA);
  assert.deepEqual(view.music, { trackId: 'bgm-a', gainDb: -12, fadeInSec: 2, fadeOutSec: 3 });
  assert.equal(view.poolAssets.length, 6, '冻结池 6 条素材(未入池素材不得出现)');
  assert.ok(!view.poolAssets.some((asset) => asset.assetId === assetNotInPool));
  const poolById = new Map(view.poolAssets.map((asset) => [asset.assetId, asset]));
  assert.equal(poolById.get(assetA)?.displayName, '素材甲');
  assert.equal(poolById.get(assetB)?.displayName, '素材乙.mp4', '无 displayName 时回落 filename');
  assert.equal(poolById.get(assetA)?.durationSec, 8);
  assert.equal(poolById.get(assetD)?.durationSec, 1.5);
  assert.equal(poolById.get(assetShort)?.durationSec, 0.4);
  assert.equal(poolById.get(assetE)?.excluded, true);
  assert.equal(poolById.get(assetA)?.excluded, false);
  assert.deepEqual(poolById.get(assetA)?.usedByPlanIds, [plans[0]]);
  assert.deepEqual(poolById.get(assetB)?.usedByPlanIds, [plans[0]]);
  assert.deepEqual(poolById.get(assetC)?.usedByPlanIds, [plans[1]]);
  assert.deepEqual(poolById.get(assetD)?.usedByPlanIds, [], '从未使用的素材必须可见');
  assert.deepEqual(poolById.get(assetE)?.usedByPlanIds, []);
  assert.match(poolById.get(assetA)!.thumbnailUrl, new RegExp(`^/api/batch-production/assets/${assetA}/thumbnail\\?projectId=${projectId}&v=`));
  assert.ok(poolById.get(assetA)!.previewUrl.includes(`batchId=${batchId}`));
  assert.ok(poolById.get(assetA)!.previewUrl.includes(`batchVersionId=${versionId}`));
  console.log('✓ 1. 编辑器数据视图(片段/口播/字幕/BGM/冻结池使用标记)');

  // 2. trim 成功:±1 帧取整误差内规整回原长度
  const trimmed = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim', clipId: 'clip-1', sourceStartUs: 500_000, sourceEndUs: 2_541_000,
  });
  assert.equal(trimmed.outputVersionId, outputVersionId);
  assert.equal(trimmed.changed, true);
  assert.equal(trimmed.editRevision, 1);
  assert.equal(clipOf(plans[0], 'clip-1').sourceStartUs, 500_000);
  assert.equal(clipOf(plans[0], 'clip-1').sourceEndUs, 2_500_000, '取整误差必须规整为 sourceStartUs + 原长度');
  assert.equal(currentArrangement(plans[0]).editRevision, 1);
  console.log('✓ 2. trim 成功并规整 24fps 取整误差');

  // 3. 生效编辑删除 $.review 且 editRevision 递增
  setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });
  assert.equal(readBatchPlanReview(db, projectId, batchId, plans[0]).decision, 'approved');
  const trimmedAgain = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim', clipId: 'clip-1', sourceStartUs: 600_000, sourceEndUs: 2_600_000,
  });
  assert.equal(trimmedAgain.editRevision, 2);
  assert.equal('review' in currentArrangement(plans[0]), false, '编辑后审核结论必须被删除');
  assert.equal(readBatchPlanReview(db, projectId, batchId, plans[0]).decision, null, '画面变了必须回到未审核态');
  console.log('✓ 3. 编辑后 $.review 清除且 editRevision 递增');

  // 4. trim 长度不符拒绝
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'trim', clipId: 'clip-1', sourceStartUs: 0, sourceEndUs: 1_000_000 }),
    'invalid_input',
    /时长不变/,
  );
  console.log('✓ 4. trim 长度不符拒绝');

  // 5. trim 越素材时长拒绝(素材甲 8s,片段长 2s,入点 6.5s → 出点 8.5s 越界)
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'trim', clipId: 'clip-1', sourceStartUs: 6_500_000, sourceEndUs: 8_500_000 }),
    'invalid_input',
    /超出素材时长/,
  );
  console.log('✓ 5. trim 越素材时长拒绝');

  // 6. trim 无变化幂等短路
  const noopTrim = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim', clipId: 'clip-1', sourceStartUs: 600_000, sourceEndUs: 2_600_000,
  });
  assert.equal(noopTrim.changed, false);
  assert.equal(noopTrim.editRevision, 2, '无变化不得递增 editRevision');
  console.log('✓ 6. trim 无变化幂等短路');

  // 7. replace 成功:窗口从 0 起,assetId 与 contentFingerprint 同步为池记录
  const replaced = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'replace', clipId: 'clip-2', assetId: assetC,
  });
  assert.equal(replaced.changed, true);
  assert.equal(replaced.editRevision, 3);
  const replacedClip = clipOf(plans[0], 'clip-2');
  assert.equal(replacedClip.assetId, assetC);
  assert.equal(replacedClip.contentFingerprint, fingerprintOf('cc'), '片段指纹必须同步为池记录指纹');
  assert.equal(replacedClip.sourceStartUs, 0, '替换窗口从 0 起');
  assert.equal(replacedClip.sourceEndUs, 2_000_000, '替换窗口长度保持片段原长度');
  console.log('✓ 7. replace 成功(窗口从 0 起 + 指纹同步)');

  // 8. replace 拒绝:非池素材 / 已排除 / 时长不足
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'replace', clipId: 'clip-2', assetId: assetNotInPool }),
    'invalid_input',
    /冻结素材池/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'replace', clipId: 'clip-2', assetId: assetE }),
    'conflict',
    /排除/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'replace', clipId: 'clip-2', assetId: assetD }),
    'invalid_input',
    /时长不足/,
  );
  console.log('✓ 8. replace 非池素材/已排除/时长不足拒绝');

  // 9. replace 同素材同窗口幂等短路
  const noopReplace = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'replace', clipId: 'clip-2', assetId: assetC,
  });
  assert.equal(noopReplace.changed, false);
  assert.equal(noopReplace.editRevision, 3);
  console.log('✓ 9. replace 同素材同窗口幂等短路');

  // 10. 门禁:stopped / draft(未冻结)批次拒绝;不存在或跨批次计划拒绝
  db.prepare(`UPDATE batch_productions SET controlState = 'stopped' WHERE id = ?`).run(batchId);
  assert.equal(getBatchOutputArrangementView(db, projectId, batchId, plans[0]).editable, false, '已停止批次视图必须只读');
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'trim', clipId: 'clip-1', sourceStartUs: 700_000, sourceEndUs: 2_700_000 }),
    'conflict',
    /已停止/,
  );
  db.prepare(`UPDATE batch_productions SET controlState = 'running' WHERE id = ?`).run(batchId);
  db.prepare(`UPDATE batch_production_versions SET inputState = 'draft' WHERE id = ?`).run(versionId);
  assert.equal(getBatchOutputArrangementView(db, projectId, batchId, plans[0]).editable, false, '未冻结批次视图必须只读');
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'trim', clipId: 'clip-1', sourceStartUs: 700_000, sourceEndUs: 2_700_000 }),
    'conflict',
    /尚未冻结/,
  );
  db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen' WHERE id = ?`).run(versionId);
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, 'ghost-plan', { type: 'trim', clipId: 'clip-1', sourceStartUs: 0, sourceEndUs: 2_000_000 }),
    'not_found',
    /成片计划不存在/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, 'ghost-batch', plans[0], { type: 'trim', clipId: 'clip-1', sourceStartUs: 0, sourceEndUs: 2_000_000 }),
    'not_found',
    /成片计划不存在/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'trim', clipId: 'ghost-clip', sourceStartUs: 0, sourceEndUs: 2_000_000 }),
    'not_found',
    /片段不存在/,
  );
  console.log('✓ 10. stopped/draft 批次与幽灵计划/片段拒绝');

  // 11. requestKey 含 editRevision:既有 succeeded 任务不吞掉编辑后的重渲染
  const taskId1 = scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]);
  assert.ok(taskId1);
  const requestKey1 = (db.prepare(`SELECT requestKey FROM batch_tasks WHERE id = ?`).get(taskId1) as { requestKey: string }).requestKey;
  assert.equal(requestKey1, `render:${outputVersionId}:batch-render-v2:cover:1500000:edit:3`);
  db.prepare(`UPDATE batch_tasks SET status = 'succeeded', attemptCount = 1 WHERE id = ?`).run(taskId1);
  const taskIdDeduped = scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]);
  assert.equal(taskIdDeduped, taskId1, '同一 editRevision 重复触发必须幂等去重');
  const editAfterSuccess = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim', clipId: 'clip-1', sourceStartUs: 700_000, sourceEndUs: 2_700_000,
  });
  assert.equal(editAfterSuccess.editRevision, 4);
  const taskId2 = scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]);
  assert.ok(taskId2);
  assert.notEqual(taskId2, taskId1, 'editRevision 变化必须在既有 succeeded 任务之上建新渲染任务');
  const requestKey2 = (db.prepare(`SELECT requestKey FROM batch_tasks WHERE id = ?`).get(taskId2) as { requestKey: string }).requestKey;
  assert.equal(requestKey2, `render:${outputVersionId}:batch-render-v2:cover:1500000:edit:4`);
  console.log('✓ 11. requestKey 含 editRevision:新编辑产生新任务,同 key 去重');

  // 11b. 延迟提交模型(2026-08-25):编辑期不排渲染,退出这一轮调整时一次性提交。
  // 旧行为是每次微调排一条整片重渲染(实测 4~7 秒),期间 renderBusy 把编辑器锁死,
  // 用户体感就是"调一下等一下"。这里锁定"N 次编辑只排 1 条、且指向最终 revision"。
  const renderTaskCount = () => (db.prepare(
    `SELECT COUNT(*) AS n FROM batch_tasks WHERE workType = 'render' AND targetId = ?`,
  ).get(outputVersionId) as { n: number }).n;
  const tasksBeforeDeferred = renderTaskCount();
  for (const [startUs, endUs] of [[100_000, 2_100_000], [200_000, 2_200_000], [300_000, 2_300_000]] as const) {
    const deferred = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'trim', clipId: 'clip-1', sourceStartUs: startUs, sourceEndUs: endUs,
    });
    assert.equal(deferred.visualChanged, true);
  }
  assert.equal(renderTaskCount(), tasksBeforeDeferred, '编辑期只改 arrangement,一条渲染任务都不该建');
  const committedTaskId = scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]);
  assert.ok(committedTaskId);
  assert.equal(renderTaskCount(), tasksBeforeDeferred + 1, '退出时一次性提交:3 次编辑只排 1 条渲染');
  const committedKey = (db.prepare(`SELECT requestKey FROM batch_tasks WHERE id = ?`).get(committedTaskId) as { requestKey: string }).requestKey;
  assert.equal(
    committedKey,
    `render:${outputVersionId}:batch-render-v2:cover:1500000:edit:7`,
    '提交的必须是最终 editRevision,不是中间态',
  );
  assert.equal(
    scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]),
    committedTaskId,
    '手动「立即重新渲染」与卸载兜底可能都提交一次,必须幂等',
  );
  console.log('✓ 11b. 延迟提交:编辑期零渲染,退出时按最终 revision 只排一条');

  // 12. 口播音频解析:有口播出绝对路径,无口播 404
  const narrationDir = path.join(storageRoot, 'batch-narration', 'test');
  fs.mkdirSync(narrationDir, { recursive: true });
  fs.writeFileSync(path.join(narrationDir, 'narration.wav'), Buffer.from('fixture-wav'));
  const narrationMedia = resolveBatchOutputNarrationAudio(db, projectId, batchId, plans[0], storageRoot);
  assert.equal(narrationMedia.absolutePath, path.join(narrationDir, 'narration.wav'));
  assert.equal(narrationMedia.contentType, 'audio/wav');
  assertDomainError(
    () => resolveBatchOutputNarrationAudio(db, projectId, batchId, plans[1], storageRoot),
    'not_found',
    /口播音频/,
  );
  console.log('✓ 12. 口播音频解析(有/无口播)');

  // 13. trim_variable 变长后 ripple:后续片段依次后延,首尾相接
  resetPlan0Arrangement();
  const longer = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim_variable', clipId: 'clip-1', sourceStartUs: 500_000, sourceEndUs: 3_500_000,
  });
  assert.equal(longer.changed, true);
  assert.equal(longer.visualChanged, true);
  assert.equal(longer.editRevision, 1);
  assert.ok(longer.warnings.some((warning) => warning.includes('画面总长比口播长 1.0 秒')), '变长后必须给出长出的后果提示');
  const longerClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.deepEqual(
    longerClips.map((clip) => [clip.clipId, clip.timelineStartUs, clip.timelineEndUs]),
    [
      ['clip-1', 0, 3_000_000],
      ['clip-2', 3_000_000, 5_000_000],
    ],
    '变长修剪后必须 ripple 且时间线连续',
  );
  assert.equal(getBatchOutputArrangementView(db, projectId, batchId, plans[0]).visualDurationUs, 5_000_000);
  console.log('✓ 13. trim_variable 变长 + ripple + 时长 warning');

  // 14. trim_variable 缩短成功;越素材时长/短于 0.5s 拒绝
  resetPlan0Arrangement();
  const shorter = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim_variable', clipId: 'clip-1', sourceStartUs: 2_000_000, sourceEndUs: 2_500_000,
  });
  assert.equal(shorter.changed, true);
  assert.equal(shorter.visualChanged, true);
  assert.ok(shorter.warnings.some((warning) => warning.includes('画面总长比口播短 1.5 秒')), '缩短后必须给出画面短于口播的提示');
  const shorterClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.deepEqual(
    shorterClips.map((clip) => [clip.clipId, clip.timelineStartUs, clip.timelineEndUs]),
    [
      ['clip-1', 0, 500_000],
      ['clip-2', 500_000, 2_500_000],
    ],
  );
  resetPlan0Arrangement();
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'trim_variable', clipId: 'clip-1', sourceStartUs: 7_500_000, sourceEndUs: 9_500_000,
    }),
    'invalid_input',
    /超出素材时长/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'trim_variable', clipId: 'clip-1', sourceStartUs: 500_000, sourceEndUs: 900_000,
    }),
    'invalid_input',
    /0\.5 秒/,
  );
  assert.equal(applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim_variable', clipId: 'clip-1', sourceStartUs: 1_000_000, sourceEndUs: 3_000_000,
  }).changed, false, '变长修剪无变化必须幂等短路');
  console.log('✓ 14. trim_variable 缩短/越界/最短长度/幂等');

  // 15. delete ripple 提前,只剩一条拒绝
  resetPlan0Arrangement();
  const deleted = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'delete', clipId: 'clip-2',
  });
  assert.equal(deleted.changed, true);
  assert.equal(deleted.visualChanged, true);
  assert.ok(deleted.warnings.some((warning) => warning.includes('删除的片段对应口播句子仍按原时间播放')), '删除必须提示口播错位');
  assert.ok(deleted.warnings.some((warning) => warning.includes('画面总长比口播短 2.0 秒')), '删除缩短后必须提示补帧');
  const deletedClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.deepEqual(deletedClips.map((clip) => [clip.clipId, clip.timelineStartUs, clip.timelineEndUs]), [['clip-1', 0, 2_000_000]]);
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], { type: 'delete', clipId: 'clip-1' }),
    'invalid_input',
    /至少保留一条片段/,
  );
  console.log('✓ 15. delete ripple / 只剩一条拒绝');

  // 16. insert 到最前/中间/末尾;非池/已排除/素材与显式窗口不足最短长度拒绝
  resetPlan0Arrangement();
  const front = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'insert', afterClipId: null, assetId: assetB, durationUs: 1_000_000,
  });
  assert.equal(front.changed, true);
  let insertedClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.deepEqual(
    insertedClips.map((clip) => [clip.assetId, clip.timelineStartUs, clip.timelineEndUs]),
    [
      [assetB, 0, 1_000_000],
      [assetA, 1_000_000, 3_000_000],
      [assetB, 3_000_000, 5_000_000],
    ],
    '插到最前必须位于第一条且后续 ripple',
  );
  assert.ok(String(insertedClips[0].clipId).startsWith('manual:'));
  resetPlan0Arrangement();
  applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'insert', afterClipId: 'clip-1', assetId: assetB, durationUs: 1_000_000,
  });
  insertedClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.deepEqual(
    insertedClips.map((clip) => [clip.clipId, clip.timelineStartUs, clip.timelineEndUs]),
    [
      ['clip-1', 0, 2_000_000],
      [insertedClips[1].clipId, 2_000_000, 3_000_000],
      ['clip-2', 3_000_000, 5_000_000],
    ],
  );
  resetPlan0Arrangement();
  const tail = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'insert', afterClipId: 'clip-2', assetId: assetB,
  });
  insertedClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.deepEqual(
    insertedClips.map((clip) => [clip.assetId, clip.timelineStartUs, clip.timelineEndUs]),
    [
      [assetA, 0, 2_000_000],
      [assetB, 2_000_000, 4_000_000],
      [assetB, 4_000_000, 7_000_000],
    ],
    '默认插入窗口必须为 3 秒并追加到末尾',
  );
  assert.ok(tail.warnings.some((warning) => warning.includes('画面总长比口播长 3.0 秒')));
  resetPlan0Arrangement();
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'insert', afterClipId: null, assetId: assetNotInPool,
    }),
    'invalid_input',
    /冻结素材池/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'insert', afterClipId: null, assetId: assetE,
    }),
    'conflict',
    /排除/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'insert', afterClipId: null, assetId: assetShort,
    }),
    'invalid_input',
    /最短片段长度/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'insert', afterClipId: null, assetId: assetB, durationUs: 200_000,
    }),
    'invalid_input',
    /最短片段长度/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'insert', afterClipId: 'ghost-clip', assetId: assetB,
    }),
    'not_found',
    /插入位置片段不存在/,
  );
  console.log('✓ 16. insert 三位置连续性/默认窗口/非法素材拒绝');

  // 17. split 源连续、时间线连续、总长不变、后续不动;不递增 revision/不清 review/不排队
  resetPlan0Arrangement();
  setBatchPlanReviews(db, projectId, batchId, { planIds: [plans[0]], decision: 'approved' });
  const taskBeforeSplit = scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]);
  const split = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'split', clipId: 'clip-1', offsetUs: 1_000_000,
  });
  assert.equal(split.changed, true);
  assert.equal(split.visualChanged, false, 'split 是纯结构操作');
  assert.equal(split.editRevision, 0, 'split 不得递增 editRevision');
  assert.deepEqual(split.warnings, []);
  assert.equal(readBatchPlanReview(db, projectId, batchId, plans[0]).decision, 'approved', 'split 不得清除审核');
  assert.ok('review' in currentArrangement(plans[0]), 'split 不得删除 $.review');
  const splitClips = currentArrangement(plans[0]).clips as Array<Record<string, unknown>>;
  assert.equal(splitClips.length, 3);
  assert.deepEqual(
    splitClips.map((clip) => [clip.clipId, clip.sourceStartUs, clip.sourceEndUs, clip.timelineStartUs, clip.timelineEndUs]),
    [
      ['clip-1', 1_000_000, 2_000_000, 0, 1_000_000],
      [splitClips[1].clipId, 2_000_000, 3_000_000, 1_000_000, 2_000_000],
      ['clip-2', 0, 2_000_000, 2_000_000, 4_000_000],
    ],
    'split 两段源区间必须连续、时间线连续且后续片段不动',
  );
  assert.equal(splitClips[1].segmentId, '');
  const taskAfterSplit = scheduleRenderAfterClipEdit(db, projectId, batchId, plans[0]);
  assert.equal(taskAfterSplit, taskBeforeSplit, 'split 不得产生新渲染任务(revision 未变,同 key 去重)');
  resetPlan0Arrangement();
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'split', clipId: 'clip-1', offsetUs: 100_000,
    }),
    'invalid_input',
    /至少 0\.5 秒/,
  );
  assertDomainError(
    () => applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
      type: 'split', clipId: 'clip-1', offsetUs: 1_900_000,
    }),
    'invalid_input',
    /至少 0\.5 秒/,
  );
  console.log('✓ 17. split 结构不变/审核保留/不重渲染/贴边拒绝');

  // 18. 第一片段窗口变化后 cover.timeUs 越界 -> 钳位到新片段开头
  resetPlan0Arrangement();
  const coverClamped = applyBatchOutputClipEdit(db, projectId, batchId, plans[0], {
    type: 'trim_variable', clipId: 'clip-1', sourceStartUs: 4_000_000, sourceEndUs: 6_000_000,
  });
  assert.equal(coverClamped.changed, true);
  assert.ok(coverClamped.warnings.includes('封面抽帧点已重置到新片段开头'));
  assert.equal((currentArrangement(plans[0]).cover as Record<string, unknown>).timeUs, 4_000_000);
  console.log('✓ 18. 封面抽帧点越界钳位');

  console.log('batch output clip edit tests passed');
} finally {
  db.close();
  fs.rmSync(storageRoot, { recursive: true, force: true });
}
