import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { registerCanvasCapability, clearCanvasCapabilities, type CanvasModelCapability } from '../lib/creative-canvas/capabilities.ts';
import { createCanvas, publishCanvasNodeResult, saveCanvasGraph, setCanvasNodeActiveTask } from '../lib/creative-canvas/repository.ts';
import { importCanvasAsset, canvasStorageRoot } from '../lib/creative-canvas/assets.ts';
import { planCanvasRun, reachableGenerationNodes } from '../lib/creative-canvas/planner.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { copyCanvasNodes } from '../lib/creative-canvas/copy.ts';
import { findActiveTaskForCanvasNode, listCanvasTasks } from '../lib/creative-canvas/tasks.ts';
import type { CanvasGraph, CanvasGraphNode } from '../lib/creative-canvas/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-planner-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';

const storageRoot = canvasStorageRoot(root);
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const migrated = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migrated.state, 'ready');

clearCanvasCapabilities();
const IMAGE_CAP: CanvasModelCapability = {
  key: 'fixture-image-edit',
  displayName: '测试图片模型',
  providerKind: 'external',
  providerIdentity: 'fixture-provider',
  modelAlias: 'fixture/image-edit',
  mediaKind: 'image',
  modes: ['image-to-image', 'text-to-image'],
  inputs: [
    { kind: 'image', roles: ['subject', 'reference', 'style'], min: 0, max: 3 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [{ key: 'ratio', label: '比例', type: 'enum', options: ['1:1', '3:4'], default: '1:1' }],
  cancellation: false,
  evidence: 'candidate',
  evidenceNote: '本地 fixture 能力，只用于测试。',
};
const VIDEO_CAP: CanvasModelCapability = {
  key: 'fixture-video',
  displayName: '测试视频模型',
  providerKind: 'external',
  providerIdentity: 'fixture-provider',
  modelAlias: 'fixture/video',
  mediaKind: 'video',
  modes: ['image-to-video', 'text-to-video'],
  inputs: [
    { kind: 'image', roles: ['first-frame', 'last-frame', 'reference', 'subject'], min: 0, max: 2 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [{ key: 'durationSec', label: '时长', type: 'integer', min: 3, max: 15, default: 5 }],
  cancellation: false,
  evidence: 'candidate',
  evidenceNote: '本地 fixture 能力，只用于测试。',
};
registerCanvasCapability(IMAGE_CAP);
registerCanvasCapability(VIDEO_CAP);

const canvas = createCanvas(db, { name: '沙发场景探索' });

function material(id: string, kind: 'image' | 'video' | 'audio', assetId: string | null): CanvasGraphNode {
  return { id, kind: 'material', position: { x: 0, y: 0 }, data: { title: id, assetId, mediaKind: kind } };
}

function promptNode(id: string, text: string): CanvasGraphNode {
  return { id, kind: 'prompt', position: { x: 0, y: 120 }, data: { title: id, text } };
}

function imageNode(id: string, modelKey: string | null, prompt = ''): CanvasGraphNode {
  return {
    id,
    kind: 'image-generation',
    position: { x: 300, y: 0 },
    data: {
      title: id,
      modelKey,
      generationMode: 'image-to-image',
      prompt,
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

function videoNode(id: string, modelKey: string | null, prompt = ''): CanvasGraphNode {
  return {
    id,
    kind: 'video-generation',
    position: { x: 600, y: 0 },
    data: {
      title: id,
      modelKey,
      generationMode: 'image-to-video',
      prompt,
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

/** 素材按画布归属：跨画布引用必须被拒绝，所以每个画布用自己的素材。 */
async function makeAsset(canvasId: string, name: string): Promise<string> {
  const data = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#808080' } }).png().toBuffer();
  const asset = await importCanvasAsset({
    db,
    canvasId,
    storageRoot,
    filename: name,
    mimeType: 'image/png',
    data,
  });
  return asset.id;
}

const assetA = await makeAsset(canvas.id, '沙发A.png');
const assetB = await makeAsset(canvas.id, '沙发B.png');

function save(graph: Partial<CanvasGraph>, expectedRevision: number) {
  return saveCanvasGraph({
    db,
    canvasId: canvas.id,
    expectedGraphRevision: expectedRevision,
    graph: {
      schemaVersion: 1,
      nodes: graph.nodes ?? [],
      edges: graph.edges ?? [],
    },
  });
}

/** 用真实发布路径给节点放一个当前结果（插入一条已成功任务 + 绑定活跃任务 + 发布）。 */
function publishResult(nodeId: string, assetId: string): void {
  const state = db.prepare(
    `SELECT nodeEpoch FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`,
  ).get(canvas.id, nodeId) as { nodeEpoch: number };
  const taskId = randomUUID();
  const at = new Date().toISOString();
  db.prepare(`
    INSERT INTO creative_canvas_tasks
      (id, runId, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot,
       submissionState, slotHeld, fence, pollCount, outputAssetId, createdAt, updatedAt)
    VALUES (?, NULL, ?, ?, ?, 'image', 'succeeded', '{}', '{}', 'terminal', 0, 1, 0, ?, ?, ?)
  `).run(taskId, canvas.id, nodeId, state.nodeEpoch, assetId, at, at);
  setCanvasNodeActiveTask(db, { canvasId: canvas.id, nodeId, taskId });
  const published = publishCanvasNodeResult({
    db,
    canvasId: canvas.id,
    nodeId,
    taskId,
    nodeEpoch: state.nodeEpoch,
    assetId,
  });
  assert.deepEqual(published, { published: true });
}

// --- 单点运行 ---------------------------------------------------------------

let revision = 0;
{
  const saved = save({
    nodes: [
      material('m1', 'image', assetA),
      promptNode('p1', '暖色调'),
      imageNode('img1', IMAGE_CAP.key, '把 @参考1 放到客厅，@参考2'),
      material('m2', 'image', null),
      imageNode('img2', IMAGE_CAP.key, '改光'),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'img1' },
      { id: 'e2', source: 'p1', target: 'img1' },
      { id: 'e3', source: 'm2', target: 'img2' },
    ],
  }, revision);
  revision = saved.graphRevision;

  const outcome = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img1',
    requestKey: 'req-1',
  });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  const plan = outcome.plan;
  assert.equal(plan.tasks.length, 1);
  assert.deepEqual(plan.reused, []);
  const task = plan.tasks[0];
  assert.equal(task.nodeId, 'img1');
  assert.equal(task.nodeEpoch, 1);
  assert.equal(task.capabilityKey, IMAGE_CAP.key);
  assert.equal(task.providerIdentity, 'fixture-provider');
  assert.equal(task.modelAlias, 'fixture/image-edit');
  // 输入顺序固定，素材固定 assetId，文本固定正文
  assert.deepEqual(task.inputs.map((input) => input.kind), ['asset', 'text']);
  assert.equal(task.inputs[0].assetId, assetA);
  assert.equal(task.inputs[0].orderIndex, 0);
  assert.equal(task.inputs[0].role, 'subject');
  assert.equal(task.inputs[1].textContent, '暖色调');
  // 冻结的提示词包含节点自己的文本与连接文本
  assert.equal(task.prompt, '把 @参考1 放到客厅，@参考2\n\n暖色调');
  assert.equal(task.inputs[0].upstreamNodeId, null);

  // 指纹稳定
  const again = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img1',
    requestKey: 'req-1-other',
  });
  assert.ok(again.ok);
  assert.equal(again.plan.fingerprint, plan.fingerprint);

  // 素材缺失 → 拒绝，且不产生任务
  const missingAsset = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img2',
    requestKey: 'req-2',
  });
  assert.equal(missingAsset.ok, false);
  assert.ok(!missingAsset.ok);
  assert.equal(missingAsset.problems[0].code, 'input_asset_missing');

  // 未选模型 → 能力未开放
  const noModelSave = save({
    nodes: [
      material('m1', 'image', assetA),
      imageNode('img1', IMAGE_CAP.key, '把 @参考1 放到客厅'),
      imageNode('img3', null, '随便'),
      material('m3', 'image', assetA),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'img1' },
      { id: 'e4', source: 'm3', target: 'img3' },
    ],
  }, revision);
  revision = noModelSave.graphRevision;
  const noModel = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img3',
    requestKey: 'req-3',
  });
  assert.equal(noModel.ok, false);
  assert.ok(!noModel.ok);
  assert.equal(noModel.problems[0].code, 'model_not_selected');

  const unknownModelSave = save({
    nodes: [
      material('m1', 'image', assetA),
      imageNode('img1', IMAGE_CAP.key, '把 @参考1 放到客厅'),
      imageNode('img3', 'ghost-model', '随便'),
      material('m3', 'image', assetA),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'img1' },
      { id: 'e4', source: 'm3', target: 'img3' },
    ],
  }, revision);
  revision = unknownModelSave.graphRevision;
  const unknownModel = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img3',
    requestKey: 'req-4',
  });
  assert.equal(unknownModel.ok, false);
  assert.ok(!unknownModel.ok);
  assert.equal(unknownModel.problems[0].code, 'capability_unknown');
}

