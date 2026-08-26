import assert from 'node:assert/strict';
import { completeAnthropicMessagesJson } from '../lib/script-providers/anthropic-messages.ts';
import { completeOpenAiCompatibleJson } from '../lib/script-providers/openai-compatible.ts';
import { completeOpenAiResponsesJson } from '../lib/script-providers/openai-responses.ts';
import type { ProviderConfig } from '../lib/script-providers/types.ts';
import type { ScriptProviderRuntimeConfig } from '../lib/script-providers/config.ts';

const encoder = new TextEncoder();

const config: ProviderConfig = {
  id: 'qwen',
  name: 'Qwen',
  apiStyle: 'openai-compatible',
  keyEnv: 'QWEN_API_KEY',
  baseUrlEnv: 'QWEN_BASE_URL',
  modelEnv: 'QWEN_MODEL',
  defaultModel: 'qwen3.6-max-preview',
  defaultBaseUrl: 'https://chat.example/v1',
  maxTokens: 4096,
};

const runtime: ScriptProviderRuntimeConfig = {
  id: 'qwen',
  name: 'Qwen',
  apiStyle: 'openai-compatible',
  baseUrl: 'https://chat.example/v1',
  apiKey: 'key',
  model: 'qwen3.6-max-preview',
  maxTokens: 4096,
  enabled: true,
  configured: true,
  missing: [],
  hasApiKey: true,
  supportsVision: true,
  visionCostPerRequest: 0,
  executionScope: 'external',
};

const anthropicConfig: ProviderConfig = {
  id: 'kimi',
  name: 'Kimi',
  apiStyle: 'anthropic-messages',
  keyEnv: 'KIMI_API_KEY',
  baseUrlEnv: 'KIMI_BASE_URL',
  modelEnv: 'KIMI_MODEL',
  defaultModel: 'kimi-k3',
  defaultBaseUrl: 'https://anthropic.example/v1',
  maxTokens: 4096,
};

const anthropicRuntime: ScriptProviderRuntimeConfig = {
  id: 'kimi',
  name: 'Kimi',
  apiStyle: 'anthropic-messages',
  baseUrl: 'https://anthropic.example/v1',
  apiKey: 'key',
  model: 'kimi-k3',
  maxTokens: 4096,
  enabled: true,
  configured: true,
  missing: [],
  hasApiKey: true,
  supportsVision: true,
  visionCostPerRequest: 0,
  executionScope: 'external',
};

const responsesConfig: ProviderConfig = {
  id: 'gpt',
  name: 'GPT',
  apiStyle: 'openai-responses',
  keyEnv: 'GPT_API_KEY',
  baseUrlEnv: 'GPT_BASE_URL',
  modelEnv: 'GPT_MODEL',
  defaultModel: 'gpt-5.5',
  defaultBaseUrl: 'https://responses.example/v1',
  maxTokens: 4096,
};

const responsesRuntime: ScriptProviderRuntimeConfig = {
  id: 'gpt',
  name: 'GPT',
  apiStyle: 'openai-responses',
  baseUrl: 'https://responses.example/v1',
  apiKey: 'key',
  model: 'gpt-5.5',
  maxTokens: 4096,
  enabled: true,
  configured: true,
  missing: [],
  hasApiKey: true,
  supportsVision: true,
  visionCostPerRequest: 0,
  executionScope: 'external',
};

function streamResponse(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const originalFetch = globalThis.fetch;
const textChunks = [
  'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"think"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"true}"}}]}\n\n',
  'data: {"choices":[],"usage":{"total_tokens":12}}\n\n',
  'data: [DONE]\n\n',
];

const anthropicChunks = [
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason "}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"true}"}}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  'data: {"type":"message_stop"}\n\n',
];

