import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-draft-final-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'company';
register('./typescript-extension-loader.mjs', import.meta.url);
const { CREATIVE_CANVAS_MIGRATIONS } = await import('../lib/creative-canvas/schema.ts');
const { directSeedanceCapability } = await import('../lib/creative-canvas/adapters/seedance-capabilities.ts');
const { registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { createCanvas, requireCanvas, saveCanvasGraph, listCanvasNodeCandidates, publishCanvasNodeResult } = await import('../lib/creative-canvas/repository.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const { SEEDANCE_25 } = await import('../lib/video-providers/seedance-contract.ts');
const db = new Database(':memory:');
try {
  db.pragma('foreign_keys = ON');
  for (const migration of CREATIVE_CANVAS_MIGRATIONS) db.exec(migration.sql);
  const capability = directSeedanceCapability(SEEDANCE_25);
  registerCanvasCapability(capability);
  const canvas = createCanvas(db, { name: '样片直接转正式' });
  const at = new Date().toISOString();
  function asset(id: string) {
    db.prepare(`INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, createdAt)
      VALUES (?, ?, 'video', ?, ?, 'video/mp4', 1, ?)`).run(id, canvas.id, id, id, at);
  }
  asset('draft');
  db.prepare(`INSERT INTO creative_canvas_tasks
    (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot, providerTaskId, outputAssetId, createdAt, updatedAt)
    VALUES ('draft-task', ?, 'old-producer', 1, 'video', 'succeeded', ?, ?, 'remote-draft', 'draft', ?, ?)`)
    .run(canvas.id, JSON.stringify({ capabilityKey: capability.key, providerIdentity: capability.providerIdentity, modelAlias: SEEDANCE_25 }),
      JSON.stringify({ generationMode: 'reference-to-video', prompt: '原提示词', parameters: { generationStage: 'draft', durationSec: 15, withAudio: true } }), at, at);
  db.prepare("INSERT INTO creative_canvas_video_metadata VALUES ('draft-task', ?)").run(JSON.stringify({
    stage: 'draft', model: SEEDANCE_25, draftConfirmed: true, remoteCreatedAt: at, expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  }));
  const sample = { id: 'sample', kind: 'material' as const, position: { x: 0, y: 0 },
    data: { title: '样片', assetId: 'draft', mediaKind: 'video' as const } };
  const saved = saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: 0, graph: { schemaVersion: 1, nodes: [sample], edges: [] } });
  const request = { canvasId: canvas.id, mode: 'single' as const, targetNodeId: 'sample', draftAssetId: 'draft',
    expectedGraphRevision: saved.graphRevision, requestKey: 'final-click' };
  const started = startCanvasRun({ db, request });
  assert.equal(started.tasks.length, 1);
  assert.equal(started.tasks[0].nodeId, 'sample');
  assert.equal(started.plan.tasks[0].parameters.generationStage, 'final-from-draft');
  assert.equal(started.plan.tasks[0].parameters.draftAssetId, 'draft');
  assert.equal(started.plan.tasks[0].capabilityKey, capability.key);
  assert.equal('outputFormat' in started.plan.tasks[0].parameters, false);
  assert.deepEqual(started.plan.tasks[0].inputs, [], '样片身份不能变成普通视频参考');
  assert.equal(requireCanvas(db, canvas.id).graph.nodes.length, 1, '转正式不得创建生成节点');
  assert.deepEqual(requireCanvas(db, canvas.id).graph.nodes[0], sample);
  const replay = startCanvasRun({ db, request });
  assert.equal(replay.tasks[0].id, started.tasks[0].id, '重复提交返回同一任务');
  assert.throws(() => startCanvasRun({ db, request: { ...request, draftAssetId: 'different' } }), /同一请求/);
  assert.throws(() => startCanvasRun({ db, request: { ...request, requestKey: 'wrong-asset', draftAssetId: 'different' } }), /样片/);

  asset('formal');
  db.prepare("UPDATE creative_canvas_tasks SET phase = 'succeeded', outputAssetId = 'formal' WHERE id = ?").run(started.tasks[0].id);
  const task = getCanvasTask(db, started.tasks[0].id)!;
  assert.equal(publishCanvasNodeResult({ db, canvasId: canvas.id, nodeId: 'sample', taskId: task.id, nodeEpoch: task.nodeEpoch, assetId: 'formal' }).published, true);
  assert.equal(listCanvasNodeCandidates(db, canvas.id).find(c => c.assetId === 'formal')?.materialized, false);
  const finalNode = { ...sample, id: 'formal-result', position: { x: 350, y: 0 }, data: { ...sample.data, title: '正式版', assetId: 'formal' } };
  const graph = { schemaVersion: 1, nodes: [sample, finalNode], edges: [{ id: 'lineage', source: 'sample', target: 'formal-result', sourceHandle: 'draft-final' }] };
  const presented = saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });
  assert.equal(listCanvasNodeCandidates(db, canvas.id).find(c => c.assetId === 'formal')?.materialized, true);
  saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: presented.graphRevision, graph: { ...graph, nodes: [sample], edges: [] } });
  assert.equal(listCanvasNodeCandidates(db, canvas.id).find(c => c.assetId === 'formal')?.materialized, true,
    '用户主动删除结果后，展示回执仍须保留，不能在返回画布时复活');
  // Unseen completions are never truncated by the recent-12 history window.
  for (let index = 0; index < 16; index++) {
    const id = 'unseen-' + index;
    asset(id);
    db.prepare(`INSERT INTO creative_canvas_tasks
      (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot, outputAssetId, createdAt, updatedAt)
      VALUES (?, ?, 'many', 1, 'video', 'succeeded', '{}', '{}', ?, ?, ?)`).run('task-' + id, canvas.id, id, at, at);
  }
  assert.equal(listCanvasNodeCandidates(db, canvas.id).filter(c => c.nodeId === 'many').length, 16);
  const current = requireCanvas(db, canvas.id);
  const manyNodes = Array.from({ length: 16 }, (_, index) => ({
    ...sample, id: 'unseen-node-' + index, data: { ...sample.data, assetId: 'unseen-' + index },
  }));
  saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: current.graphRevision,
    graph: { ...current.graph, nodes: [...current.graph.nodes, ...manyNodes] } });
  assert.equal(listCanvasNodeCandidates(db, canvas.id).filter(c => c.nodeId === 'many').length, 12, '已展示历史继续限制为 12 条');

  const legacy = new Database(':memory:');
  try {
    for (const migration of CREATIVE_CANVAS_MIGRATIONS.filter(m => m.version < 5)) legacy.exec(migration.sql);
    const oldCanvas = createCanvas(legacy, { name: 'v4 existing results' });
    legacy.prepare(`INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, createdAt)
      VALUES ('old-result', ?, 'video', 'old.mp4', 'hash', 'video/mp4', 1, ?)`).run(oldCanvas.id, at);
    legacy.prepare('UPDATE creative_canvases SET graphJson = ? WHERE id = ?').run(JSON.stringify({
      schemaVersion: 1, nodes: [{ ...sample, data: { ...sample.data, assetId: 'old-result' } }], edges: [],
    }), oldCanvas.id);
    legacy.exec(CREATIVE_CANVAS_MIGRATIONS.find(m => m.version === 5)!.sql);
    assert.deepEqual(legacy.prepare('SELECT * FROM creative_canvas_result_presentations').all(),
      [{ assetId: 'old-result', canvasId: oldCanvas.id }], '升级时给已在旧图中的结果补展示回执');
  } finally { legacy.close(); }
  // Legacy company nodes may retain obsolete format/watermark defaults in saved graphs.
  const companyCapability = { ...capability, key: 'company-draft-final-fixture', providerKind: 'company' as const,
    providerIdentity: 'company-draft-final-provider' };
  registerCanvasCapability(companyCapability);
  db.prepare("UPDATE creative_canvas_tasks SET providerSnapshot = ? WHERE id = 'draft-task'").run(JSON.stringify({
    capabilityKey: companyCapability.key, providerIdentity: companyCapability.providerIdentity, modelAlias: SEEDANCE_25,
  }));
  const beforeLegacy = requireCanvas(db, canvas.id);
  const legacyNode = { id: 'legacy-final', kind: 'video-generation' as const, position: { x: 600, y: 0 }, data: {
    title: 'Legacy Final', modelKey: companyCapability.key, generationMode: 'reference-to-video', prompt: '', references: [], referenceLabelCounter: 0,
    parameters: { generationStage: 'final-from-draft', draftAssetId: 'draft', resolution: '1080p', watermark: true, outputFormat: 'mov', returnLastFrame: false },
  } };
  saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: beforeLegacy.graphRevision,
    graph: { ...beforeLegacy.graph, nodes: [...beforeLegacy.graph.nodes, legacyNode] } });
  const legacyFinal = startCanvasRun({ db, request: { canvasId: canvas.id, mode: 'single', targetNodeId: legacyNode.id, requestKey: 'legacy-company-final' } });
  assert.deepEqual(legacyFinal.plan.tasks[0].parameters,
    { generationStage: 'final-from-draft', draftAssetId: 'draft', resolution: '1080p' },
    '公司转正式快照不能保留格式、水印或尾帧参数');
  console.log('creative-canvas-draft-final.test.ts passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
