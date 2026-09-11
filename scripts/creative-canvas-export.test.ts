import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { registerFixtureCanvasCapabilities } from '../lib/creative-canvas/adapters/fixture-capabilities.ts';
import { canvasStorageRoot, importCanvasAsset, registerCanvasResultAsset } from '../lib/creative-canvas/assets.ts';
import { createCanvas, publishCanvasNodeResult, saveCanvasGraph, setCanvasNodeActiveTask } from '../lib/creative-canvas/repository.ts';
import { createCanvasExport, requireCanvasExport, sanitizeCanvasExportFilename, uniqueCanvasExportFilename } from '../lib/creative-canvas/export.ts';
import type { CanvasGraphEdge, CanvasGraphNode } from '../lib/creative-canvas/types.ts';

/**
 * T6：导出。
 *
 * 断言的是真实压缩包内容：清单、条目名、内容 hash、缺失文件报错、
 * 导出期间节点换结果不影响已固定的 manifest，以及重名不互相覆盖。
 */

process.env.CREATIVE_STUDIO_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-export-'));
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'fixture';

const root = process.env.CREATIVE_STUDIO_DATA_ROOT;
const storageRoot = canvasStorageRoot(root);
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const migrated = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migrated.state, 'ready');
registerFixtureCanvasCapabilities();

const canvas = createCanvas(db, { name: '导出验证画布' });

function revision(): number {
  const row = db.prepare(`SELECT graphRevision FROM creative_canvases WHERE id = ?`).get(canvas.id) as { graphRevision: number };
  return Number(row.graphRevision);
}

function imageNode(id: string, title: string): CanvasGraphNode {
  return {
    id,
    kind: 'image-generation',
    position: { x: 0, y: 0 },
    data: {
      title,
      modelKey: 'fixture-image-edit',
      generationMode: 'image-to-image',
      prompt: '',
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

function promptNode(id: string, title: string): CanvasGraphNode {
  return { id, kind: 'prompt', position: { x: 0, y: 120 }, data: { title, text: '文本' } };
}

async function makeResultAsset(suffix: string, size = 16): Promise<string> {
  const data = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: size % 200, g: 90, b: 140 } },
  }).png().toBuffer();
  // 产物的扩展名来自媒体类型
  const asset = await registerCanvasResultAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    taskId: `task-${suffix}`,
    mediaKind: 'image',
    mimeType: 'image/png',
    data,
  });
  return asset.id;
}

/** 用真实发布路径把某个产物挂到节点当前结果上。 */
function publish(nodeId: string, assetId: string): void {
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

function save(nodes: CanvasGraphNode[], edges: CanvasGraphEdge[] = []) {
  return saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: revision(), graph: { schemaVersion: 1, nodes, edges } });
}

/** 读取 ZIP 的中央目录，列出条目名（不依赖解压工具）。 */
function readZipEntryNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) === 0x04034b50) {
      const nameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);
      const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      names.push(name);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      offset += 30 + nameLength + extraLength + compressedSize;
      continue;
    }
    offset += 1;
  }
  return names;
}

// --- 1. 文件名清洗与重名 ------------------------------------------------------

{
  assert.equal(sanitizeCanvasExportFilename('a/b\\c.png'), 'a_b_c.png');
  assert.equal(sanitizeCanvasExportFilename('...hidden.png'), 'hidden.png');
  assert.equal(sanitizeCanvasExportFilename(''), 'result');
  const used = new Set<string>();
  assert.equal(uniqueCanvasExportFilename('沙发.png', used), '沙发.png');
  assert.equal(uniqueCanvasExportFilename('沙发.png', used), '沙发-2.png');
  assert.equal(uniqueCanvasExportFilename('沙发.png', used), '沙发-3.png');
}

// --- 2. 正常导出：清单固定、内容 hash 一致、跳过项有理由 ----------------------