// --- 失效引用与未知提及 -------------------------------------------------------

{
  // img1 依赖 m1；断开后提示词仍然提到 @参考1 → 阻止提交
  const saved = save({
    nodes: [
      material('m1', 'image', assetA),
      imageNode('img1', IMAGE_CAP.key, '把 @参考1 放到客厅'),
      material('m2', 'image', assetB),
      imageNode('img2', IMAGE_CAP.key, '改光'),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'img1' },
      { id: 'e2', source: 'm2', target: 'img2' },
    ],
  }, revision);
  revision = saved.graphRevision;

  const detached = save({
    nodes: saved.graph.nodes,
    edges: [{ id: 'e2', source: 'm2', target: 'img2' }],
  }, revision);
  revision = detached.graphRevision;

  const outcome = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img1',
    requestKey: 'req-detached',
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.problems[0].code, 'detached_reference_mentioned');

  // 不提及断开参考时可以正常计划（失效引用不参与提交）
  const withoutMention = save({
    nodes: detached.graph.nodes.map((node) => (
      node.id === 'img1' && node.kind === 'image-generation'
        ? { ...node, data: { ...node.data, prompt: '把画面调亮' } }
        : node
    )),
    edges: detached.graph.edges,
  }, revision);
  revision = withoutMention.graphRevision;
  const ok = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img1',
    requestKey: 'req-detached-ok',
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.ok);
  assert.equal(ok.plan.tasks[0].inputs.length, 0);

  // 提示词提到不存在的编号
  const badMention = save({
    nodes: withoutMention.graph.nodes.map((node) => (
      node.id === 'img1' && node.kind === 'image-generation'
        ? { ...node, data: { ...node.data, prompt: '参考 @参考9' } }
        : node
    )),
    edges: withoutMention.graph.edges,
  }, revision);
  revision = badMention.graphRevision;
  const unknownMention = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'img1',
    requestKey: 'req-mention-unknown',
  });
  assert.equal(unknownMention.ok, false);
  assert.ok(!unknownMention.ok);
  assert.equal(unknownMention.problems[0].code, 'mention_unresolved');
}

