import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jimengAdapter } from '../lib/video-providers/jimeng.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-adapter-'));
const imagePath = path.join(tmpDir, 'source.png');
const tailImagePath = path.join(tmpDir, 'tail.png');
fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(tailImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

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
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-2-0-260128'), {
    supported: true,
    protocol: 'ark-content-roles',
  });
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-2-0-260128-fast'), {
    supported: false,
    reason: 'unsupported_model',
  });
  assert.deepEqual(jimengAdapter.tailFrameCapability?.('doubao-seedance-1-5-pro-251215'), {
    supported: false,
    reason: 'unsupported_model',
  });

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

  const tailResult = await jimengAdapter.submit(
    {
      model: 'doubao-seedance-2-0-260128',
      prompt: '从首帧自然过渡到尾帧',
      sourceImagePath: imagePath,
      sourceMimeType: 'image/png',
      tailImagePath,
      tailMimeType: 'image/png',
      durationSec: 5,
    },
    'ark-key',
    'https://ark.cn-beijing.volces.com/api/v3',
  );

  assert.equal(tailResult.providerTaskId, 'task-1');
  const tailContent = capturedBody?.content as Array<Record<string, unknown>>;
  assert.equal(tailContent.length, 3);
  assert.equal(tailContent[0].type, 'text');
  assert.equal(tailContent[0].text, '从首帧自然过渡到尾帧');
  assert.equal(tailContent[1].type, 'image_url');
  assert.equal((tailContent[1].image_url as { url: string }).url.startsWith('data:image/png;base64,'), true);
  assert.equal(tailContent[1].role, 'first_frame');
  assert.equal(tailContent[2].type, 'image_url');
  assert.equal((tailContent[2].image_url as { url: string }).url.startsWith('data:image/png;base64,'), true);
  assert.equal(tailContent[2].role, 'last_frame');

  await assert.rejects(
    () => jimengAdapter.submit(
      {
        model: 'doubao-seedance-2-0-260128-fast',
        prompt: '不支持的尾帧模型',
        sourceImagePath: imagePath,
        sourceMimeType: 'image/png',
        tailImagePath,
        tailMimeType: 'image/png',
        durationSec: 5,
      },
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
    ),
    /tail frame.*unsupported/i,
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('jimeng video adapter tests passed');
