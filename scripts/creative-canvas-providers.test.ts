import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { clearCanvasCapabilities, registerCanvasCapability } from '../lib/creative-canvas/capabilities.ts';
import { COMPANY_CANVAS_CAPABILITIES, COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY } from '../lib/creative-canvas/adapters/company-capabilities.ts';
import { createCanvasExecutorAdapter } from '../lib/creative-canvas/adapters/index.ts';
import { registerExternalCanvasCapabilities } from '../lib/creative-canvas/adapters/external-capabilities.ts';
import { createDefaultCanvasDeliverer, type CanvasMediaDeliverer } from '../lib/creative-canvas/adapters/media-delivery.ts';
import { canvasStorageRoot, importCanvasAsset } from '../lib/creative-canvas/assets.ts';
import { createCanvas, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { runCanvasTask } from '../lib/creative-canvas/runner.ts';
import { claimCanvasTasks, getCanvasTask, listCanvasTasks } from '../lib/creative-canvas/tasks.ts';
import { snapCompanyVideoSize, companyVideoCapsForModel } from '../lib/company-gateway-size.ts';
import type { CanvasGenerationMode, CanvasGraphEdge, CanvasGraphNode, CanvasMediaKind } from '../lib/creative-canvas/types.ts';

/**
 * T4：公司模型的画布请求捕获。
 *
 * 用本地 HTTP 上游捕获真实请求体，断言「应用构造了预期请求」，并验证
 * 缺能力、缺 COS、非法组合、中止信号这些情况下**生成 POST 为零**。
 * 这不证明公司网关继续转发了所有字段——那需要 P7 的真实样本。
 */

process.env.CREATIVE_STUDIO_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-providers-'));
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'company';
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';

const root = process.env.CREATIVE_STUDIO_DATA_ROOT;
const storageRoot = canvasStorageRoot(root);
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 画布模块只建自己的表；供应商路由表属于核心库，这里按 lib/db.ts 的定义补最小结构。
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'gpt-image-2',
    type TEXT NOT NULL DEFAULT 'openai-compatible',
    enabled INTEGER NOT NULL DEFAULT 1,
    defaultCostPerImage REAL
  );
  CREATE TABLE IF NOT EXISTS video_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    baseUrlEnv TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL,
    modelEnv TEXT NOT NULL,
    defaultModel TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    defaultDurationSec INTEGER NOT NULL DEFAULT 5,
    defaultCostPerVideo REAL,
    baseUrl TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '',
    accessKey TEXT NOT NULL DEFAULT '',
    secretKey TEXT NOT NULL DEFAULT ''
  );
`);
const migrated = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migrated.state, 'ready');

// --- 本地捕获上游 -------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
  authorization: string | undefined;
}

const captured: CapturedRequest[] = [];
const resultPng = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3d6b8f' } }).png().toBuffer();
const resultMp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(128, 5),
]);

const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    captured.push({
      method: request.method ?? '',
      url: request.url ?? '',
      body,
      authorization: request.headers.authorization,
    });
    if (request.method === 'POST' && request.url === '/v1/videos') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'gateway-task-1', status: 'queued' }));
      return;
    }
    // 外部图片供应商：OpenAI 风格同步出图
    if (request.method === 'POST' && (request.url === '/v1/images/generations' || request.url === '/v1/images/edits')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: resultPng.toString('base64') }] }));
      return;
    }
    // 方舟直连：文生／图生视频的任务创建与查询
    if (request.method === 'POST' && request.url === '/contents/generations/tasks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'ark-task-1' }));
      return;
    }
    if (request.method === 'GET' && /^\/contents\/generations\/tasks\/[^/]+$/.test(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'ark-task-1',
        status: 'succeeded',
        content: { video_url: `http://127.0.0.1:${port}/files/result` },
      }));
      return;
    }
    if (request.method === 'GET' && /^\/v1\/videos\/[^/]+$/.test(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'gateway-task-1',
        status: 'completed',
        metadata: { url: `http://127.0.0.1:${port}/files/result` },
      }));
      return;
    }
    if (request.method === 'GET' && request.url === '/files/result') {
      const isImage = (request.headers.authorization ?? '').includes('image-key');
      response.writeHead(200, { 'content-type': isImage ? 'image/png' : 'video/mp4' });
      response.end(isImage ? resultPng : resultMp4);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"not found"}}');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