// --- 上游当前结果 / 等待绑定任务 / 都没有 --------------------------------------

{
  const saved = save({
    nodes: [
      material('m1', 'image', assetA),
      imageNode('up', IMAGE_CAP.key, '上游'),
      material('m2', 'image', assetB),
      videoNode('down', VIDEO_CAP.key, '下游'),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'up' },
      { id: 'e2', source: 'up', target: 'down' },
      { id: 'e3', source: 'm2', target: 'down' },
    ],
  }, revision);
  revision = saved.graphRevision;

  // 上游没有结果也没有任务 → 拒绝（A07）
  const blocked = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'down',
    requestKey: 'req-up-empty',
  });
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok);
  assert.equal(blocked.problems[0].code, 'upstream_without_result_or_task');

  // 上游有当前结果 → 固定 assetId（A05：即使上游正在重做也用当时可见的结果）
  publishResult('up', assetA);
  const withResult = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'down',
    requestKey: 'req-up-result',
  });
  assert.equal(withResult.ok, true);
  assert.ok(withResult.ok);
  const upInput = withResult.plan.tasks[0].inputs.find((input) => input.sourceNodeId === 'up');
  assert.equal(upInput?.assetId, assetA);
  assert.equal(upInput?.upstreamNodeId, null);
  assert.equal(upInput?.kind, 'result');

  // 上游「有旧结果 + 正在重做」：仍然使用点击时可见的旧结果，不改为等待新图（A05）
  startCanvasRun({
    db,
    request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'up', requestKey: 'req-up-redo' },
  });
  assert.equal(findActiveTaskForCanvasNode(db, canvas.id, 'up')?.phase, 'queued');
  const whileRedoing = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'down',
    requestKey: 'req-up-redoing',
  });
  assert.equal(whileRedoing.ok, true);
  assert.ok(whileRedoing.ok);
  const redoingInput = whileRedoing.plan.tasks[0].inputs.find((input) => input.sourceNodeId === 'up');
  assert.equal(redoingInput?.assetId, assetA);
  assert.equal(redoingInput?.upstreamNodeId, null);

  // 上游没有结果但有已启动任务 → 绑定该次任务（A06）
  const saved2 = save({
    nodes: [
      ...saved.graph.nodes.map((node) => (
        node.id === 'up' && node.kind === 'image-generation'
          ? { ...node, data: { ...node.data, title: '上游' } }
          : node
      )),
      imageNode('up2', IMAGE_CAP.key, '第二次'),
      material('m4', 'image', assetA),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'up' },
      { id: 'e2', source: 'up', target: 'down' },
      { id: 'e3', source: 'm2', target: 'down' },
      { id: 'e5', source: 'm4', target: 'up2' },
    ],
  }, revision);
  revision = saved2.graphRevision;

  const freshNode = save({
    nodes: [
      ...saved2.graph.nodes,
      imageNode('up3', IMAGE_CAP.key, '第三次'),
      material('m5', 'image', assetA),
    ],
    edges: [...saved2.graph.edges, { id: 'e6', source: 'm5', target: 'up3' }],
  }, revision);
  revision = freshNode.graphRevision;

  const started = startCanvasRun({
    db,
    request: {
      canvasId: canvas.id,
      mode: 'single',
      targetNodeId: 'up3',
      requestKey: 'req-up3',
    },
  });
  assert.equal(started.tasks.length, 1);
  assert.equal(started.tasks[0].phase, 'queued');

  // 让 down 的另一个上游 up2 变成「无结果、有活跃任务」：直接创建一个等待中的任务
  const waiting = startCanvasRun({
    db,
    request: {
      canvasId: canvas.id,
      mode: 'branch',
      startNodeId: 'up2',
      reuseStart: false,
      requestKey: 'req-branch-up2',
    },
  });
  const up2TaskId = waiting.tasks.find((task) => task.nodeId === 'up2')?.id;
  assert.ok(up2TaskId);

  const boundPlan = planCanvasRun(db, {
    canvasId: canvas.id,
    mode: 'single',
    targetNodeId: 'down',
    requestKey: 'req-bound',
  });
  assert.equal(boundPlan.ok, true);
  assert.ok(boundPlan.ok);
  // up 有结果 → 固定 asset；up2 有活跃任务 → 绑定任务
  const up2Input = boundPlan.plan.tasks[0].inputs.find((input) => input.sourceNodeId === 'up2');
  if (up2Input) {
    assert.equal(up2Input.upstreamNodeId, 'up2');
    assert.equal(up2Input.assetId, null);
  }
}

