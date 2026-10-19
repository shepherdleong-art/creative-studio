import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion, addAssetToPool } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createBatchTask } from '../lib/batch-production/tasks.ts';
import {
  BatchExecutorError,
  createSemanticScoreExecutor,
  type BatchTaskProgress,
} from '../lib/batch-production/executors.ts';
import {
  buildBatchScenes,
  buildBatchSentences,
  batchSemanticPoolKey,
  batchSemanticScriptKey,
  persistBatchSemanticMatrix,
  readBatchSemanticMatrix,
} from '../lib/batch-production/semantic-match.ts';
import type { ClaimedBatchTask } from '../lib/batch-production/tasks.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-semantic-executor-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);

function claimFor(taskId: string, batchId: string, snapshotId: string): ClaimedBatchTask {
  return {
    task: { id: taskId, batchId, workType: 'semantic_score', targetKind: 'script_snapshot', targetId: snapshotId },
    attempt: { id: `attempt-${taskId}`, attemptNumber: 1 },
  };
}

async function runExecutor(
  executor: ReturnType<typeof createSemanticScoreExecutor>,
  claim: ClaimedBatchTask,
): Promise<{ progress: BatchTaskProgress[]; resultJson: unknown; committed?: { resultJson?: unknown; progress?: BatchTaskProgress } }> {
  const progress: BatchTaskProgress[] = [];
  const execution = await executor.execute({
    db,
    claim,
    signal: new AbortController().signal,
    reportProgress: (entry) => progress.push(entry),
  });
  const committed = execution.commit?.();
  return { progress, resultJson: execution.resultJson, committed };
}

