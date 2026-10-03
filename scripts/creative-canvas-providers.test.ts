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
  assert.deepEqual(registered, ['external-jimeng-seedance-2-0', 'external-jimeng-seedance-2-5'], '真实能力表按「行 + 启用 + Key」注册');
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

  // 10.3 图生视频 + 尾帧：两张图按参考顺序推断首帧／尾帧，尾帧不再被静默丢掉
  {
    save([
      material('f-first', firstFrameAsset),
      material('f-last', lastFrameAsset),
      videoNode('v-tail', jimengKey, { durationSec: 5 }),
    ], [
      { id: 'e1', source: 'f-first', target: 'v-tail' },
      { id: 'e2', source: 'f-last', target: 'v-tail' },
    ]);

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

  // 10.4 帧角色跟随参考列表顺序：↑↓ 排序即调换首尾帧（界面不再手标用途）
  {
    const saved = save([
      material('d-a', firstFrameAsset),
      material('d-b', lastFrameAsset),
      videoNode('v-ambiguous', jimengKey, { durationSec: 5 }),
    ], [
      { id: 'e1', source: 'd-a', target: 'v-ambiguous' },
      { id: 'e2', source: 'd-b', target: 'v-ambiguous' },
    ]);
    // 调换参考顺序：d-b 在前 → d-b 成为首帧
    const graph = saved.graph;
    const node = graph.nodes.find((candidate) => candidate.id === 'v-ambiguous');
    assert.ok(node && node.kind === 'video-generation');
    node.data.references = [...node.data.references].reverse();
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });

    const result = await runOnce('v-ambiguous');
    assert.equal(result.posts, 1, `顺序推断首尾帧应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    const taskRow = db.prepare(
      `SELECT id FROM creative_canvas_tasks WHERE canvasId = ? AND nodeId = 'v-ambiguous' ORDER BY createdAt DESC LIMIT 1`,
    ).get(canvas.id) as { id: string };
    const inputRows = db.prepare(
      `SELECT sourceNodeId, role FROM creative_canvas_task_inputs WHERE taskId = ? ORDER BY orderIndex`,
    ).all(taskRow.id) as Array<{ sourceNodeId: string; role: string }>;
    assert.deepEqual(inputRows, [
      { sourceNodeId: 'd-b', role: 'first-frame' },
      { sourceNodeId: 'd-a', role: 'last-frame' },
    ], '参考列表顺序即首帧→尾帧顺序');
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

  // 10.7 模式互斥：参考模式不接受首帧角色（首帧合同只属于图生视频）
  {
    const before = postCount();
    const saved = save([
      material('x-img', firstFrameAsset),
      videoNode('v-mode', jimengKey, { durationSec: 5, aspectRatio: '16:9' }, 'reference-to-video'),
    ], [{ id: 'e1', source: 'x-img', target: 'v-mode' }]);
    const graph = saved.graph;
    const node = graph.nodes.find((candidate) => candidate.id === 'v-mode');
    assert.ok(node && node.kind === 'video-generation');
    node.data.references = node.data.references.map((slot) => ({ ...slot, role: 'first-frame' as const }));
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

  // 10.8 Seedance 2.5：30 秒时长透传、参考子任务显式引导、参考素材单段上限放宽到 30 秒
  {
    const jimeng25Key = 'external-jimeng-seedance-2-5';
    // 20 秒参考音频：2.0 的 15 秒单段上限会拒，2.5 的 30 秒上限放行
    const longAudioAsset = await makeAudioAsset('长参考音频.wav', 20);

    save([
      material('r25-img', extraRefAsset),
      material('r25-aud', longAudioAsset, 'audio'),
      videoNode('v-ref25', jimeng25Key, { durationSec: 20, aspectRatio: '21:9' }, 'reference-to-video'),
    ], [
      { id: 'e1', source: 'r25-img', target: 'v-ref25' },
      { id: 'e2', source: 'r25-aud', target: 'v-ref25' },
    ]);
    const reference = await runOnce('v-ref25');
    assert.equal(reference.posts, 1, `2.5 参考生成应恰好一次 POST：${reference.errorCode}/${reference.errorMessage}`);
    assert.ok(reference.body);
    assert.equal(reference.body.model, 'doubao-seedance-2-5-260628');
    assert.equal(reference.body.duration, 20, '2.5 单段上限 30 秒，20 秒原样透传');
    assert.equal(reference.body.ratio, '21:9');
    assert.equal(reference.body.omni_reference_task_type, 'reference', '2.5 全模态参考显式引导为纯参考子任务');
    assert.equal(reference.body.camera_fixed, undefined, '2.5 属 2.x 家族，不送 camera_fixed');

    // 首尾帧：与 2.0 同一 content-role 合同，ratio 锁 adaptive，30 秒不被 2.0 的 15 秒钳住
    save([
      material('f25-first', firstFrameAsset),
      material('f25-last', lastFrameAsset),
      videoNode('v-tail25', jimeng25Key, { durationSec: 30 }),
    ], [
      { id: 'e1', source: 'f25-first', target: 'v-tail25' },
      { id: 'e2', source: 'f25-last', target: 'v-tail25' },
    ]);
    const tail = await runOnce('v-tail25');
    assert.equal(tail.posts, 1, `2.5 首尾帧应恰好一次 POST：${tail.errorCode}/${tail.errorMessage}`);
    assert.ok(tail.body);
    const tailContent = tail.body.content as Array<Record<string, unknown>>;
    assert.equal(tailContent.length, 3, '文本 + 首帧 + 尾帧');
    assert.equal(tailContent[1].role, 'first_frame');
    assert.equal(tailContent[2].role, 'last_frame');
    assert.equal(tail.body.ratio, 'adaptive', '2.5 首尾帧锁定 adaptive');
    assert.equal(tail.body.duration, 30, '2.5 时长上限 30 秒');
  }

  // 10.9 全能参考合并入口：只接 1 段参考视频（旧「至少 1 图」规则会拒，合并后合法）
  {
    const jimeng25Key = 'external-jimeng-seedance-2-5';
    save([
      material('r9-vid', videoRefAsset, 'video'),
      videoNode('v-omni', jimeng25Key, { durationSec: 6, aspectRatio: '16:9' }, 'reference-to-video'),
    ], [{ id: 'e1', source: 'r9-vid', target: 'v-omni' }]);
    const result = await runOnce('v-omni');
    assert.equal(result.posts, 1, `全能参考仅视频应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    assert.ok(result.body);
    assert.equal(result.body.omni_reference_task_type, 'reference');
    assert.equal(result.body.ratio, '16:9', '全能参考比例取节点参数');
    assert.equal(result.body.duration, 6);
  }

  // 10.10 全能参考零媒体：跨类型至少 1 份素材（minMediaInputs），计划校验拦下
  {
    const before = postCount();
    save([videoNode('v-empty', 'external-jimeng-seedance-2-5', { durationSec: 5 }, 'reference-to-video')], []);
    assert.throws(
      () => startCanvasRun({
        db,
        request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-empty', requestKey: `req-${crypto.randomUUID()}` },
      }),
      (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
    );
    assert.equal(postCount(), before, '零媒体参考不得发出 POST');
  }

  // 10.11 智能多帧：≥2 张关键帧图走多模态参考；1 图或接入视频都在计划校验拦下
  {
    const jimeng25Key = 'external-jimeng-seedance-2-5';
    save([
      material('mf-a', firstFrameAsset),
      material('mf-b', extraRefAsset),
      videoNode('v-frames', jimeng25Key, { durationSec: 8, aspectRatio: '4:3' }, 'frames-to-video'),
    ], [
      { id: 'e1', source: 'mf-a', target: 'v-frames' },
      { id: 'e2', source: 'mf-b', target: 'v-frames' },
    ]);
    const result = await runOnce('v-frames');
    assert.equal(result.posts, 1, `智能多帧应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    assert.ok(result.body);
    assert.equal(result.body.omni_reference_task_type, 'reference', '智能多帧是纯参考子任务');
    assert.equal(result.body.ratio, '4:3', '智能多帧比例取节点参数');
    assert.equal(result.body.duration, 8);
    const frameContent = result.body.content as Array<Record<string, unknown>>;
    assert.equal(frameContent.length, 3, '文本 + 两张关键帧图');
    assert.ok(frameContent.every((item, index) => index === 0 || item.role === 'reference_image'), '关键帧按 reference_image 进 content');

    const beforeSingle = postCount();
    save([
      material('mf-c', firstFrameAsset),
      videoNode('v-frames-one', jimeng25Key, { durationSec: 5 }, 'frames-to-video'),
    ], [{ id: 'e1', source: 'mf-c', target: 'v-frames-one' }]);
    assert.throws(
      () => startCanvasRun({
        db,
        request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-frames-one', requestKey: `req-${crypto.randomUUID()}` },
      }),
      (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
      '智能多帧只有 1 张图时必须拦下（至少 2 张关键帧）',
    );
    assert.equal(postCount(), beforeSingle);

    const beforeVideo = postCount();
    save([
      material('mf-v', videoRefAsset, 'video'),
      material('mf-i', firstFrameAsset),
      videoNode('v-frames-vid', jimeng25Key, { durationSec: 5 }, 'frames-to-video'),
    ], [
      { id: 'e1', source: 'mf-v', target: 'v-frames-vid' },
      { id: 'e2', source: 'mf-i', target: 'v-frames-vid' },
    ]);
    assert.throws(
      () => startCanvasRun({
        db,
        request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'v-frames-vid', requestKey: `req-${crypto.randomUUID()}` },
      }),
      (error: unknown) => (error as { code?: string }).code === 'capability_unavailable',
      '智能多帧不接受视频输入',
    );
    assert.equal(postCount(), beforeVideo);
  }

  // 10.12 智能编辑：omni=edit、ratio 锁 adaptive、duration 锁 -1；残留越界参数不进计划；关键词与 4 秒下限前置
  {
    const jimeng25Key = 'external-jimeng-seedance-2-5';
    const saved = save([
      material('ed-vid', videoRefAsset, 'video'),
      material('ed-img', extraRefAsset),
      // 故意残留 aspectRatio/durationSec：edit 模式都不接受，planner 应静默丢弃
      videoNode('v-edit', jimeng25Key, { durationSec: 12, aspectRatio: '9:16' }, 'video-edit'),
    ], [
      { id: 'e1', source: 'ed-vid', target: 'v-edit' },
      { id: 'e2', source: 'ed-img', target: 'v-edit' },
    ]);
    const graph = saved.graph;
    const editNode = graph.nodes.find((candidate) => candidate.id === 'v-edit');
    assert.ok(editNode && editNode.kind === 'video-generation');
    editNode.data.prompt = '把参考1里的沙发替换成参考图的款式';
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });

    const result = await runOnce('v-edit');
    assert.equal(result.posts, 1, `智能编辑应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    assert.ok(result.body);
    assert.equal(result.body.omni_reference_task_type, 'edit');
    assert.equal(result.body.ratio, 'adaptive', '编辑子任务比例锁 adaptive（残留 9:16 不得生效）');
    assert.equal(result.body.duration, -1, '编辑子任务时长锁 -1（残留 12 不得生效）');

    // 缺编辑关键词：prepare 前置拦下
    const beforeKeyword = postCount();
    save([
      material('ed2-vid', videoRefAsset, 'video'),
      videoNode('v-edit-kw', jimeng25Key, {}, 'video-edit'),
    ], [{ id: 'e1', source: 'ed2-vid', target: 'v-edit-kw' }]);
    const keywordResult = await runOnce('v-edit-kw');
    assert.equal(keywordResult.posts, 0, '缺编辑关键词不得发出 POST');
    assert.equal(postCount(), beforeKeyword);
    assert.equal(keywordResult.errorCode, 'prompt_keyword_missing');

    // 参考视频短于 4 秒：编辑子任务的硬性下限
    const shortVideoAsset = await makeAsset('3秒视频.mp4', 'video');
    db.prepare(`UPDATE creative_canvas_assets SET durationSec = 3 WHERE id = ?`).run(shortVideoAsset);
    const beforeShort = postCount();
    const savedShort = save([
      material('ed3-vid', shortVideoAsset, 'video'),
      videoNode('v-edit-short', jimeng25Key, {}, 'video-edit'),
    ], [{ id: 'e1', source: 'ed3-vid', target: 'v-edit-short' }]);
    const shortGraph = savedShort.graph;
    const shortNode = shortGraph.nodes.find((candidate) => candidate.id === 'v-edit-short');
    assert.ok(shortNode && shortNode.kind === 'video-generation');
    shortNode.data.prompt = '删除参考1里的路人';
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: savedShort.graphRevision, graph: shortGraph });
    const shortResult = await runOnce('v-edit-short');
    assert.equal(shortResult.posts, 0, '3 秒参考视频不得发出 POST');
    assert.equal(postCount(), beforeShort);
    assert.equal(shortResult.errorCode, 'reference_combination_invalid');
    assert.match(String(shortResult.errorMessage), /短于 4s/);
  }

  // 10.13 超长视频：omni=extend、ratio 锁 adaptive、显式时长透传
  {
    const jimeng25Key = 'external-jimeng-seedance-2-5';
    const saved = save([
      material('ex-vid', videoRefAsset, 'video'),
      videoNode('v-extend', jimeng25Key, { durationSec: 12 }, 'video-extend'),
    ], [{ id: 'e1', source: 'ex-vid', target: 'v-extend' }]);
    const graph = saved.graph;
    const extendNode = graph.nodes.find((candidate) => candidate.id === 'v-extend');
    assert.ok(extendNode && extendNode.kind === 'video-generation');
    extendNode.data.prompt = '向后延长 @参考1，镜头继续向前推进';
    saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: saved.graphRevision, graph });

    const result = await runOnce('v-extend');
    assert.equal(result.posts, 1, `超长视频应恰好一次 POST：${result.errorCode}/${result.errorMessage}`);
    assert.ok(result.body);
    assert.equal(result.body.omni_reference_task_type, 'extend');
    assert.equal(result.body.ratio, 'adaptive', '延长子任务比例锁 adaptive');
    assert.equal(result.body.duration, 12, '延长子任务时长取节点参数');
  }
}

server.close();
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('creative-canvas-providers.test.ts 通过');