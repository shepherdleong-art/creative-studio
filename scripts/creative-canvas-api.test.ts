import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/**
 * T1 的接口层测试：直接调用 Next 路由处理函数，覆盖真实 HTTP 语义
 * （功能开关、修订冲突、复制、导入、Range、跨画布与越界拒绝）。
 *
 * 数据根必须在导入应用模块之前固定，所以先设置环境变量再动态 import；
 * `@/` 别名用 Node 的同步模块钩子映射到仓库根。
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const EXISTING_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

// @types/node 20 还没有 module.registerHooks 的声明；这里给出测试需要的最小签名。
interface ResolvedModule {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base
        : EXISTING_EXTENSIONS.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Node 的 ESM 解析不走 next 的 exports 子路径；测试里补上显式 .js
      if (
        (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
        && !specifier.startsWith('.')
        && !specifier.startsWith('/')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-api-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
delete process.env.CREATIVE_STUDIO_CANVAS_ENABLE;

const databaseFile = path.join(root, 'data', 'workbench.db');

const canvasRoute = await import('../app/api/canvas/route.ts');
const canvasItemRoute = await import('../app/api/canvas/[id]/route.ts');
const canvasCopiesRoute = await import('../app/api/canvas/[id]/copies/route.ts');
const canvasAssetsRoute = await import('../app/api/canvas/[id]/assets/route.ts');
const canvasAssetItemRoute = await import('../app/api/canvas/assets/[assetId]/route.ts');
const canvasModelsRoute = await import('../app/api/canvas/models/route.ts');

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

// --- 功能关闭：API 拒绝，且完全不触碰画布表 ------------------------------------

{
  const listResponse = await canvasRoute.GET();
  assert.equal(listResponse.status, 503);
  const listBody = await body(listResponse);
  assert.equal(listBody.error, 'canvas_disabled');

  const createResponse = await canvasRoute.POST(new Request('http://127.0.0.1/api/canvas', {
    method: 'POST',
    body: JSON.stringify({ name: '不该被创建' }),
  }));
  assert.equal(createResponse.status, 503);

  // 开关关闭时不执行画布迁移：数据库文件与画布表都不存在
  assert.equal(fs.existsSync(databaseFile), false);
}

// --- 打开开关后走 readiness（含迁移） -----------------------------------------

process.env.CREATIVE_STUDIO_CANVAS_ENABLE = '1';

let canvasId = '';
let graphRevision = 0;
let imageNodeId = '';

{
  const createResponse = await canvasRoute.POST(new Request('http://127.0.0.1/api/canvas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '沙发场景探索' }),
  }));
  assert.equal(createResponse.status, 201);
  const created = (await body(createResponse)).canvas as Record<string, unknown>;
  canvasId = String(created.id);
  assert.equal(created.graphRevision, 0);
  assert.deepEqual(created.nodeStates, []);

  const listResponse = await canvasRoute.GET();
  assert.equal(listResponse.status, 200);
  const canvases = (await body(listResponse)).canvases as Array<Record<string, unknown>>;
  assert.equal(canvases.length, 1);
  assert.equal(canvases[0].name, '沙发场景探索');

  const emptyNameResponse = await canvasRoute.POST(new Request('http://127.0.0.1/api/canvas', {
    method: 'POST',
    body: JSON.stringify({ name: '   ' }),
  }));
  assert.equal(emptyNameResponse.status, 400);
}

// --- 保存编辑定义：修订号、连接对账、运行字段拒写 ------------------------------

function graphPayload(extraNodeData: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'm1', kind: 'material', position: { x: 0, y: 0 }, data: { title: '沙发底图', assetId: null, mediaKind: 'image' } },
      {
        id: 'g1',
        kind: 'image-generation',
        position: { x: 260, y: 0 },
        data: {
          title: '场景图',
          modelKey: null,
          generationMode: 'image-to-image',
          prompt: '把 @参考1 放到客厅',
          parameters: {},
          references: [],
          referenceLabelCounter: 0,
          ...extraNodeData,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'm1', target: 'g1' }],
  };
}

{
  const save = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({ expectedGraphRevision: 0, graph: graphPayload(), viewport: { x: 10, y: 20, zoom: 0.8 } }),
  }), params({ id: canvasId }));
  assert.equal(save.status, 200);
  const saved = (await body(save)).canvas as Record<string, unknown>;
  graphRevision = Number(saved.graphRevision);
  assert.equal(graphRevision, 1);
  const savedGraph = saved.graph as { nodes: Array<Record<string, unknown>> };
  const generationNode = savedGraph.nodes.find((node) => node.id === 'g1') as {
    data: { references: Array<Record<string, unknown>>; referenceLabelCounter: number };
  };
  imageNodeId = String(generationNode && 'id' in generationNode ? (generationNode as unknown as { id: string }).id : 'g1');
  // 连接自动补出参考槽位
  assert.equal(generationNode.data.references.length, 1);
  assert.equal(generationNode.data.references[0].label, 1);
  assert.equal(generationNode.data.references[0].sourceNodeId, 'm1');
  const nodeStates = saved.nodeStates as Array<Record<string, unknown>>;
  assert.deepEqual(nodeStates.map((state) => state.nodeId).sort(), ['g1', 'm1']);
  assert.equal(nodeStates.every((state) => state.nodeEpoch === 1 && state.deleted === false), true);

  // 读取回图与视口
  const read = await canvasItemRoute.GET(new Request('http://127.0.0.1/api/canvas/x'), params({ id: canvasId }));
  assert.equal(read.status, 200);
  const readCanvas = (await body(read)).canvas as Record<string, unknown>;
  assert.equal(readCanvas.graphRevision, 1);
  assert.deepEqual(readCanvas.viewport, { x: 10, y: 20, zoom: 0.8 });
}

{
  // 修订号过期 → 409，且带回当前修订号让前端保留草稿并重试
  const conflict = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({ expectedGraphRevision: 0, graph: graphPayload() }),
  }), params({ id: canvasId }));
  assert.equal(conflict.status, 409);
  const conflictBody = await body(conflict);
  assert.equal(conflictBody.error, 'conflict');
  assert.equal(conflictBody.currentGraphRevision, 1);

  // 画布内容没有被这次失败保存改动
  const read = await canvasItemRoute.GET(new Request('http://127.0.0.1/api/canvas/x'), params({ id: canvasId }));
  assert.equal(((await body(read)).canvas as Record<string, unknown>).graphRevision, 1);

  // 缺少期望修订号 → 400
  const missingRevision = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({ graph: graphPayload() }),
  }), params({ id: canvasId }));
  assert.equal(missingRevision.status, 400);
}

{
  // 客户端不能写运行投影字段
  const runtimeField = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedGraphRevision: graphRevision,
      graph: graphPayload({ currentAssetId: 'forged-asset' }),
    }),
  }), params({ id: canvasId }));
  assert.equal(runtimeField.status, 400);
  assert.equal((await body(runtimeField)).error, 'runtime_field_not_writable');

  const activeTask = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedGraphRevision: graphRevision,
      graph: graphPayload({ activeTaskId: 'forged-task' }),
    }),
  }), params({ id: canvasId }));
  assert.equal(activeTask.status, 400);
  assert.equal((await body(activeTask)).error, 'runtime_field_not_writable');

  // 循环连接被拒绝
  const cyclic = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({
      expectedGraphRevision: graphRevision,
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'm1', kind: 'material', position: { x: 0, y: 0 }, data: { title: '沙发底图', assetId: null, mediaKind: 'image' } },
          { id: 'g1', kind: 'image-generation', position: { x: 260, y: 0 }, data: { title: '场景图', modelKey: null, generationMode: 'image-to-image', prompt: '', parameters: {}, references: [], referenceLabelCounter: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'm1', target: 'g1' },
          { id: 'e2', source: 'g1', target: 'g1' },
        ],
      },
    }),
  }), params({ id: canvasId }));
  assert.equal(cyclic.status, 400);
  assert.equal((await body(cyclic)).error, 'self_loop');

  // 改名不改变修订号
  const renamed = await canvasItemRoute.PATCH(new Request('http://127.0.0.1/api/canvas/x', {
    method: 'PATCH',
    body: JSON.stringify({ name: '沙发场景探索 2' }),
  }), params({ id: canvasId }));
  assert.equal(renamed.status, 200);
  const renamedCanvas = (await body(renamed)).canvas as Record<string, unknown>;
  assert.equal(renamedCanvas.name, '沙发场景探索 2');
  assert.equal(renamedCanvas.graphRevision, graphRevision);
}

// --- 素材导入与 Range 读取 ----------------------------------------------------

let assetId = '';
const assetBytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();

{
  const form = new FormData();
  form.append('file', new File([new Uint8Array(assetBytes)], '沙发.png', { type: 'image/png' }));
  const upload = await canvasAssetsRoute.POST(new Request('http://127.0.0.1/api/canvas/x/assets', {
    method: 'POST',
    body: form,
  }), params({ id: canvasId }));
  assert.equal(upload.status, 201);
  const asset = (await body(upload)).asset as Record<string, unknown>;
  assetId = String(asset.id);
  assert.equal(asset.mediaKind, 'image');
  assert.equal(asset.width, 16);

  const missingFile = await canvasAssetsRoute.POST(new Request('http://127.0.0.1/api/canvas/x/assets', {
    method: 'POST',
    body: new FormData(),
  }), params({ id: canvasId }));
  assert.equal(missingFile.status, 400);

  const unknownCanvas = await canvasAssetsRoute.POST(new Request('http://127.0.0.1/api/canvas/x/assets', {
    method: 'POST',
    body: new FormData(),
  }), params({ id: 'ghost-canvas' }));
  assert.equal(unknownCanvas.status, 404);

  const full = await canvasAssetItemRoute.GET(
    new Request(`http://127.0.0.1/api/canvas/assets/${assetId}`),
    params({ assetId }),
  );
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), assetBytes);

  const ranged = await canvasAssetItemRoute.GET(
    new Request(`http://127.0.0.1/api/canvas/assets/${assetId}`, { headers: { range: 'bytes=0-7' } }),
    params({ assetId }),
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${assetBytes.byteLength}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), assetBytes.subarray(0, 8));

  const unsatisfiable = await canvasAssetItemRoute.GET(
    new Request(`http://127.0.0.1/api/canvas/assets/${assetId}`, { headers: { range: 'bytes=99999-' } }),
    params({ assetId }),
  );
  assert.equal(unsatisfiable.status, 416);

  const missing = await canvasAssetItemRoute.GET(
    new Request('http://127.0.0.1/api/canvas/assets/ghost'),
    params({ assetId: 'ghost' }),
  );
  assert.equal(missing.status, 404);
}

// --- 完整复制 -----------------------------------------------------------------

{
  // 让 g1 有一个“当前结果”，模拟任务已经发布过产物
  const { getDb } = await import('../lib/db.ts');
  const { setCanvasNodeActiveTask, publishCanvasNodeResult, listCanvasNodeStates } = await import('../lib/creative-canvas/repository.ts');
  const db = getDb();
  setCanvasNodeActiveTask(db, { canvasId, nodeId: imageNodeId, taskId: 'task-1' });
  const published = publishCanvasNodeResult({
    db,
    canvasId,
    nodeId: imageNodeId,
    taskId: 'task-1',
    nodeEpoch: 1,
    assetId,
  });
  assert.deepEqual(published, { published: true });

  const snapshot = {
    sourceCanvasId: canvasId,
    snapshotKey: 'paste-1',
    expectedGraphRevision: graphRevision,
    nodes: [
      {
        id: 'g1',
        kind: 'image-generation',
        position: { x: 260, y: 0 },
        data: {
          title: '场景图',
          modelKey: null,
          generationMode: 'image-to-image',
          prompt: '把 @参考1 放到客厅',
          parameters: {},
          references: [
            { refId: 'ref-m1', label: 1, role: 'subject', note: '', sourceNodeId: 'm1', sourceKind: 'asset' },
          ],
          referenceLabelCounter: 1,
        },
      },
    ],
    edges: [],
    resultAssetIds: { g1: assetId },
  };

  const copied = await canvasCopiesRoute.POST(new Request('http://127.0.0.1/api/canvas/x/copies', {
    method: 'POST',
    body: JSON.stringify(snapshot),
  }), params({ id: canvasId }));
  assert.equal(copied.status, 200);
  const copy = (await body(copied)).copy as Record<string, unknown>;
  const copyNodeId = String((copy.nodes as Array<Record<string, unknown>>)[0].id);
  assert.notEqual(copyNodeId, 'g1');
  assert.deepEqual(copy.nodeIdMap, { g1: copyNodeId });
  assert.equal(copy.idempotentReplay, false);
  graphRevision = Number(copy.graphRevision);
  assert.equal(graphRevision, 2);

  // 副本保留复制时的画面与设置，但不复制任务
  const states = listCanvasNodeStates(db, canvasId);
  const copyState = states.find((state) => state.nodeId === copyNodeId);
  assert.equal(copyState?.currentAssetId, assetId);
  assert.equal(copyState?.activeTaskId, null);
  const originalState = states.find((state) => state.nodeId === imageNodeId);
  assert.equal(originalState?.currentAssetId, assetId);
  assert.equal(originalState?.activeTaskId, null);

  const copiedNode = (copy.nodes as Array<Record<string, unknown>>)[0] as {
    data: { prompt: string; references: Array<Record<string, unknown>>; referenceLabelCounter: number };
    position: { x: number; y: number };
  };
  assert.equal(copiedNode.data.prompt, '把 @参考1 放到客厅');
  // 外部输入继续引用原来源，编号稳定
  assert.equal(copiedNode.data.references[0].sourceNodeId, 'm1');
  assert.equal(copiedNode.data.references[0].label, 1);
  assert.equal(copiedNode.position.x, 260 + 48);
  assert.equal('currentAssetId' in copiedNode.data, false);

  const readBack = await canvasItemRoute.GET(new Request('http://127.0.0.1/api/canvas/x'), params({ id: canvasId }));
  const readCanvas = (await body(readBack)).canvas as { graph: { nodes: unknown[] } };
  assert.equal(readCanvas.graph.nodes.length, 3);

  // 同一 snapshotKey 重试：幂等，不再新增节点、不再推进修订号
  const replay = await canvasCopiesRoute.POST(new Request('http://127.0.0.1/api/canvas/x/copies', {
    method: 'POST',
    body: JSON.stringify(snapshot),
  }), params({ id: canvasId }));
  assert.equal(replay.status, 200);
  const replayed = (await body(replay)).copy as Record<string, unknown>;
  assert.equal(replayed.idempotentReplay, true);
  assert.deepEqual(replayed.nodeIdMap, { g1: copyNodeId });
  assert.equal(replayed.graphRevision, 2);

  const afterReplay = await canvasItemRoute.GET(new Request('http://127.0.0.1/api/canvas/x'), params({ id: canvasId }));
  assert.equal(((await body(afterReplay)).canvas as { graph: { nodes: unknown[] } }).graph.nodes.length, 3);

  // 跨画布复制明确拒绝
  const crossCanvas = await canvasCopiesRoute.POST(new Request('http://127.0.0.1/api/canvas/x/copies', {
    method: 'POST',
    body: JSON.stringify({ ...snapshot, sourceCanvasId: 'other-canvas', snapshotKey: 'paste-2' }),
  }), params({ id: canvasId }));
  assert.equal(crossCanvas.status, 403);
  assert.equal((await body(crossCanvas)).error, 'forbidden');

  // 快照引用不属于本画布的素材 → 400，不产生副本
  const foreignAsset = await canvasCopiesRoute.POST(new Request('http://127.0.0.1/api/canvas/x/copies', {
    method: 'POST',
    body: JSON.stringify({
      ...snapshot,
      snapshotKey: 'paste-3',
      resultAssetIds: { g1: 'foreign-asset' },
    }),
  }), params({ id: canvasId }));
  assert.equal(foreignAsset.status, 400);

  // 快照引用画布外的节点来源 → 400
  const ghostSource = await canvasCopiesRoute.POST(new Request('http://127.0.0.1/api/canvas/x/copies', {
    method: 'POST',
    body: JSON.stringify({
      ...snapshot,
      snapshotKey: 'paste-4',
      nodes: [{
        ...(snapshot.nodes[0] as Record<string, unknown>),
        data: {
          ...(snapshot.nodes[0] as { data: Record<string, unknown> }).data,
          references: [{ refId: 'ref-ghost', label: 1, role: 'subject', note: '', sourceNodeId: 'ghost', sourceKind: 'asset' }],
        },
      }],
    }),
  }), params({ id: canvasId }));
  assert.equal(ghostSource.status, 400);

  // 快照内部连线必须两端都在范围内
  const externalEdge = await canvasCopiesRoute.POST(new Request('http://127.0.0.1/api/canvas/x/copies', {
    method: 'POST',
    body: JSON.stringify({
      ...snapshot,
      snapshotKey: 'paste-5',
      edges: [{ id: 'e1', source: 'm1', target: 'g1' }],
    }),
  }), params({ id: canvasId }));
  assert.equal(externalEdge.status, 400);
}

// --- 删除节点：图与运行状态分离 -----------------------------------------------

{
  const { getDb } = await import('../lib/db.ts');
  const { saveCanvasGraph, listCanvasNodeStates } = await import('../lib/creative-canvas/repository.ts');
  const db = getDb();
  const current = await canvasItemRoute.GET(new Request('http://127.0.0.1/api/canvas/x'), params({ id: canvasId }));
  const canvas = (await body(current)).canvas as { graphRevision: number; graph: { schemaVersion: number; nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } };
  const withoutMaterial = {
    ...canvas.graph,
    nodes: canvas.graph.nodes.filter((node) => node.id !== 'm1'),
    edges: canvas.graph.edges.filter((edge) => edge.source !== 'm1' && edge.target !== 'm1'),
  };
  const saved = saveCanvasGraph({
    db,
    canvasId,
    expectedGraphRevision: canvas.graphRevision,
    graph: withoutMaterial,
  });
  assert.equal(saved.graphRevision, canvas.graphRevision + 1);
  const tombstoned = listCanvasNodeStates(db, canvasId).find((state) => state.nodeId === 'm1');
  // 删除保留身份记录（tombstone），并递增 epoch 让旧任务失去发布权
  assert.equal(tombstoned?.deleted, true);
  assert.equal(tombstoned?.nodeEpoch, 2);
  // 生成节点的参考槽位保留，成为失效引用
  const generationNode = saved.graph.nodes.find((node) => node.id === imageNodeId) as { data: { references: unknown[] } };
  assert.equal(generationNode.data.references.length, 1);

  // 撤销删除：恢复编辑定义，但不恢复旧运行状态，也不重置 epoch
  const restored = saveCanvasGraph({
    db,
    canvasId,
    expectedGraphRevision: saved.graphRevision,
    graph: canvas.graph,
  });
  const restoredState = listCanvasNodeStates(db, canvasId).find((state) => state.nodeId === 'm1');
  assert.equal(restoredState?.deleted, false);
  assert.equal(restoredState?.nodeEpoch, 2);
  assert.equal(restoredState?.activeTaskId, null);
  assert.equal(restored.graph.nodes.some((node) => node.id === 'm1'), true);

  // 删除生成节点再撤销：已有画面保留，但删除前启动的旧任务永久失去发布权
  const withoutGeneration = {
    ...restored.graph,
    nodes: restored.graph.nodes.filter((node) => node.id !== imageNodeId),
    edges: restored.graph.edges.filter((edge) => edge.source !== imageNodeId && edge.target !== imageNodeId),
  };
  const deletedGeneration = saveCanvasGraph({
    db,
    canvasId,
    expectedGraphRevision: restored.graphRevision,
    graph: withoutGeneration,
  });
  const generationDeleted = listCanvasNodeStates(db, canvasId).find((state) => state.nodeId === imageNodeId);
  assert.equal(generationDeleted?.deleted, true);
  assert.equal(generationDeleted?.nodeEpoch, 2);
  assert.equal(generationDeleted?.currentAssetId, assetId);

  const restoredGeneration = saveCanvasGraph({
    db,
    canvasId,
    expectedGraphRevision: deletedGeneration.graphRevision,
    graph: restored.graph,
  });
  const generationRestored = listCanvasNodeStates(db, canvasId).find((state) => state.nodeId === imageNodeId);
  assert.equal(generationRestored?.deleted, false);
  assert.equal(generationRestored?.nodeEpoch, 2);
  assert.equal(generationRestored?.currentAssetId, assetId);

  const { publishCanvasNodeResult } = await import('../lib/creative-canvas/repository.ts');
  const stalePublish = publishCanvasNodeResult({
    db,
    canvasId,
    nodeId: imageNodeId,
    taskId: 'task-1',
    nodeEpoch: 1,
    assetId,
  });
  assert.deepEqual(stalePublish, { published: false, reason: 'epoch_mismatch' });
  graphRevision = restoredGeneration.graphRevision;
}

// --- 模型能力接口 -------------------------------------------------------------

{
  const models = await canvasModelsRoute.GET();
  assert.equal(models.status, 200);
  const payload = await body(models);
  assert.deepEqual(payload.models, []);
  assert.equal(payload.executor, 'disabled');
}

{
  const { closeDb } = await import('../lib/db.ts');
  closeDb();
}

fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-api.test.ts 通过');
