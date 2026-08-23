import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { createBatchProduction, createBatchProductionVersion, addAssetToPool } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import {
  buildBatchScenes,
  buildBatchSentences,
  batchSemanticPoolKey,
  batchSemanticScriptKey,
  countIncompleteBatchSemanticScoreTasks,
  persistBatchSemanticMatrix,
  prepareBatchSemanticScoreBeforeStart,
  queueBatchSemanticScoreTasks,
  readBatchSemanticMatrix,
  resolveBatchSemanticProvider,
  scoreBatchSemanticMatrix,
  SEMANTIC_SCORE_MAX_AUTO_ATTEMPTS,
} from '../lib/batch-production/semantic-match.ts';
import { splitAllocationScriptBody } from '../lib/batch-production/allocator.ts';

// ---------- 纯函数:句段构造 ----------

const sentences = buildBatchSentences('开场介绍产品。细节展示卖点！\n第三句收尾');
assert.equal(sentences.length, 3);
assert.deepEqual(sentences.map((sentence) => sentence.id), ['segment-1', 'segment-2', 'segment-3']);
assert.deepEqual(sentences.map((sentence) => sentence.text), ['开场介绍产品', '细节展示卖点', '第三句收尾']);
assert.deepEqual(sentences[0]!.keywords, ['开场介绍产品']);
assert.ok(sentences.every((sentence) => sentence.keywords.length > 0), '每句都必须带 keywords');
// 与分配器断句逐字一致
assert.deepEqual(sentences.map((sentence) => sentence.text), splitAllocationScriptBody('开场介绍产品。细节展示卖点！\n第三句收尾'));
assert.deepEqual(buildBatchSentences('   '), [], '空正文没有句段');

// ---------- 纯函数:场景构造只收 content ----------

const poolRows = [
  { assetId: 'asset-technical', contentFingerprint: 'fp-t', analysisJson: JSON.stringify({ analysisLevel: 'technical', durationUs: 8_000_000 }) },
  {
    assetId: 'asset-content',
    contentFingerprint: 'fp-c',
    analysisJson: {
      analysisLevel: 'content',
      scenes: [
        { startUs: 0, endUs: 2_000_000, description: '开箱画面', labels: ['开箱', '桌面'], qualityScore: 0.8 },
        { startUs: 2_000_000, endUs: 4_000_000, description: '手持特写', labels: ['手持'], qualityScore: 1.5 },
      ],
    },
  },
  { assetId: 'asset-empty', contentFingerprint: 'fp-e', analysisJson: JSON.stringify({ analysisLevel: 'content', scenes: [] }) },
];
const scenes = buildBatchScenes(poolRows);
assert.equal(scenes.length, 2, 'technical 与空 scenes 的内容分析都不产出场景');
assert.equal(scenes[0]!.assetKey, 'asset-content');
assert.equal(scenes[0]!.assetFingerprint, 'fp-c');
assert.equal(scenes[0]!.sceneIndex, 0);
assert.deepEqual(scenes[0]!.labels, ['开箱', '桌面']);
assert.equal(scenes[0]!.description, '开箱画面');
assert.equal(scenes[0]!.quality, 0.8);
assert.equal(scenes[1]!.quality, 1, 'quality 必须钳制到 0..1');
assert.equal(scenes[1]!.sceneIndex, 1);

// ---------- 键的稳定性与敏感性 ----------