try {
  let requests = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const textDeltas: string[] = [];
  const reasoningDeltas: string[] = [];
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return streamResponse(textChunks);
  };

  await completeOpenAiCompatibleJson(config, {
    systemPrompt: 'system',
    userPrompt: 'user',
    onTextDelta: (accumulated) => textDeltas.push(accumulated),
    onReasoningDelta: (accumulated) => reasoningDeltas.push(accumulated),
  }, runtime);

  assert.equal(requests, 1);
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.ok(textDeltas.length >= 2);
  assert.equal(textDeltas[textDeltas.length - 1], '{"ok":true}');
  assert.ok(reasoningDeltas.length >= 1);
  assert.equal(reasoningDeltas[reasoningDeltas.length - 1], 'think');

  // temperature=1 重试后，请求体必须仍然保留流式参数。
  requests = 0;
  bodies.length = 0;
  textDeltas.length = 0;
  reasoningDeltas.length = 0;
  let first = true;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    if (first) {
      first = false;
      return new Response('temperature 0.5 is not supported by this model', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return streamResponse(textChunks);
  };

  await completeOpenAiCompatibleJson(config, {
    systemPrompt: 'system',
    userPrompt: 'user',
    temperature: 0.5,
    onTextDelta: (accumulated) => textDeltas.push(accumulated),
    onReasoningDelta: (accumulated) => reasoningDeltas.push(accumulated),
  }, runtime);

  assert.equal(requests, 2);
  assert.equal(bodies[1].temperature, 1);
  assert.equal(bodies[1].stream, true);
  assert.deepEqual(bodies[1].stream_options, { include_usage: true });
  assert.equal(textDeltas[textDeltas.length - 1], '{"ok":true}');
  assert.equal(reasoningDeltas[reasoningDeltas.length - 1], 'think');

  // 公司 Luna 命中的模型在首请求即带 temperature=1，不产生 400 往返。
  requests = 0;
  bodies.length = 0;
  const companyRuntime = {
    ...runtime,
    model: 'GPT-5-6-Luna-Standard',
  };
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return streamResponse(textChunks);
  };
  await completeOpenAiCompatibleJson(config, {
    systemPrompt: 'system',
    userPrompt: 'user',
    temperature: 0.5,
    stream: true,
  }, companyRuntime);
  assert.equal(requests, 1);
  assert.equal(bodies[0].temperature, 1);
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });

  // 只有正文、没有推理时，onReasoningDelta 必须从不触发。
  requests = 0;
  let reasoningCalled = false;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return streamResponse([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n',
      'data: {"choices":[]}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  await completeOpenAiCompatibleJson(config, {
    systemPrompt: 'system',
    userPrompt: 'user',
    onTextDelta: () => undefined,
    onReasoningDelta: () => {
      reasoningCalled = true;
    },
  }, runtime);
  assert.equal(requests, 1);
  assert.equal(reasoningCalled, false);

  // anthropic-messages：thinking_delta / text_delta 分流，并发送 stream + thinking 参数。
  let anthropicRequests = 0;
  let anthropicBody: Record<string, unknown> = {};
  const anthropicTextDeltas: string[] = [];
  const anthropicReasoningDeltas: string[] = [];
  globalThis.fetch = async (_input, init) => {
    anthropicRequests += 1;
    anthropicBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return streamResponse(anthropicChunks);
  };
  await completeAnthropicMessagesJson(anthropicConfig, {
    systemPrompt: 'system',
    userPrompt: 'user',
    onTextDelta: (accumulated) => anthropicTextDeltas.push(accumulated),
    onReasoningDelta: (accumulated) => anthropicReasoningDeltas.push(accumulated),
  }, anthropicRuntime);
  assert.equal(anthropicRequests, 1);
  assert.equal(anthropicBody.stream, true);
  assert.deepEqual(anthropicBody.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(anthropicTextDeltas[anthropicTextDeltas.length - 1], '{"ok":true}');
  assert.equal(anthropicReasoningDeltas[anthropicReasoningDeltas.length - 1], 'reason ');

  // openai-responses：正文与推理字段按 schema 分流。
  let responsesBody: Record<string, unknown> = {};
  const responsesTextDeltas: string[] = [];
  const responsesReasoningDeltas: string[] = [];
  globalThis.fetch = async (_input, init) => {
    responsesBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return streamResponse([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"true}"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ]);
  };
  await completeOpenAiResponsesJson(responsesConfig, {
    systemPrompt: 'system',
    userPrompt: 'user',
    onTextDelta: (accumulated) => responsesTextDeltas.push(accumulated),
    onReasoningDelta: (accumulated) => responsesReasoningDeltas.push(accumulated),
  }, responsesRuntime);
  assert.equal(responsesBody.stream, true);
  assert.deepEqual(responsesBody.reasoning, { summary: 'auto' });
  assert.equal(responsesTextDeltas[responsesTextDeltas.length - 1], '{"ok":true}');
  assert.equal(responsesReasoningDeltas[responsesReasoningDeltas.length - 1], 'think');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('script provider stream adapters tests passed');
