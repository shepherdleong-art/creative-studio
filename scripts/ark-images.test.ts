import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { buildArkImageBody, editImageArk } from '../lib/providers/ark-images.ts';
import { SEEDREAM_5_PRO, SEEDREAM_PROVIDER_ID, SEEDREAM_BASE_URL, seedreamImageEndpoint } from '../lib/seedream-image.ts';
import { createExternalCanvasAdapter } from '../lib/creative-canvas/adapters/external.ts';
import { registerExternalCanvasCapabilities } from '../lib/creative-canvas/adapters/external-capabilities.ts';
import { registerCanvasCapability, findCanvasCapability } from '../lib/creative-canvas/capabilities.ts';
import { getSupportedImageResolutions } from '../lib/image-generation-settings.ts';
import type { CanvasTaskContext } from '../lib/creative-canvas/adapters/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-images-'));
const db = new Database(':memory:');
const originalFetch = globalThis.fetch;
try {
  const paths = [path.join(root, 'red.png'), path.join(root, 'blue.png')];
  for (const [i, file] of paths.entries()) {
    await sharp({ create: { width: 32, height: 32, channels: 3, background: i ? 'blue' : 'red' } }).png().toFile(file);
  }
  const images = paths.map(absolutePath => ({ absolutePath, mimeType: 'image/png' }));
  const request = { model: SEEDREAM_5_PRO, prompt: '保持 @参考1 主体，参考 @参考2 颜色', size: '1728x2304', images };
  const body = await buildArkImageBody(request);
  assert.equal(body.prompt, request.prompt);
  assert.equal(body.size, '1728x2304');
  assert.deepEqual(body.image, paths.map(file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`));
  assert.equal('quality' in body, false);
  assert.equal('n' in body, false);
  assert.equal('sequential_image_generation' in body, false);
  assert.equal('image' in await buildArkImageBody({ ...request, images: [] }), false);
  assert.equal((await buildArkImageBody({ ...request, size: '1456x624' })).size, '1512x648');
  await assert.rejects(buildArkImageBody({ ...request, size: '3840x2160' }), /尺寸/);
  await assert.rejects(buildArkImageBody({ ...request, images: Array(11).fill(images[0]) }), /10 张/);
  await buildArkImageBody({ ...request, images: Array(10).fill(images[0]) });
  assert.deepEqual(getSupportedImageResolutions(SEEDREAM_5_PRO, '3:4'), ['1k', '2k']);
  assert.equal(seedreamImageEndpoint(SEEDREAM_BASE_URL + '/'), SEEDREAM_BASE_URL + '/images/generations');
  assert.equal(seedreamImageEndpoint('https://ark.cn-beijing.volces.com'), SEEDREAM_BASE_URL + '/images/generations');

  db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, baseUrl TEXT, apiKey TEXT, model TEXT, type TEXT, enabled INTEGER)`);
  db.exec(`CREATE TABLE video_providers (id TEXT PRIMARY KEY, enabled INTEGER, apiKey TEXT)`);
  db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    SEEDREAM_PROVIDER_ID, 'Seedream', SEEDREAM_BASE_URL, '', SEEDREAM_5_PRO, 'ark-images', 1,
  );
  assert.deepEqual(registerExternalCanvasCapabilities(db, registerCanvasCapability), [], '没有 Key 时不开放');
  db.prepare('UPDATE providers SET apiKey = ?').run('local-test-key');
  const key = 'external-ark-seedream-5-0-pro';
  assert.deepEqual(registerExternalCanvasCapabilities(db, registerCanvasCapability), [key]);
  assert.equal(findCanvasCapability(key)?.inputs[0].max, 10);
  const context: CanvasTaskContext = {
    task: { id: 'seedream-test', canvasId: 'canvas-test' } as CanvasTaskContext['task'],
    mediaKind: 'image', generationMode: 'text-to-image', prompt: 'a cat',
    parameters: { aspectRatio: '3:4', resolution: '2K' }, capabilityKey: key,
    providerIdentity: SEEDREAM_PROVIDER_ID, modelAlias: SEEDREAM_5_PRO, inputs: [],
  };
  let posts = 0;
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(String(url), SEEDREAM_BASE_URL + '/images/generations');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-test-key');
    requests.push(JSON.parse(String(init?.body)));
    posts++;
    return Response.json({ data: [{ url: 'https://result.test/image.png' }] });
  };
  const adapter = createExternalCanvasAdapter({ db, storageRoot: root, fetchImpl });
  await adapter.prepare(context);
  const submitted = await adapter.submit(context);
  assert.equal(requests[0].image, undefined);
  assert.equal(requests[0].size, '1728x2304');
  const withRefs: CanvasTaskContext = { ...context, generationMode: 'image-to-image', inputs: images.map((image, i): CanvasTaskContext['inputs'][number] => ({
    ...image, refId: `ref${i}`, orderIndex: i, role: 'reference', note: '', kind: 'image',
    assetId: null, byteSize: fs.statSync(image.absolutePath).size, durationSec: null,
    textContent: null, upstreamTaskId: null, record: {} as never,
  })).reverse() };
  await adapter.prepare(withRefs);
  await adapter.submit(withRefs);
  assert.deepEqual(requests[1].image, body.image, '按参考顺序发送，不能依赖传入数组顺序');
  await assert.rejects(adapter.submit({ ...context, parameters: { aspectRatio: '1:1', resolution: '4K' } }), /尺寸/);
  assert.equal(posts, 2, '非法参数不得 POST');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(adapter.submit(context, aborted.signal), /中止/);
  assert.equal(posts, 2);
  const retryAdapter = createExternalCanvasAdapter({ db, storageRoot: root, fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://result.test/image.png');
    assert.equal(init?.method, undefined);
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(fs.readFileSync(paths[0]));
  } });
  const downloaded = await retryAdapter.download({ ...context, providerTaskId: submitted.providerTaskId });
  assert.deepEqual(downloaded.bytes, fs.readFileSync(paths[0]), '重建适配器后凭回执下载，不能重新生成');
  const failingAdapter = createExternalCanvasAdapter({ db, storageRoot: root, fetchImpl: async () => new Response('rejected', { status: 400 }) });
  await assert.rejects(failingAdapter.submit(context), (e: unknown) => (e as { uncertain?: boolean }).uncertain === false);
  const uncertainAdapter = createExternalCanvasAdapter({ db, storageRoot: root, fetchImpl: async () => { throw new TypeError('network failure'); } });
  await assert.rejects(uncertainAdapter.submit(context), (e: unknown) => (e as { uncertain?: boolean }).uncertain === true);

  let editCalls = 0;
  globalThis.fetch = async (url, init) => {
    editCalls++;
    if (editCalls === 1) {
      assert.equal(String(url), SEEDREAM_BASE_URL + '/images/generations');
      assert.deepEqual(JSON.parse(String(init?.body)).image, body.image);
      return Response.json({ data: [{ url: 'https://result.test/image.png' }] });
    }
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(fs.readFileSync(paths[0]));
  };
  const edited = await editImageArk({
    provider: { id: SEEDREAM_PROVIDER_ID, name: 'Seedream', model: SEEDREAM_5_PRO,
      type: 'ark-images', enabled: true, baseUrl: SEEDREAM_BASE_URL, apiKeyEnv: '' },
    model: SEEDREAM_5_PRO, prompt: request.prompt, size: request.size, quality: 'high',
    inputImagePath: paths[0], inputMimeType: 'image/png', referenceImagePaths: [paths[1]], referenceMimeTypes: ['image/png'],
  }, 'local-test-key', SEEDREAM_BASE_URL);
  assert.deepEqual(edited.imageBuffer, fs.readFileSync(paths[0]));
  assert.equal(editCalls, 2);
  console.log('ark-images: protocol, limits, credentials, canvas registration and recovery passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
