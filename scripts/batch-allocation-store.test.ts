import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion, addAssetToPool } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import {
  clearBatchAssetExclusion,
  listBatchAssetExclusions,
  persistBatchAllocation,
  persistOutputReallocation,
  setBatchAssetExclusion,
} from '../lib/batch-production/allocation-store.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-allocation-store-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);

try {
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: () => new Date('2026-08-03T00:00:00.000Z') });
  assert.equal(ready.state, 'ready');
  const batchId = createBatchProduction(db, 'project-1', 'E1');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 2 });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-1',
    title: '稳定标题',
    bodyText: JSON.stringify({ segments: [
      { id: 'segment-1', text: '开场', startUs: 0, endUs: 2_000_000, semanticScores: { 'asset-1': 0.9, 'asset-2': 0.7 } },
      { id: 'segment-2', text: '细节', startUs: 2_000_000, endUs: 4_000_000, semanticScores: { 'asset-2': 0.9, 'asset-1': 0.7 } },
    ] }),
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 2 });
  const plans = createOutputPlansForSnapshot(db, versionId, snapshotId);
  const asset1 = createAsset(db, { projectId: 'project-1', sourceKind: 'managed', locationJson: { key: 'asset-1' }, contentFingerprint: 'sha256:asset-1', mediaKind: 'video' });
  const analysis1 = createAnalysisVersion(db, { assetId: asset1, analyzerVersion: 'test', providerId: 'test', model: 'test', analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] } });
  const asset2 = createAsset(db, { projectId: 'project-1', sourceKind: 'managed', locationJson: { key: 'asset-2' }, contentFingerprint: 'sha256:asset-2', mediaKind: 'video' });
  const analysis2 = createAnalysisVersion(db, { assetId: asset2, analyzerVersion: 'test', providerId: 'test', model: 'test', analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] } });
  addAssetToPool(db, versionId, { assetId: asset1, analysisId: analysis1 });
  addAssetToPool(db, versionId, { assetId: asset2, analysisId: analysis2 });
  db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = '2026-08-03T00:00:00.000Z' WHERE id = ?`).run(versionId);
  db.prepare(`UPDATE batch_productions SET status = 'running', currentVersionId = ? WHERE id = ?`).run(versionId, batchId);
  db.prepare(`UPDATE batch_output_plans SET currentArtifactId = 'artifact-sentinel' WHERE id = ?`).run(plans[0]);

  const first = persistBatchAllocation(db, 'project-1', versionId, { seed: 'store-seed', now: () => new Date('2026-08-03T01:00:00.000Z') });
  assert.equal(first.created, true);
  assert.equal(Object.keys(first.outputVersionIds).length, 2);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions`).get() as { n: number }).n, 2);
  assert.equal((db.prepare(`SELECT currentArtifactId FROM batch_output_plans WHERE id = ?`).get(plans[0]) as { currentArtifactId: string }).currentArtifactId, 'artifact-sentinel');
  const traced = db.prepare(`SELECT allocationRunId FROM batch_output_versions WHERE planId = ?`).get(plans[0]) as { allocationRunId: string };
  assert.equal(traced.allocationRunId, first.runId);

  const idempotent = persistBatchAllocation(db, 'project-1', versionId, { seed: 'store-seed', now: () => new Date('2026-08-03T02:00:00.000Z') });
  assert.equal(idempotent.created, false);
  assert.equal(idempotent.runId, first.runId);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions`).get() as { n: number }).n, 2, '同一冻结输入不得重复增加版本');

  setBatchAssetExclusion(db, 'project-1', versionId, asset2, '用户排除');
  assert.deepEqual(listBatchAssetExclusions(db, 'project-1', versionId).map(({ assetId, reason }) => ({ assetId, reason })), [{ assetId: asset2, reason: '用户排除' }]);
  const changed = persistBatchAllocation(db, 'project-1', versionId, { seed: 'store-seed', now: () => new Date('2026-08-03T03:00:00.000Z') });
  assert.notEqual(changed.runId, first.runId);
  assert.deepEqual(changed.result.exclusions, [{ assetId: asset2, reason: '用户排除' }]);
  clearBatchAssetExclusion(db, 'project-1', versionId, asset2);
  const restored = persistBatchAllocation(db, 'project-1', versionId, { seed: 'store-seed', now: () => new Date('2026-08-03T03:30:00.000Z') });
  assert.equal(restored.created, false);
  assert.equal((db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(plans[0]) as { currentVersionId: string | null }).currentVersionId, first.outputVersionIds[plans[0]], '命中历史幂等运行时恢复当前候选指针');

  const beforeOther = (db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions WHERE planId = ?`).get(plans[1]) as { n: number }).n;
  const beforeOtherPointer = (db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(plans[1]) as { currentVersionId: string | null }).currentVersionId;
  const reallocated = persistOutputReallocation(db, 'project-1', versionId, plans[0], '换一种分配', { seed: 'reallocate-seed', now: () => new Date('2026-08-03T04:00:00.000Z') });
  assert.ok(reallocated.runId);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_output_versions WHERE planId = ?`).get(plans[1]) as { n: number }).n, beforeOther, '单条重分配不得增加其他计划版本');
  assert.equal((db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(plans[1]) as { currentVersionId: string | null }).currentVersionId, beforeOtherPointer, '单条重分配不得改变其他计划当前指针');

  setBatchAssetExclusion(db, 'project-1', versionId, asset2, '临时排除');
  persistBatchAllocation(db, 'project-1', versionId, { seed: 'store-seed', now: () => new Date('2026-08-03T04:00:30.000Z') });
  clearBatchAssetExclusion(db, 'project-1', versionId, asset2);
  const reactivatedInitial = persistBatchAllocation(db, 'project-1', versionId, { seed: 'store-seed', now: () => new Date('2026-08-03T04:00:45.000Z') });
  assert.equal(reactivatedInitial.runId, first.runId, '恢复原输入后应重新激活初始联合分配');
  assert.equal(
    (db.prepare(`SELECT currentAllocationRunId FROM batch_production_versions WHERE id = ?`).get(versionId) as { currentAllocationRunId: string | null }).currentAllocationRunId,
    first.runId,
  );
  const repeatedReallocation = persistOutputReallocation(db, 'project-1', versionId, plans[0], '换一种分配', { seed: 'reallocate-seed', now: () => new Date('2026-08-03T04:01:00.000Z') });
  assert.equal(repeatedReallocation.created, false, '相同目标、原因和 seed 的重试必须命中同一分配运行');
  assert.equal(repeatedReallocation.runId, reallocated.runId);
  assert.equal(
    (db.prepare(`SELECT currentAllocationRunId FROM batch_production_versions WHERE id = ?`).get(versionId) as { currentAllocationRunId: string | null }).currentAllocationRunId,
    reallocated.runId,
    '命中历史重分配运行时必须同步激活联合分配指针',
  );
  const automatic = persistOutputReallocation(db, 'project-1', versionId, plans[0], '自动重试', { now: () => new Date('2026-08-03T04:02:00.000Z') });
  const repeatedAutomatic = persistOutputReallocation(db, 'project-1', versionId, plans[0], '自动重试', { now: () => new Date('2026-08-03T04:03:00.000Z') });
  assert.equal(repeatedAutomatic.created, true, '换一批成功后再次点击必须产生新运行,画面必须继续变化');
  assert.notEqual(repeatedAutomatic.runId, automatic.runId);
  const repeatedSameState = persistOutputReallocation(db, 'project-1', versionId, plans[0], '自动重试', { seed: repeatedAutomatic.result.seed, now: () => new Date('2026-08-03T04:04:00.000Z') });
  assert.equal(repeatedSameState.created, false, '同一状态下显式同 seed 的重试仍必须幂等');
  assert.equal(repeatedSameState.runId, repeatedAutomatic.runId);

  console.log('batch allocation store tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
