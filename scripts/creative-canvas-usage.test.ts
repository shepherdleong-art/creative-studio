import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { initUsageSchema } from '../lib/usage-schema.ts';
import { createCanvas, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { canvasStorageRoot } from '../lib/creative-canvas/assets.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { runCanvasTask } from '../lib/creative-canvas/runner.ts';
import { claimCanvasTasks, getCanvasTask } from '../lib/creative-canvas/tasks.ts';
import { canvasTaskUsageEventKey, canvasTaskUsageRows, recordCanvasTaskUsage } from '../lib/creative-canvas/usage.ts';
import { retryCanvasTaskDownload } from '../lib/creative-canvas/recovery.ts';
import { createCanvasFixtureAdapter } from '../lib/creative-canvas/adapters/fixture.ts';
import { COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY, COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY } from '../lib/creative-canvas/adapters/company-capabilities.ts';
import { clearCanvasCapabilities, registerCanvasCapability } from '../lib/creative-canvas/capabilities.ts';
import type { CanvasGraphEdge, CanvasGraphNode } from '../lib/creative-canvas/types.ts';

/**
 * T5：画布用量记账。
 *
 * - eventKey 按任务稳定：重试、补下载、复制、查询都只算一次生成调用；
 * - 账本失败只漏记，不改任务状态、不触发重新生成；
 * - 没有价格依据的模型明确「未计价」，不编造金额。
 */

process.env.CREATIVE_STUDIO_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-usage-'));
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';

const root = process.env.CREATIVE_STUDIO_DATA_ROOT;
const storageRoot = canvasStorageRoot(root);
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const migrated = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migrated.state, 'ready');
// 核心供应商表 + 通用账本表（账本是本用例的被测对象）
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'gpt-image-2', type TEXT NOT NULL DEFAULT 'openai-compatible',
    enabled INTEGER NOT NULL DEFAULT 1, defaultCostPerImage REAL
  );
  CREATE TABLE IF NOT EXISTS video_providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    baseUrlEnv TEXT NOT NULL, apiKeyEnv TEXT NOT NULL, modelEnv TEXT NOT NULL,
    defaultModel TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    defaultDurationSec INTEGER NOT NULL DEFAULT 5, defaultCostPerVideo REAL,
    baseUrl TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '',
    accessKey TEXT NOT NULL DEFAULT '', secretKey TEXT NOT NULL DEFAULT ''
  );
`);
assert.equal(initUsageSchema(db).available, true);

// 公司路由：baseUrl 用回环地址，账本的计价门禁按这家身份复核
const loopback = 'http://127.0.0.1:4100';
db.prepare(`
  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
  VALUES ('company-seedance-2-5', '公司即梦 Seedance 2.5', 'openai-video', '', '', '', 'doubao-seedance-2-5-260628', 1, 5, ?, 'k', '', '')
`).run(loopback);
db.prepare(`
  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
  VALUES ('company-qiniuyun-kling-3-0', '公司七牛可灵 3.0', 'openai-video', '', '', '', 'qiniuyun/kling-3.0', 1, 5, ?, 'k', '', '')
