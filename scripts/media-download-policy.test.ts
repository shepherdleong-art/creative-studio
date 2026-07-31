import assert from 'node:assert/strict';
import {
  describeGatewayDownloadFailure,
  downloadVideoMediaForProvider,
  shouldPersistVideoResumeDownloadFailure,
} from '../lib/media-download-policy.ts';

const originalFetch = globalThis.fetch;

try {
  assert.equal(shouldPersistVideoResumeDownloadFailure('openai-video'), true);
  assert.equal(shouldPersistVideoResumeDownloadFailure('kling'), false);
  assert.equal(shouldPersistVideoResumeDownloadFailure('jimeng'), false);

  const gatewayCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    gatewayCalls.push({ url, init });
    return new Response('gateway denied', { status: 403 });
  }) as typeof fetch;

  const gatewayResult = await downloadVideoMediaForProvider({
    providerType: 'openai-video',
    url: 'https://gateway.example/v1/videos/task-1/content',
    baseUrl: 'https://gateway.example',
    apiKey: 'gateway-key',
  });

  assert.equal(gatewayResult.ok, false);
  assert.equal(gatewayResult.status, 403);
  assert.match(gatewayResult.errorMessage, /HTTP 403/);
  assert.equal(gatewayCalls.length, 1);
  assert.equal(gatewayCalls[0].init?.redirect, 'manual');
  assert.deepEqual(gatewayCalls[0].init?.headers, { Authorization: 'Bearer gateway-key' });

  const directCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    directCalls.push({ url, init });
    return new Response(Buffer.from('video-bytes'), { status: 200 });
  }) as typeof fetch;

  const directResult = await downloadVideoMediaForProvider({
    providerType: 'jimeng',
    url: 'https://cdn.example/video.mp4',
    baseUrl: 'https://jimeng.example',
    apiKey: 'must-not-leak',
  });

  assert.equal(directResult.ok, true);
  if (directResult.ok) {
    assert.equal(directResult.buffer.toString(), 'video-bytes');
  }
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].init?.redirect, undefined);
  assert.equal(directCalls[0].init?.headers, undefined);

  const failure = describeGatewayDownloadFailure(
    'image',
    'https://gateway.example/content/gateway-key?signature=signed-secret',
    { ok: false, status: 403, errorMessage: 'HTTP 403: denied' },
    'gateway-key',
  );

  assert.deepEqual(failure, {
    status: 'failed',
    providerStatus: 'download_failed',
    errorMessage: 'Remote image ready but local download failed. HTTP 403: denied',
    logUrl: 'https://gateway.example/content/[REDACTED]?[query redacted]',
  });

  const encodedKey = 'key /?';
  const encodedFailure = describeGatewayDownloadFailure(
    'video',
    `https://gateway.example/content/${encodeURIComponent(encodedKey)}`,
    { ok: false, errorMessage: 'download failed' },
    encodedKey,
  );
  assert.equal(encodedFailure.logUrl.includes(encodedKey), false);
  assert.equal(encodedFailure.logUrl.toLowerCase().includes(encodeURIComponent(encodedKey).toLowerCase()), false);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('media download policy tests passed');
