import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';
import { QINIU_KLING_4_MODEL, QINIU_KLING_4_PROVIDER_ID } from '../lib/company-qiniu-kling-4.ts';
import type { CanvasTaskContext } from '../lib/creative-canvas/adapters/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-video-output-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);
const { createCompanyCanvasAdapter } = await import('../lib/creative-canvas/adapters/company.ts');
const { CanvasAdapterError } = await import('../lib/creative-canvas/adapters/types.ts');

const baseUrl = 'http://127.0.0.1:4000';
const taskUrl = `${baseUrl}/v1/videos/fixture-video`;
const db = new Database(':memory:');
const originalFetch = globalThis.fetch;
try {
  db.exec('CREATE TABLE video_providers (id TEXT, name TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER, defaultModel TEXT)');
  db.prepare('INSERT INTO video_providers VALUES (?, ?, ?, ?, ?, 1, ?)').run(
    QINIU_KLING_4_PROVIDER_ID, '可灵 4.0', 'openai-video', baseUrl, 'fixture-key', QINIU_KLING_4_MODEL,
  );
  const adapter = createCompanyCanvasAdapter({
    db,
    deliverer: { name: 'unused', async deliver() { throw new Error('download must not deliver input'); } },
    async fetchImpl(url, init) {
      assert.equal(String(url), taskUrl);
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json({ status: 'completed' });
    },
  });
  const context: CanvasTaskContext & { providerTaskId: string } = {
    task: { id: 'fixture-task' } as CanvasTaskContext['task'],
    providerTaskId: 'fixture-video', mediaKind: 'video', generationMode: 'reference-to-video', prompt: '',
    parameters: { aspectRatio: '3:4', resolution: '1080p' }, capabilityKey: QINIU_KLING_4_PROVIDER_ID,
    providerIdentity: QINIU_KLING_4_PROVIDER_ID, modelAlias: QINIU_KLING_4_MODEL, inputs: [{
      refId: 'ref1', orderIndex: 0, role: 'camera', note: '', kind: 'video', assetId: 'video',
      absolutePath: null, mimeType: 'video/mp4', byteSize: 100, durationSec: 3, textContent: null,
      upstreamTaskId: null, record: {} as CanvasTaskContext['inputs'][number]['record'],
    }],
  };

  const sourceFile = path.join(root, 'landscape.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x192:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-y', sourceFile,
  ], { timeoutMs: 10_000 });
  const source = fs.readFileSync(sourceFile);
  let gatewayVideo: Buffer = source;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${taskUrl}/content`);
    assert.equal(init?.method ?? 'GET', 'GET');
    return new Response(new Uint8Array(gatewayVideo), { headers: { 'Content-Type': 'video/mp4' } });
  };

  const output = await adapter.download(context);
  assert.equal(output.mimeType, 'video/mp4');
  const croppedFile = path.join(root, 'cropped.mp4');
  fs.writeFileSync(croppedFile, output.bytes);
  const original = await probeVideoMedia(sourceFile);
  const cropped = await probeVideoMedia(croppedFile);
  assert.deepEqual([cropped.width, cropped.height], [144, 192], 'references without photos retain their existing 3:4 export');
  assert.equal(cropped.durationUs, original.durationUs);
  assert.equal(cropped.fps, original.fps);
  assert.equal(cropped.audioCodec, 'aac');
  assert.equal(cropped.audioSampleRate, original.audioSampleRate);

  gatewayVideo = output.bytes;
  assert.deepEqual((await adapter.download(context)).bytes, gatewayVideo, 'already matching video keeps its original bytes');

  const anamorphicFile = path.join(root, 'anamorphic.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=120x160:rate=24', '-t', '1', '-vf', 'setsar=2', '-c:v', 'libx264', '-y', anamorphicFile,
  ], { timeoutMs: 10_000 });
  assert.equal((await probeVideoMedia(anamorphicFile)).sampleAspectRatio, 2);
  gatewayVideo = fs.readFileSync(anamorphicFile);
  fs.writeFileSync(croppedFile, (await adapter.download(context)).bytes);
  const square = await probeVideoMedia(croppedFile);
  assert.deepEqual([square.width, square.height, square.sampleAspectRatio ?? 1], [60, 80, 1]);

  gatewayVideo = source;
  const photoContext = { ...context, inputs: [...context.inputs, {
    ...context.inputs[0], refId: 'ref2', orderIndex: 1, role: 'product' as const, kind: 'image' as const,
    assetId: 'photo', mimeType: 'image/png', durationSec: null,
  }] };
  assert.ok((await adapter.download(photoContext)).bytes.equals(source), 'keep the entire product if the provider still returns landscape');

  const roundedFile = path.join(root, 'rounded.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=122x164:rate=24', '-t', '0.25', '-c:v', 'libx264', '-y', roundedFile,
  ], { timeoutMs: 10_000 });
  gatewayVideo = fs.readFileSync(roundedFile);
  fs.writeFileSync(croppedFile, (await adapter.download(photoContext)).bytes);
  const aligned = await probeVideoMedia(croppedFile);
  assert.deepEqual([aligned.width, aligned.height], [120, 160], 'only pixel rounding may be corrected after image-guided generation');
  gatewayVideo = source;
  for (const generationMode of ['image-to-video', 'frames-to-video'] as const) {
    const frames = { ...context, generationMode, parameters: { frameAspectRatio: '3:4' } };
    assert.deepEqual((await adapter.download(frames)).bytes, source);
  }
  const adaptive = { ...context, parameters: { aspectRatio: 'adaptive' } };
  assert.deepEqual((await adapter.download(adaptive)).bytes, source);

  gatewayVideo = Buffer.from('invalid video');
  await assert.rejects(adapter.download(context), (error: unknown) => error instanceof CanvasAdapterError
    && error.stage === 'download' && error.code === 'output_aspect_ratio_failed');
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage', 'tmp', 'canvas-video-output')), []);
  console.log('PASS: Kling 4.0 downloads preserve photo framing and correct pixel rounding');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
