import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { registerCanvasCapability } from '../lib/creative-canvas/capabilities.ts';
import { createExternalCanvasAdapter } from '../lib/creative-canvas/adapters/external.ts';
import { registerTestVideoAdapter } from '../lib/video-providers/index.ts';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import { createCanvas, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { claimCanvasTasks, getCanvasTask } from '../lib/creative-canvas/tasks.ts';
import { runCanvasTask } from '../lib/creative-canvas/runner.ts';
import { retryCanvasTaskDownload } from '../lib/creative-canvas/recovery.ts';
import type { CanvasTaskContext } from '../lib/creative-canvas/adapters/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-external-recovery-'));
process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'company';
process.env.CREATIVE_STUDIO_CANVAS_ENABLE = '1';
const storageRoot = path.join(root, 'storage');
const db = new Database(path.join(root, 'workbench.db'));
db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, baseUrl TEXT, apiKey TEXT, model TEXT, type TEXT, enabled INTEGER)`);
db.exec(`CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT, baseUrl TEXT, apiKey TEXT, defaultModel TEXT, type TEXT, enabled INTEGER)`);
db.prepare(`INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, 1)`).run(
  'external-recovery', 'external', 'https://gateway.test', 'secret-key', 'ext/image', 'gateway-task-image',
);
registerCanvasCapability({
  key: 'external-recovery-image', displayName: 'test', providerKind: 'external',
  providerIdentity: 'external-recovery', modelAlias: 'ext/image', mediaKind: 'image',
  modes: ['text-to-image'], inputs: [], parameters: [], cancellation: false,
  evidence: 'candidate', evidenceNote: 'test',
});

const task = { id: 'task-recovery', canvasId: 'canvas-recovery' } as CanvasTaskContext['task'];
const context = {
  task, mediaKind: 'image', generationMode: 'text-to-image', prompt: 'safe prompt', parameters: {},
  capabilityKey: 'external-recovery-image', providerIdentity: 'external-recovery', modelAlias: 'ext/image', inputs: [],
} satisfies CanvasTaskContext;
const inputImagePath = path.join(root, 'input.png');
fs.writeFileSync(inputImagePath, Buffer.from('png-input'));
const multipartContext = {
  ...context,
  task: { ...task, id: 'task-multipart' },
  generationMode: 'image-to-image',
  inputs: [{
    refId: 'base', orderIndex: 0, role: 'subject', note: '', kind: 'image', assetId: null,
    absolutePath: inputImagePath, mimeType: 'image/png', byteSize: 9, durationSec: null,
    textContent: null, upstreamTaskId: null, record: {} as never,
  }],
} satisfies CanvasTaskContext;

let posts = 0;
let downloads = 0;
const imageUrl = 'https://cdn.test/result.png?token=secret-key';
const firstFetch: typeof fetch = async (url, init) => {
  if (init?.method === 'POST') {
    posts += 1;
    return new Response(JSON.stringify({ data: [{ url: imageUrl }] }), { status: 200 });
  }
  downloads += 1;
  return new Response('temporarily unavailable', { status: 503 });
};
const firstAdapter = createExternalCanvasAdapter({ db, storageRoot, fetchImpl: firstFetch });
const submitted = await firstAdapter.submit(context);
assert.equal(posts, 1);
await assert.rejects(
  firstAdapter.download({ ...context, providerTaskId: submitted.providerTaskId }),
  (error: unknown) => (error as { code?: string }).code === 'external_result_download_failed'
    && !(error as Error).message.includes('secret-key'),
);

db.prepare(`INSERT INTO video_providers VALUES (?, ?, ?, ?, ?, ?, 1)`).run(
  'external-video-recovery', 'external video', 'https://gateway.test', 'secret-key', 'ext/video', 'jimeng',
);
registerCanvasCapability({
  key: 'external-recovery-video', displayName: 'test video', providerKind: 'external',
  providerIdentity: 'external-video-recovery', modelAlias: 'ext/video', mediaKind: 'video',
  modes: ['text-to-video'], inputs: [], parameters: [], cancellation: false,
  evidence: 'candidate', evidenceNote: 'test',
});
registerTestVideoAdapter('test-recovery-video', {
  async submitText() {
    throw new Error('Jimeng submit error 500: upstream said submit error 400');
  },
  async submit() { throw new Error('unused'); },
  async poll() { return { status: 'pending', rawResponse: null }; },
} as never);
db.prepare(`UPDATE video_providers SET type = ? WHERE id = ?`).run('test-recovery-video', 'external-video-recovery');
const videoContext = {
  ...context, mediaKind: 'video', generationMode: 'text-to-video', capabilityKey: 'external-recovery-video',
  providerIdentity: 'external-video-recovery', modelAlias: 'ext/video',
} satisfies CanvasTaskContext;
await assert.rejects(
  createExternalCanvasAdapter({ db, storageRoot }).submit(videoContext),
  (error: unknown) => (error as { uncertain?: boolean }).uncertain === true,
  '外层 500 即使正文含 submit error 400 仍必须 uncertain',
);

// Recreate the adapter to exercise recovery after adapter teardown/reinitialization.
const secondFetch: typeof fetch = async (url, init) => {
  assert.equal(init?.method, undefined);
  assert.equal(String(url), imageUrl);
  downloads += 1;
  return new Response(Buffer.from('cached-image'), { status: 200, headers: { 'content-type': 'image/png' } });
};
const secondAdapter = createExternalCanvasAdapter({ db, storageRoot, fetchImpl: secondFetch });
const recovered = await secondAdapter.download({ ...context, providerTaskId: submitted.providerTaskId });
assert.equal(recovered.bytes.toString(), 'cached-image');
assert.equal(posts, 1, '补下载不得重新 POST');
assert.equal(downloads, 2);

await assert.rejects(
  createExternalCanvasAdapter({ db, storageRoot, fetchImpl: async () => { throw new TypeError('multipart network down'); } })
    .submit(multipartContext),
  (error: unknown) => (error as { uncertain?: boolean }).uncertain === true,
);
let downloadSignal: AbortSignal | undefined;
const abortTaskContext = { ...context, task: { ...task, id: 'task-download-abort' } };
await createExternalCanvasAdapter({
  db, storageRoot,
  fetchImpl: async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/abort.png' }] }), { status: 200 })
    : new Response('unexpected', { status: 500 }),
}).submit(abortTaskContext);
const downloadAbortAdapter = createExternalCanvasAdapter({
  db, storageRoot,
  fetchImpl: async (_url, init) => {
    downloadSignal = init?.signal as AbortSignal;
    throw new DOMException('aborted', 'AbortError');
  },
});
const downloadController = new AbortController();
await assert.rejects(
  downloadAbortAdapter.download({ ...abortTaskContext, providerTaskId: `external-image:${abortTaskContext.task.id}` }, downloadController.signal),
  (error: unknown) => (error as { code?: string }).code === 'external_result_download_failed',
);
assert.ok(downloadSignal, '下载请求必须收到合并后的 abort signal');
downloadController.abort();
assert.equal(downloadSignal?.aborted, true, '下载中止必须传播到请求 signal');

await assert.rejects(
  createExternalCanvasAdapter({ db, storageRoot, fetchImpl: async () => { throw new TypeError('network down'); } })
    .submit(context),
  (error: unknown) => (error as { uncertain?: boolean }).uncertain === true,
);
const aborted = new AbortController();
aborted.abort();
let abortCalls = 0;
await assert.rejects(
  createExternalCanvasAdapter({ db, storageRoot, fetchImpl: async () => { abortCalls += 1; throw new Error('must not call'); } })
    .submit(context, aborted.signal),
  (error: unknown) => (error as { uncertain?: boolean }).uncertain === false,
);
assert.equal(abortCalls, 0, '预先 abort 不得 POST');

await assert.rejects(
  createExternalCanvasAdapter({
    db, storageRoot,
    fetchImpl: async () => new Response('bad secret-key payload', { status: 400 }),
  }).submit(context),
  (error: unknown) => (error as { uncertain?: boolean }).uncertain === false
    && !(error as Error).message.includes('secret-key'),
);

// 真实 runner 状态链：download_failed -> retry -> claim -> 新 adapter -> 发布资产。
db.close();
const e2eDb = new Database(path.join(root, 'e2e-workbench.db'));
try {
  await ensureCreativeCanvasSchemaReady({ db: e2eDb, backupRoot: path.join(root, 'backups') });
  e2eDb.exec(`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT, baseUrl TEXT, apiKey TEXT, model TEXT, type TEXT, enabled INTEGER)`);
  e2eDb.prepare(`INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, 1)`).run(
    'external-e2e', 'external', 'https://gateway.test', 'secret-key', 'ext/e2e', 'gateway-task-image',
  );
  registerCanvasCapability({
    key: 'external-e2e-image', displayName: 'e2e', providerKind: 'external', providerIdentity: 'external-e2e',
    modelAlias: 'ext/e2e', mediaKind: 'image', modes: ['text-to-image'], inputs: [], parameters: [],
    cancellation: false, evidence: 'candidate', evidenceNote: 'test',
  });
  const canvas = createCanvas(e2eDb, { name: 'external recovery' });
  saveCanvasGraph({
    db: e2eDb, canvasId: canvas.id, expectedGraphRevision: 0,
    graph: { schemaVersion: 1, nodes: [{
      id: 'image-node', kind: 'image-generation', position: { x: 0, y: 0 },
      data: { title: 'image', modelKey: 'external-e2e-image', generationMode: 'text-to-image', prompt: 'test', parameters: {}, references: [], referenceLabelCounter: 0 },
    }], edges: [] },
  });
  let e2ePosts = 0;
  let e2eDownloads = 0;
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#234567' } }).png().toBuffer();
  const e2eFetch: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      e2ePosts += 1;
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/e2e.png?token=secret-key' }] }), { status: 200 });
    }
    e2eDownloads += 1;
    if (e2eDownloads === 1) return new Response('retry later', { status: 503 });
    return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const adapter1 = createExternalCanvasAdapter({ db: e2eDb, storageRoot, fetchImpl: e2eFetch });
  startCanvasRun({ db: e2eDb, request: { canvasId: canvas.id, mode: 'single', targetNodeId: 'image-node', requestKey: 'e2e-recovery' } });
  const claimed1 = claimCanvasTasks({ db: e2eDb, workerId: 'e2e-worker', limit: 1 });
  assert.equal(claimed1.length, 1);
  await runCanvasTask({ db: e2eDb, taskId: claimed1[0].task.id, adapter: adapter1, workerId: 'e2e-worker', fence: claimed1[0].fence, storageRoot, pollIntervalMs: 1 });
  const failed = getCanvasTask(e2eDb, claimed1[0].task.id)!;
  assert.equal(failed.phase, 'download_failed');
  assert.equal(failed.providerTaskId, `external-image:${failed.id}`);
  retryCanvasTaskDownload(e2eDb, { taskId: failed.id });
  const claimed2 = claimCanvasTasks({ db: e2eDb, workerId: 'e2e-worker', limit: 1 });
  assert.equal(claimed2.length, 1);
  const adapter2 = createExternalCanvasAdapter({ db: e2eDb, storageRoot, fetchImpl: e2eFetch });
  await runCanvasTask({ db: e2eDb, taskId: failed.id, adapter: adapter2, workerId: 'e2e-worker', fence: claimed2[0].fence, storageRoot, pollIntervalMs: 1 });
  const succeeded = getCanvasTask(e2eDb, failed.id)!;
  assert.equal(succeeded.phase, 'succeeded');
  assert.ok(succeeded.outputAssetId);
  const asset = e2eDb.prepare(`SELECT relativePath, mimeType FROM creative_canvas_assets WHERE id = ?`).get(succeeded.outputAssetId) as { relativePath: string; mimeType: string };
  assert.equal(asset.mimeType, 'image/png');
  assert.equal((await sharp(path.join(storageRoot, asset.relativePath)).metadata()).format, 'png');
  assert.equal(e2ePosts, 1);
} finally {
  e2eDb.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('creative-canvas-external-recovery.test.ts 通过');
