import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-video-adapter-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = tmpDir;
process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL = 'https://media.example.com';

const originalNetworkInterfaces = os.networkInterfaces;
os.networkInterfaces = () => ({
  Ethernet: [{
    address: '10.123.45.67',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: '10.123.45.67/24',
  }],
});

const storageDir = path.join(tmpDir, 'storage', 'sources');
fs.mkdirSync(storageDir, { recursive: true });
const imagePath = path.join(storageDir, 'source.png');
fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const outsideImagePath = path.join(tmpDir, 'outside.png');
fs.writeFileSync(outsideImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

let capturedUrl = '';
let capturedBody: Record<string, unknown> | undefined;
let capturedHeaders: Headers | undefined;
const capturedMethods: string[] = [];

const originalFetch = globalThis.fetch;
const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  capturedUrl = String(input);
  capturedMethods.push(init?.method || 'GET');
  capturedBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  capturedHeaders = new Headers(init?.headers);
  return new Response(JSON.stringify({
    id: 'video_xxx',
    object: 'video',
    status: init?.method === 'POST' ? 'queued' : 'completed',
    progress: init?.method === 'POST' ? 0 : 100,
    metadata: { url: 'http://localhost:3000/v1/videos/video_xxx/content' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

function assertActionablePublicUrlError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /CREATIVE_STUDIO_PUBLIC_BASE_URL/);
  assert.match(error.message, /(?:设置|配置|公网|访问)/);
  return true;
}

try {
  // dataRoot() depends on the environment, so import after setting the data root.
  const { openaiVideoAdapter } = await import('../lib/video-providers/openai-video.ts');
  globalThis.fetch = mockFetch;

  const result = await openaiVideoAdapter.submit(
    {
      model: 'kling-3.0',
      prompt: '镜头慢慢推进产品细节',
      sourceImagePath: imagePath,
      sourceMimeType: 'image/png',
      durationSec: 5,
    },
    'gateway-key',
    'https://llm-gateway.example.com',
  );

  assert.equal(result.providerTaskId, 'video_xxx');
  assert.equal(capturedMethods[0], 'POST');
  assert.equal(capturedUrl, 'https://llm-gateway.example.com/v1/videos');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer gateway-key');
  assert.deepEqual(Object.keys(capturedBody || {}).sort(), ['images', 'model', 'multi_shot', 'prompt', 'seconds', 'shot_type']);
  assert.equal(capturedBody?.model, 'kling-3.0');
  assert.equal(capturedBody?.prompt, '镜头慢慢推进产品细节');
  assert.equal(capturedBody?.seconds, '5');
  assert.equal(capturedBody?.multi_shot, true);
  assert.equal(capturedBody?.shot_type, 'intelligence');
  assert.deepEqual(capturedBody?.images, [
    'https://media.example.com/api/images/sources/source.png',
  ]);

  delete process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL;
  const fetchCountBeforePrivateNetworkSubmit = capturedMethods.length;
  await assert.rejects(
    openaiVideoAdapter.submit(
      {
        model: 'kling-3.0',
        prompt: 'test',
        sourceImagePath: imagePath,
        sourceMimeType: 'image/png',
        durationSec: 5,
      },
      'gateway-key',
      'https://llm-gateway.example.com',
    ),
    assertActionablePublicUrlError,
  );
  assert.equal(capturedMethods.length, fetchCountBeforePrivateNetworkSubmit);

  const fetchCountBeforeUnresolvableSubmit = capturedMethods.length;
  await assert.rejects(
    openaiVideoAdapter.submit(
      {
        model: 'kling-3.0',
        prompt: 'test',
        sourceImagePath: outsideImagePath,
        sourceMimeType: 'image/png',
        durationSec: 5,
      },
      'gateway-key',
      'https://llm-gateway.example.com',
    ),
    assertActionablePublicUrlError,
  );
  assert.equal(capturedMethods.length, fetchCountBeforeUnresolvableSubmit);

  process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL = 'http://192.168.1.10:3000';
  const fetchCountBeforeConfiguredPrivateSubmit = capturedMethods.length;
  await openaiVideoAdapter.submit(
    {
      model: 'doubao-seedance-2-0-260128',
      prompt: 'test',
      sourceImagePath: imagePath,
      sourceMimeType: 'image/png',
      durationSec: 5,
    },
    'gateway-key',
    'https://llm-gateway.example.com',
  );
  assert.equal(capturedMethods.length, fetchCountBeforeConfiguredPrivateSubmit + 1);
  assert.equal(capturedUrl, 'https://llm-gateway.example.com/v1/videos');
  assert.deepEqual(Object.keys(capturedBody || {}).sort(), ['images', 'model', 'prompt', 'seconds']);
  assert.deepEqual(capturedBody?.images, [
    'http://192.168.1.10:3000/api/images/sources/source.png',
  ]);

  const pollResult = await openaiVideoAdapter.poll(
    'video_xxx',
    'gateway-key',
    'https://llm-gateway.example.com/',
  );

  assert.equal(pollResult.status, 'succeeded');
  assert.equal(pollResult.videoUrl, 'https://llm-gateway.example.com/v1/videos/video_xxx/content');
  assert.equal(capturedMethods[2], 'GET');
  assert.equal(capturedUrl, 'https://llm-gateway.example.com/v1/videos/video_xxx');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer gateway-key');

  const secretApiKey = 'gateway key/?';
  const encodedApiKey = encodeURIComponent(secretApiKey);
  const sasUrl = 'https://account.blob.core.windows.net/c/video.mp4?sv=1&sig=azure-secret';
  const assertSecretFree = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert.doesNotMatch(text, /gateway key\/\?|azure-secret|(?:^|[?&])sig=|(?:^|[?&])sv=/i);
    assert.equal(text.toLowerCase().includes(encodedApiKey.toLowerCase()), false);
    assert.match(text, /\?\[query redacted\]/);
  };
  const secretRequest = {
    model: 'kling-3.0',
    prompt: 'test',
    sourceImagePath: imagePath,
    sourceMimeType: 'image/png' as const,
    durationSec: 5,
  };

  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: `raw=${secretApiKey}; encoded=${encodedApiKey}; url=${sasUrl}`,
    code: 'E_SUBMIT', retry: false,
  }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await assert.rejects(
    openaiVideoAdapter.submit(secretRequest, secretApiKey, 'https://llm-gateway.example.com'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assertSecretFree(error.message);
      return true;
    },
  );

  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: 'video_secret', status: 'queued',
    diagnostic: `raw=${secretApiKey}; encoded=${encodedApiKey}; url=${sasUrl}`,
    authorization: 'Bearer bearer-secret',
    code: 'E_QUEUED', retry: false,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const sanitizedSubmit = await openaiVideoAdapter.submit(secretRequest, secretApiKey, 'https://llm-gateway.example.com');
  assertSecretFree(sanitizedSubmit.rawResponse);
  assert.doesNotMatch(JSON.stringify(sanitizedSubmit.rawResponse), /bearer-secret/i);
  assert.equal((sanitizedSubmit.rawResponse as Record<string, unknown>).authorization, 'Bearer [REDACTED]');
  assert.equal((sanitizedSubmit.rawResponse as Record<string, unknown>).code, 'E_QUEUED');
  assert.equal((sanitizedSubmit.rawResponse as Record<string, unknown>).retry, false);

  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: `raw=${secretApiKey}; encoded=${encodedApiKey}; url=${sasUrl}`,
    code: 'E_POLL', retry: false,
  }), { status: 429, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const rejectedPoll = await openaiVideoAdapter.poll('video_secret', secretApiKey, 'https://llm-gateway.example.com');
  assertSecretFree(rejectedPoll.errorMessage);
  assertSecretFree(rejectedPoll.rawResponse);
  assert.equal((rejectedPoll.rawResponse as Record<string, unknown>).code, 'E_POLL');
  assert.equal((rejectedPoll.rawResponse as Record<string, unknown>).retry, false);

  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: 'video_secret', status: 'failed',
    error: { message: `raw=${secretApiKey}; encoded=${encodedApiKey}; url=${sasUrl}` },
    code: 'E_TASK', retry: false,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const failedPoll = await openaiVideoAdapter.poll('video_secret', secretApiKey, 'https://llm-gateway.example.com');
  assert.equal(failedPoll.status, 'failed');
  assertSecretFree(failedPoll.errorMessage);
  assertSecretFree(failedPoll.rawResponse);
  assert.equal((failedPoll.rawResponse as Record<string, unknown>).code, 'E_TASK');
  assert.equal((failedPoll.rawResponse as Record<string, unknown>).retry, false);
} finally {
  globalThis.fetch = originalFetch;
  os.networkInterfaces = originalNetworkInterfaces;
  delete process.env.CREATIVE_STUDIO_PUBLIC_BASE_URL;
  delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('openai-video adapter tests passed');
