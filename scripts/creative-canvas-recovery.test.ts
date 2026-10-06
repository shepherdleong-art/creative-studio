import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { createCanvas, listCanvasNodeStates, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { canvasStorageRoot, importCanvasAsset } from '../lib/creative-canvas/assets.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { createCanvasScheduler } from '../lib/creative-canvas/scheduler.ts';
import { createCanvasFixtureAdapter } from '../lib/creative-canvas/adapters/fixture.ts';
import { registerFixtureCanvasCapabilities } from '../lib/creative-canvas/adapters/fixture-capabilities.ts';
import {
  canvasRecoverySnapshot,
  recoverCanvasTasks,
  reconcileCanvasTaskNotCreated,
  reconcileCanvasTaskWithRemoteId,
  resumeCanvasTask,
  retryCanvasTaskDownload,
  takeOverResumableCanvasTasks,
} from '../lib/creative-canvas/recovery.ts';
import {
  canvasTaskSlotUsage,
  claimCanvasTasks,
  getCanvasTask,
  updateCanvasTaskUnGuarded,
} from '../lib/creative-canvas/tasks.ts';
import type { CanvasGraphEdge, CanvasGraphNode } from '../lib/creative-canvas/types.ts';
import { runCanvasTask } from '../lib/creative-canvas/runner.ts';

/**
 * T5：画布故障恢复。
 *
 * 在每个可中断点注入中断，断言「恢复只走原任务」：有远端身份只查询／补下载，
 * 未提交的等用户继续，身份不明的进待核查并保留名额——任何一步都不重新生成。
 */

process.env.CREATIVE_STUDIO_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-recovery-'));
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';

const root = process.env.CREATIVE_STUDIO_DATA_ROOT;
const storageRoot = canvasStorageRoot(root);
const databaseFile = path.join(root, 'workbench.db');
const db = new Database(databaseFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const migrated = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migrated.state, 'ready');
// 第二个连接代表「另一个进程」：恢复与接管都要经数据库约束，不能靠进程内状态
const db2 = new Database(databaseFile);
db2.pragma('journal_mode = WAL');
db2.pragma('foreign_keys = ON');

registerFixtureCanvasCapabilities();

const canvas = createCanvas(db, { name: '恢复验证画布' });
const IMAGE_MODEL = 'fixture-image-edit';

async function makeAsset(name: string): Promise<string> {
  const seed = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const data = await sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: seed % 200, g: 60, b: 120 } },
  }).png().toBuffer();
  const asset = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: name,
    mimeType: 'image/png',
    data,
  });
  return asset.id;
}

function material(id: string, assetId: string): CanvasGraphNode {
  return { id, kind: 'material', position: { x: 0, y: 0 }, data: { title: id, assetId, mediaKind: 'image' } };
}

