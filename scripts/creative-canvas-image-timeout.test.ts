import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-image-timeout-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { createExternalCanvasAdapter } = await import('../lib/creative-canvas/adapters/external.ts');
type Context = import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext;

const db = new Database(':memory:');
db.exec(`CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT, type TEXT, model TEXT,
  baseUrl TEXT, apiKey TEXT, enabled INTEGER
)`);

// Compress the real five-minute HTTP headers limit to one timer tick. The
// request itself has a longer deadline and must still receive its image.
const previousDispatcher = getGlobalDispatcher();
const shortDefaultDispatcher = new Agent({ headersTimeout: 10, bodyTimeout: 10 });
let responseMode: 'headers' | 'body' = 'headers';
const server = http.createServer((_request, response) => {
  if (responseMode === 'body') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"data":[');
    setTimeout(() => response.end('{"url":"https://result.example.test/image.png"}]}'), 1_600);
    return;
  }
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ url: 'https://result.example.test/image.png' }] }));
  }, 1_600);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, 1)').run(
  'company-gateway-seedream-5-0-pro', 'Seedream', 'gateway-task-image',
  'doubao-seedream-5-0-pro-image', `http://127.0.0.1:${address.port}`, 'test-key',
);
registerCanvasCapability({
  key: 'timeout-seedream', displayName: 'Seedream', providerKind: 'company',
  providerIdentity: 'company-gateway-seedream-5-0-pro', modelAlias: 'doubao-seedream-5-0-pro-image',
  mediaKind: 'image', modes: ['text-to-image'], inputs: [], parameters: [],
  cancellation: false, evidence: 'candidate', evidenceNote: 'Local HTTP timeout regression.',
});
db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, 1)').run(
  'direct-seedream', 'Seedream direct', 'ark-images', 'doubao-seedream-5-0-pro-260628',
  `http://127.0.0.1:${address.port}`, 'test-key',
);
registerCanvasCapability({
  key: 'timeout-direct-seedream', displayName: 'Seedream direct', providerKind: 'external',
  providerIdentity: 'direct-seedream', modelAlias: 'doubao-seedream-5-0-pro-260628',
  mediaKind: 'image', modes: ['text-to-image'], inputs: [], parameters: [],
  cancellation: false, evidence: 'candidate', evidenceNote: 'Local HTTP timeout regression.',
});
const context = {
  task: { id: 'timeout-image', canvasId: 'timeout-canvas' } as Context['task'],
  mediaKind: 'image', generationMode: 'text-to-image', prompt: 'test',
  parameters: { aspectRatio: '3:4', resolution: '2K' },
  capabilityKey: 'timeout-seedream', providerIdentity: 'company-gateway-seedream-5-0-pro',
  modelAlias: 'doubao-seedream-5-0-pro-image', inputs: [],
} satisfies Context;

let transportErrorCode: string | undefined;
let posts = 0;
setGlobalDispatcher(shortDefaultDispatcher);
try {
  const adapter = createExternalCanvasAdapter({
    db, storageRoot: path.join(root, 'storage'), submitTimeoutMs: 4_000,
    fetchImpl: async (url, init) => {
      posts += 1;
      try {
        return await fetch(url, init);
      } catch (error) {
        transportErrorCode = (error as { cause?: { code?: string } }).cause?.code;
        throw error;
      }
    },
  });
  let result;
  let submitError;
  try {
    result = await adapter.submit(context);
  } catch (error) {
    submitError = error;
  }
  assert.equal(
    result?.terminalState, 'succeeded',
    `Seedream must outlive the shorter transport default: ${transportErrorCode ?? String(submitError)}`,
  );
  assert.equal(posts, 1, 'Waiting longer must not resubmit the generation request.');

  responseMode = 'body';
  const direct = await adapter.submit({
    ...context,
    task: { ...context.task, id: 'direct-timeout-image' },
    capabilityKey: 'timeout-direct-seedream', providerIdentity: 'direct-seedream',
    modelAlias: 'doubao-seedream-5-0-pro-260628',
  });
  assert.equal(direct.terminalState, 'succeeded', 'Direct Seedream must also outlive the default body timeout.');
  assert.equal(posts, 2, 'Each model request must be submitted exactly once.');

  responseMode = 'headers';
  let timedOutPosts = 0;
  const deadlineAdapter = createExternalCanvasAdapter({
    db, storageRoot: path.join(root, 'storage'), submitTimeoutMs: 50,
    fetchImpl: async (url, init) => {
      timedOutPosts += 1;
      return fetch(url, init);
    },
  });
  await assert.rejects(deadlineAdapter.submit(context), (error: unknown) => {
    assert.equal((error as { uncertain?: boolean }).uncertain, true);
    assert.match((error as Error).message, /响应超时/);
    return true;
  });
  assert.equal(timedOutPosts, 1, 'The bounded deadline must still abort without retrying.');

  const controller = new AbortController();
  const stoppingAdapter = createExternalCanvasAdapter({
    db, storageRoot: path.join(root, 'storage'), submitTimeoutMs: 4_000,
    fetchImpl: async (url, init) => {
      const pending = fetch(url, init);
      setTimeout(() => controller.abort(), 30);
      return pending;
    },
  });
  await assert.rejects(stoppingAdapter.submit(context, controller.signal), (error: unknown) =>
    (error as { uncertain?: boolean }).uncertain === true);
  assert.equal(controller.signal.aborted, true, 'Shutdown must still interrupt the synchronous request.');
} finally {
  setGlobalDispatcher(previousDispatcher);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await shortDefaultDispatcher.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('creative-canvas-image-timeout.test.ts passed');
