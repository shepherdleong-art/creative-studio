import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import type { CanvasTaskContext } from '../lib/creative-canvas/adapters/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-media-delivery-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);
const { registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { COMPANY_CANVAS_NATIVE_VIDEO_CAPABILITIES } = await import('../lib/creative-canvas/adapters/company-capabilities.ts');
const { createCompanyCanvasAdapter } = await import('../lib/creative-canvas/adapters/company.ts');
const { createDefaultCanvasDeliverer } = await import('../lib/creative-canvas/adapters/media-delivery.ts');
const { CanvasAdapterError } = await import('../lib/creative-canvas/adapters/types.ts');

const db = new Database(':memory:');
db.exec('CREATE TABLE video_providers (id TEXT, name TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER, defaultModel TEXT)');
const originalFetch = globalThis.fetch;
const uploads: Array<{ bytes: Buffer; mime: string }> = [];
let posts = 0;
let cosUnavailable = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'canvas-cos.test', 'No real network requests');
  if (cosUnavailable) return new Response('', { status: 503 });
  if (init?.method === 'PUT') {
    uploads.push({ bytes: Buffer.from(init.body as Uint8Array), mime: new Headers(init.headers).get('content-type')! });
    return new Response('', { status: 200 });
  }
  return new Response('', { status: 404 });
};
Object.assign(process.env, {
  CREATIVE_STUDIO_COS_SECRET_ID: 'test-id', CREATIVE_STUDIO_COS_SECRET_KEY: 'canvas-test-secret',
  CREATIVE_STUDIO_COS_DOMAIN: 'canvas-cos.test', CREATIVE_STUDIO_COS_COMPRESS: '0',
});

type Capability = typeof COMPANY_CANVAS_NATIVE_VIDEO_CAPABILITIES[number];
function context(capability: Capability, file: string, bytes: Buffer, mimeType: string): CanvasTaskContext {
  return {
    task: { id: 'test-task', canvasId: 'test-canvas' } as CanvasTaskContext['task'],
    mediaKind: 'video', generationMode: 'reference-to-video', prompt: '缓慢展示沙发',
    parameters: { durationSec: 15, resolution: capability.modelAlias === 'minimax-h3' ? '2K' : '1080P', aspectRatio: '3:4' },
    capabilityKey: capability.key, providerIdentity: capability.providerIdentity, modelAlias: capability.modelAlias,
    inputs: [{
      refId: 'ref1', orderIndex: 0, role: 'reference', note: '', kind: 'image', assetId: 'original-image',
      absolutePath: file, mimeType, byteSize: bytes.length, durationSec: null,
      textContent: null, upstreamTaskId: null, record: {} as never,
    }],
  };
}