try {
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: () => new Date('2026-08-06T00:00:00.000Z') });
  assert.equal(ready.state, 'ready');

  const bodyText = '开场介绍产品。细节展示卖点！';
  const providers = [{ id: 'prov-1', model: 'm1', configured: true }];

  function setupBatch(analysisJson: unknown): { batchId: string; versionId: string; snapshotId: string; taskId: string } {
    const batchId = createBatchProduction(db, 'project-1', `批次-${Math.random()}`);
    const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
    const scriptId = createProjectScript(db, 'project-1', {
      sourceKind: 'script_draft',
      sourceId: `script-${Math.random()}`,
      title: '脚本',
      bodyText,
      sourceVersion: 'v1',
    });
    const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
    const assetId = createAsset(db, {
      projectId: 'project-1',
      sourceKind: 'managed',
      locationJson: { key: `asset-${Math.random()}` },
      contentFingerprint: `sha256:${Math.random()}`,
      mediaKind: 'video',
    });
    const analysisId = createAnalysisVersion(db, { assetId, analyzerVersion: 'test', providerId: 'test', model: 'test', analysisJson });
    addAssetToPool(db, versionId, { assetId, analysisId });
    const taskId = createBatchTask(db, 'project-1', {
      batchId,
      workType: 'semantic_score',
      targetKind: 'script_snapshot',
      targetId: snapshotId,
    });
    return { batchId, versionId, snapshotId, taskId };
  }

  // 1. 无 content 分析(technical)→ 成功跳过,progressJson 标 skipped
  {
    const { batchId, snapshotId, taskId } = setupBatch({ analysisLevel: 'technical', durationUs: 8_000_000 });
    const executor = createSemanticScoreExecutor({ listProviders: () => providers });
    const { resultJson, committed } = await runExecutor(executor, claimFor(taskId, batchId, snapshotId));
    assert.deepEqual(resultJson, { scriptSnapshotId: snapshotId, skipped: 'no-content-analysis' });
    assert.deepEqual(committed?.resultJson, { scriptSnapshotId: snapshotId, skipped: 'no-content-analysis' });
    assert.equal(committed?.progress?.phase, 'semantic_score');
    assert.equal(committed?.progress?.skipped, 'no-content-analysis');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_semantic_matrices`).get() as { n: number }).n, 0);
  }

  const contentAnalysis = {
    analysisLevel: 'content',
    durationUs: 4_000_000,
    scenes: [
      { startUs: 0, endUs: 2_000_000, description: '开箱画面', labels: ['开箱'], qualityScore: 0.9 },
      { startUs: 2_000_000, endUs: 4_000_000, description: '手持特写', labels: ['手持'], qualityScore: 0.7 },
    ],
  };

  // 2. 矩阵已存在 → 幂等复用,不调用打分
  {
    const { batchId, versionId, snapshotId, taskId } = setupBatch(contentAnalysis);
    const sentences = buildBatchSentences(bodyText);
    const scenes = buildBatchScenes(db.prepare(`
      SELECT pool.assetId, assets.contentFingerprint, analysis.analysisJson
      FROM batch_asset_pool_items pool
      JOIN batch_assets assets ON assets.id = pool.assetId
      JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
      WHERE pool.batchVersionId = ?
    `).all(versionId) as Array<{ assetId: string; contentFingerprint: string; analysisJson: string }>);
    persistBatchSemanticMatrix(db, {
      projectId: 'project-1',
      scriptKey: batchSemanticScriptKey(sentences),
      poolKey: batchSemanticPoolKey(scenes),
      providerId: 'prov-1',
      model: 'm1',
      scores: { 'segment-1': { [`${scenes[0]!.assetKey}:0`]: 0.9 } },
      hooks: { [`${scenes[0]!.assetKey}:0`]: 0.8 },
    });
    let scoreCalled = false;
    const executor = createSemanticScoreExecutor({
      listProviders: () => providers,
      scoreBatch: async () => {
        scoreCalled = true;
        return { fallback: true };
      },
    });
    const { committed } = await runExecutor(executor, claimFor(taskId, batchId, snapshotId));
    assert.equal(scoreCalled, false, '矩阵已存在时不得重复打分');
    assert.equal((committed?.resultJson as { reused?: boolean }).reused, true);
    assert.equal(committed?.progress?.phase, 'semantic_score');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_semantic_matrices`).get() as { n: number }).n, 1);
  }

  // 3. 打分成功 → 落库,commit 后表内有 1 行新矩阵
  {
    const { batchId, versionId, snapshotId, taskId } = setupBatch(contentAnalysis);
    const executor = createSemanticScoreExecutor({
      listProviders: () => providers,
      scoreBatch: async ({ sentences, scenes }) => ({
        fallback: false,
        model: 'm1',
        scores: Object.fromEntries(sentences.map((sentence) => [
          sentence.id,
          Object.fromEntries(scenes.map((scene, index) => [`${scene.assetKey}:${scene.sceneIndex}`, 0.9 - index * 0.2])),
        ])),
        hooks: Object.fromEntries(scenes.map((scene) => [`${scene.assetKey}:${scene.sceneIndex}`, 0.6])),
      }),
    });
    const { progress, committed } = await runExecutor(executor, claimFor(taskId, batchId, snapshotId));
    assert.ok(progress.some((entry) => entry.phase === 'semantic_score' && entry.percent === null), '打分阶段不可测,不得伪造百分比');
    const created = (committed?.resultJson as { created?: boolean; matrixId?: string });
    assert.equal(created.created, true);
    const sentences = buildBatchSentences(bodyText);
    const scenes = buildBatchScenes(db.prepare(`
      SELECT pool.assetId, assets.contentFingerprint, analysis.analysisJson
      FROM batch_asset_pool_items pool
      JOIN batch_assets assets ON assets.id = pool.assetId
      JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
      WHERE pool.batchVersionId = ?
    `).all(versionId) as Array<{ assetId: string; contentFingerprint: string; analysisJson: string }>);
    const matrix = readBatchSemanticMatrix(db, 'project-1', batchSemanticScriptKey(sentences), batchSemanticPoolKey(scenes));
    assert.ok(matrix, '打分成功后矩阵必须落库');
    assert.deepEqual(Object.keys(matrix!.scores), ['segment-1', 'segment-2']);
    assert.equal(matrix!.scores['segment-1']![`${scenes[0]!.assetKey}:0`], 0.9);
    assert.equal(matrix!.hooks[`${scenes[0]!.assetKey}:0`], 0.6);
  }

  // 4. 打分 fallback → 抛出带 code 的错误(落账 errorCode=semantic_fallback),表保持为空
  {
    const { batchId, versionId, snapshotId, taskId } = setupBatch(contentAnalysis);
    const executor = createSemanticScoreExecutor({
      listProviders: () => providers,
      scoreBatch: async () => ({ fallback: true }),
    });
    await assert.rejects(
      executor.execute({
        db,
        claim: claimFor(taskId, batchId, snapshotId),
        signal: new AbortController().signal,
        reportProgress: () => undefined,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BatchExecutorError);
        assert.equal(error.code, 'semantic_fallback');
        return true;
      },
    );
    const sentences = buildBatchSentences(bodyText);
    const scenes = buildBatchScenes(db.prepare(`
      SELECT pool.assetId, assets.contentFingerprint, analysis.analysisJson
      FROM batch_asset_pool_items pool
      JOIN batch_assets assets ON assets.id = pool.assetId
      JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
      WHERE pool.batchVersionId = ?
    `).all(versionId) as Array<{ assetId: string; contentFingerprint: string; analysisJson: string }>);
    assert.equal(
      readBatchSemanticMatrix(db, 'project-1', batchSemanticScriptKey(sentences), batchSemanticPoolKey(scenes)),
      undefined,
      'fallback 不得落库',
    );
  }

  // 5. 解析不到供应商 → no_provider 错误
  {
    const { batchId, snapshotId, taskId } = setupBatch(contentAnalysis);
    const executor = createSemanticScoreExecutor({
      listProviders: () => [],
      scoreBatch: async () => ({ fallback: true }),
    });
    await assert.rejects(
      executor.execute({
        db,
        claim: claimFor(taskId, batchId, snapshotId),
        signal: new AbortController().signal,
        reportProgress: () => undefined,
      }),
      (error: unknown) => error instanceof BatchExecutorError && error.code === 'no_provider',
    );
  }

  console.log('batch semantic score executor tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
