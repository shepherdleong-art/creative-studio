import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jimengAdapter } from '../lib/video-providers/jimeng.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-adapter-'));
const imagePath = path.join(tmpDir, 'source.png');
fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

let capturedUrl = '';
let capturedBody: Record<string, unknown> | undefined;
let capturedHeaders: Headers | undefined;
const capturedMethods: string[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  capturedUrl = String(input);
  capturedMethods.push(init?.method || 'GET');
  capturedBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  capturedHeaders = new Headers(init?.headers);
  return new Response(JSON.stringify({
    id: 'task-1',
    model: capturedBody?.model || 'doubao-seedance-1-5-pro-251215',
    status: init?.method === 'POST' ? 'queued' : 'succeeded',
    content: { video_url: 'https://example.com/video.mp4' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

try {
  const result = await jimengAdapter.submit(
    {
      model: 'doubao-seedance-1-5-pro-251215',
      prompt: '镜头慢慢推进产品细节',
      sourceImagePath: imagePath,
      sourceMimeType: 'image/png',
      durationSec: 5,
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(result.providerTaskId, 'task-1');
  assert.equal(capturedMethods[0], 'POST');
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer ark-key');
  assert.equal(capturedBody?.model, 'doubao-seedance-1-5-pro-251215');
  assert.deepEqual(Object.keys(capturedBody || {}).sort(), [
    'camera_fixed',
    'content',
    'duration',
    'generate_audio',
    'model',
    'ratio',
    'resolution',
    'watermark',
  ]);
  assert.equal(capturedBody?.resolution, '1080p');
  assert.equal(capturedBody?.ratio, 'adaptive');
  assert.equal(capturedBody?.duration, 5);
  assert.equal(capturedBody?.camera_fixed, false);
  assert.equal(capturedBody?.watermark, false);
  assert.equal(capturedBody?.generate_audio, true);

  const content = capturedBody?.content as Array<Record<string, unknown>>;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '镜头慢慢推进产品细节');
  assert.equal(content[1].type, 'image_url');
  assert.ok((content[1].image_url as { url: string }).url.startsWith('data:image/png;base64,'));
  assert.equal('role' in content[1], false);

  const pollResult = await jimengAdapter.poll(
    'task-1',
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(pollResult.status, 'succeeded');
  assert.equal(pollResult.videoUrl, 'https://example.com/video.mp4');
  assert.equal(capturedMethods[1], 'GET');
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1');
  assert.equal(capturedHeaders?.get('content-type'), 'application/json');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer ark-key');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('jimeng video adapter tests passed');