assert.equal(batchSemanticScriptKey(sentences), batchSemanticScriptKey(buildBatchSentences('开场介绍产品。细节展示卖点！\n第三句收尾')), '相同句段必须得到相同 scriptKey');
assert.notEqual(batchSemanticScriptKey(sentences), batchSemanticScriptKey(buildBatchSentences('开场介绍产品。细节展示卖点！')), '句段变化必须换 scriptKey');
assert.notEqual(batchSemanticScriptKey(sentences), batchSemanticScriptKey(sentences.map((sentence, index) => index === 0 ? { ...sentence, keywords: ['别的'] } : sentence)), 'keywords 变化必须换 scriptKey');
assert.equal(batchSemanticPoolKey(scenes), batchSemanticPoolKey(buildBatchScenes(poolRows)), '相同场景必须得到相同 poolKey');
const changedScenes = scenes.map((scene, index) => index === 0 ? { ...scene, labels: ['别的标签'] } : scene);
assert.notEqual(batchSemanticPoolKey(scenes), batchSemanticPoolKey(changedScenes), '场景 labels 变化必须换 poolKey');
const changedFingerprint = scenes.map((scene, index) => index === 0 ? { ...scene, assetFingerprint: 'fp-other' } : scene);
assert.notEqual(batchSemanticPoolKey(scenes), batchSemanticPoolKey(changedFingerprint), '素材指纹变化必须换 poolKey');

// ---------- 打分键映射(prompt 顺序 → assetId:sceneIndex)与 fallback ----------

const scoreScenes = [
  { assetKey: 'asset-1', assetFingerprint: 'fp-1', sceneIndex: 0, startUs: 0, endUs: 1_000_000, labels: ['a'], description: 'd1', quality: 0.5 },
  { assetKey: 'asset-1', assetFingerprint: 'fp-1', sceneIndex: 1, startUs: 1_000_000, endUs: 2_000_000, labels: ['b'], description: 'd2', quality: 0.5 },
  { assetKey: 'asset-2', assetFingerprint: 'fp-2', sceneIndex: 0, startUs: 0, endUs: 1_000_000, labels: ['c'], description: 'd3', quality: 0.5 },
];
const scored = await scoreBatchSemanticMatrix({
  sentences: sentences.slice(0, 2),
  scenes: scoreScenes,
  providerId: 'prov-fake',
  model: 'model-fake',
  score: async () => ({
    score_matrix: [[0.9, 0.1, 0.5], [0.2, 0.8, 0.4]],
    hook_scores: [0.7, 0.3, 0.6],
  }),
});
assert.equal(scored.fallback, false);
if (!scored.fallback) {
  assert.equal(scored.model, 'model-fake');
  assert.deepEqual(scored.scores['segment-1'], { 'asset-1:0': 0.9, 'asset-1:1': 0.1, 'asset-2:0': 0.5 });
  assert.deepEqual(scored.scores['segment-2'], { 'asset-1:0': 0.2, 'asset-1:1': 0.8, 'asset-2:0': 0.4 });
  assert.deepEqual(scored.hooks, { 'asset-1:0': 0.7, 'asset-1:1': 0.3, 'asset-2:0': 0.6 });
}

const fallbackOutcome = await scoreBatchSemanticMatrix({
  sentences: sentences.slice(0, 2),
  scenes: scoreScenes,
  providerId: 'prov-fake',
  score: async () => ({ unexpected: true }),
  sleep: async () => undefined,
});
assert.deepEqual(fallbackOutcome, { fallback: true }, '无效矩阵必须收敛为 fallback');

// ---------- 数据库:持久化、最新读取、触发排队 ----------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-semantic-match-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);

