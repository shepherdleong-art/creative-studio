import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { CanvasGraphNode } from '../lib/creative-canvas/types.ts';

// 真正调用 API、readiness 与定时调度器；所有素材与数据库均在隔离根，执行器只用 fixture。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-bootstrap-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';
delete process.env.CREATIVE_STUDIO_CANVAS_ENABLE;

const repoRoot = path.resolve(import.meta.dirname, '..');
type Resolution = { url: string; format?: string | null; shortCircuit?: boolean };
const { registerHooks } = module as unknown as {
  registerHooks(hooks: {
    resolve(specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => Resolution): Resolution;
  }): void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const file = ['', '.ts', '.tsx', '/index.ts'].map((ext) => base + ext)
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (file) return nextResolve(pathToFileURL(file).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
          && !specifier.startsWith('.') && !specifier.startsWith('/')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const bootstrap = await import('../lib/creative-canvas/bootstrap.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { acquireSchemaUpgradeLock } = await import('../lib/schema-upgrade/lock.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { getCanvasReadiness } = await import('../lib/creative-canvas/runtime-readiness.ts');
const { registerCanvasAdapterFactory } = await import('../lib/creative-canvas/adapters/index.ts');
const { createCanvasFixtureAdapter } = await import('../lib/creative-canvas/adapters/fixture.ts');
const { ensureCanvasCapabilitiesRegistered } = await import('../lib/creative-canvas/capabilities-bootstrap.ts');
const { createCanvas, saveCanvasGraph } = await import('../lib/creative-canvas/repository.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { claimCanvasTasks, getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const itemRoute = await import('../app/api/canvas/[id]/route.ts');
const runsRoute = await import('../app/api/canvas/[id]/runs/route.ts');
const modelsRoute = await import('../app/api/canvas/models/route.ts');

function node(id: string): CanvasGraphNode {
  return {
    id, kind: 'image-generation', position: { x: 0, y: 0 },
    data: { title: id, modelKey: 'fixture-image-edit', generationMode: 'text-to-image',
      prompt: id, parameters: {}, references: [], referenceLabelCounter: 0 },
  };
}

async function waitUntil(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!check() && Date.now() < deadline) await delay(25);
  assert.ok(check(), message);
}

let releaseFirst = false;
try {
  assert.equal(await bootstrap.startCanvasAfterReadiness(), null);
  assert.equal((await modelsRoute.GET()).status, 503);
  assert.equal(fs.existsSync(path.join(root, 'data')), false, '关闭画布不触碰数据根');

  process.env.CREATIVE_STUDIO_CANVAS_ENABLE = '1';
  const db = getDb();
  // 复现桌面启动时其他模块持有升级锁：首次启动失败，之后 API 的 readiness 恢复。
  const lock = await acquireSchemaUpgradeLock(schemaUpgradeRuntimePaths(root));
  try {
    assert.equal(await bootstrap.startCanvasAfterReadiness(), null);
    assert.equal(bootstrap.getCanvasSchedulerController(), null);
  } finally {
    lock.release();
  }
  assert.equal((await getCanvasReadiness()).available, true);
  ensureCanvasCapabilitiesRegistered(db);

  const canvasId = createCanvas(db, { name: '启动恢复与独立节点并发' }).id;
  const params = { params: Promise.resolve({ id: canvasId }) };
  const graph = { schemaVersion: 1 as const, nodes: [node('interrupted'), node('first')], edges: [] };
  const saved = saveCanvasGraph({ db, canvasId, expectedGraphRevision: 0, graph });
  const interrupted = startCanvasRun({ db, request: {
    canvasId, mode: 'single', targetNodeId: 'interrupted', requestKey: 'interrupted',
  } }).tasks[0];
  claimCanvasTasks({ db, workerId: 'previous-process' });
  const first = startCanvasRun({ db, request: {
    canvasId, mode: 'single', targetNodeId: 'first', requestKey: 'first',
  } }).tasks[0];
  assert.equal(getCanvasTask(db, first.id)?.phase, 'queued');

  let factories = 0;
  const adapter = createCanvasFixtureAdapter();
  registerCanvasAdapterFactory('fixture', () => {
    factories += 1;
    return {
      ...adapter,
      async poll(context, signal) {
        if (context.task.nodeId === 'first' && !releaseFirst) return { status: 'running' };
        return adapter.poll(context, signal);
      },
    };
  });

  // 多个页面请求同时恢复：必须只启动一次，不能反复清空在途任务的租约。
  const responses = await Promise.all(Array.from({ length: 6 }, () => (
    itemRoute.GET(new Request('http://127.0.0.1/api/canvas/test'), params)
  )));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(bootstrap.getCanvasSchedulerController()?.running, true,
    '升级锁释放后，画布 API 必须补启动调度器，不能让任务永久排队');
  assert.equal(factories, 1, '并发 API 请求只创建一个调度器');
  assert.equal(getCanvasTask(db, interrupted.id)?.phase, 'resume_pending', '补启动同样执行一次恢复');
  await waitUntil(() => (getCanvasTask(db, first.id)?.pollCount ?? 0) > 0, '首个节点应自动进入远端轮询');
  const firstFence = getCanvasTask(db, first.id)!.fence;
  await Promise.all([bootstrap.startCanvasAfterReadiness(), bootstrap.startCanvasAfterReadiness()]);
  assert.equal(getCanvasTask(db, first.id)?.leaseOwner, 'creative-canvas-scheduler',
    '重复启动入口不能清空当前调度器的在途租约');

  // 第一个仍在生成时，新建独立节点，并经真实提交接口启动。
  const patched = await itemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/test', {
    method: 'PATCH', body: JSON.stringify({ expectedGraphRevision: saved.graphRevision,
      graph: { ...graph, nodes: [...graph.nodes, node('second')] } }),
  }), params);
  assert.equal(patched.status, 200);
  const requestBody = { mode: 'single', targetNodeId: 'second', requestKey: 'second',
    expectedGraphRevision: saved.graphRevision + 1 };
  const submit = () => runsRoute.POST(new Request('http://127.0.0.1/api/canvas/test/runs', {
    method: 'POST', body: JSON.stringify(requestBody),
  }), params);
  const submitted = await submit();
  assert.equal(submitted.status, 200);
  const secondId = (await submitted.json()).tasks[0].id as string;
  assert.equal((await submit()).status, 200, '幂等重放不会新增任务');
  await waitUntil(() => getCanvasTask(db, secondId)?.phase === 'succeeded', '后建节点无需等待首个节点完成');
  assert.equal(getCanvasTask(db, first.id)?.phase, 'polling');
  assert.equal(getCanvasTask(db, first.id)?.fence, firstFence);
  assert.equal(factories, 1);
  assert.equal(adapter.submitCountForNode('first'), 1);
  assert.equal(adapter.submitCountForNode('second'), 1);
  assert.equal(adapter.submitCountForNode('interrupted'), 0);

  releaseFirst = true;
  await waitUntil(() => getCanvasTask(db, first.id)?.phase === 'succeeded', '首个节点可继续完成');
  await bootstrap.stopCanvasScheduler();
  process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'disabled';
  assert.equal((await modelsRoute.GET()).status, 200);
  assert.equal(bootstrap.getCanvasSchedulerController(), null, '执行器关闭时仍只允许编辑');
  console.log('creative-canvas-bootstrap.test.ts 通过');
} finally {
  releaseFirst = true;
  await bootstrap.stopCanvasScheduler();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