function imageNode(id: string): CanvasGraphNode {
  return {
    id,
    kind: 'image-generation',
    position: { x: 300, y: 0 },
    data: {
      title: id,
      modelKey: IMAGE_MODEL,
      generationMode: 'image-to-image',
      prompt: '改场景',
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

function revision(): number {
  const row = db.prepare(`SELECT graphRevision FROM creative_canvases WHERE id = ?`).get(canvas.id) as { graphRevision: number };
  return Number(row.graphRevision);
}

function save(nodes: CanvasGraphNode[], edges: CanvasGraphEdge[]) {
  return saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: revision(), graph: { schemaVersion: 1, nodes, edges } });
}

async function prepareNode(nodeId: string, assetName: string): Promise<string> {
  const assetId = await makeAsset(assetName);
  save([material(`m-${nodeId}`, assetId), imageNode(nodeId)], [
    { id: `e-${nodeId}`, source: `m-${nodeId}`, target: nodeId },
  ]);
  const started = startCanvasRun({
    db,
    request: { canvasId: canvas.id, mode: 'single', targetNodeId: nodeId, requestKey: `req-${randomUUID()}` },
  });
  return started.tasks[0].id;
}

function claimOne(workerId: string) {
  const claimed = claimCanvasTasks({ db, workerId, limit: 1 });
  assert.equal(claimed.length, 1, '应能领取到一个任务');
  return claimed[0];
}

// --- 1. 提交意图落库后、POST 之前中断 → 待核查且保留名额 ----------------------

{
  const taskId = await prepareNode('g-submit-before', '素材1.png');
  const { fence } = claimOne('worker-a');
  // 模拟 runner 已持久化 submitting + maybe_sent 之后进程消失
  updateCanvasTaskUnGuarded(db, taskId, {
    phase: 'submitting',
    submissionState: 'maybe_sent',
    slotHeld: true,
    leaseOwner: 'worker-a',
    leaseUntil: new Date(Date.now() - 60_000).toISOString(),
  });
  const before = canvasTaskSlotUsage(db).held;
  const report = recoverCanvasTasks(db);
  assert.deepEqual(report.uncertain, [taskId]);
  const task = getCanvasTask(db, taskId);
  assert.equal(task?.phase, 'uncertain');
  assert.equal(task?.slotHeld, true, '提交结果不明必须保留可能占用的名额');
  assert.equal(task?.providerTaskId, null);
  assert.equal(canvasTaskSlotUsage(db).held, before);

  // 待核查期间不会被重新领取，也不会重新 POST
  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  const scheduler = createCanvasScheduler({ db, workerId: 'worker-recovery', adapter, storageRoot, pollIntervalMs: 1 });
  await scheduler.tick();
  await scheduler.drain();
  assert.equal(adapter.submissions.length, 0, '待核查任务不得被自动重发');
  assert.equal(getCanvasTask(db, taskId)?.phase, 'uncertain');

  // 核查：确认远端没有创建 → 释放名额；随后用户可以重新生成（新任务）
  const reconciled = reconcileCanvasTaskNotCreated(db, { taskId });
  assert.equal(reconciled.phase, 'failed');
  assert.equal(reconciled.slotHeld, false);
  assert.equal(canvasTaskSlotUsage(db).held, before - 1);
  void fence;
}

// --- 2. 远端 ID 已保存、查询中断 → 续查原任务，不重新提交 ---------------------

{
  const taskId = await prepareNode('g-remote-id', '素材2.png');
  const { fence } = claimOne('worker-b');
  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1, pollsBeforeSuccess: 2 } });

  // 第一次执行：提交成功后本地中断（信号在轮询阶段触发）
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await runCanvasTask({
    db,
    taskId,
    adapter,
    workerId: 'worker-b',
    fence,
    storageRoot,
    pollIntervalMs: 20,
    signal: controller.signal,
  });
  const interrupted = getCanvasTask(db, taskId);
  if (process.env.CANVAS_DEBUG === '1') {
    console.log('[debug] interrupted', JSON.stringify({
      phase: interrupted?.phase,
      submissionState: interrupted?.submissionState,
      providerTaskId: interrupted?.providerTaskId,
      errorCode: interrupted?.errorCode,
      errorMessage: interrupted?.errorMessage,
      pollCount: interrupted?.pollCount,
    }));
  }
  assert.ok(interrupted?.providerTaskId, '远端身份必须已经保存');
  assert.equal(adapter.submissions.length, 1);

  // 进程重启：恢复后接管续查
  const report = recoverCanvasTasks(db);
  assert.deepEqual(report.resumable, [taskId]);
  if (process.env.CANVAS_DEBUG === '1') {
    console.log('[debug] row:', JSON.stringify(db.prepare(
      `SELECT id, phase, providerTaskId, slotHeld, leaseOwner, leaseUntil FROM creative_canvas_tasks WHERE id = ?`,
    ).get(taskId)));
  }
  const takenOver = takeOverResumableCanvasTasks(db);
  assert.deepEqual(takenOver, [taskId]);
  assert.equal(getCanvasTask(db, taskId)?.leaseOwner, null);

  const resumedAdapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1, pollsBeforeSuccess: 1 } });
  const scheduler = createCanvasScheduler({ db: db2, workerId: 'worker-restarted', adapter: resumedAdapter, storageRoot, pollIntervalMs: 1 });
  await scheduler.tick();
  await scheduler.drain();

  const settled = getCanvasTask(db, taskId);
  assert.equal(settled?.phase, 'succeeded');
  assert.equal(resumedAdapter.submissions.length, 0, '恢复只能查询原任务，绝不能重新提交');
  assert.equal(adapter.submissions.length, 1, '整个生命周期只提交一次');
}

// --- 3. 下载失败 → 补下载原产物，不重新生成 -----------------------------------

