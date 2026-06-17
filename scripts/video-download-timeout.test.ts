import assert from 'node:assert/strict';
import { downloadVideo } from '../lib/video-download.ts';

const originalFetch = globalThis.fetch;
let aborted = false;

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
  throw new Error('unreachable');
}) as typeof fetch;

try {
  const startedAt = Date.now();
  const result = await downloadVideo('https://example.com/stuck.mp4', 20);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.ok(elapsedMs < 500, `download should time out quickly, took ${elapsedMs}ms`);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('video download timeout tests passed');