const baseUrl = `http://127.0.0.1:${port}`;

// --- 供应商路由与能力 ---------------------------------------------------------

const insertVideoProvider = db.prepare(`
  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
  VALUES (?, ?, 'openai-video', '', '', '', ?, 1, 5, ?, ?, '', '')
`);
insertVideoProvider.run('company-qiniuyun-kling-3-0', '公司七牛可灵 3.0', 'qiniuyun/kling-3.0', baseUrl, 'video-key');
insertVideoProvider.run('company-seedance-2-5', '公司即梦 Seedance 2.5', 'doubao-seedance-2-5-260628', baseUrl, 'video-key');
insertVideoProvider.run('company-kling-3-0', '公司可灵 3.0', 'kling-3.0', baseUrl, 'video-key');
db.prepare(`
  INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
  VALUES ('company-gateway-image2-medium', '公司网关 image2-medium', ?, '', 'image-key', 'image2-medium', 'gateway-task-image', 1)
`).run(baseUrl);

clearCanvasCapabilities();
for (const capability of COMPANY_CANVAS_CAPABILITIES) registerCanvasCapability(capability);

/** 测试交付：不访问真实 COS，按「角色 + 落盘文件名」给出可断言的假签名地址。 */
const fakeDeliverer: CanvasMediaDeliverer = {
  name: 'test-fake',
  async deliver(request) {
    return `https://cos.test/${request.role}/${path.basename(request.absolutePath)}?sign=fake`;
  },
};

function expectedRef(assetId: string, role: string): string {
  const row = db.prepare(
    `SELECT relativePath FROM creative_canvas_assets WHERE id = ?`,
  ).get(assetId) as { relativePath: string };
  return `https://cos.test/${role}/${path.basename(row.relativePath)}?sign=fake`;
}

function companyAdapter(deliverer: CanvasMediaDeliverer = fakeDeliverer) {
  // 用真实执行器入口：它会按能力表的 providerKind 在公司／外部适配器之间分流
  return createCanvasExecutorAdapter({ db, storageRoot }, { deliverer });
}

// --- 画布与素材 ---------------------------------------------------------------

const canvas = createCanvas(db, { name: '公司通道请求捕获' });

async function makeAsset(name: string, kind: 'image' | 'video' = 'image'): Promise<string> {
  // 每份素材内容不同：内容哈希去重会把完全相同的文件合并成同一资产
  const seed = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const data = kind === 'image'
    ? await sharp({
      create: {
        width: 24,
        height: 32,
        channels: 3,
        background: { r: seed % 200, g: (seed * 3) % 200, b: (seed * 7) % 200 },
      },
    }).png().toBuffer()
    : Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(64, seed % 251)]);
  const asset = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: name,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    data,
  });
  return asset.id;
}

const firstFrameAsset = await makeAsset('首帧.png');
const lastFrameAsset = await makeAsset('尾帧.png');
const extraRefAsset = await makeAsset('参考.png');
const videoRefAsset = await makeAsset('参考视频.mp4', 'video');

function material(id: string, assetId: string, mediaKind: CanvasMediaKind = 'image'): CanvasGraphNode {
  return { id, kind: 'material', position: { x: 0, y: 0 }, data: { title: id, assetId, mediaKind } };
}

