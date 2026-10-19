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
import { buildFrozenBatchInput, persistBatchAllocation } from '../lib/batch-production/allocation-store.ts';
import {
  buildBatchScenes,
  buildBatchSentences,
  batchSemanticPoolKey,
  batchSemanticScriptKey,
  persistBatchSemanticMatrix,
} from '../lib/batch-production/semantic-match.ts';
import type { AllocationSegmentInput } from '../lib/batch-production/allocator.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-semantic-allocation-input-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);

const BODY_TEXT = '开场介绍产品。细节展示卖点！';

try {
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: () => new Date('2026-08-06T00:00:00.000Z') });
  assert.equal(ready.state, 'ready');

  const batchId = createBatchProduction(db, 'project-1', '语义装配批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-1',
    title: '脚本',
    bodyText: BODY_TEXT,
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
  createOutputPlansForSnapshot(db, versionId, snapshotId);
  const assetId = createAsset(db, { projectId: 'project-1', sourceKind: 'managed', locationJson: { key: 'asset-1' }, contentFingerprint: 'sha256:asset-1', mediaKind: 'video' });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'test',
    providerId: 'test',
    model: 'test',
    analysisJson: {
      analysisLevel: 'content',
      durationUs: 8_000_000,
      scenes: [
        { startUs: 0, endUs: 4_000_000, description: '开箱画面', labels: ['开箱', '产品'], qualityScore: 0.9 },
        { startUs: 4_000_000, endUs: 8_000_000, description: '手持特写', labels: ['手持', '细节'], qualityScore: 0.7 },
      ],
    },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });
  db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = '2026-08-06T00:00:00.000Z' WHERE id = ?`).run(versionId);
  db.prepare(`UPDATE batch_productions SET status = 'running', currentVersionId = ? WHERE id = ?`).run(versionId, batchId);

  const sentences = buildBatchSentences(BODY_TEXT);
  const scenes = buildBatchScenes([
    { assetId, contentFingerprint: 'sha256:asset-1', analysisJson: (db.prepare(`SELECT analysisJson FROM batch_asset_analysis WHERE id = ?`).get(analysisId) as { analysisJson: string }).analysisJson },
  ]);
  const scriptKey = batchSemanticScriptKey(sentences);
  const poolKey = batchSemanticPoolKey(scenes);

  // 1. 无矩阵:segments 显式带 keywords,不带 semanticScores/hookScores
  const withoutMatrix = buildFrozenBatchInput(db, 'project-1', versionId, { seed: 'semantic-seed' });
  const baseSegments = withoutMatrix.plans![0]!.segments as AllocationSegmentInput[];
  assert.equal(baseSegments.length, 2);
  assert.deepEqual(baseSegments.map((segment) => segment.text), ['开场介绍产品', '细节展示卖点']);
  assert.deepEqual(baseSegments[0]!.keywords, ['开场介绍产品']);
  assert.deepEqual(baseSegments[1]!.keywords, ['细节展示卖点']);
  assert.equal(baseSegments[0]!.semanticScores, undefined);
  assert.equal(baseSegments[0]!.hookScores, undefined);

  const firstRun = persistBatchAllocation(db, 'project-1', versionId, { seed: 'semantic-seed', now: () => new Date('2026-08-06T01:00:00.000Z') });
  assert.equal(firstRun.created, true);

  // 2. 落库矩阵后:segments 带 semanticScores/hookScores/keywords,指纹变化产生新 run
  persistBatchSemanticMatrix(db, {
    projectId: 'project-1',
    scriptKey,
    poolKey,
    providerId: 'prov-1',
    model: 'm1',
    scores: {
      'segment-1': { [`${assetId}:0`]: 0.95, [`${assetId}:1`]: 0.1 },
      'segment-2': { [`${assetId}:0`]: 0.2, [`${assetId}:1`]: 0.9 },
    },
    hooks: { [`${assetId}:0`]: 0.8, [`${assetId}:1`]: 0.3 },
  });
  const withMatrix = buildFrozenBatchInput(db, 'project-1', versionId, { seed: 'semantic-seed' });
  const enriched = withMatrix.plans![0]!.segments as AllocationSegmentInput[];
  assert.equal(enriched.length, 2);
  assert.deepEqual(enriched[0]!.semanticScores, { [`${assetId}:0`]: 0.95, [`${assetId}:1`]: 0.1 });
  assert.deepEqual(enriched[1]!.semanticScores, { [`${assetId}:0`]: 0.2, [`${assetId}:1`]: 0.9 });
  assert.deepEqual(enriched[0]!.hookScores, { [`${assetId}:0`]: 0.8, [`${assetId}:1`]: 0.3 });
  assert.deepEqual(enriched[1]!.hookScores, { [`${assetId}:0`]: 0.8, [`${assetId}:1`]: 0.3 });
  assert.deepEqual(enriched[0]!.keywords, ['开场介绍产品']);

  const secondRun = persistBatchAllocation(db, 'project-1', versionId, { seed: 'semantic-seed', now: () => new Date('2026-08-06T02:00:00.000Z') });
  assert.equal(secondRun.created, true, '矩阵就绪后输入指纹必须变化并产生新分配运行');
  assert.notEqual(secondRun.inputFingerprint, firstRun.inputFingerprint);
  assert.notEqual(secondRun.runId, firstRun.runId);

  // 3. 历史路径:bodyText 自带 segments 时保留原 id 与时间,按 index 对齐补分
  const batchId2 = createBatchProduction(db, 'project-1', '历史段批次');
  const versionId2 = createBatchProductionVersion(db, batchId2, { copyCount: 1 });
  const scriptId2 = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-2',
    title: '脚本2',
    bodyText: JSON.stringify({ segments: [
      { id: 'seg-a', text: '第一句开场', startUs: 0, endUs: 2_000_000 },
      { id: 'seg-b', text: '第二句细节', startUs: 2_000_000, endUs: 4_000_000 },
    ] }),
    sourceVersion: 'v1',
  });
  const snapshotId2 = snapshotScriptIntoBatch(db, versionId2, { scriptId: scriptId2, copyCount: 1 });
  createOutputPlansForSnapshot(db, versionId2, snapshotId2);
  addAssetToPool(db, versionId2, { assetId, analysisId });
  db.prepare(`UPDATE batch_production_versions SET inputState = 'frozen', frozenAt = '2026-08-06T00:00:00.000Z' WHERE id = ?`).run(versionId2);
  const jsonBodyText = (db.prepare(`SELECT bodyText FROM batch_script_snapshots WHERE id = ?`).get(snapshotId2) as { bodyText: string }).bodyText;
  persistBatchSemanticMatrix(db, {
    projectId: 'project-1',
    scriptKey: batchSemanticScriptKey(buildBatchSentences(jsonBodyText)),
    poolKey,
    providerId: 'prov-1',
    model: 'm1',
    scores: {
      'segment-1': { [`${assetId}:0`]: 0.6 },
      'segment-2': { [`${assetId}:1`]: 0.7 },
    },
    hooks: { [`${assetId}:0`]: 0.5 },
  });
  const historical = buildFrozenBatchInput(db, 'project-1', versionId2, { seed: 'semantic-seed' });
  const historicalSegments = historical.plans![0]!.segments as AllocationSegmentInput[];
  assert.equal(historicalSegments.length, 2);
  assert.equal(historicalSegments[0]!.id, 'seg-a', '历史 segments 的 id 不得改写');
  assert.equal(historicalSegments[0]!.startUs, 0);
  assert.equal(historicalSegments[0]!.endUs, 2_000_000);
  assert.deepEqual(historicalSegments[0]!.keywords, ['第一句开场'], '缺失的 keywords 必须按段文本补齐');
  assert.deepEqual(historicalSegments[0]!.semanticScores, { [`${assetId}:0`]: 0.6 });
  assert.deepEqual(historicalSegments[1]!.semanticScores, { [`${assetId}:1`]: 0.7 });
  assert.deepEqual(historicalSegments[0]!.hookScores, { [`${assetId}:0`]: 0.5 });

  console.log('batch semantic allocation input tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