`).run(loopback);

clearCanvasCapabilities();
registerCanvasCapability(COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY);
registerCanvasCapability(COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY);

const canvas = createCanvas(db, { name: '用量验证画布' });

function revision(): number {
  const row = db.prepare(`SELECT graphRevision FROM creative_canvases WHERE id = ?`).get(canvas.id) as { graphRevision: number };
  return Number(row.graphRevision);
}

function videoNode(id: string, modelKey: string, parameters: Record<string, string | number | boolean>): CanvasGraphNode {
  return {
    id,
    kind: 'video-generation',
    position: { x: 300, y: 0 },
    data: {
      title: id,
      modelKey,
      generationMode: 'text-to-video',
      prompt: '运镜',
      parameters,
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

function save(nodes: CanvasGraphNode[], edges: CanvasGraphEdge[] = []) {
  return saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: revision(), graph: { schemaVersion: 1, nodes, edges } });
}

async function prepareRun(nodeId: string): Promise<string> {
  const started = startCanvasRun({
    db,
    request: { canvasId: canvas.id, mode: 'single', targetNodeId: nodeId, requestKey: `req-${randomUUID()}` },
  });
  return started.tasks[0].id;
}

function claimOne(workerId: string) {
  const claimed = claimCanvasTasks({ db, workerId, limit: 1 });
  assert.equal(claimed.length, 1);
  return claimed[0];
}

// --- 1. 已计价模型：一次任务一条账本记录 --------------------------------------

let seedanceTaskId = '';
{
  save([videoNode('v-seedance', COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY.key, { durationSec: 8 })]);
  seedanceTaskId = await prepareRun('v-seedance');
  const { fence } = claimOne('usage-worker');

  const adapter = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  await runCanvasTask({ db, taskId: seedanceTaskId, adapter, workerId: 'usage-worker', fence, storageRoot, pollIntervalMs: 1 });
  assert.equal(getCanvasTask(db, seedanceTaskId)?.phase, 'succeeded');

  const rows = canvasTaskUsageRows(db, seedanceTaskId);
  assert.equal(rows, 1, '一次生成调用记一条');
  const ledger = db.prepare(
    `SELECT coreModelKey, category, refType, refId, callCount, quantity, unit, costMicros
       FROM usage_ledger WHERE eventKey = ?`,
  ).get(canvasTaskUsageEventKey(seedanceTaskId)) as Record<string, unknown>;
  assert.equal(ledger.refType, 'canvas-task');
  assert.equal(ledger.refId, seedanceTaskId);
  assert.equal(ledger.category, 'video');
  assert.equal(Number(ledger.callCount), 1);
  assert.equal(Number(ledger.quantity), 8, '视频按实际时长计费');
  assert.equal(String(ledger.unit).length > 0, true);
  assert.ok(Number(ledger.costMicros) > 0, '已计价模型应算出金额');
}

// --- 2. 重复记账与补下载都不增加生成调用数 ------------------------------------

{
  // 直接再记一次：eventKey 相同 → 去重，不新增记录
  const again = recordCanvasTaskUsage(db, { taskId: seedanceTaskId });
  assert.equal(again.ok, true);
  assert.equal(again.inserted, false, '同一任务重复记账必须被 eventKey 去重');
  assert.equal(canvasTaskUsageRows(db, seedanceTaskId), 1);

  // 下载失败 → 补下载：同一次生成调用，不新增记录
  save([videoNode('v-retry', COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY.key, { durationSec: 5 })]);
  const taskId = await prepareRun('v-retry');
  const { fence } = claimOne('usage-retry');
  const failing = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1, download: 'fail' } });
  await runCanvasTask({ db, taskId, adapter: failing, workerId: 'usage-retry', fence, storageRoot, pollIntervalMs: 1 });
  assert.equal(getCanvasTask(db, taskId)?.phase, 'download_failed');
  assert.equal(canvasTaskUsageRows(db, taskId), 1, '提交被接受即记账，下载失败不回滚也不重复');

  retryCanvasTaskDownload(db, { taskId });
  const { fence: retryFence } = claimOne('usage-retry-2');
  const recovering = createCanvasFixtureAdapter({ defaultScript: { delayMs: 1 } });
  await runCanvasTask({
    db,
    taskId,
    adapter: recovering,
    workerId: 'usage-retry-2',
    fence: retryFence,
    storageRoot,
    pollIntervalMs: 1,
  });
  assert.equal(getCanvasTask(db, taskId)?.phase, 'succeeded');
  assert.equal(recovering.submissions.length, 0, '补下载不重新生成');
  assert.equal(canvasTaskUsageRows(db, taskId), 1, '补下载不得再记一次生成调用');
}

// --- 3. 未计价模型：不编造金额 ------------------------------------------------

{
  save([videoNode('v-qiniu', COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.key, { durationSec: 6 })]);
  const taskId = await prepareRun('v-qiniu');
  claimOne('usage-worker-qiniu');
  // 模拟提交已被接受（公司路由的连接与请求捕获由 T4 覆盖）
  db.prepare(
    `UPDATE creative_canvas_tasks SET submissionState = 'accepted', providerTaskId = 'remote-1' WHERE id = ?`,
  ).run(taskId);

  // 主项目已为七牛可灵补充价格；未知型号才是未计价用例。
  const unpriced = JSON.parse(getCanvasTask(db, taskId)!.providerSnapshot);
  unpriced.providerIdentity = 'fixture-unpriced-provider';
  unpriced.modelAlias = 'fixture/unpriced-video';
  db.prepare('UPDATE creative_canvas_tasks SET providerSnapshot = ? WHERE id = ?')
    .run(JSON.stringify(unpriced), taskId);

  const result = recordCanvasTaskUsage(db, { taskId });
  assert.equal(result.priced, false, '没有价格依据的模型必须按未计价返回');
  assert.equal(result.reason, 'pricing_unavailable');
  assert.equal(canvasTaskUsageRows(db, taskId), 0, '不得伪造 0 元记录');
}

// --- 4. 账本不可用：漏记但不影响任务 ------------------------------------------

{
  const isolated = new Database(':memory:');
  isolated.pragma('foreign_keys = ON');
  await ensureCreativeCanvasSchemaReady({ db: isolated, backupRoot: path.join(root, 'iso-backups') });
  const result = recordCanvasTaskUsage(isolated, { taskId: 'ghost-task' });
  assert.equal(result.ok, false, '缺表时应返回失败而不是抛错');
  assert.equal(result.inserted, false);
  isolated.close();
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-usage.test.ts 通过');
