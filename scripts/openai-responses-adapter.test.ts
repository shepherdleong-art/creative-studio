import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  executionScope: 'external',
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

  const routingDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-responses-routing-'));
  try {
    const childPath = path.join(routingDataRoot, 'routing-check.mjs');
    const indexUrl = pathToFileURL(path.resolve('lib/script-providers/index.ts')).href;
    const dbUrl = pathToFileURL(path.resolve('lib/db.ts')).href;
    fs.writeFileSync(childPath, `
      import assert from 'node:assert/strict';
      const { completeJson, getAvailableProviders } = await import(${JSON.stringify(indexUrl)});
      const { closeDb, getDb } = await import(${JSON.stringify(dbUrl)});
      getAvailableProviders();
      const db = getDb();
      db.prepare("UPDATE script_providers SET baseUrl=?, apiKey=?, model=?, apiStyle=?, enabled=1 WHERE id=?")
        .run('https://chat.example/v1', 'chat-key', 'chat-model', 'openai-compatible', 'qwen');
      db.prepare("UPDATE script_providers SET baseUrl=?, apiKey=?, model=?, apiStyle=?, enabled=1 WHERE id=?")
        .run('https://gemini.example', 'gemini-key', 'gemini-model', 'native-gemini', 'gemini');
      const urls = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/responses')) throw new Error('non-Responses apiStyle was routed to Responses');
        if (url.includes(':generateContent')) {
          return Response.json({ candidates: [{ content: { parts: [{ text: '{"route":"native-gemini"}' }] } }] });
        }
        return Response.json({ choices: [{ message: { content: '{"route":"openai-compatible"}' } }] });
      };
      assert.deepEqual(await completeJson({ providerId: 'qwen', systemPrompt: 'system', userPrompt: 'user' }), { route: 'openai-compatible' });
      assert.deepEqual(await completeJson({ providerId: 'gemini', systemPrompt: 'system', userPrompt: 'user' }), { route: 'native-gemini' });
      assert.equal(urls.some((url) => url.endsWith('/v1/chat/completions')), true);
      assert.equal(urls.some((url) => url.includes(':generateContent')), true);
      assert.equal(urls.some((url) => url.includes('/responses')), false);
      const requestCountBeforeCompanyGate = urls.length;
      db.prepare("UPDATE script_providers SET executionScope='company', baseUrl=? WHERE id='qwen'")
        .run('http://127.0.0.1:4000/v1');
      await assert.rejects(
        completeJson({ providerId: 'qwen', systemPrompt: 'system', userPrompt: 'user' }),
        /尚未配置公司供应商/,
      );
      assert.equal(urls.length, requestCountBeforeCompanyGate, '公司运行环境门禁失败时不得调用供应商');
      db.prepare("UPDATE script_providers SET executionScope='external', baseUrl=? WHERE id='qwen'")
        .run('https://chat.example/v1');
      closeDb();
    `);
    const routingResult = spawnSync(process.execPath, [
      '--no-warnings',
      '--experimental-loader', pathToFileURL(path.resolve('scripts/typescript-extension-loader.mjs')).href,
      '--experimental-strip-types',
      childPath,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: routingDataRoot },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(
      routingResult.status,
      0,
      `真实 completeJson 分发测试失败：\n${routingResult.stderr}\n${routingResult.stdout}`,
    );
  } finally {
    fs.rmSync(routingDataRoot, { recursive: true, force: true });
  }

  globalThis.fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
    start() {
      init?.signal?.addEventListener('abort', () => undefined);
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(
    chatCompletion(config, { systemPrompt: 'system', userPrompt: 'user', timeoutMs: 20 }, runtime),
    /请求超时/
  );

  const cancellation = new AbortController();
  const cancelledRequest = chatCompletion(config, {
    systemPrompt: 'system', userPrompt: 'user', timeoutMs: 100, signal: cancellation.signal,
  }, runtime);
  cancellation.abort();
  await assert.rejects(cancelledRequest, /脚本生成已取消/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai responses adapter tests passed');