function uploadCopies(): string[] {
  const directory = path.join(root, 'storage', 'tmp', 'canvas-media-delivery');
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

try {
  // Actual oversized PNG/JPEG/transparent PNG, not forged size metadata.
  const pixels = Buffer.alloc(2400 * 1800 * 4);
  let seed = 0x12345678;
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    pixels[i] = seed & 255;
  }
  const rgb = () => sharp(pixels.subarray(0, 2400 * 1800 * 3), { raw: { width: 2400, height: 1800, channels: 3 } });
  const rgba = () => sharp(pixels, { raw: { width: 2400, height: 1800, channels: 4 } });
  const fixtures = [
    { name: 'large.png', bytes: await rgb().png({ compressionLevel: 0 }).toBuffer(), mime: 'image/png', alpha: false },
    { name: 'large.jpg', bytes: await rgb().jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg', alpha: false },
    { name: 'large-alpha.png', bytes: await rgba().png({ compressionLevel: 0 }).toBuffer(), mime: 'image/png', alpha: true },
  ];
  for (const fixture of fixtures) {
    assert.ok(fixture.bytes.length > 10 * 1024 * 1024, fixture.name);
    fs.writeFileSync(path.join(root, fixture.name), fixture.bytes);
  }
  const small = await rgba().resize(1200, 900).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(small.length > 2 * 1024 * 1024 && small.length < 10 * 1024 * 1024);
  const smallPath = path.join(root, 'small-alpha.png');
  fs.writeFileSync(smallPath, small);

  for (const capability of COMPANY_CANVAS_NATIVE_VIDEO_CAPABILITIES) {
    process.env.CREATIVE_STUDIO_COS_PREFIX = capability.modelAlias + '/';
    registerCanvasCapability(capability);
    db.prepare('INSERT INTO video_providers VALUES (?, ?, ?, ?, ?, 1, ?)').run(
      capability.providerIdentity, capability.modelAlias, 'openai-video', 'http://127.0.0.1:4000', 'test-key', capability.modelAlias,
    );
    const adapter = createCompanyCanvasAdapter({
      db, deliverer: createDefaultCanvasDeliverer(),
      fetchImpl: async (_input, init) => {
        assert.equal(init?.method, 'POST');
        posts++;
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, capability.modelAlias);
        assert.equal(body.FileInfos[0].Usage, 'Reference');
        assert.ok(body.FileInfos[0].Url.startsWith('https://canvas-cos.test/'));
        return Response.json({ id: 'test-video-' + posts });
      },
    });

    for (const [index, fixture] of fixtures.entries()) {
      // Explicit model budgets also apply when optional COS compression is disabled.
      process.env.CREATIVE_STUDIO_COS_COMPRESS = index === 0 ? '0' : '1';
      uploads.length = 0;
      const beforePosts = posts;
      const file = path.join(root, fixture.name);
      const request = context(capability, file, fixture.bytes, fixture.mime);
      await adapter.prepare(request);
      assert.equal(posts, beforePosts, 'Preparation must never submit generation');
      assert.deepEqual(uploadCopies(), [], 'Upload copy must be removed after delivery');
      await adapter.submit(request);
      assert.equal(posts, beforePosts + 1, 'Exactly one generation POST after compression');
      assert.equal(uploads.length, 1, 'Both models must upload a checked image');
      {
        const upload = uploads[0];
        assert.ok(upload.bytes.length <= 10 * 1024 * 1024, 'Uploaded image must fit the model budget');
        assert.ok(['image/png', 'image/jpeg'].includes(upload.mime));
        const metadata = await sharp(upload.bytes).metadata();
        assert.ok(Math.abs(metadata.width! / metadata.height! - 4 / 3) < 0.002, 'Aspect ratio must be preserved');
        if (fixture.alpha) {
          assert.equal(upload.mime, 'image/png', 'No WebP for JPEG/PNG-only models');
          assert.equal(metadata.hasAlpha, true, 'Transparency must survive compression');
        } else {
          assert.equal(metadata.width, 2400, 'Keep full dimensions when encoding quality alone suffices');
          assert.equal(metadata.height, 1800);
        }
        console.log(capability.modelAlias + '/' + fixture.name + ': ' +
          (fixture.bytes.length / 1024 / 1024).toFixed(2) + ' -> ' +
          (upload.bytes.length / 1024 / 1024).toFixed(2) + ' MiB');
      }
      assert.deepEqual(fs.readFileSync(file), fixture.bytes, 'Original asset must remain byte-for-byte unchanged');
      assert.equal(request.inputs[0].absolutePath, file, 'Frozen inputs must still identify the original asset');
      assert.equal(request.inputs[0].byteSize, fixture.bytes.length);
    }

    // Already compliant images must not be transcoded to unsupported WebP by COS.
    uploads.length = 0;
    await adapter.prepare(context(capability, smallPath, small, 'image/png'));
    assert.equal(uploads.length, 1);
    {
      assert.equal(uploads[0].mime, 'image/png');
      assert.deepEqual(uploads[0].bytes, small, 'Compliant source should upload unchanged');
    }

    const beforePosts = posts;
    const beforeUploads = uploads.length;
    const invalid = context(capability, smallPath, small, 'image/webp');
    await assert.rejects(adapter.prepare(invalid),
      (error: unknown) => error instanceof CanvasAdapterError && error.code === 'media_precheck_failed');
    const video = context(capability, smallPath, small, 'video/mp4');
    Object.assign(video.inputs[0], { kind: 'video', durationSec: 2, byteSize: 101 * 1024 * 1024 });
    await assert.rejects(adapter.prepare(video),
      (error: unknown) => error instanceof CanvasAdapterError && error.code === 'media_precheck_failed');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter.prepare(context(capability, path.join(root, fixtures[0].name), fixtures[0].bytes, 'image/png'), controller.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(uploads.length, beforeUploads, 'Invalid/aborted inputs must not upload');
    assert.equal(posts, beforePosts, 'Invalid/aborted inputs must not generate');

    // Corrupt oversized images still fail closed, with no upload or generation.
    const badFile = path.join(root, 'corrupt.png');
    const corrupt = Buffer.alloc(10 * 1024 * 1024 + 1);
    fs.writeFileSync(badFile, corrupt);
    await assert.rejects(adapter.prepare(context(capability, badFile, corrupt, 'image/png')),
      (error: unknown) => error instanceof CanvasAdapterError && error.code === 'image_compression_failed');
    assert.equal(posts, beforePosts);
    assert.equal(uploads.length, beforeUploads);

    // Delivery failure must clean up the compressed copy as well.
    cosUnavailable = true;
    // Unique content avoids a previously cached signed URL.
    const failureBytes = await rgb().flop().png({ compressionLevel: 0 }).toBuffer();
    const failureFile = path.join(root, 'delivery-failure.png');
    fs.writeFileSync(failureFile, failureBytes);
    await assert.rejects(adapter.prepare(context(capability, failureFile, failureBytes, 'image/png')),
      (error: unknown) => error instanceof CanvasAdapterError && error.code === 'cos_upload_failed');
    cosUnavailable = false;
    assert.equal(posts, beforePosts);
    assert.deepEqual(uploadCopies(), [], 'Failed delivery must not leave temporary copies');
    assert.deepEqual(fs.readFileSync(failureFile), failureBytes);
    console.log(capability.modelAlias + ': oversized PNG/JPEG/alpha, compliant image, invalid media, cancellation and cleanup passed');
  }
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('creative-canvas-media-delivery.test.ts passed');