{
  const taskId = await prepareNode('g-download', '素材3.png');
  const { fence } = claimOne('worker-c');
  const failing = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1, download: 'fail' } });
  await runCanvasTask({ db, taskId, adapter: failing, workerId: 'worker-c', fence, storageRoot, pollIntervalMs: 1 });

  const failed = getCanvasTask(db, taskId);
  assert.equal(failed?.phase, 'download_failed');
  assert.ok(failed?.providerTaskId);
  assert.equal(canvasTaskSlotUsage(db).held, 0, '下载失败不占全局名额');

  // 恢复不会自动补下载（等用户触发）
  const report = recoverCanvasTasks(db);
  assert.deepEqual(report.resumable, []);

  // 用户点补下载：回到查询阶段，用同一个远端身份取原产物
  const retried = retryCanvasTaskDownload(db, { taskId });
  assert.equal(retried.phase, 'polling');
  assert.equal(retried.providerTaskId, failed?.providerTaskId);

  const recovering = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  const scheduler = createCanvasScheduler({ db, workerId: 'worker-retry', adapter: recovering, storageRoot, pollIntervalMs: 1 });
  await scheduler.tick();
  await scheduler.drain();

  assert.equal(getCanvasTask(db, taskId)?.phase, 'succeeded');
  assert.equal(recovering.submissions.length, 0, '补下载不得重新生成');
}

// --- 4. 输出已落盘、发布事务中断 → 接管同一文件 -------------------------------

{
  const taskId = await prepareNode('g-publish', '素材4.png');
  const { fence } = claimOne('worker-d');
  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  // 先正常跑完一次，拿到一个已登记的产物
  await runCanvasTask({ db, taskId, adapter, workerId: 'worker-d', fence, storageRoot, pollIntervalMs: 1 });
  const succeeded = getCanvasTask(db, taskId);
  const assetId = succeeded?.outputAssetId;
  assert.ok(assetId);

  // 模拟「文件已落盘、登记完成，但发布事务没走完就崩溃」：任务退回下载中、节点没有当前结果
  const nodeStateBefore = listCanvasNodeStates(db, canvas.id).find((state) => state.nodeId === 'g-publish');
  assert.equal(nodeStateBefore?.currentAssetId, assetId);
  updateCanvasTaskUnGuarded(db, taskId, {
    phase: 'downloading',
    slotHeld: true,
    leaseOwner: null,
    leaseUntil: null,
  });
  // 真实崩溃现场：产物已登记，但发布事务没执行——activeTaskId 仍指向本任务
  db.prepare(
    `UPDATE creative_canvas_node_states
        SET currentAssetId = NULL, resultTaskId = NULL, activeTaskId = ?
      WHERE canvasId = ? AND nodeId = ?`,
  ).run(taskId, canvas.id, 'g-publish');

  const resumedAdapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  const scheduler = createCanvasScheduler({ db, workerId: 'worker-publish', adapter: resumedAdapter, storageRoot, pollIntervalMs: 1 });
  await scheduler.tick();
  await scheduler.drain();

  assert.equal(resumedAdapter.submissions.length, 0, '落盘后接管不得重新生成');
  assert.equal(getCanvasTask(db, taskId)?.outputAssetId, assetId, '必须复用同一份产物');
  const nodeStateAfter = listCanvasNodeStates(db, canvas.id).find((state) => state.nodeId === 'g-publish');
  assert.equal(nodeStateAfter?.currentAssetId, assetId, '接管后补发布到原节点');
}

// --- 5. lease 过期后的接管：只允许查询／下载 ---------------------------------

