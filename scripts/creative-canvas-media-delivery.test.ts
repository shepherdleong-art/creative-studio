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
const { configuredCanvasVideos } = await import('../lib/creative-canvas/adapters/configured-videos.ts');
const { configuredCanvasImages } = await import('../lib/creative-canvas/adapters/configured-images.ts');
const { QINIU_IMAGE_26_MODELS } = await import('../lib/company-qiniu-image-models.ts');
const { _setCompanyTailFrameRuntimeInspectorForTest } = await import('../lib/company-gateway-tail-frame.ts');
const { createCompanyCanvasAdapter } = await import('../lib/creative-canvas/adapters/company.ts');
const { createDefaultCanvasDeliverer } = await import('../lib/creative-canvas/adapters/media-delivery.ts');
const { CanvasAdapterError } = await import('../lib/creative-canvas/adapters/types.ts');

const db = new Database(':memory:');
db.exec('CREATE TABLE video_providers (id TEXT, name TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER, defaultModel TEXT)');
const originalFetch = globalThis.fetch;
const uploads: Array<{ bytes: Buffer; mime: string }> = [];
let posts = 0;
let cosUnavailable = false;
const originHost = 'fixture-12345.cos.ap-guangzhou.myqcloud.com';
let originStatus = 206;
let originReads = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === originHost) {
    originReads++;
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-0');
    assert.equal(init?.redirect, 'error');
    assert.ok(url.searchParams.has('q-signature'));
    return new Response(new Uint8Array([0xff]), { status: originStatus });
  }
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

  db.exec('CREATE TABLE providers (id TEXT, name TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER, model TEXT)');
  for (const spec of QINIU_IMAGE_26_MODELS) {
    db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, 1, ?)').run(
      spec.id, spec.name, 'gateway-task-image', 'http://127.0.0.1:4300', 'fixture-key', spec.model,
    );
  }
  const images = configuredCanvasImages(db);
  for (const image of images) registerCanvasCapability(image);
  process.env.CREATIVE_STUDIO_COS_SIGN_HOST = originHost;
  const submitted: URL[] = [];
  const imageAdapter = createCompanyCanvasAdapter({ db, deliverer: createDefaultCanvasDeliverer(),
    fetchImpl: async (_url, init) => {
      submitted.push(new URL(JSON.parse(String(init?.body)).images[0]));
      return Response.json({ id: 'fixture-image' });
    },
  });
  for (const [alias, status] of [['sunburst', 206], ['flare', 206], ['sunburst', 403]] as const) {
    originStatus = status;
    const image = images.find(entry => entry.modelAlias === 'qiniuyun/gpt-image-2.6-' + alias)!;
    const request = context(image, smallPath, small, 'image/png');
    Object.assign(request, { mediaKind: 'image', generationMode: 'image-to-image', parameters: { aspectRatio: '16:9', resolution: '4K' } });
    await imageAdapter.prepare(request);
    await imageAdapter.submit(request);
  }
  assert.deepEqual(submitted.map(url => url.hostname), [originHost, 'canvas-cos.test', 'canvas-cos.test']);
  assert.equal(originReads, 2, '仅 Sunburst 探测源站，每次生成最多一次 POST');
  assert.equal(submitted[0].pathname + submitted[0].search, submitted[1].pathname + submitted[1].search,
    '缓存命中时只换下载域名，保留原对象和签名');
  delete process.env.CREATIVE_STUDIO_COS_SIGN_HOST;

  const kling4Model = 'qiniuyun/kling-4.0';
  _setCompanyTailFrameRuntimeInspectorForTest(async () => ({
    status: 'ready', reason: '', proxyAvailable: true, cosConfigured: true, startedAt: null,
  }));
  db.prepare('INSERT INTO video_providers VALUES (?, ?, ?, ?, ?, 1, ?)').run(
    'company-qiniuyun-kling-4-0', kling4Model, 'openai-video', 'http://127.0.0.1:4000', 'test-key', kling4Model,
  );
  const kling4 = configuredCanvasVideos(db).find(capability => capability.modelAlias === kling4Model)!;
  assert.ok(kling4);
  registerCanvasCapability(kling4);
  let kling4Body: Record<string, unknown> = {};
  let kling4Posts = 0;
  const deliveredKling4Frames: Array<[number, number]> = [];
  const kling4Adapter = createCompanyCanvasAdapter({
    db,
    deliverer: { name: 'fixture-cos', async deliver(request) {
      assert.equal(request.requireCos, true);
      if (request.isFrameImage) {
        const { width, height } = await sharp(request.absolutePath).metadata();
        deliveredKling4Frames.push([width, height]);
      }
      const name = path.basename(request.absolutePath);
      return 'https://canvas-cos.test/' + name;
    } },
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method, 'POST');
      kling4Body = JSON.parse(String(init.body));
      kling4Posts++;
      if (kling4Body.aspect_ratio === '3:4') {
        return Response.json({ code: 'invalid_kling_v4_request',
          message: 'Kling v4 does not support aspect_ratio "3:4" for this operation' }, { status: 400 });
      }
      return Response.json({ id: 'test-kling4' });
    },
  });
  const fixtureBytes = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#aa7755' } }).png().toBuffer();
  const portraitFrameBytes = await sharp({ create: { width: 720, height: 1080, channels: 3, background: '#aa7755' } }).png().toBuffer();
  const frames = context(kling4, smallPath, portraitFrameBytes, 'image/png');
  frames.generationMode = 'frames-to-video';
  frames.parameters = { durationSec: 3, resolution: '1080p' };
  const roles = ['first-frame', 'middle-frame', 'middle-frame', 'last-frame'] as const;
  frames.inputs = roles.map((role, orderIndex) => {
    const file = path.join(root, 'frame-' + orderIndex + '.png');
    fs.writeFileSync(file, portraitFrameBytes);
    return { ...frames.inputs[0], absolutePath: file, refId: 'frame-' + orderIndex, role, orderIndex };
  });
  await kling4Adapter.prepare(frames);
  await kling4Adapter.submit(frames);
  assert.deepEqual(kling4Body.middle_image_urls, ['https://canvas-cos.test/frame-1.png', 'https://canvas-cos.test/frame-2.png']);
  assert.deepEqual(kling4Body.images, ['https://canvas-cos.test/frame-0.png']);
  assert.equal(kling4Body.end_image_url, 'https://canvas-cos.test/frame-3.png');
  assert.equal(kling4Body.resolution, '1080p');
  assert.equal(kling4Body.size, undefined);
  assert.equal(kling4Body.aspect_ratio, undefined);
  assert.deepEqual(deliveredKling4Frames, roles.map(() => [720, 1080]));

  for (const generationMode of ['image-to-video', 'frames-to-video'] as const) {
    const inputs = generationMode === 'image-to-video'
      ? frames.inputs.filter(input => input.role !== 'middle-frame') : frames.inputs;
    for (const resolution of ['720p', '1080p']) {
      const request = { ...frames, generationMode, inputs, parameters: { durationSec: 3, resolution, frameAspectRatio: '3:4' } };
      deliveredKling4Frames.length = 0;
      await kling4Adapter.prepare(request);
      await kling4Adapter.submit(request);
      assert.deepEqual(deliveredKling4Frames, inputs.map(() => [720, 960]));
      assert.equal(kling4Body.resolution, resolution);
      assert.equal(kling4Body.size, undefined);
      assert.equal(kling4Body.aspect_ratio, undefined);
      assert.deepEqual(kling4Body.images, [inputs[0].deliveryRef]);
      assert.equal(kling4Body.start_image_url, inputs[0].deliveryRef);
      assert.equal(kling4Body.end_image_url, inputs.at(-1)!.deliveryRef);
      assert.notEqual(kling4Body.start_image_url, 'https://canvas-cos.test/frame-0.png');
      const middleFrames = inputs.filter(input => input.role === 'middle-frame');
      assert.deepEqual(kling4Body.middle_image_urls, middleFrames.length ? middleFrames.map(input => input.deliveryRef) : undefined);
      for (const input of inputs) assert.deepEqual(fs.readFileSync(input.absolutePath!), portraitFrameBytes);
      assert.deepEqual(uploadCopies(), []);
      console.log(`PASS: Kling 4.0 ${generationMode} 3:4 ${resolution} delivery and request`);
    }
  }

  const firstFrame = { ...frames, generationMode: 'image-to-video' as const, inputs: [frames.inputs[0]],
    parameters: { ...frames.parameters, frameAspectRatio: '3:4' } };
  deliveredKling4Frames.length = 0;
  await kling4Adapter.prepare(firstFrame);
  await kling4Adapter.submit(firstFrame);
  assert.deepEqual(deliveredKling4Frames, [[720, 960]]);
  assert.equal(kling4Body.aspect_ratio, undefined);

  const rotatedFramePath = path.join(root, 'rotated-frame.jpg');
  const rotatedFrameBytes = await sharp(fixtureBytes).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  fs.writeFileSync(rotatedFramePath, rotatedFrameBytes);
  deliveredKling4Frames.length = 0;
  await kling4Adapter.prepare({ ...firstFrame, inputs: [{
    ...firstFrame.inputs[0], absolutePath: rotatedFramePath, mimeType: 'image/jpeg', byteSize: rotatedFrameBytes.length,
  }] });
  assert.deepEqual(deliveredKling4Frames, [[720, 960]], '裁切使用 EXIF 校正后的宽高');

  const reference = context(kling4, smallPath, fixtureBytes, 'image/png');
  reference.parameters = { durationSec: 3, resolution: '720p', aspectRatio: '16:9' };
  // A delivery double stands in for the already tested upstream video upload.
  const referenceVideo = path.join(root, 'reference.mp4');
  fs.writeFileSync(referenceVideo, 'fixture');
  reference.inputs = [
    { ...reference.inputs[0], absolutePath: frames.inputs[0].absolutePath },
    { ...reference.inputs[0], refId: 'ref2', orderIndex: 1, kind: 'video', role: 'camera', mimeType: 'video/mp4',
      absolutePath: referenceVideo, byteSize: 7, durationSec: 3 },
  ];
  await kling4Adapter.prepare(reference);
  await kling4Adapter.submit(reference);
  assert.deepEqual(kling4Body.image_urls, ['https://canvas-cos.test/frame-0.png']);
  assert.deepEqual(kling4Body.video_urls, ['https://canvas-cos.test/reference.mp4']);
  assert.equal(kling4Body.images, undefined);
  assert.equal(kling4Body.aspect_ratio, '16:9');
  for (const [ratio, gatewayRatio] of [
    ['3:4', 'adaptive'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:3', '4:3'], ['21:9', '21:9'], ['adaptive', 'adaptive'],
  ]) {
    reference.parameters.aspectRatio = ratio;
    await kling4Adapter.prepare(reference);
    const postsBeforeSubmit = kling4Posts;
    await kling4Adapter.submit(reference);
    assert.equal(kling4Posts, postsBeforeSubmit + 1);
    assert.equal(kling4Body.aspect_ratio, gatewayRatio);
    assert.equal(reference.parameters.aspectRatio, ratio);
    assert.deepEqual(kling4Body.image_urls, [reference.inputs[0].deliveryRef]);
    assert.equal(reference.inputs[0].deliveryRef === 'https://canvas-cos.test/frame-0.png', ratio !== '3:4');
    assert.deepEqual(kling4Body.video_urls, ['https://canvas-cos.test/reference.mp4']);
  }
  await assert.rejects(kling4Adapter.prepare({ ...reference, inputs: [] }), /至少/);

  const referenceImage = fixtures[0];
  const referenceImagePath = path.join(root, referenceImage.name);
  const largeKling4Reference = context(kling4, referenceImagePath, referenceImage.bytes, referenceImage.mime);
  largeKling4Reference.parameters = { ...reference.parameters, resolution: '1080p' };
  const kling4CosAdapter = createCompanyCanvasAdapter({
    db, deliverer: createDefaultCanvasDeliverer(),
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method, 'POST');
      kling4Body = JSON.parse(String(init.body));
      return Response.json({ id: 'test-large-kling4' });
    },
  });
  uploads.length = 0;
  await kling4CosAdapter.prepare(largeKling4Reference);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].bytes.length <= 10 * 1024 * 1024);
  assert.equal(largeKling4Reference.inputs[0].byteSize, referenceImage.bytes.length);
  assert.deepEqual(fs.readFileSync(referenceImagePath), referenceImage.bytes);
  assert.deepEqual(uploadCopies(), []);
  await kling4CosAdapter.submit(largeKling4Reference);
  assert.equal(kling4Body.resolution, '1080p');
  assert.deepEqual(kling4Body.image_urls, [largeKling4Reference.inputs[0].deliveryRef]);

  // Exercise the actual bytes handed to COS before the generation request.
  const landscapePath = path.join(root, 'landscape-reference.png');
  const landscapeBytes = await sharp(pixels.subarray(0, 1280 * 720 * 4), {
    raw: { width: 1280, height: 720, channels: 4 },
  }).png().toBuffer();
  fs.writeFileSync(landscapePath, landscapeBytes);
  const photoReferences = context(kling4, landscapePath, landscapeBytes, 'image/png');
  photoReferences.inputs.push({ ...photoReferences.inputs[0], refId: 'ref2', role: 'product', orderIndex: 1,
    absolutePath: rotatedFramePath, mimeType: 'image/jpeg', byteSize: rotatedFrameBytes.length });
  photoReferences.parameters = { durationSec: 3, resolution: '1080p', aspectRatio: '3:4' };
  uploads.length = 0;
  await kling4CosAdapter.prepare(photoReferences);
  assert.equal(uploads.length, 2);
  const photoSizes = await Promise.all(uploads.map(async upload => {
    const { width, height } = await sharp(upload.bytes).metadata();
    return [width, height];
  }));
  assert.deepEqual(photoSizes, [[540, 720], [720, 960]], '16:9 and EXIF-oriented 9:16 are both cropped before upload');
  const centerPixels = await sharp(landscapeBytes).extract({ left: 370, top: 0, width: 540, height: 720 }).raw().toBuffer();
  assert.ok((await sharp(uploads[0].bytes).raw().toBuffer()).equals(centerPixels), 'the upload contains the centered crop, without stretching');
  assert.ok(fs.readFileSync(landscapePath).equals(landscapeBytes));
  assert.deepEqual(fs.readFileSync(rotatedFramePath), rotatedFrameBytes);
  await kling4CosAdapter.submit(photoReferences);
  assert.deepEqual(kling4Body.image_urls, photoReferences.inputs.map(input => input.deliveryRef));
  assert.equal(kling4Body.aspect_ratio, 'adaptive');
  assert.equal(kling4Body.start_image_url, undefined);
  assert.deepEqual(uploadCopies(), []);

  const exactPhoto = await sharp(landscapeBytes).extract({ left: 0, top: 0, width: 540, height: 720 }).png().toBuffer();
  const exactPath = path.join(root, 'exact-3x4.png');
  fs.writeFileSync(exactPath, exactPhoto);
  const alreadyPrepared = context(kling4, exactPath, exactPhoto, 'image/png');
  alreadyPrepared.parameters = photoReferences.parameters;
  uploads.length = 0;
  await kling4CosAdapter.prepare(alreadyPrepared);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].bytes.equals(exactPhoto), 'a compliant 3:4 photo keeps its original bytes');

  const invalidPhoto = Buffer.from('invalid png');
  const invalidPath = path.join(root, 'invalid-reference.png');
  fs.writeFileSync(invalidPath, invalidPhoto);
  const invalidReference = context(kling4, invalidPath, invalidPhoto, 'image/png');
  invalidReference.parameters = photoReferences.parameters;
  await assert.rejects(kling4CosAdapter.prepare(invalidReference), (error: unknown) => error instanceof CanvasAdapterError
    && error.stage === 'prepare' && error.code === 'reference_aspect_ratio_failed');
  assert.equal(uploads.length, 1, 'a failed crop must not upload the reference');

  const matchingWidth = 1797;
  const matchingHeight = 2396;
  const matchingPng = await sharp(pixels.subarray(0, matchingWidth * matchingHeight * 4), {
    raw: { width: matchingWidth, height: matchingHeight, channels: 4 },
  }).png().toBuffer();
  assert.ok(matchingPng.length > 10 * 1024 * 1024);
  const matchingPath = path.join(root, 'large-3x4.png');
  fs.writeFileSync(matchingPath, matchingPng);
  const matchingPhoto = context(kling4, matchingPath, matchingPng, 'image/png');
  matchingPhoto.parameters = photoReferences.parameters;
  uploads.length = 0;
  await kling4CosAdapter.prepare(matchingPhoto);
  assert.equal(uploads.length, 1);
  const reduced = await sharp(uploads[0].bytes).metadata();
  assert.ok(uploads[0].bytes.length <= 10 * 1024 * 1024);
  assert.equal(reduced.hasAlpha, true);
  assert.equal(reduced.width * 4, reduced.height * 3, 'shrinking to meet the byte budget must retain exact 3:4');
  assert.ok(fs.readFileSync(matchingPath).equals(matchingPng));
  assert.deepEqual(uploadCopies(), []);
  const uploadCount = uploads.length;
  await assert.rejects(kling4CosAdapter.prepare({
    ...reference, inputs: [{ ...reference.inputs[1], byteSize: 201 * 1024 * 1024 }],
  }), /超过 200 MiB 上限/);
  assert.equal(uploads.length, uploadCount);

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

    if (capability.modelAlias === 'minimax-h3') {
      const tall = await sharp({ create: { width: 4342, height: 6513, channels: 3, background: '#a48763' } }).jpeg().toBuffer();
      const file = path.join(root, 'tall-below-byte-limit.jpg');
      fs.writeFileSync(file, tall);
      assert.ok(tall.length < 10 * 1024 * 1024);
      const request = context(capability, file, tall, 'image/jpeg');
      uploads.length = 0;
      await adapter.prepare(request);
      assert.equal(uploads.length, 1);
      const dimensions = await sharp(uploads[0].bytes).metadata();
      assert.deepEqual([dimensions.width, dimensions.height], [3840, 5760]);
      assert.deepEqual(fs.readFileSync(file), tall);
      assert.equal(request.inputs[0].absolutePath, file);
      assert.equal(request.inputs[0].byteSize, tall.length);
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
      (error: unknown) => error instanceof CanvasAdapterError
        && error.code === (capability.modelAlias === 'minimax-h3' ? 'reference_preparation_failed' : 'image_compression_failed'));
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
  _setCompanyTailFrameRuntimeInspectorForTest(null);
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('creative-canvas-media-delivery.test.ts passed');