// --- 分支运行 ---------------------------------------------------------------

{
  clearCanvasCapabilities();
  registerCanvasCapability(IMAGE_CAP);
  registerCanvasCapability(VIDEO_CAP);

  const created = createCanvas(db, { name: '分支画布' });
  const branchCanvas = created.id;
  const branchAssetA = await makeAsset(branchCanvas, '分支A.png');
  const branchAssetB = await makeAsset(branchCanvas, '分支B.png');
  const graph: CanvasGraph = {
    schemaVersion: 1,
    nodes: [
      material('m1', 'image', branchAssetA),
      imageNode('start', IMAGE_CAP.key, '起点'),
      imageNode('mid', IMAGE_CAP.key, '中段'),
      videoNode('leaf', VIDEO_CAP.key, '末段'),
      material('out', 'image', branchAssetB),
      imageNode('outside', IMAGE_CAP.key, '范围外'),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'start' },
      { id: 'e2', source: 'start', target: 'mid' },
      { id: 'e3', source: 'mid', target: 'leaf' },
      { id: 'e4', source: 'out', target: 'leaf' },
      { id: 'e5', source: 'm1', target: 'outside' },
    ],
  };
  const saved = saveCanvasGraph({
    db,
    canvasId: branchCanvas,
    expectedGraphRevision: 0,
    graph,
  });

  // 可达集合与拓扑序
  const reachable = reachableGenerationNodes(saved.graph, 'start').map((node) => node.id);
  assert.deepEqual(reachable, ['start', 'mid', 'leaf']);

  // 起点无结果 → 起点参与执行，范围内依赖绑定本次任务
  const fresh = planCanvasRun(db, {
    canvasId: branchCanvas,
    mode: 'branch',
    startNodeId: 'start',
    requestKey: 'branch-fresh',
  });
  assert.equal(fresh.ok, true);
  assert.ok(fresh.ok);
  assert.deepEqual(fresh.plan.tasks.map((task) => task.nodeId), ['start', 'mid', 'leaf']);
  assert.deepEqual(fresh.plan.reused, []);
  const midTask = fresh.plan.tasks.find((task) => task.nodeId === 'mid');
  assert.equal(midTask?.inputs.find((input) => input.sourceNodeId === 'start')?.upstreamNodeId, 'start');
  const leafTask = fresh.plan.tasks.find((task) => task.nodeId === 'leaf');
  // 范围内依赖绑定本次上游，范围外输入固定已有素材
  assert.equal(leafTask?.inputs.find((input) => input.sourceNodeId === 'mid')?.upstreamNodeId, 'mid');
  assert.equal(leafTask?.inputs.find((input) => input.sourceNodeId === 'out')?.assetId, branchAssetB);

  // 起点已有结果 → 默认复用，不重新生成起点
  publishResultFor(branchCanvas, 'start', branchAssetA);
  const reused = planCanvasRun(db, {
    canvasId: branchCanvas,
    mode: 'branch',
    startNodeId: 'start',
    requestKey: 'branch-reuse',
  });
  assert.equal(reused.ok, true);
  assert.ok(reused.ok);
  assert.deepEqual(reused.plan.tasks.map((task) => task.nodeId), ['mid', 'leaf']);
  assert.deepEqual(reused.plan.reused, [{ nodeId: 'start', assetId: branchAssetA }]);
  const midAfterReuse = reused.plan.tasks.find((task) => task.nodeId === 'mid');
  assert.equal(midAfterReuse?.inputs.find((input) => input.sourceNodeId === 'start')?.assetId, branchAssetA);

  // 显式选择重新生成起点 → 起点回到任务列表，并绑定本次上游
  const regenerate = planCanvasRun(db, {
    canvasId: branchCanvas,
    mode: 'branch',
    startNodeId: 'start',
    reuseStart: false,
    requestKey: 'branch-regenerate',
  });
  assert.equal(regenerate.ok, true);
  assert.ok(regenerate.ok);
  assert.deepEqual(regenerate.plan.tasks.map((task) => task.nodeId), ['start', 'mid', 'leaf']);

  // 范围外缺结果 → 不扩充计划，直接拒绝
  const outsideMissing = planCanvasRun(db, {
    canvasId: branchCanvas,
    mode: 'branch',
    startNodeId: 'outside',
    requestKey: 'branch-outside',
  });
  assert.equal(outsideMissing.ok, true);
  assert.ok(outsideMissing.ok);
  assert.deepEqual(outsideMissing.plan.tasks.map((task) => task.nodeId), ['outside']);

  // 计划指纹随图变化而改变
  const before = planCanvasRun(db, {
    canvasId: branchCanvas,
    mode: 'branch',
    startNodeId: 'start',
    requestKey: 'branch-fingerprint',
  });
  assert.ok(before.ok);
  saveCanvasGraph({
    db,
    canvasId: branchCanvas,
    expectedGraphRevision: saved.graphRevision,
    graph: {
      ...saved.graph,
      nodes: saved.graph.nodes.map((node) => (
        node.id === 'leaf' && node.kind === 'image-generation'
          ? { ...node, data: { ...node.data, prompt: '换一个提示词' } }
          : node
      )),
    },
  });
  const after = planCanvasRun(db, {
    canvasId: branchCanvas,
    mode: 'branch',
    startNodeId: 'start',
    requestKey: 'branch-fingerprint',
  });
  assert.ok(after.ok);
  assert.notEqual(after.plan.fingerprint, before.plan.fingerprint);
}

