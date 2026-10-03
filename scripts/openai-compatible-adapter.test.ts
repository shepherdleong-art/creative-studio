import assert from 'node:assert/strict';
import { chatCompletion, parseJsonResponse } from '../lib/script-providers/openai-compatible.ts';
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
  executionScope: 'external',
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

  // GPT-5-6-Luna-Standard 只接受默认 temperature：无论调用方传什么都固定 temperature=1，
  // 且从首次请求起生效，不应触发 400 重试。
  const lunaRuntime: ScriptProviderRuntimeConfig = {
    ...runtime,
    model: 'GPT-5-6-Luna-Standard',
  };
  const lunaBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    lunaBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  await chatCompletion(config, {
    systemPrompt: 'system', userPrompt: 'user', temperature: 0.2,
  }, lunaRuntime);
  assert.equal(lunaBodies.length, 1, 'Luna 模型不应触发 400 重试');
  assert.equal(lunaBodies[0].temperature, 1, 'Luna 模型必须固定 temperature=1');

  // 普通模型：调用方温度原样透传。
  const plainBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    plainBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  await chatCompletion(config, {
    systemPrompt: 'system', userPrompt: 'user', temperature: 0.5,
  }, runtime);
  assert.equal(plainBodies.length, 1);
  assert.equal(plainBodies[0].temperature, 0.5, '普通模型必须透传调用方温度');

  // 其他只接受默认 temperature 的模型：首次 400 后改传 temperature=1 重试，
  // 并记入进程内名单，后续调用直接固定 temperature=1。
  const reasonerRuntime: ScriptProviderRuntimeConfig = {
    ...runtime,
    model: 'reasoner-x',
  };
  const reasonerBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    reasonerBodies.push(body);
    if (reasonerBodies.length === 1) {
      return new Response(
        "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
        { status: 400 },
      );
    }
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  await chatCompletion(config, { systemPrompt: 'system', userPrompt: 'user' }, reasonerRuntime);
  assert.equal(reasonerBodies.length, 2, '被 400 拒绝后必须重试一次');
  assert.equal(reasonerBodies[0].temperature, 0.7, '默认温度 0.7 原样发出');
  assert.equal(reasonerBodies[1].temperature, 1, '被 400 拒绝后必须以 temperature=1 重试');

  await chatCompletion(config, {
    systemPrompt: 'system', userPrompt: 'user', temperature: 0.3,
  }, reasonerRuntime);
  assert.equal(reasonerBodies.length, 3, '已记忆的模型不应再次触发 400 重试');
  assert.equal(reasonerBodies[2].temperature, 1, '已记忆的模型必须固定 temperature=1');

  // 两条业务链共用此适配器：保留可识别的拒绝原因，但不泄漏上游回显的内容。
  const sensitiveEcho = 'private-prompt Bearer secret https://example.test/image?q-signature=private-signature';
  for (const sample of [
    { body: JSON.stringify({ error: { code: 'context_length_exceeded', message: sensitiveEcho } }), hint: '上下文长度超限', images: undefined },
    { body: JSON.stringify({ error: { message: `litellm.BadRequestError: OpenAIException - Error while downloading image. ${sensitiveEcho}` } }), hint: '图片读取失败', images: [{ mimeType: 'image/jpeg', imageUrl: 'https://example.test/image' }] },
    { body: JSON.stringify({ error: { code: 'rate_limit_exceeded', message: sensitiveEcho } }), hint: '上游限流', images: undefined },
    { body: JSON.stringify({ error: { code: 'insufficient_quota', message: sensitiveEcho } }), hint: '上游额度不足', images: undefined },
    { body: JSON.stringify({ error: { code: 'content_policy_violation', message: sensitiveEcho } }), hint: '上游内容审核拒绝', images: undefined },
    { body: JSON.stringify({ error: { code: 'model_not_found', message: sensitiveEcho } }), hint: '模型不存在', images: undefined },
    { body: JSON.stringify({ error: { code: 'invalid_api_key', message: sensitiveEcho } }), hint: '上游鉴权失败', images: undefined },
    { body: JSON.stringify({ error: { message: `Request timed out. ${sensitiveEcho}` } }), hint: '上游请求超时', images: undefined },
    { body: JSON.stringify({ error: { message: `Unsupported parameter: 'max_tokens'. ${sensitiveEcho}` } }), hint: '不支持的参数：max_tokens', images: undefined },
    { body: JSON.stringify({ error: { code: 'unsupported_parameter', param: 'private-parameter', message: sensitiveEcho } }), hint: '请求参数或参数值不受支持', images: undefined },
    { body: JSON.stringify({ error: { code: 'private-secret-code', message: sensitiveEcho } }), hint: '上游未提供可安全识别的原因', images: undefined },
    { body: `<html>${sensitiveEcho}</html>`, hint: '上游未提供可安全识别的原因', images: undefined },
  ]) {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response(sample.body, { status: 400 }); };
    await assert.rejects(chatCompletion(config, {
      systemPrompt: 'private-prompt', userPrompt: 'user', images: sample.images,
    }, lunaRuntime), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(sample.hint), `缺少错误诊断：${sample.hint}`);
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /private-|Bearer|https:\/\//, '错误会落库，不得包含上游原文');
      return true;
    });
    assert.equal(calls, 1, '诊断不能为任意 400 增加重试');
  }

  let fallbackCalls = 0;
  globalThis.fetch = async () => {
    fallbackCalls += 1;
    return new Response(fallbackCalls === 1
      ? "Unsupported value: 'temperature' does not support 0.7."
      : JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 });
  };
  await assert.rejects(chatCompletion(config, {
    systemPrompt: 'system', userPrompt: 'user',
  }, { ...runtime, model: 'fallback-diagnostic' }), /上下文长度超限/, '重试失败应显示最后一次响应的原因');
  assert.equal(fallbackCalls, 2);

  const invalidJson = `not-json:${'x'.repeat(220)}:tail-marker`;
  assert.throws(
    () => parseJsonResponse(invalidJson, '测试供应商'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^测试供应商 返回了无效 JSON。原始回复: not-json:/);
      assert.doesNotMatch(error.message, /tail-marker/, '诊断片段不得超过 200 字');
      return true;
    },
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('openai compatible adapter tests passed');