try {
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: () => new Date('2026-08-06T00:00:00.000Z') });
  assert.equal(ready.state, 'ready');

  const scriptKey = batchSemanticScriptKey(sentences);
  const poolKey = batchSemanticPoolKey(scenes);
  assert.equal(readBatchSemanticMatrix(db, 'project-1', scriptKey, poolKey), undefined);

  const first = persistBatchSemanticMatrix(db, {
    projectId: 'project-1',
    scriptKey,
    poolKey,
    providerId: 'prov-1',
    model: 'm1',
    scores: { 'segment-1': { 'asset-content:0': 0.9 } },
    hooks: { 'asset-content:0': 0.7 },
    now: () => new Date('2026-08-06T01:00:00.000Z'),
  });
  assert.equal(first.created, true);
  const duplicate = persistBatchSemanticMatrix(db, {
    projectId: 'project-1',
    scriptKey,
    poolKey,
    providerId: 'prov-1',
    model: 'm1',
    scores: { 'segment-1': { 'asset-content:0': 0.1 } },
    hooks: {},
    now: () => new Date('2026-08-06T02:00:00.000Z'),
  });
  assert.equal(duplicate.created, false, '同内容指纹+供应商+模型必须幂等跳过');
  assert.equal(duplicate.id, first.id);
  const second = persistBatchSemanticMatrix(db, {
    projectId: 'project-1',
    scriptKey,
    poolKey,
    providerId: 'prov-2',
    model: 'm2',
    scores: { 'segment-1': { 'asset-content:0': 0.3 } },
    hooks: { 'asset-content:0': 0.2 },
    now: () => new Date('2026-08-06T03:00:00.000Z'),
  });
  assert.equal(second.created, true, '换供应商/模型必须允许新行');
  const latest = readBatchSemanticMatrix(db, 'project-1', scriptKey, poolKey);
  assert.deepEqual(latest, {
    scores: { 'segment-1': { 'asset-content:0': 0.3 } },
    hooks: { 'asset-content:0': 0.2 },
  }, '读取必须返回最新一行的矩阵');

  // 触发排队:有 content 场景 + 可解析供应商 → 幂等创建任务
  const batchId = createBatchProduction(db, 'project-1', '语义批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'script-1',
    title: '脚本',
    bodyText: '开场介绍产品。细节展示卖点！',
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
  const assetId = createAsset(db, { projectId: 'project-1', sourceKind: 'managed', locationJson: { key: 'asset-c' }, contentFingerprint: 'sha256:asset-c', mediaKind: 'video' });
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'test',
    providerId: 'test',
    model: 'test',
    analysisJson: {
      analysisLevel: 'content',
      durationUs: 4_000_000,
      scenes: [{ startUs: 0, endUs: 2_000_000, description: '画面', labels: ['产品'], qualityScore: 0.9 }],
    },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });

  const providers = [{ id: 'prov-1', model: 'm1', configured: true }, { id: 'prov-2', model: 'm2', configured: true }];
  const queued = await queueBatchSemanticScoreTasks(db, 'project-1', batchId, versionId, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T04:00:00.000Z'),
  });
  assert.equal(queued.created.length, 1);
  assert.equal(queued.skipped.length, 0);
  const taskRow = db.prepare(`SELECT workType, targetKind, targetId, requestKey FROM batch_tasks WHERE id = ?`).get(queued.created[0]) as {
    workType: string; targetKind: string; targetId: string; requestKey: string;
  };
  assert.equal(taskRow.workType, 'semantic_score');
  assert.equal(taskRow.targetKind, 'script_snapshot');
  assert.equal(taskRow.targetId, snapshotId);
  assert.ok(taskRow.requestKey.startsWith(`semantic_score:${versionId}:${snapshotId}:`));

  const again = await queueBatchSemanticScoreTasks(db, 'project-1', batchId, versionId, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T04:01:00.000Z'),
  });
  assert.equal(again.created.length, 0);
  assert.deepEqual(again.skipped, [snapshotId], '同 requestKey 重复触发必须幂等跳过');

  const switched = await queueBatchSemanticScoreTasks(db, 'project-1', batchId, versionId, {
    explicitProviderId: 'prov-2',
    listProviders: () => providers,
    now: () => new Date('2026-08-06T04:02:00.000Z'),
  });
  assert.equal(switched.created.length, 1, '换供应商必须形成新 requestKey 并创建新任务');
  assert.notEqual(switched.created[0], queued.created[0]);

  // 失败任务原地回 queued:同供应商「重新生成」必须能恢复失败(与素材准备任务同语义)
  db.prepare(`UPDATE batch_tasks SET status = 'failed' WHERE id = ?`).run(queued.created[0]);
  const resurrected = await queueBatchSemanticScoreTasks(db, 'project-1', batchId, versionId, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T04:02:30.000Z'),
  });
  assert.deepEqual(resurrected.created, [queued.created[0]], 'failed 任务必须原地回 queued');
  const resurrectedRow = db.prepare(`SELECT status, expectedState FROM batch_tasks WHERE id = ?`).get(queued.created[0]) as { status: string; expectedState: string };
  assert.equal(resurrectedRow.status, 'queued');
  assert.equal(resurrectedRow.expectedState, 'running');
  const afterResurrect = await queueBatchSemanticScoreTasks(db, 'project-1', batchId, versionId, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T04:02:40.000Z'),
  });
  assert.deepEqual(afterResurrect.created, [], '回 queued 后重复触发必须幂等跳过');

  const noProvider = await queueBatchSemanticScoreTasks(db, 'project-1', batchId, versionId, {
    listProviders: () => [],
    now: () => new Date('2026-08-06T04:03:00.000Z'),
  });
  // 该批次无内容分析请求,listProviders 为空 → 解析不到供应商,但前两步已建过任务的
  // requestKey 含供应商摘要,此处供应商解析失败必须整体静默跳过。
  assert.deepEqual(noProvider, { created: [], skipped: [] }, '解析不到供应商必须静默跳过');

  // 供应商解析顺序:显式 > 内容分析请求 > 第一个 configured
  assert.deepEqual(
    await resolveBatchSemanticProvider(db, { batchVersionId: versionId, explicitProviderId: 'prov-x', listProviders: () => providers }),
    { providerId: 'prov-x', model: '' },
  );
  assert.deepEqual(
    await resolveBatchSemanticProvider(db, { batchVersionId: versionId, listProviders: () => providers }),
    { providerId: 'prov-1', model: 'm1' },
  );
  assert.equal(await resolveBatchSemanticProvider(db, { batchVersionId: versionId, listProviders: () => [{ id: 'p', model: 'm', configured: false }] }), undefined);

  // 开跑前语义匹配保证:独立批次夹具,排队→pending 计数→幂等→终态归零
  const batchId2 = createBatchProduction(db, 'project-1', '开跑保证批次');
  const versionId2 = createBatchProductionVersion(db, batchId2, { copyCount: 1 });
  const snapshotId2 = snapshotScriptIntoBatch(db, versionId2, { scriptId, copyCount: 1 });
  addAssetToPool(db, versionId2, { assetId, analysisId });
  assert.equal(countIncompleteBatchSemanticScoreTasks(db, versionId2), 0);
  const prep1 = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId2, versionId2, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T05:00:00.000Z'),
  });
  assert.equal(prep1.pending, 1, '排队成功后必须有 1 个未完成打分');
  const prep2 = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId2, versionId2, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T05:01:00.000Z'),
  });
  assert.equal(prep2.pending, 1, '重复开跑准备必须幂等(不重复建任务)');
  const scoreTaskCount = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_tasks t
    JOIN batch_script_snapshots s ON s.id = t.targetId
    WHERE t.workType = 'semantic_score' AND s.batchVersionId = ?
  `).get(versionId2) as { n: number };
  assert.equal(scoreTaskCount.n, 1);
  db.prepare(`
    UPDATE batch_tasks SET status = 'succeeded'
    WHERE workType = 'semantic_score' AND targetId = ?
  `).run(snapshotId2);
  const prep3 = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId2, versionId2, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T05:02:00.000Z'),
  });
  assert.equal(prep3.pending, 0, '打分终态后不得再阻塞开跑');

  // 开跑门禁的失败复活有自动上限(2026-08-23):门禁会被前端自动续跑反复触发,
  // 无条件复活 + 供应商持续失败 = 无限重试循环(每 2-4 秒白打一次供应商 API)。
  const batchId3 = createBatchProduction(db, 'project-1', '门禁上限批次');
  const versionId3 = createBatchProductionVersion(db, batchId3, { copyCount: 1 });
  const snapshotId3 = snapshotScriptIntoBatch(db, versionId3, { scriptId, copyCount: 1 });
  addAssetToPool(db, versionId3, { assetId, analysisId });
  const prepA = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId3, versionId3, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T06:00:00.000Z'),
  });
  assert.equal(prepA.pending, 1);
  const gateTaskId = (db.prepare(`
    SELECT t.id FROM batch_tasks t JOIN batch_script_snapshots s ON s.id = t.targetId
    WHERE t.workType = 'semantic_score' AND s.batchVersionId = ?
  `).get(versionId3) as { id: string }).id;
  // 尝试次数低于上限:失败后门禁复活
  db.prepare(`UPDATE batch_tasks SET status = 'failed' WHERE id = ?`).run(gateTaskId);
  db.prepare(`
    INSERT INTO batch_task_attempts (id, taskId, attemptNumber, status, startedAt, createdAt)
    VALUES ('att-1', ?, 1, 'failed', '2026-08-06T06:01:00.000Z', '2026-08-06T06:01:00.000Z')
  `).run(gateTaskId);
  const prepB = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId3, versionId3, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T06:02:00.000Z'),
  });
  assert.equal(prepB.pending, 1, '尝试次数低于上限时门禁必须复活失败任务');
  // 尝试次数达到上限:门禁不再复活,pending 归零,开跑走关键词兜底
  db.prepare(`UPDATE batch_tasks SET status = 'failed' WHERE id = ?`).run(gateTaskId);
  for (let n = 2; n <= SEMANTIC_SCORE_MAX_AUTO_ATTEMPTS; n++) {
    db.prepare(`
      INSERT INTO batch_task_attempts (id, taskId, attemptNumber, status, startedAt, createdAt)
      VALUES (?, ?, ?, 'failed', '2026-08-06T06:03:00.000Z', '2026-08-06T06:03:00.000Z')
    `).run(`att-${n}`, gateTaskId, n);
  }
  const prepC = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId3, versionId3, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T06:04:00.000Z'),
  });
  assert.equal(prepC.pending, 0, '达到自动尝试上限后不得再复活,开跑走关键词兜底');
  assert.equal(
    (db.prepare(`SELECT status FROM batch_tasks WHERE id = ?`).get(gateTaskId) as { status: string }).status,
    'failed',
    '达到上限后任务保持 failed 终态',
  );
  // 手动「重新生成语义匹配」不受自动上限约束
  const manualRevive = await queueBatchSemanticScoreTasks(db, 'project-1', batchId3, versionId3, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T06:05:00.000Z'),
  });
  assert.deepEqual(manualRevive.created, [gateTaskId], '手动重新生成必须无条件复活失败任务');
  // 已取消任务(停止批次后再开跑同一版本)必须经 createBatchTask 释放 requestKey 重建,
  // 不能被幂等跳过吞掉
  db.prepare(`UPDATE batch_tasks SET status = 'cancelled', expectedState = 'stopped' WHERE id = ?`).run(gateTaskId);
  const prepD = await prepareBatchSemanticScoreBeforeStart(db, 'project-1', batchId3, versionId3, {
    listProviders: () => providers,
    now: () => new Date('2026-08-06T06:06:00.000Z'),
  });
  assert.equal(prepD.pending, 1, '已取消任务必须被重建为新的可领取任务');
  const recreated = db.prepare(`
    SELECT t.id, t.status FROM batch_tasks t JOIN batch_script_snapshots s ON s.id = t.targetId
    WHERE t.workType = 'semantic_score' AND s.batchVersionId = ? AND t.status IN ('queued', 'running')
  `).get(versionId3) as { id: string; status: string };
  assert.notEqual(recreated.id, gateTaskId, '重建必须是新任务而不是复活已取消任务');
  assert.equal(recreated.status, 'queued');

  console.log('batch semantic match tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
