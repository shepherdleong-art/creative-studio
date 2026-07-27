import assert from 'node:assert/strict';
import { chatCompletion, usesOpenAiResponses } from '../lib/script-providers/openai-responses.ts';
import type { ScriptProviderRuntimeConfig } from '../lib/script-providers/config.ts';
import type { ProviderConfig } from '../lib/script-providers/types.ts';

const config: ProviderConfig = {
  id: 'gpt',
  name: 'GPT',
  apiStyle: 'openai-responses',
  keyEnv: '',
  baseUrlEnv: '',
  modelEnv: '',
  defaultModel: 'gpt-5.4',
  defaultBaseUrl: 'https://example.test',
  maxTokens: 1500,
};
const runtime: ScriptProviderRuntimeConfig = {
  id: 'gpt',
  name: 'GPT',
  apiStyle: 'openai-responses',
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  model: 'gpt-5.4',
  maxTokens: 1500,
  enabled: true,
  configured: true,
  missing: [],
  hasApiKey: true,
  supportsVision: true,
  visionCostPerRequest: 0,
};

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

function streamResponse(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

try {
  let requestedUrl = '';
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return streamResponse([
      'data: {"type":"response.output_text.del',
      'ta","delta":"{\\"ok\\":"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"true}"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ]);
  };

  const result = await chatCompletion(config, {
    systemPrompt: '只返回 JSON',
    userPrompt: '分析图片',
    maxTokens: 1200,
    responseFormat: 'json_object',
    images: [{ mimeType: 'image/jpeg', imageBase64: 'abc123' }],
  }, runtime);
  assert.equal(result, '{"ok":true}');
  assert.equal(requestedUrl, 'https://example.test/v1/responses');
  assert.equal(requestedBody.stream, true);
  assert.equal(requestedBody.max_output_tokens, 1200);
  const input = requestedBody.input as Array<{ role: string; content: unknown }>;
  assert.deepEqual(input[1].content, [
    { type: 'input_text', text: '分析图片' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,abc123' },
  ]);

  globalThis.fetch = async () => streamResponse(['data: {"type":"response.completed"}\n\n']);
  await assert.rejects(
    chatCompletion(config, { systemPrompt: 'system', userPrompt: 'user' }, runtime),
    /返回了空响应/
  );

  globalThis.fetch = async () => streamResponse([
    'data: {"type":"response.failed","response":{"error":{"message":"quota exceeded"}}}\n\n',
  ]);
  await assert.rejects(
    chatCompletion(config, { systemPrompt: 'system', userPrompt: 'user' }, runtime),
    /quota exceeded/
  );

  assert.equal(usesOpenAiResponses('openai-responses'), true);
  assert.equal(usesOpenAiResponses('native-gemini'), false, 'Native Gemini 不得路由到 Responses');
  assert.equal(usesOpenAiResponses('openai-compatible'), false, 'Chat Completions 供应商不得路由到 Responses');

  globalThis.fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
    start() {
      init?.signal?.addEventListener('abort', () => undefined);
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(
    chatCompletion(config, { systemPrompt: 'system', userPrompt: 'user', timeoutMs: 20 }, runtime),
    /请求超时/
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai responses adapter tests passed');