function videoNode(
  id: string,
  modelKey: string,
  parameters: Record<string, string | number | boolean> = {},
  generationMode: CanvasGenerationMode = 'image-to-video',
): CanvasGraphNode {
  return {
    id,
    kind: 'video-generation',
    position: { x: 400, y: 0 },
    data: {
      title: id,
      modelKey,
      generationMode,
      prompt: '让镜头缓慢推进',
      parameters,
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

function imageNode(id: string, modelKey: string, parameters: Record<string, string | number | boolean> = {}): CanvasGraphNode {
  return {
    id,
    kind: 'image-generation',
    position: { x: 400, y: 0 },
    data: {
      title: id,
      modelKey,
      generationMode: 'image-to-image',
      prompt: '把产品放到明亮的客厅里',
      parameters,
      references: [],
      referenceLabelCounter: 0,
    },
  };
}

function save(nodes: CanvasGraphNode[], edges: CanvasGraphEdge[]) {
  return saveCanvasGraph({
    db,
    canvasId: canvas.id,
    expectedGraphRevision: currentRevision(),
    graph: { schemaVersion: 1, nodes, edges },
  });
}

function currentRevision(): number {
  const row = db.prepare(`SELECT graphRevision FROM creative_canvases WHERE id = ?`).get(canvas.id) as { graphRevision: number };
  return Number(row.graphRevision);
}

/** 走真实 planner → 幂等创建 → 领取 → 执行器，返回本次任务的提交计数。 */
async function runOnce(
  targetNodeId: string,
  adapter = companyAdapter(),
  options: { signal?: AbortSignal } = {},
): Promise<{
  body: Record<string, unknown> | null;
  posts: number;
  phase: string;
  errorCode: string | null;
  errorMessage: string | null;
}> {
  const before = captured.filter((entry) => entry.method === 'POST').length;
  startCanvasRun({
    db,
    request: {
      canvasId: canvas.id,
      mode: 'single',
      targetNodeId,
      requestKey: `req-${crypto.randomUUID()}`,
    },
  });
  const claimed = claimCanvasTasks({ db, workerId: 't4-worker', limit: 1 });
  assert.equal(claimed.length, 1, '任务应能被领取');
  const { task, fence } = claimed[0];
  assert.equal(task.nodeId, targetNodeId, '领取到的必须是本次目标节点的任务');
  await runCanvasTask({
    db,
    taskId: task.id,
    adapter,
    workerId: 't4-worker',
    fence,
    storageRoot,
    pollIntervalMs: 1,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const posts = captured.filter((entry) => entry.method === 'POST').length - before;
  const post = captured.filter((entry) => entry.method === 'POST')[captured.filter((entry) => entry.method === 'POST').length - 1];
  const settled = getCanvasTask(db, task.id);
  return {
    body: posts > 0 ? JSON.parse(post.body) as Record<string, unknown> : null,
    posts,
    phase: settled?.phase ?? 'unknown',
    errorCode: settled?.errorCode ?? null,
    errorMessage: settled?.errorMessage ?? null,
  };
}

// --- 1. 七牛可灵 3.0：首帧 images[0] + 尾帧 end_image_url ----------------------

{
  const saved = save([
    material('m-first', firstFrameAsset),
    material('m-last', lastFrameAsset),
    videoNode('v-qiniu', COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.key, { durationSec: 6, multiShot: false }),
  ], [
    { id: 'e1', source: 'm-first', target: 'v-qiniu' },
    { id: 'e2', source: 'm-last', target: 'v-qiniu' },
  ]);
  // 角色改成首帧／尾帧，模拟用户在节点里显式标注用途
  const graph = saved.graph;
  const node = graph.nodes.find((candidate) => candidate.id === 'v-qiniu');
  assert.ok(node && node.kind === 'video-generation');
  node.data.references = node.data.references.map((slot) => ({
    ...slot,
    role: slot.sourceNodeId === 'm-first' ? 'first-frame' : 'last-frame',
  }));
  saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });

  const result = await runOnce('v-qiniu');
  assert.equal(result.posts, 1, '已映射组合必须恰好一次 POST');
  assert.equal(result.phase, 'succeeded');
  const body = result.body;
  assert.ok(body);
  assert.equal(body.model, 'qiniuyun/kling-3.0');
  assert.equal(body.mode, 'pro');
  assert.equal(body.generate_audio, true);
  assert.equal(body.multi_shot, false, '关闭智能分镜必须显式传 false');
  assert.equal(body.shot_type, undefined);
  assert.equal(body.seconds, '6');
  assert.equal(body.end_image_url, expectedRef(lastFrameAsset, 'last-frame'));
  assert.deepEqual(body.images, [expectedRef(firstFrameAsset, 'first-frame')]);
  assert.equal(body.LastFrameUrl, undefined, '七牛不使用腾讯 LastFrameUrl');
  // 1K 名义尺寸按首帧比例吸附（3:4）
  const expectedSize = snapCompanyVideoSize(24, 32, companyVideoCapsForModel('qiniuyun/kling-3.0')!);
  assert.equal(body.size, expectedSize);
  assert.match(String(body.size), /^\d+x\d+$/);
  assert.equal(body.response_format, undefined, '七牛渠道不发 response_format');

  // 每张参考图都走了 COS 预签名交付
  const delivererCalls = captured.filter((entry) => entry.url.startsWith('/files/'));
  void delivererCalls;
}

// --- 2. Seedance 2.5：双图参考 + 1080p size -----------------------------------

{
  const saved = save([
    material('m-a', firstFrameAsset),
    material('m-b', lastFrameAsset),
    videoNode('v-seedance', 'company-seedance-2-5', { durationSec: 5 }),
  ], [
    { id: 'e1', source: 'm-a', target: 'v-seedance' },
    { id: 'e2', source: 'm-b', target: 'v-seedance' },
  ]);
  void saved;
  const result = await runOnce('v-seedance');
  const body = result.body;
  assert.ok(body);
  assert.equal(result.posts, 1);
  assert.equal(body.model, 'doubao-seedance-2-5-260628');
  assert.equal(Array.isArray(body.images), true);
  assert.equal((body.images as string[]).length, 2, '双图按参考图模式提交');
  assert.equal(body.LastFrameUrl, undefined);
  assert.equal(body.end_image_url, undefined, '2.5 双图不声明严格首尾帧锚定');
  assert.equal(body.seconds, '5');
  const expectedSize = snapCompanyVideoSize(24, 32, companyVideoCapsForModel('doubao-seedance-2-5-260628')!);
  assert.equal(body.size, expectedSize, '2.5 固定送 1080p 像素表里的 size');
  assert.match(String(body.size), /1080|1920|1664|1248/);
}

// --- 3. 文生视频：不伪造首帧 ---------------------------------------------------

{
  save([videoNode('v-t2v', 'company-seedance-2-5', { durationSec: 5, aspectRatio: '9:16' })], []);
  const result = await runOnce('v-t2v');
  const body = result.body;
  assert.ok(body, `文生视频应发出一次 POST，实际 phase=${result.phase} error=${result.errorCode}/${result.errorMessage}`);
  assert.equal(result.posts, 1);
  assert.equal(body.images, undefined, '纯文本不发送占位首帧');
  assert.equal(body.size, snapCompanyVideoSize(9, 16, companyVideoCapsForModel('doubao-seedance-2-5-260628')!));
}

// --- 4. 图片：无图输入与多参考顺序 --------------------------------------------

{
  save([imageNode('i-t2i', 'company-image2-medium', { aspectRatio: '3:4', resolution: '2K' })], []);
  const result = await runOnce('i-t2i');
  const body = result.body;
  assert.ok(body, `文生图应发出一次 POST，实际 phase=${result.phase} error=${result.errorCode}/${result.errorMessage}`);
  assert.equal(result.posts, 1);
  assert.equal(body.images, undefined, '文生图不伪造底图');
  assert.equal(body.response_format, 'jpeg', 'image2 渠道沿用历史验证过的 jpeg（qiniuyun 才用 png）');
  assert.match(String(body.size), /^\d+x\d+$/);
}

{
  save([
    material('m-1', firstFrameAsset),
    material('m-2', lastFrameAsset),
    material('m-3', extraRefAsset),
    imageNode('i-multi', 'company-image2-medium', { aspectRatio: '1:1', resolution: '2K' }),
  ], [
    { id: 'e1', source: 'm-1', target: 'i-multi' },
    { id: 'e2', source: 'm-2', target: 'i-multi' },
    { id: 'e3', source: 'm-3', target: 'i-multi' },
  ]);
  const result = await runOnce('i-multi');
  const body = result.body;
  assert.ok(body);
  assert.equal(result.posts, 1);
  assert.deepEqual(body.images, [
    expectedRef(firstFrameAsset, 'subject'),
    expectedRef(lastFrameAsset, 'subject'),
    expectedRef(extraRefAsset, 'subject'),
  ], '参考顺序与节点内顺序一致');
}

// --- 5. 未知能力 / 非法组合：POST 为零 ----------------------------------------

{
  const postsBefore = captured.filter((entry) => entry.method === 'POST').length;
  save([videoNode('v-unknown', 'ghost-model', { durationSec: 5 })], []);
  assert.throws(
    () => startCanvasRun({
      db,
      request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-unknown', requestKey: `req-${crypto.randomUUID()}` },
    }),
    (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
  );
  assert.equal(captured.filter((entry) => entry.method === 'POST').length, postsBefore, '能力未开放时 POST 必须为零');
}

{
  const postsBefore = captured.filter((entry) => entry.method === 'POST').length;
  // 参考视频接到不接受视频输入的模型上：能力校验应在提交前拦下
  save([
    material('m-video', videoRefAsset, 'video'),
    videoNode('v-badref', 'company-seedance-2-5', { durationSec: 5 }),
  ], [{ id: 'e1', source: 'm-video', target: 'v-badref' }]);
  assert.throws(
    () => startCanvasRun({
      db,
      request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-badref', requestKey: `req-${crypto.randomUUID()}` },
    }),
    (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
  );
  assert.equal(captured.filter((entry) => entry.method === 'POST').length, postsBefore, '非法组合 POST 必须为零');
}

// --- 6. 缺 COS 的七牛渠道：fail closed ----------------------------------------

{
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];
  }
  save([
    material('m-first2', firstFrameAsset),
    videoNode('v-nocos', COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.key, { durationSec: 6, multiShot: false }),
  ], [{ id: 'e1', source: 'm-first2', target: 'v-nocos' }]);

  const result = await runOnce('v-nocos', companyAdapter(createDefaultCanvasDeliverer()));
  assert.equal(result.posts, 0, '缺 COS 时七牛渠道必须在 POST 前结束');
  assert.equal(result.phase, 'failed');
  const task = listCanvasTasks(db, { canvasId: canvas.id })[0];
  assert.equal(task.errorCode, 'cos_not_configured');
}

// --- 7. 停机信号：已中止时不得发出生成 POST ----------------------------------

{
  save([
    material('m-first3', firstFrameAsset),
    videoNode('v-abort', 'company-seedance-2-5', { durationSec: 5 }),
  ], [{ id: 'e1', source: 'm-first3', target: 'v-abort' }]);

  const controller = new AbortController();
  controller.abort();
  const result = await runOnce('v-abort', companyAdapter(), { signal: controller.signal });
  assert.equal(result.posts, 0, '已中止的信号不得发出生成 POST');
  // 中止发生在提交之前，任务不算已提交：保守进入待核查还是失败，取决于中止时机，
  // 这里只要求「没有生成 POST」这一条硬结论。
  assert.ok(['uncertain', 'failed', 'queued'].includes(result.phase), `实际阶段 ${result.phase}`);
}

// --- 8. 外部（非公司）供应商：同一条画布链路也能用真实 HTTP 跑通 --------------

{
  // 外部网关：库里有行、有 Key、指向可达地址即可；不需要公司内网
  db.prepare(`
    INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES ('external-image-test', '外部测试图片', ?, '', 'image-key-ext', 'ext/image-1', 'gateway-task-image', 1)
  `).run(baseUrl);
  registerCanvasCapability({
    key: 'external-image-1',
    displayName: '外部图片模型（本地假上游）',
    providerKind: 'external',
    providerIdentity: 'external-image-test',
    modelAlias: 'ext/image-1',
    mediaKind: 'image',
    modes: ['text-to-image', 'image-to-image'],
    inputs: [
      { kind: 'image', roles: ['subject', 'reference'], min: 0, max: 3 },
      { kind: 'text', roles: ['reference'], min: 0, max: 1 },
    ],
    parameters: [
      { key: 'aspectRatio', label: '比例', type: 'enum', options: ['1:1', '3:4'], default: '1:1' },
      { key: 'resolution', label: '清晰度', type: 'enum', options: ['1K', '2K'], default: '2K' },
    ],
    cancellation: false,
    evidence: 'candidate',
    evidenceNote: '本地假上游，仅用于验证画布的外部供应商通道；不代表任何真实模型。',
  });

  save([imageNode('i-ext', 'external-image-1', { aspectRatio: '1:1', resolution: '2K' })], []);
  const result = await runOnce('i-ext');
  assert.equal(result.posts, 1, '外部供应商应恰好一次 POST');
  assert.equal(result.phase, 'succeeded', `外部供应商链路应走通：${result.errorCode}/${result.errorMessage}`);
  const body = result.body;
  assert.ok(body);
  assert.equal(body.model, 'ext/image-1');
  assert.equal(body.images, undefined, '文生图不伪造底图');
  assert.equal(body.response_format, undefined, '不替外部网关决定输出格式');
  assert.match(String(body.size), /^\d+x\d+$/);

  // 认证头用的是该外部供应商自己的 Key，而不是公司占位 Key
  const post = captured.filter((entry) => entry.method === 'POST').at(-1);
  assert.equal(post?.authorization, 'Bearer image-key-ext');

  // 产物真实落盘、可下载、可发布到节点
  const task = listCanvasTasks(db, { canvasId: canvas.id })[0];
  assert.ok(task.outputAssetId, '外部链路也要登记本地产物');
  const assetRow = db.prepare(`SELECT mediaKind, byteSize FROM creative_canvas_assets WHERE id = ?`).get(task.outputAssetId) as { mediaKind: string; byteSize: number };
  assert.equal(assetRow.mediaKind, 'image');
  assert.ok(assetRow.byteSize > 0);
  const state = db.prepare(
    `SELECT currentAssetId FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = 'i-ext'`,
  ).get(canvas.id) as { currentAssetId: string | null };
  assert.equal(state.currentAssetId, task.outputAssetId, '结果应发布到原节点');
}

// --- 9. 外部视频供应商的文生视频：content 只有文本项，不塞占位首帧 ------------

{
  // 方舟直连协议：POST /contents/generations/tasks，content 是类型数组
  db.prepare(`
    INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
    VALUES ('jimeng-test', '即梦直连（测试）', 'jimeng', '', '', '', 'doubao-seedance-2-0-260128', 1, 5, ?, 'ark-key', '', '')
  `).run(baseUrl);
  registerCanvasCapability({
    key: 'external-jimeng-test',
    displayName: '即梦直连（本地假上游）',
    providerKind: 'external',
    providerIdentity: 'jimeng-test',
    modelAlias: 'doubao-seedance-2-0-260128',
    mediaKind: 'video',
    modes: ['text-to-video', 'image-to-video'],
    inputs: [
      { kind: 'image', roles: ['first-frame', 'subject', 'reference'], min: 1, max: 2, modes: ['image-to-video'] },
      { kind: 'text', roles: ['reference'], min: 0, max: 1 },
    ],
    parameters: [
      { key: 'durationSec', label: '时长', type: 'integer', min: 4, max: 12, default: 5 },
      { key: 'aspectRatio', label: '比例', type: 'enum', options: ['16:9', '9:16'], default: '16:9', modes: ['text-to-video'] },
    ],
    cancellation: false,
    evidence: 'candidate',
    evidenceNote: '本地假上游，仅用于验证文生视频的请求构造。',
  });

  const postsBefore = captured.filter((entry) => entry.method === 'POST').length;
  save([videoNode('v-t2v', 'external-jimeng-test', { durationSec: 5, aspectRatio: '16:9' }, 'text-to-video')], []);
  const result = await runOnce('v-t2v');
  assert.equal(result.posts, 1, '文生视频应恰好一次 POST');
  const body = result.body;
  assert.ok(body, `文生视频应发出请求：${result.phase}/${result.errorCode}`);
  assert.equal(body.model, 'doubao-seedance-2-0-260128');
  assert.deepEqual(
    body.content,
    [{ type: 'text', text: '让镜头缓慢推进' }],
    '文生视频的 content 只能有文本项，不得塞占位首帧',
  );
  assert.equal(body.ratio, '16:9');
  assert.equal(body.resolution, '1080p');
  assert.equal(body.duration, 5);
  const post = captured.filter((entry) => entry.method === 'POST').at(-1);
  assert.equal(post?.url, '/contents/generations/tasks', '走方舟直连路径');
  void postsBefore;
}

// --- 10. 外部方舟的参考模式：多模态参考 content 与首尾帧透传 --------------------

/** 真实可解析的 WAV：时长由 ffprobe 探出，用于验证「参考素材 2–15 秒」这类与时长有关的闸门。 */
function wavBuffer(seconds: number): Buffer {
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function makeAudioAsset(name: string, seconds: number): Promise<string> {
  const asset = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: name,
    mimeType: 'audio/wav',
    data: wavBuffer(seconds),
  });
  assert.equal(asset.mediaKind, 'audio');
  assert.ok(asset.durationSec && Math.abs(asset.durationSec - seconds) < 0.2, '音频时长应被探测出来');
  return asset.id;
}

{
  // 用真实的外部能力表（external-capabilities.ts），不另写一份测试副本：
  // 「行存在 + 已启用 + 已配置 Key」才注册，这条注册闸门本身也被验证。
  db.prepare(`
    INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
    VALUES ('jimeng-2-0', '即梦直连（测试）', 'jimeng', '', '', '', 'doubao-seedance-2-0-260128', 1, 5, ?, 'ark-key', '', '')
  `).run(baseUrl);
  const registered = registerExternalCanvasCapabilities(db, (capability) => registerCanvasCapability(capability));
  assert.deepEqual(registered, ['external-jimeng-seedance-2-0'], '真实能力表按「行 + 启用 + Key」注册');
  const jimengKey = 'external-jimeng-seedance-2-0';

  const audioAsset = await makeAudioAsset('参考音频.wav', 3);
  const shortAudioAsset = await makeAudioAsset('过短音频.wav', 1.5);
  const postCount = () => captured.filter((entry) => entry.method === 'POST').length;

  // 10.1 参考生成：图片 + 视频 + 音频三种 content 项各一份
  {
    const saved = save([
      material('r-img', firstFrameAsset),
      material('r-vid', videoRefAsset, 'video'),
      material('r-aud', audioAsset, 'audio'),
      videoNode('v-ref', jimengKey, { durationSec: 6, aspectRatio: '9:16' }, 'reference-to-video'),
    ], [
      { id: 'e1', source: 'r-img', target: 'v-ref' },
      { id: 'e2', source: 'r-vid', target: 'v-ref' },
      { id: 'e3', source: 'r-aud', target: 'v-ref' },
    ]);
    const node = saved.graph.nodes.find((candidate) => candidate.id === 'v-ref');
    assert.ok(node && node.kind === 'video-generation');
    assert.deepEqual(
      node.data.references.map((slot) => slot.role),
      ['subject', 'reference', 'audio'],
      '默认角色：图片=主体、视频=参考、音频=音频',
    );

    const result = await runOnce('v-ref');
    assert.equal(result.posts, 1, `参考生成应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    assert.equal(result.phase, 'succeeded', `${result.errorCode}/${result.errorMessage}`);
    const body = result.body;
    assert.ok(body);
    assert.equal(body.model, 'doubao-seedance-2-0-260128');
    assert.equal(body.ratio, '9:16', '参考模式没有首帧可吸附，比例取节点参数');
    assert.equal(body.resolution, '1080p');
    assert.deepEqual(body.content, [
      { type: 'text', text: '让镜头缓慢推进' },
      { type: 'image_url', image_url: { url: expectedRef(firstFrameAsset, 'subject') }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: expectedRef(videoRefAsset, 'reference') }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: expectedRef(audioAsset, 'audio') }, role: 'reference_audio' },
    ], '参考素材按角色进 content，顺序与节点一致，视频／音频地址来自交付层');
  }

  // 10.2 视频生视频：参考视频必填，图片可选
  {
    save([
      material('v-vid', videoRefAsset, 'video'),
      material('v-img', extraRefAsset),
      videoNode('v-v2v', jimengKey, { durationSec: 5 }, 'video-to-video'),
    ], [
      { id: 'e1', source: 'v-vid', target: 'v-v2v' },
      { id: 'e2', source: 'v-img', target: 'v-v2v' },
    ]);
    const result = await runOnce('v-v2v');
    assert.equal(result.posts, 1, `视频生视频应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    const body = result.body;
    assert.ok(body);
    assert.equal(body.ratio, '16:9', '未给比例时按显式默认值提交，不假定参考视频比例');
    assert.deepEqual(body.content, [
      { type: 'text', text: '让镜头缓慢推进' },
      { type: 'video_url', video_url: { url: expectedRef(videoRefAsset, 'reference') }, role: 'reference_video' },
      { type: 'image_url', image_url: { url: expectedRef(extraRefAsset, 'subject') }, role: 'reference_image' },
    ]);
  }

  // 10.3 图生视频 + 尾帧：两张图都必须带角色，尾帧不再被静默丢掉
  {
    const saved = save([
      material('f-first', firstFrameAsset),
      material('f-last', lastFrameAsset),
      videoNode('v-tail', jimengKey, { durationSec: 5 }),
    ], [
      { id: 'e1', source: 'f-first', target: 'v-tail' },
      { id: 'e2', source: 'f-last', target: 'v-tail' },
    ]);
    const graph = saved.graph;
    const node = graph.nodes.find((candidate) => candidate.id === 'v-tail');
    assert.ok(node && node.kind === 'video-generation');
    node.data.references = node.data.references.map((slot) => ({
      ...slot,
      role: slot.sourceNodeId === 'f-last' ? 'last-frame' : 'first-frame',
    }));
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });

    const result = await runOnce('v-tail');
    assert.equal(result.posts, 1, `首尾帧应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    const body = result.body;
    assert.ok(body);
    const content = body.content as Array<Record<string, unknown>>;
    assert.equal(content.length, 3, '文本 + 首帧 + 尾帧');
    assert.equal(content[1].role, 'first_frame');
    assert.equal(content[2].role, 'last_frame');
    assert.equal(
      String((content[1].image_url as { url: string }).url).startsWith('data:image/png;base64,'),
      true,
      '首帧按本机文件转 data URL（既有已验证路径）',
    );
    assert.equal(body.ratio, 'adaptive', '图生视频仍按首帧吸附比例');
  }

  // 10.4 两张图却没有尾帧角色：在 POST 前失败，不静默丢掉第二张
  {
    const before = postCount();
    save([
      material('d-a', firstFrameAsset),
      material('d-b', lastFrameAsset),
      videoNode('v-ambiguous', jimengKey, { durationSec: 5 }),
    ], [
      { id: 'e1', source: 'd-a', target: 'v-ambiguous' },
      { id: 'e2', source: 'd-b', target: 'v-ambiguous' },
    ]);
    const result = await runOnce('v-ambiguous');
    assert.equal(result.posts, 0, '歧义组合不得发出生成 POST');
    assert.equal(postCount(), before);
    assert.equal(result.phase, 'failed');
    assert.equal(result.errorCode, 'last_frame_role_required');
  }

  // 10.5 参考音频过短：prepare 阶段 fail closed
  {
    const before = postCount();
    save([
      material('s-img', extraRefAsset),
      material('s-aud', shortAudioAsset, 'audio'),
      videoNode('v-short-audio', jimengKey, { durationSec: 5, aspectRatio: '16:9' }, 'reference-to-video'),
    ], [
      { id: 'e1', source: 's-img', target: 'v-short-audio' },
      { id: 'e2', source: 's-aud', target: 'v-short-audio' },
    ]);
    const result = await runOnce('v-short-audio');
    assert.equal(result.posts, 0, '参考音频短于 2 秒时不得发出生成 POST');
    assert.equal(postCount(), before);
    assert.equal(result.errorCode, 'reference_combination_invalid');
    assert.match(String(result.errorMessage), /短于 2s/);
  }

  // 10.6 只有音频、没有图或视频：计划校验就拦下（方舟不允许音频单独作为参考）
  {
    const before = postCount();
    save([
      material('a-only', audioAsset, 'audio'),
      videoNode('v-audio-only', jimengKey, { durationSec: 5, aspectRatio: '16:9' }, 'reference-to-video'),
    ], [{ id: 'e1', source: 'a-only', target: 'v-audio-only' }]);
    assert.throws(
      () => startCanvasRun({
        db,
        request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-audio-only', requestKey: `req-${crypto.randomUUID()}` },
      }),
      (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
    );
    assert.equal(postCount(), before, '非法组合 POST 必须为零');
  }

  // 10.7 模式互斥：首帧合同不接受「场景」这类参考用途，参考模式也不接受首帧角色
  {
    const before = postCount();
    const saved = save([
      material('x-img', firstFrameAsset),
      videoNode('v-mode', jimengKey, { durationSec: 5 }),
    ], [{ id: 'e1', source: 'x-img', target: 'v-mode' }]);
    const graph = saved.graph;
    const node = graph.nodes.find((candidate) => candidate.id === 'v-mode');
    assert.ok(node && node.kind === 'video-generation');
    node.data.references = node.data.references.map((slot) => ({ ...slot, role: 'scene' as const }));
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });
    assert.throws(
      () => startCanvasRun({
        db,
        request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-mode', requestKey: `req-${crypto.randomUUID()}` },
      }),
      (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
    );
    assert.equal(postCount(), before);
  }
}

server.close();
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-providers.test.ts 通过');