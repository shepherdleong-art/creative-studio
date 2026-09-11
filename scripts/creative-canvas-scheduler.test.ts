import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { clearCanvasCapabilities, registerCanvasCapability, type CanvasModelCapability } from '../lib/creative-canvas/capabilities.ts';
import { canvasStorageRoot, importCanvasAsset } from '../lib/creative-canvas/assets.ts';
import { createCanvas, listCanvasNodeStates, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { createCanvasScheduler } from '../lib/creative-canvas/scheduler.ts';
import { createCanvasFixtureAdapter } from '../lib/creative-canvas/adapters/fixture.ts';
import {
  CANVAS_DEFAULT_GLOBAL_TASK_LIMIT,
  canvasTaskSlotUsage,
  claimCanvasTasks,
  findActiveTaskForCanvasNode,
  getCanvasTask,
  listCanvasTasks,
} from '../lib/creative-canvas/tasks.ts';
import type { CanvasGraphEdge, CanvasGraphNode } from '../lib/creative-canvas/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-scheduler-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';

interface TestDatabase {
  db: Database.Database;
  db2: Database.Database;
  storageRoot: string;
  dispose: () => void;
}

/**
 * 每个用例独立文件库：调度器是「所有创作画布共享 10 个名额」的全局设施，
 * 复用同一个库会让上一个用例残留的排队任务被下一个用例的调度器领取。
 */
async function freshDatabase(name: string): Promise<TestDatabase> {
  const directory = fs.mkdtempSync(path.join(root, `${name}-`));
  const databaseFile = path.join(directory, 'workbench.db');
  const connection = new Database(databaseFile);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  const migrated = await ensureCreativeCanvasSchemaReady({ db: connection, backupRoot: path.join(directory, 'backups') });
  assert.equal(migrated.state, 'ready');
  // 第二个连接模拟另一个调度器实例（同一文件库、各自进程内状态）
  const second = new Database(databaseFile);
  second.pragma('journal_mode = WAL');
  second.pragma('foreign_keys = ON');
  return {
    db: connection,
    db2: second,
    storageRoot: canvasStorageRoot(directory),
    dispose: () => {
      second.close();
      connection.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

clearCanvasCapabilities();
function capability(key: string, mediaKind: 'image' | 'video', extra: Partial<CanvasModelCapability> = {}): CanvasModelCapability {
  return {
    key,
    displayName: key,
    providerKind: 'external',
    providerIdentity: `provider-${key}`,
    modelAlias: `alias/${key}`,
    mediaKind,
    modes: mediaKind === 'image' ? ['image-to-image', 'text-to-image'] : ['image-to-video', 'text-to-video'],
    inputs: [
      { kind: 'image', roles: ['subject', 'first-frame', 'reference', 'style'], min: 0, max: 2 },
      { kind: 'text', roles: ['reference'], min: 0, max: 1 },
    ],
    parameters: [],
    cancellation: false,
    evidence: 'candidate',
    evidenceNote: '本地 fixture 能力，只用于测试。',
    ...extra,
  };
}
const IMAGE_CAP = capability('fixture-image', 'image');
const VIDEO_CAP = capability('fixture-video', 'video');
const LIMITED_CAP = capability('fixture-limited', 'image');
registerCanvasCapability(IMAGE_CAP);
registerCanvasCapability(VIDEO_CAP);
registerCanvasCapability(LIMITED_CAP);

function imageNode(id: string, modelKey: string, prompt = ''): CanvasGraphNode {
  return {
    id,
    kind: 'image-generation',
    position: { x: 0, y: 0 },
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

function material(id: string, assetId: string | null): CanvasGraphNode {
  return { id, kind: 'material', position: { x: 0, y: 0 }, data: { title: id, assetId, mediaKind: 'image' } };
}

async function makeAsset(env: TestDatabase, canvasId: string, name: string): Promise<string> {
  const data = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#556677' } }).png().toBuffer();
  const asset = await importCanvasAsset({
    db: env.db,
    canvasId,
    storageRoot: env.storageRoot,
    filename: name,
    mimeType: 'image/png',
    data,
  });
  return asset.id;
}

function save(
  env: TestDatabase,
  canvasId: string,
  nodes: CanvasGraphNode[],
  edges: CanvasGraphEdge[],
  expectedRevision: number,
) {
  return saveCanvasGraph({
    db: env.db,
    canvasId,
    expectedGraphRevision: expectedRevision,
    graph: { schemaVersion: 1, nodes, edges },
  });
}

// --- 全局名额：11 个就绪任务，两个调度实例 --------------------------------

{
  const env = await freshDatabase('concurrency');
  const { db, db2, storageRoot } = env;
  const canvasId = createCanvas(db, { name: '并发画布' }).id;
  const nodes: CanvasGraphNode[] = [];
  const edges: CanvasGraphEdge[] = [];
  for (let index = 0; index < 11; index += 1) {
    const assetId = await makeAsset(env, canvasId, `素材${index}.png`);
    nodes.push(material(`m${index}`, assetId), imageNode(`g${index}`, IMAGE_CAP.key, `任务 ${index}`));
    edges.push({ id: `e${index}`, source: `m${index}`, target: `g${index}` });
  }
  const saved = save(env, canvasId, nodes, edges, 0);

  for (let index = 0; index < 11; index += 1) {
    startCanvasRun({
      db,
      request: {
        canvasId,
        mode: 'single',
        targetNodeId: `g${index}`,
        requestKey: `run-${index}`,
      },
    });
  }
  assert.equal(listCanvasTasks(db, { canvasId }).length, 11);
  assert.equal(canvasTaskSlotUsage(db).held, 0);
  void saved;

  const adapterA = createCanvasFixtureAdapter({ defaultScript: { delayMs: 15 } });
  const adapterB = createCanvasFixtureAdapter({ defaultScript: { delayMs: 15 } });
  const schedulerA = createCanvasScheduler({
    db,
    workerId: 'scheduler-a',
    adapter: adapterA,
    storageRoot,
    pollIntervalMs: 1,
  });
  const schedulerB = createCanvasScheduler({
    db: db2,
    workerId: 'scheduler-b',
    adapter: adapterB,
    storageRoot,
    pollIntervalMs: 1,
  });

  const tickA = await schedulerA.tick();
  assert.equal(tickA.claimed.length, CANVAS_DEFAULT_GLOBAL_TASK_LIMIT);
  assert.equal(canvasTaskSlotUsage(db).held, CANVAS_DEFAULT_GLOBAL_TASK_LIMIT);

  // 第二个实例这时拿不到名额
  const tickB = await schedulerB.tick();
  assert.equal(tickB.claimed.length, 0);
  assert.equal(canvasTaskSlotUsage(db).held, CANVAS_DEFAULT_GLOBAL_TASK_LIMIT);

  // 第 11 个任务仍在排队
  const queued = listCanvasTasks(db, { canvasId, phases: ['queued'] });
  assert.equal(queued.length, 1);

  await schedulerA.drain();
  assert.equal(canvasTaskSlotUsage(db).held, 0);

  // 名额释放后第二个实例可以领取剩下的任务
  const tickB2 = await schedulerB.tick();
  assert.equal(tickB2.claimed.length, 1);
  await schedulerB.drain();

  const finished = listCanvasTasks(db, { canvasId });
  assert.equal(finished.length, 11);
  assert.equal(finished.every((task) => task.phase === 'succeeded'), true);
  // 每个节点只提交一次
  for (let index = 0; index < 11; index += 1) {
    assert.equal(adapterA.submitCountForNode(`g${index}`) + adapterB.submitCountForNode(`g${index}`), 1);
  }
  // 结果都发布到了各自的节点
  const states = listCanvasNodeStates(db, canvasId);
  assert.equal(states.filter((state) => state.currentAssetId).length, 11);
  env.dispose();
}

// --- 直接争抢：两个连接交替领取，任何时刻都不超过全局上限 --------------------

{
  const env = await freshDatabase('contention');
  const { db, db2 } = env;
  const canvasId = createCanvas(db, { name: '争抢画布' }).id;
  const nodes: CanvasGraphNode[] = [];
  const edges: CanvasGraphEdge[] = [];
  for (let index = 0; index < 11; index += 1) {
    const assetId = await makeAsset(env, canvasId, `争抢素材${index}.png`);
    nodes.push(material(`m${index}`, assetId), imageNode(`g${index}`, IMAGE_CAP.key));
    edges.push({ id: `e${index}`, source: `m${index}`, target: `g${index}` });
  }
  save(env, canvasId, nodes, edges, 0);
  for (let index = 0; index < 11; index += 1) {
    startCanvasRun({
      db,
      request: { canvasId, mode: 'single', targetNodeId: `g${index}`, requestKey: `race-${index}` },
    });
  }

  let maxHeld = 0;
  for (let round = 0; round < 12; round += 1) {
    claimCanvasTasks({ db, workerId: `race-a-${round}`, limit: 3 });
    maxHeld = Math.max(maxHeld, canvasTaskSlotUsage(db).held);
    claimCanvasTasks({ db: db2, workerId: `race-b-${round}`, limit: 4 });
    maxHeld = Math.max(maxHeld, canvasTaskSlotUsage(db).held);
    assert.ok(maxHeld <= CANVAS_DEFAULT_GLOBAL_TASK_LIMIT, `占用达到 ${maxHeld}`);
    // 累积两轮后释放，继续争抢；期间不得越过全局上限
    if (round % 2 === 1) {
      db.prepare(`UPDATE creative_canvas_tasks SET slotHeld = 0, phase = 'queued' WHERE slotHeld = 1`).run();
    }
  }
  assert.equal(maxHeld, CANVAS_DEFAULT_GLOBAL_TASK_LIMIT);
  env.dispose();
}

// --- 等待输入不占名额；上游完成后才提交下游 ----------------------------------

{
  const env = await freshDatabase('dependency');
  const { db, storageRoot } = env;
  const canvasId = createCanvas(db, { name: '依赖画布' }).id;
  const assetId = await makeAsset(env, canvasId, '依赖素材.png');
  save(env, canvasId, [
    material('m1', assetId),
    imageNode('up', IMAGE_CAP.key, '上游'),
    imageNode('down', IMAGE_CAP.key, '下游'),
  ], [
    { id: 'e1', source: 'm1', target: 'up' },
    { id: 'e2', source: 'up', target: 'down' },
  ], 0);

  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  const scheduler = createCanvasScheduler({
    db,
    workerId: 'dependency-scheduler',
    adapter,
    storageRoot,
    pollIntervalMs: 1,
  });

  const started = startCanvasRun({
    db,
    request: { canvasId, mode: 'branch', startNodeId: 'up', requestKey: 'dependency-run' },
  });
  assert.equal(started.tasks.length, 2);
  const upTask = started.tasks.find((task) => task.nodeId === 'up');
  const downTask = started.tasks.find((task) => task.nodeId === 'down');
  assert.equal(upTask?.phase, 'queued');
  // 等待上游的任务不占名额
  assert.equal(downTask?.phase, 'waiting_input');
  assert.equal(canvasTaskSlotUsage(db).held, 0);

  const first = await scheduler.tick();
  assert.equal(first.claimed.length, 1);
  await scheduler.drain();

  assert.equal(getCanvasTask(db, upTask?.id ?? '')?.phase, 'succeeded');
  const upResult = getCanvasTask(db, upTask?.id ?? '');
  assert.ok(upResult?.outputAssetId);
  // 上游完成后、下一次调度之前，下游仍在等待（本地结果保存才算输入可用）
  assert.equal(getCanvasTask(db, downTask?.id ?? '')?.phase, 'waiting_input');

  // 下一次调度先把绑定任务的产物登记为已解析输入，再让下游排队
  const second = await scheduler.tick();
  assert.deepEqual(second.promoted, [downTask?.id]);
  await scheduler.drain();
  const downFinal = getCanvasTask(db, downTask?.id ?? '');
  assert.equal(downFinal?.phase, 'succeeded');
  const resolved = db.prepare(
    `SELECT resolvedAssetId FROM creative_canvas_task_inputs WHERE taskId = ? AND upstreamTaskId = ?`,
  ).get(downTask?.id, upTask?.id) as { resolvedAssetId: string | null };
  assert.equal(resolved.resolvedAssetId, upResult?.outputAssetId);
  // 下游使用的正是绑定任务的产物
  assert.equal(adapter.submissions.find((entry) => entry.nodeId === 'down')?.inputs[0].assetId, upResult?.outputAssetId);

  // 上游节点后来的当前结果不会改变已经绑定的输入
  const downStates = listCanvasNodeStates(db, canvasId);
  assert.equal(downStates.find((state) => state.nodeId === 'down')?.currentAssetId, downFinal?.outputAssetId);
  assert.equal(downStates.find((state) => state.nodeId === 'up')?.currentAssetId, upResult?.outputAssetId);
  env.dispose();
}

// --- 上游失败只阻塞后代，独立任务继续 ----------------------------------------

{
  const env = await freshDatabase('isolation');
  const { db, storageRoot } = env;
  const canvasId = createCanvas(db, { name: '失败隔离画布' }).id;
  const assetId = await makeAsset(env, canvasId, '隔离素材.png');
  save(env, canvasId, [
    material('m1', assetId),
    imageNode('up', IMAGE_CAP.key, '会失败'),
    imageNode('down', IMAGE_CAP.key, '后代'),
    material('m2', assetId),
    imageNode('independent', IMAGE_CAP.key, '独立'),
  ], [
    { id: 'e1', source: 'm1', target: 'up' },
    { id: 'e2', source: 'up', target: 'down' },
    { id: 'e3', source: 'm2', target: 'independent' },
  ], 0);

  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  adapter.setScriptForNode('up', { poll: 'fail' });
  const scheduler = createCanvasScheduler({
    db,
    workerId: 'isolation-scheduler',
    adapter,
    storageRoot,
    pollIntervalMs: 1,
  });

  const started = startCanvasRun({
    db,
    request: { canvasId, mode: 'branch', startNodeId: 'up', requestKey: 'isolation-run' },
  });
  const independentStarted = startCanvasRun({
    db,
    request: { canvasId, mode: 'single', targetNodeId: 'independent', requestKey: 'independent-run' },
  });
  assert.equal(started.tasks.length, 2);
  assert.equal(independentStarted.tasks.length, 1);

  await scheduler.tick();
  await scheduler.drain();
  await scheduler.tick();
  await scheduler.drain();

  const tasks = listCanvasTasks(db, { canvasId });
  const byNode = new Map(tasks.map((task) => [task.nodeId, task]));
  assert.equal(byNode.get('up')?.phase, 'failed');
  // 后代被阻塞，且不自动改等后来新建的任务
  assert.equal(byNode.get('down')?.phase, 'blocked');
  assert.equal(byNode.get('down')?.errorCode, 'upstream_incomplete');
  // 独立任务照常完成
  assert.equal(byNode.get('independent')?.phase, 'succeeded');
  assert.equal(adapter.submitCountForNode('down'), 0);
  // 失败不占名额
  assert.equal(canvasTaskSlotUsage(db).held, 0);
  env.dispose();
}

// --- 模型名额不足不造成队头阻塞 ----------------------------------------------

{
  // 名额用例只关心领取结果，不需要真实素材交付
  const env = await freshDatabase('quota');
  const { db } = env;
  const canvasId = createCanvas(db, { name: '模型名额画布' }).id;
  const nodes: CanvasGraphNode[] = [];
  const edges: CanvasGraphEdge[] = [];
  for (const [index, modelKey] of [LIMITED_CAP.key, LIMITED_CAP.key, IMAGE_CAP.key, IMAGE_CAP.key].entries()) {
    const assetId = await makeAsset(env, canvasId, `名额素材${index}.png`);
    nodes.push(material(`m${index}`, assetId), imageNode(`g${index}`, modelKey));
    edges.push({ id: `e${index}`, source: `m${index}`, target: `g${index}` });
  }
  save(env, canvasId, nodes, edges, 0);
  for (let index = 0; index < 4; index += 1) {
    startCanvasRun({
      db,
      request: { canvasId, mode: 'single', targetNodeId: `g${index}`, requestKey: `quota-${index}` },
    });
  }

  // 受限模型只有 1 个名额：被它挡住的第 2 个任务要跳过，先跑其他模型
  const claimed = claimCanvasTasks({
    db,
    workerId: 'quota-worker',
    quotaLimits: { [LIMITED_CAP.key]: 1 },
  });
  const claimedNodes = claimed.map(({ task }) => task.nodeId).sort();
  assert.deepEqual(claimedNodes, ['g0', 'g2', 'g3']);
  const usage = canvasTaskSlotUsage(db);
  assert.equal(usage.held, 3);
  assert.equal(usage.byQuotaKey[LIMITED_CAP.key], 1);
  assert.equal(usage.byQuotaKey[IMAGE_CAP.key], 2);
  env.dispose();
}

// --- 下载失败：保留远端身份、补下载不重新生成 ---------------------------------

{
  const env = await freshDatabase('download');
  const { db, storageRoot } = env;
  const canvasId = createCanvas(db, { name: '下载失败画布' }).id;
  const assetId = await makeAsset(env, canvasId, '下载素材.png');
  save(env, canvasId, [material('m1', assetId), imageNode('g1', IMAGE_CAP.key)], [
    { id: 'e1', source: 'm1', target: 'g1' },
  ], 0);

  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1, download: 'fail' } });
  const scheduler = createCanvasScheduler({
    db,
    workerId: 'download-scheduler',
    adapter,
    storageRoot,
    pollIntervalMs: 1,
  });
  const started = startCanvasRun({
    db,
    request: { canvasId, mode: 'single', targetNodeId: 'g1', requestKey: 'download-run' },
  });
  const taskId = started.tasks[0].id;
  await scheduler.tick();
  await scheduler.drain();

  const failed = getCanvasTask(db, taskId);
  assert.equal(failed?.phase, 'download_failed');
  assert.equal(failed?.slotHeld, false);
  assert.ok(failed?.providerTaskId);
  assert.equal(failed?.outputAssetId, null);
  assert.equal(adapter.submitCountForNode('g1'), 1);

  // 再次调度不会重新提交（任务不在可领取阶段）
  await scheduler.tick();
  await scheduler.drain();
  assert.equal(adapter.submitCountForNode('g1'), 1);
  assert.equal(getCanvasTask(db, taskId)?.phase, 'download_failed');

  // 节点没有当前结果；下载失败不占全局名额，但仍占用该节点的活跃位置：
  // 远端产物还需要用户补下载或明确取消，不能用「再生成一次」绕过。
  assert.equal(listCanvasNodeStates(db, canvasId).find((state) => state.nodeId === 'g1')?.currentAssetId, null);
  assert.equal(findActiveTaskForCanvasNode(db, canvasId, 'g1')?.phase, 'download_failed');
  const reusedSlot = claimCanvasTasks({ db, workerId: 'after-download-failure' });
  assert.equal(reusedSlot.some(({ task }) => task.nodeId === 'g1'), false);
  env.dispose();
}

// --- 未知响应进入待核查并保留名额 --------------------------------------------

{
  const env = await freshDatabase('uncertain');
  const { db, storageRoot } = env;
  const canvasId = createCanvas(db, { name: '待核查画布' }).id;
  const assetId = await makeAsset(env, canvasId, '待核查素材.png');
  save(env, canvasId, [material('m1', assetId), imageNode('g1', IMAGE_CAP.key)], [
    { id: 'e1', source: 'm1', target: 'g1' },
  ], 0);

  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1, submit: 'uncertain' } });
  const scheduler = createCanvasScheduler({
    db,
    workerId: 'uncertain-scheduler',
    adapter,
    storageRoot,
    pollIntervalMs: 1,
  });
  const started = startCanvasRun({
    db,
    request: { canvasId, mode: 'single', targetNodeId: 'g1', requestKey: 'uncertain-run' },
  });
  const taskId = started.tasks[0].id;
  await scheduler.tick();
  await scheduler.drain();

  const uncertain = getCanvasTask(db, taskId);
  assert.equal(uncertain?.phase, 'uncertain');
  assert.equal(uncertain?.submissionState, 'maybe_sent');
  // 提交结果不明时保守保留可能占用的名额，不自动重发
  assert.equal(uncertain?.slotHeld, true);
  assert.equal(adapter.submitCountForNode('g1'), 1);

  await scheduler.tick();
  await scheduler.drain();
  assert.equal(adapter.submitCountForNode('g1'), 1);
  assert.equal(getCanvasTask(db, taskId)?.phase, 'uncertain');
  env.dispose();
}

fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-scheduler.test.ts 通过');
