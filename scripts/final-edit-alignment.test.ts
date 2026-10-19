import assert from 'node:assert/strict';
import { createOpenAiAlignmentAdapter } from '../lib/final-edit/adapters/alignment.ts';

const fallback = {
  baseUrl: 'https://api.v3.cm',
  apiKey: 'configured-vapi-key',
  model: 'whisper-1',
};

function successfulResponse(): Response {
  return Response.json({ words: [{ word: '你好', start: 0, end: 0.5 }] });
}

async function withMockFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function run() {
  assert.equal(createOpenAiAlignmentAdapter({}, fallback).configured, true,
    'V-API provider config should enable Whisper alignment without duplicate env settings');
  assert.equal(createOpenAiAlignmentAdapter({
    FINAL_EDIT_ALIGNMENT_BASE_URL: 'https://dedicated-alignment.example.com',
  }, fallback).configured, false,
  'partial dedicated alignment settings must not mix credentials with the V-API fallback');

  let transientRequestCount = 0;
  await withMockFetch(async () => {
    transientRequestCount += 1;
    if (transientRequestCount === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
    if (transientRequestCount === 2) return new Response('upstream unavailable', { status: 503, headers: { 'Retry-After': '0' } });
    return successfulResponse();
  }, async () => {
    const words = await createOpenAiAlignmentAdapter({}, fallback).align({ audioPath: new URL(import.meta.url).pathname, text: '你好' });
    assert.equal(transientRequestCount, 3, '429 and 5xx responses should be retried');
    assert.deepEqual(words, [{ text: '你好', startUs: 0, endUs: 500_000 }]);
  });

  let networkRequestCount = 0;
  await withMockFetch(async () => {
    networkRequestCount += 1;
    if (networkRequestCount === 1) throw new Error('offline');
    return successfulResponse();
  }, async () => {
    await createOpenAiAlignmentAdapter({}, fallback).align({ audioPath: new URL(import.meta.url).pathname, text: '你好' });
    assert.equal(networkRequestCount, 2, 'network errors should be retried');
  });

  let exhaustedRequestCount = 0;
  await withMockFetch(async () => {
    exhaustedRequestCount += 1;
    return new Response('still unavailable', { status: 503, headers: { 'Retry-After': '0' } });
  }, async () => {
    await assert.rejects(
      createOpenAiAlignmentAdapter({}, fallback).align({ audioPath: new URL(import.meta.url).pathname, text: '你好' }),
      /强制对齐服务返回 503/,
    );
    assert.equal(exhaustedRequestCount, 5, 'retryable responses should stop after five attempts');
  });

  let unauthorizedRequestCount = 0;
  await withMockFetch(async () => {
    unauthorizedRequestCount += 1;
    return new Response('unauthorized', { status: 401 });
  }, async () => {
    await assert.rejects(
      createOpenAiAlignmentAdapter({}, fallback).align({ audioPath: new URL(import.meta.url).pathname, text: '你好' }),
      /强制对齐服务返回 401/,
    );
    assert.equal(unauthorizedRequestCount, 1, 'configuration errors must not be retried');
  });
}

void run()
  .then(() => console.log('final-edit alignment tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
