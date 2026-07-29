import assert from 'node:assert/strict';
import { chatCompletion } from '../lib/script-providers/openai-compatible.ts';
import type { ScriptProviderRuntimeConfig } from '../lib/script-providers/config.ts';
import type { ProviderConfig } from '../lib/script-providers/types.ts';

const config: ProviderConfig = {
  id: 'qwen',
  name: '通义千问',
  apiStyle: 'openai-compatible',
  keyEnv: '',
  baseUrlEnv: '',
  modelEnv: '',
  defaultModel: 'qwen3.6-max-preview',
  defaultBaseUrl: 'https://example.test',
  maxTokens: 8192,
};
const runtime: ScriptProviderRuntimeConfig = {
  id: 'qwen',
  name: '通义千问',
  apiStyle: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  model: 'qwen3.6-max-preview',
  maxTokens: 8192,
  enabled: true,
  configured: true,
  missing: [],
  hasApiKey: true,
  supportsVision: true,
  visionCostPerRequest: 0,
};

const originalFetch = globalThis.fetch;
try {
  let requestedUrl = '';
  let requestedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedSignal = init?.signal;
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };

  assert.equal(await chatCompletion(config, {
    systemPrompt: '只返回 JSON',
    userPrompt: '分析图片',
    images: [{ mimeType: 'image/jpeg', imageBase64: 'abc123' }],
  }, runtime), '{"ok":true}');
  assert.equal(requestedUrl, 'https://example.test/v1/chat/completions');
  assert.ok(requestedSignal instanceof AbortSignal, 'Chat Completions 请求必须可取消');

  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(
    chatCompletion(config, { systemPrompt: 'system', userPrompt: 'user', timeoutMs: 20 }, runtime),
    /请求超时/,
  );

  const cancellation = new AbortController();
  const cancelledRequest = chatCompletion(config, {
    systemPrompt: 'system',
    userPrompt: 'user',
    timeoutMs: 100,
    signal: cancellation.signal,
  }, runtime);
  cancellation.abort();
  await assert.rejects(cancelledRequest, /脚本生成已取消/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai compatible adapter tests passed');