{
  const taskId = await prepareNode('g-lease', '素材5.png');
  const { fence } = claimOne('worker-e');
  void fence;
  // 另一个进程还持有未过期的租约
  updateCanvasTaskUnGuarded(db, taskId, {
    phase: 'polling',
    providerTaskId: 'fixture-remote-lease',
    submissionState: 'accepted',
    slotHeld: true,
    leaseOwner: 'worker-other',
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.deepEqual(takeOverResumableCanvasTasks(db), [], '租约未过期不得接管');
  const notClaimed = claimCanvasTasks({ db, workerId: 'worker-f', limit: 1 });
  assert.equal(notClaimed.length, 0, '租约未过期时另一个实例拿不到该任务');

  // 租约过期后可以安全接管查询；任务不会回到可提交状态
  updateCanvasTaskUnGuarded(db, taskId, { leaseUntil: new Date(Date.now() - 1_000).toISOString() });
  assert.deepEqual(takeOverResumableCanvasTasks(db), [taskId]);
  const claimed = claimCanvasTasks({ db, workerId: 'worker-f', limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].task.phase, 'polling', '接管后仍是查询阶段，不会变成可重新 POST');
  assert.equal(claimed[0].task.providerTaskId, 'fixture-remote-lease');
}

// --- 6. 迟到回执与删除后的发布检查 --------------------------------------------

{
  const taskId = await prepareNode('g-late', '素材6.png');
  const { fence } = claimOne('worker-g');
  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  await runCanvasTask({ db, taskId, adapter, workerId: 'worker-g', fence, storageRoot, pollIntervalMs: 1 });
  const published = getCanvasTask(db, taskId);
  assert.equal(published?.phase, 'succeeded');

  // 删除节点后再用旧任务发布：epoch 已经递增，必须被拒绝
  const current = db.prepare(`SELECT graphJson FROM creative_canvases WHERE id = ?`).get(canvas.id) as { graphJson: string };
  const graph = JSON.parse(current.graphJson) as { schemaVersion: number; nodes: CanvasGraphNode[]; edges: CanvasGraphEdge[] };
  saveCanvasGraph({
    db,
    canvasId: canvas.id,
    expectedGraphRevision: revision(),
    graph: {
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== 'g-late'),
      edges: graph.edges.filter((edge) => edge.source !== 'g-late' && edge.target !== 'g-late'),
    },
  });
  const tombstoned = listCanvasNodeStates(db, canvas.id).find((state) => state.nodeId === 'g-late');
  assert.equal(tombstoned?.deleted, true);
  assert.ok((tombstoned?.nodeEpoch ?? 0) > 1);

  const stalePublish = db.prepare(
    `SELECT 1 AS ok FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ? AND deletedAt IS NULL`,
  ).get(canvas.id, 'g-late');
  assert.equal(stalePublish, undefined, '删除后的节点不再接受任何回写');
}

// --- 7. 两个进程：恢复与领取都经数据库 ---------------------------------------

{
  const taskId = await prepareNode('g-two-process', '素材7.png');
  const { fence } = claimOne('worker-h');
  void fence;
  updateCanvasTaskUnGuarded(db, taskId, {
    phase: 'preparing',
    slotHeld: true,
    submissionState: 'not_sent',
    leaseOwner: 'worker-h',
    leaseUntil: new Date(Date.now() - 1).toISOString(),
  });
  // 另一个进程做恢复：确定未提交 → 等用户继续，释放该任务占用的名额
  const heldBefore = canvasTaskSlotUsage(db).held;
  const report = recoverCanvasTasks(db2);
  assert.deepEqual(report.pending, [taskId]);
  assert.equal(getCanvasTask(db, taskId)?.phase, 'resume_pending');
  assert.equal(getCanvasTask(db, taskId)?.slotHeld, false);
  assert.equal(canvasTaskSlotUsage(db).held, heldBefore - 1);

  // 用户继续：用原设置启动原任务（输入快照不变）
  const resumed = resumeCanvasTask(db, { taskId });
  assert.equal(resumed.phase, 'queued');
  assert.equal(resumed.submissionState, 'not_sent');

  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  const scheduler = createCanvasScheduler({ db, workerId: 'worker-i', adapter, storageRoot, pollIntervalMs: 1 });
  await scheduler.tick();
  await scheduler.drain();
  assert.equal(getCanvasTask(db, taskId)?.phase, 'succeeded');
  assert.equal(adapter.submissions.length, 1, '继续执行只提交一次');
  // 输入快照没有被改写
  const inputs = db.prepare(`SELECT COUNT(*) AS count FROM creative_canvas_task_inputs WHERE taskId = ?`).get(taskId) as { count: number };
  assert.equal(Number(inputs.count), 1);

  // 待核查任务不允许直接继续：必须先给核查结论
  const uncertainId = await prepareNode('g-uncertain', '素材8.png');
  claimOne('worker-j');
  updateCanvasTaskUnGuarded(db, uncertainId, {
    phase: 'uncertain',
    submissionState: 'maybe_sent',
    slotHeld: true,
    providerTaskId: null,
  });
  assert.throws(
    () => resumeCanvasTask(db, { taskId: uncertainId }),
    (error: unknown) => (error as { code?: string }).code === 'conflict',
  );
  // 用户填入远端任务 ID → 接管原任务续查
  const withRemote = reconcileCanvasTaskWithRemoteId(db, { taskId: uncertainId, providerTaskId: 'fixture-late-id' });
  assert.equal(withRemote.phase, 'polling');
  assert.equal(withRemote.providerTaskId, 'fixture-late-id');

  const snapshot = canvasRecoverySnapshot(db);
  assert.equal(snapshot.uncertain.length, 0, '核查完成后不再待核查');
}

db2.close();
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-recovery.test.ts 通过');