function publishResultFor(canvasId: string, nodeId: string, assetId: string): void {
  const state = db.prepare(
    `SELECT nodeEpoch FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`,
  ).get(canvasId, nodeId) as { nodeEpoch: number };
  const taskId = randomUUID();
  const at = new Date().toISOString();
  db.prepare(`
    INSERT INTO creative_canvas_tasks
      (id, runId, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot,
       submissionState, slotHeld, fence, pollCount, outputAssetId, createdAt, updatedAt)
    VALUES (?, NULL, ?, ?, ?, 'image', 'succeeded', '{}', '{}', 'terminal', 0, 1, 0, ?, ?, ?)
  `).run(taskId, canvasId, nodeId, state.nodeEpoch, assetId, at, at);
  setCanvasNodeActiveTask(db, { canvasId, nodeId, taskId });
  const published = publishCanvasNodeResult({
    db,
    canvasId,
    nodeId,
    taskId,
    nodeEpoch: state.nodeEpoch,
    assetId,
  });
  assert.deepEqual(published, { published: true });
}

// --- 幂等创建：重放、不同内容冲突、抢节点 ---------------------------------------

{
  const created = createCanvas(db, { name: '幂等画布' });
  const idempotentCanvas = created.id;
  const idempotentAsset = await makeAsset(idempotentCanvas, '幂等.png');
  const saved = saveCanvasGraph({
    db,
    canvasId: idempotentCanvas,
    expectedGraphRevision: 0,
    graph: {
      schemaVersion: 1,
      nodes: [
        material('m1', 'image', idempotentAsset),
        imageNode('g1', IMAGE_CAP.key, '第一版'),
        material('m2', 'image', idempotentAsset),
        imageNode('g2', IMAGE_CAP.key, '另一条'),
      ],
      edges: [
        { id: 'e1', source: 'm1', target: 'g1' },
        { id: 'e2', source: 'm2', target: 'g2' },
      ],
    },
  });

  const request = {
    canvasId: idempotentCanvas,
    mode: 'single' as const,
    targetNodeId: 'g1',
    requestKey: 'same-key',
  };
  const first = startCanvasRun({ db, request });
  assert.equal(first.idempotentReplay, false);
  assert.equal(first.tasks.length, 1);

  // 图后来改了、任务也已经开始了，同一 requestKey 仍然返回原结果
  saveCanvasGraph({
    db,
    canvasId: idempotentCanvas,
    expectedGraphRevision: saved.graphRevision,
    graph: {
      ...saved.graph,
      nodes: saved.graph.nodes.map((node) => (
        node.id === 'g1' && node.kind === 'image-generation'
          ? { ...node, data: { ...node.data, prompt: '第二版' } }
          : node
      )),
    },
  });
  const replay = startCanvasRun({ db, request });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.run.id, first.run.id);
  assert.deepEqual(replay.tasks.map((task) => task.id), first.tasks.map((task) => task.id));
  assert.equal(listCanvasTasks(db, { canvasId: idempotentCanvas }).length, 1);

  // 同 key 不同内容 → 冲突
  assert.throws(
    () => startCanvasRun({
      db,
      request,
      planFingerprint: 'not-the-same-fingerprint',
    }),
    (error: unknown) => (error as { code?: string }).code === 'conflict',
  );

  // 不同 key 抢同一节点 → 冲突，不产生第二个任务
  assert.throws(
    () => startCanvasRun({
      db,
      request: { ...request, requestKey: 'other-key' },
    }),
    (error: unknown) => (error as { code?: string }).code === 'conflict',
  );
  assert.equal(listCanvasTasks(db, { canvasId: idempotentCanvas }).length, 1);

  // 预览指纹过期（图在预览与确认之间变了）→ 冲突，并带回可重新确认的新计划
  const staleRequest = {
    canvasId: idempotentCanvas,
    mode: 'single' as const,
    targetNodeId: 'g2',
    requestKey: 'stale-fingerprint',
  };
  const preview = planCanvasRun(db, staleRequest);
  assert.equal(preview.ok, true);
  assert.ok(preview.ok);
  assert.throws(
    () => startCanvasRun({ db, request: staleRequest, planFingerprint: 'stale-fingerprint-that-changed' }),
    (error: unknown) => (error as { code?: string }).code === 'conflict'
      && Boolean((error as { details?: { plan?: unknown } }).details?.plan),
  );
  // 用预览拿到的指纹提交则成功
  const confirmed = startCanvasRun({ db, request: staleRequest, planFingerprint: preview.plan.fingerprint });
  assert.equal(confirmed.idempotentReplay, false);
  assert.equal(confirmed.tasks.length, 1);
}

