import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { registerCanvasCapability, clearCanvasCapabilities } from '../lib/creative-canvas/capabilities.ts';
import { canvasStorageRoot, registerCanvasResultAsset } from '../lib/creative-canvas/assets.ts';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { createCanvas, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { runCanvasTask } from '../lib/creative-canvas/runner.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { claimCanvasTasks, getCanvasTask } from '../lib/creative-canvas/tasks.ts';
import type {
  CanvasDownloadOutcome,
  CanvasPollOutcome,
  CanvasSubmitOutcome,
  CanvasTaskAdapter,
} from '../lib/creative-canvas/adapters/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-review-regressions-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';

const capabilityKey = 'review-regression-image';
clearCanvasCapabilities();
registerCanvasCapability({
  key: capabilityKey,
  displayName: capabilityKey,
  providerKind: 'external',
  providerIdentity: 'review-regression',
  modelAlias: capabilityKey,
  mediaKind: 'image',
  modes: ['text-to-image'],
  inputs: [],
  parameters: [],
  cancellation: false,
  evidence: 'candidate',
  evidenceNote: '仅用于本地回归。',
});

const png = async (background: string): Promise<Buffer> => sharp({
  create: { width: 8, height: 8, channels: 3, background },
}).png().toBuffer();

function delayedDownloadAdapter(
  providerTaskId: string,
  bytes: Buffer,
  downloadStarted: Promise<void>,
  resolveDownloadStarted: () => void,
  downloadRelease: Promise<void>,
): CanvasTaskAdapter {
  void downloadStarted;
  return {
    kind: 'review-regression',
    async prepare(): Promise<void> {},
    async submit(): Promise<CanvasSubmitOutcome> { return { providerTaskId }; },
    async poll(): Promise<CanvasPollOutcome> { return { status: 'succeeded' }; },
    async download(): Promise<CanvasDownloadOutcome> {
      resolveDownloadStarted();
      await downloadRelease;
      return { bytes, mimeType: 'image/png' };
    },
  };
}

function immediateAdapter(providerTaskId: string, bytes: Buffer): CanvasTaskAdapter {
  return {
    kind: 'review-regression',
    async prepare(): Promise<void> {},
    async submit(): Promise<CanvasSubmitOutcome> { return { providerTaskId }; },
    async poll(): Promise<CanvasPollOutcome> { return { status: 'succeeded' }; },
    async download(): Promise<CanvasDownloadOutcome> { return { bytes, mimeType: 'image/png' }; },
  };
}

async function freshEnvironment(name: string): Promise<{
  db: Database.Database;
  db2: Database.Database;
  storageRoot: string;
  canvasId: string;
  taskId: string;
  nodeId: string;
  close: () => void;
}> {
  const directory = fs.mkdtempSync(path.join(root, `${name}-`));
  const databasePath = path.join(directory, 'workbench.db');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const readiness = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(directory, 'backups') });
  assert.equal(readiness.state, 'ready');
  const db2 = new Database(databasePath);
  db2.pragma('journal_mode = WAL');
  db2.pragma('foreign_keys = ON');

  const canvas = createCanvas(db, { name });
  const nodeId = 'review-image-node';
  saveCanvasGraph({
    db,
    canvasId: canvas.id,
    expectedGraphRevision: 0,
    graph: {
      schemaVersion: 1,
      nodes: [{
        id: nodeId,
        kind: 'image-generation',
        position: { x: 0, y: 0 },
        data: {
          title: nodeId,
          modelKey: capabilityKey,
          generationMode: 'text-to-image',
          prompt: 'review',
          parameters: {},
          references: [],
          referenceLabelCounter: 0,
        },
      }],
      edges: [],
    },
  });
  const run = startCanvasRun({
    db,
    request: { canvasId: canvas.id, mode: 'single', targetNodeId: nodeId, requestKey: `${name}-run` },
  });
  assert.equal(run.tasks.length, 1);
  return {
    db,
    db2,
    storageRoot: canvasStorageRoot(directory),
    canvasId: canvas.id,
    taskId: run.tasks[0].id,
    nodeId,
    close: () => {
      db2.close();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

// 迟到下载回归：旧 worker 不理会 AbortSignal，接管后的新 worker 先登记并发布，
// 旧 worker 回来后只能清理自己的文件，不能插入资产或覆盖节点。
{
  const env = await freshEnvironment('late-download');
  try {
    const oldBytes = await png('#cc3344');
    const newBytes = await png('#3366cc');
    let releaseOldDownload!: () => void;
    const oldDownloadRelease = new Promise<void>((resolve) => { releaseOldDownload = resolve; });
    let resolveOldDownloadStarted!: () => void;
    const oldDownloadStarted = new Promise<void>((resolve) => { resolveOldDownloadStarted = resolve; });
    const oldAdapter = delayedDownloadAdapter(
      'remote-late-download', oldBytes, oldDownloadStarted, resolveOldDownloadStarted, oldDownloadRelease,
    );
    const firstClaim = claimCanvasTasks({
      db: env.db,
      workerId: 'old-worker',
      limit: 1,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });
    assert.equal(firstClaim.length, 1);
    const oldRun = runCanvasTask({
      db: env.db,
      taskId: env.taskId,
      adapter: oldAdapter,
      workerId: 'old-worker',
      fence: firstClaim[0].fence,
      storageRoot: env.storageRoot,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    await oldDownloadStarted;

    // 让第二个连接看见租约过期，模拟真实接管；它会递增 fence 并保留远端身份。
    env.db2.prepare(`UPDATE creative_canvas_tasks SET leaseUntil = ? WHERE id = ?`)
      .run('2020-01-01T00:00:00.000Z', env.taskId);
    const takeover = claimCanvasTasks({
      db: env.db2,
      workerId: 'new-worker',
      limit: 1,
      now: () => new Date('2026-09-12T00:01:00.000Z'),
    });
    assert.equal(takeover.length, 1);
    assert.equal(takeover[0].task.providerTaskId, 'remote-late-download');
    const newOutcome = await runCanvasTask({
      db: env.db2,
      taskId: env.taskId,
      adapter: immediateAdapter('remote-late-download', newBytes),
      workerId: 'new-worker',
      fence: takeover[0].fence,
      storageRoot: env.storageRoot,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(newOutcome.phase, 'succeeded');
    assert.equal(newOutcome.published, true);
    const newTask = getCanvasTask(env.db, env.taskId)!;
    assert.equal(newTask.phase, 'succeeded');
    assert.ok(newTask.outputAssetId);
    const adopted = env.db.prepare(`SELECT contentHash, relativePath FROM creative_canvas_assets WHERE id = ?`)
      .get(newTask.outputAssetId) as { contentHash: string; relativePath: string };
    assert.equal(adopted.contentHash, createHash('sha256').update(newBytes).digest('hex'));

    releaseOldDownload();
    const oldOutcome = await oldRun;
    assert.equal(oldOutcome.phase, 'succeeded');
    const assets = env.db.prepare(`SELECT id, contentHash, relativePath FROM creative_canvas_assets WHERE sourceTaskId = ?`)
      .all(env.taskId) as Array<{ id: string; contentHash: string; relativePath: string }>;
    assert.equal(assets.length, 1, '旧 worker 迟到结果不得登记第二份资产');
    assert.equal(assets[0].id, newTask.outputAssetId);
    assert.notEqual(assets[0].contentHash, createHash('sha256').update(oldBytes).digest('hex'));
    const nodeState = env.db.prepare(`SELECT currentAssetId, resultTaskId, activeTaskId FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`)
      .get(env.canvasId, env.nodeId) as { currentAssetId: string | null; resultTaskId: string | null; activeTaskId: string | null };
    assert.equal(nodeState.currentAssetId, newTask.outputAssetId);
    assert.equal(nodeState.resultTaskId, env.taskId);
    assert.equal(nodeState.activeTaskId, null);
    assert.equal(fs.existsSync(path.join(env.storageRoot, assets[0].relativePath)), true);
    const resultFiles = fs.readdirSync(path.dirname(path.join(env.storageRoot, assets[0].relativePath)));
    assert.deepEqual(resultFiles, [path.basename(assets[0].relativePath)], '旧 worker 的私有结果文件必须被清理');
  } finally {
    env.close();
  }
}

// commit 回调失败也必须回滚资产插入，且只清理本次写入的私有文件。
{
  const env = await freshEnvironment('commit-rollback');
  try {
    const claim = claimCanvasTasks({ db: env.db, workerId: 'rollback-worker', limit: 1 });
    assert.equal(claim.length, 1);
    const before = Number((env.db.prepare(`SELECT COUNT(*) AS count FROM creative_canvas_assets`).get() as { count: number }).count);
    await assert.rejects(
      registerCanvasResultAsset({
        db: env.db,
        canvasId: env.canvasId,
        storageRoot: env.storageRoot,
        taskId: env.taskId,
        mediaKind: 'image',
        mimeType: 'image/png',
        data: await png('#aa55aa'),
        guard: { fence: claim[0].fence, workerId: 'rollback-worker' },
        commit: () => { throw new Error('intentional commit failure'); },
      }),
      /intentional commit failure/,
    );
    const after = Number((env.db.prepare(`SELECT COUNT(*) AS count FROM creative_canvas_assets`).get() as { count: number }).count);
    assert.equal(after, before);
    assert.equal(Number((env.db.prepare(`SELECT COUNT(*) AS count FROM creative_canvas_tasks WHERE outputAssetId IS NOT NULL`).get() as { count: number }).count), 0);
    const resultsDirectory = path.join(env.storageRoot, 'canvas', env.canvasId, 'results');
    const resultFiles = fs.existsSync(resultsDirectory) ? fs.readdirSync(resultsDirectory) : [];
    assert.deepEqual(resultFiles, [], '事务失败后不得留下结果文件');
  } finally {
    env.close();
  }
}

console.log('creative-canvas-review-regressions.test.ts 通过');