let firstExportId = '';
const firstAssetId = await makeResultAsset('a');
const secondAssetId = await makeResultAsset('b', 24);
{
  save([imageNode('g1', '沙发场景'), imageNode('g2', '沙发场景'), imageNode('g3', '空结果'), promptNode('p1', '提示词')]);
  publish('g1', firstAssetId);
  publish('g2', secondAssetId);

  const record = await createCanvasExport({
    db,
    canvasId: canvas.id,
    storageRoot,
    nodeIds: ['g1', 'g2', 'g3', 'p1'],
  });
  firstExportId = record.id;
  assert.equal(record.status, 'ready');
  assert.equal(record.manifest.items.length, 2);
  // 同名节点不互相覆盖
  const filenames = record.manifest.items.map((item) => item.filename);
  assert.deepEqual(filenames, ['沙发场景.png', '沙发场景-2.png']);
  // 跳过项说明原因，不静默少文件
  assert.deepEqual(
    record.manifest.skipped.map((skip) => [skip.nodeId, skip.reason]).sort(),
    [['g3', 'no_result'], ['p1', 'not_exportable']],
  );
  // 内容 hash 与磁盘文件一致
  for (const item of record.manifest.items) {
    const asset = db.prepare(`SELECT relativePath FROM creative_canvas_assets WHERE id = ?`).get(item.assetId) as { relativePath: string };
    const bytes = fs.readFileSync(path.join(storageRoot, asset.relativePath));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    assert.equal(bytes.byteLength, item.byteSize);
  }

  const zipPath = path.join(storageRoot, record.zipRelativePath ?? '');
  assert.equal(fs.existsSync(zipPath), true);
  const zipBuffer = fs.readFileSync(zipPath);
  const entries = readZipEntryNames(zipBuffer);
  assert.deepEqual(entries.sort(), ['manifest.json', '沙发场景-2.png', '沙发场景.png'].sort());
}

// --- 3. 导出期间节点换结果：manifest 与内容都不变 -----------------------------

{
  const record = requireCanvasExport(db, firstExportId);
  const zipPath = path.join(storageRoot, record.zipRelativePath ?? '');
  const before = fs.readFileSync(zipPath);
  const beforeHashes = record.manifest.items.map((item) => item.sha256);

  // 打包已完成后 g1 又生成了新结果
  const replacement = await makeResultAsset('replacement', 40);
  publish('g1', replacement);

  const after = requireCanvasExport(db, firstExportId);
  assert.deepEqual(after.manifest.items.map((item) => item.sha256), beforeHashes, '已固定的 manifest 不得被后来的结果改变');
  assert.deepEqual(fs.readFileSync(zipPath), before, '已经生成的 ZIP 内容不变');

  // 重新导出才会带上新结果
  const refreshed = await createCanvasExport({ db, canvasId: canvas.id, storageRoot, nodeIds: ['g1'] });
  assert.equal(refreshed.manifest.items[0].assetId, replacement);
}

// --- 4. 缺失文件：明确指出是哪一项，不报告完整成功 ----------------------------

{
  const orphan = await makeResultAsset('orphan', 20);
  publish('g2', orphan);
  const assetRow = db.prepare(`SELECT relativePath FROM creative_canvas_assets WHERE id = ?`).get(orphan) as { relativePath: string };
  const absolute = path.join(storageRoot, assetRow.relativePath);
  fs.rmSync(absolute);

  await assert.rejects(
    () => createCanvasExport({ db, canvasId: canvas.id, storageRoot, nodeIds: ['g2'] }),
    (error: unknown) => (error as { code?: string }).code === 'conflict'
      && String((error as Error).message).includes('沙发场景'),
  );
}

// --- 5. 空选择与全无结果：不生成空 ZIP ---------------------------------------

{
  await assert.rejects(
    () => createCanvasExport({ db, canvasId: canvas.id, storageRoot, nodeIds: [] }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_input',
  );
  await assert.rejects(
    () => createCanvasExport({ db, canvasId: canvas.id, storageRoot, nodeIds: ['g3'] }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_input',
  );
}

// --- 6. 导出不占生成名额、不调用模型 ------------------------------------------

{
  const held = db.prepare(`SELECT COUNT(*) AS count FROM creative_canvas_tasks WHERE slotHeld = 1`).get() as { count: number };
  assert.equal(Number(held.count), 0, '导出不应占用生成名额');
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-export.test.ts 通过');