// --- 复制不产生新任务 ---------------------------------------------------------

{
  const created = createCanvas(db, { name: '复制画布' });
  const copyCanvasId = created.id;
  const copyAsset = await makeAsset(copyCanvasId, '复制.png');
  const saved = saveCanvasGraph({
    db,
    canvasId: copyCanvasId,
    expectedGraphRevision: 0,
    graph: {
      schemaVersion: 1,
      nodes: [
        material('m1', 'image', copyAsset),
        imageNode('g1', IMAGE_CAP.key, '原节点'),
        videoNode('v1', VIDEO_CAP.key, '下游'),
      ],
      edges: [
        { id: 'e1', source: 'm1', target: 'g1' },
        { id: 'e2', source: 'g1', target: 'v1' },
      ],
    },
  });
  publishResultFor(copyCanvasId, 'g1', copyAsset);
  const tasksBefore = listCanvasTasks(db, { canvasId: copyCanvasId }).length;

  const g1 = saved.graph.nodes.find((node) => node.id === 'g1');
  assert.ok(g1 && g1.kind === 'image-generation');
  const result = copyCanvasNodes(db, {
    canvasId: copyCanvasId,
    request: {
      sourceCanvasId: copyCanvasId,
      snapshotKey: 'copy-1',
      nodes: [g1],
      edges: [],
      resultAssetIds: { g1: copyAsset },
    },
  });
  // 复制不新增任务、不新增提交
  assert.equal(listCanvasTasks(db, { canvasId: copyCanvasId }).length, tasksBefore);
  const newNodeId = result.nodeIdMap.g1;
  const copiedState = db.prepare(
    `SELECT currentAssetId, activeTaskId FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`,
  ).get(copyCanvasId, newNodeId) as { currentAssetId: string; activeTaskId: string | null };
  assert.equal(copiedState.currentAssetId, copyAsset);
  assert.equal(copiedState.activeTaskId, null);
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-planner.test.ts 通过');
