import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-anthropic-routing-'));

try {
  const childPath = path.join(dataRoot, 'anthropic-routing-check.mjs');
  const indexUrl = pathToFileURL(path.resolve('lib/script-providers/index.ts')).href;
  const dbUrl = pathToFileURL(path.resolve('lib/db.ts')).href;

  fs.writeFileSync(childPath, `
    import assert from 'node:assert/strict';
    const { completeJson, getAvailableProviders } = await import(${JSON.stringify(indexUrl)});
    const { closeDb, getDb } = await import(${JSON.stringify(dbUrl)});

    getAvailableProviders();
    const db = getDb();
    db.prepare("UPDATE script_providers SET type=?, apiStyle=?, baseUrl=?, apiKey=?, model=?, enabled=1, supportsVision=1 WHERE id=?")
      .run('anthropic-messages', 'anthropic-messages', 'https://anthropic.example/v1', 'anthropic-key', 'kimi-k2.6', 'kimi');

    let requestedUrl = '';
    let requestedInit;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal' },
          { type: 'text', text: '{"route":"anthropic-messages"}' },
        ],
        model: 'kimi-k2.6',
        stop_reason: 'end_turn',
      });
    };

    const result = await completeJson({
      providerId: 'kimi',
      systemPrompt: '只返回 JSON',
      userPrompt: '分析图片',
      temperature: 0.2,
      maxTokens: 1200,
      images: [{ mimeType: 'image/jpeg', imageBase64: 'abc123' }],
    });

    assert.deepEqual(result, { route: 'anthropic-messages' });
    assert.equal(requestedUrl, 'https://anthropic.example/v1/messages');
    assert.equal(requestedInit?.method, 'POST');

    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get('authorization'), 'Bearer anthropic-key');
    assert.equal(headers.get('x-api-key'), 'anthropic-key');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');

    const body = JSON.parse(String(requestedInit?.body || '{}'));
    assert.deepEqual(body, {
      model: 'kimi-k2.6',
      system: '只返回 JSON',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' } },
          { type: 'text', text: '分析图片' },
        ],
      }],
      temperature: 0.2,
      max_tokens: 1200,
    });

    assert.deepEqual(
      db.prepare("SELECT type, apiStyle FROM script_providers WHERE id='kimi'").get(),
      { type: 'anthropic-messages', apiStyle: 'anthropic-messages' },
      '读取内置供应商时不得覆盖用户保存的 Anthropic 协议',
    );

    const { chatCompletion } = await import(${JSON.stringify(pathToFileURL(path.resolve('lib/script-providers/anthropic-messages.ts')).href)});
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(
      chatCompletion({
        id: 'kimi', name: 'Kimi（月之暗面）', apiStyle: 'anthropic-messages',
        keyEnv: '', baseUrlEnv: '', modelEnv: '', defaultModel: 'kimi-k2.6',
        defaultBaseUrl: 'https://anthropic.example', maxTokens: 8192,
      }, { systemPrompt: 'system', userPrompt: 'user', timeoutMs: 20 }, {
        id: 'kimi', name: 'Kimi（月之暗面）', apiStyle: 'anthropic-messages',
        baseUrl: 'https://anthropic.example', apiKey: 'anthropic-key', model: 'kimi-k2.6',
        maxTokens: 8192, enabled: true, configured: true, missing: [], hasApiKey: true,
        supportsVision: true, visionCostPerRequest: 0, executionScope: 'external',
      }),
      /请求超时/,
    );

    const cancellation = new AbortController();
    const cancelledRequest = chatCompletion({
      id: 'kimi', name: 'Kimi（月之暗面）', apiStyle: 'anthropic-messages',
      keyEnv: '', baseUrlEnv: '', modelEnv: '', defaultModel: 'kimi-k2.6',
      defaultBaseUrl: 'https://anthropic.example', maxTokens: 8192,
    }, {
      systemPrompt: 'system', userPrompt: 'user', timeoutMs: 100, signal: cancellation.signal,
    }, {
      id: 'kimi', name: 'Kimi（月之暗面）', apiStyle: 'anthropic-messages',
      baseUrl: 'https://anthropic.example', apiKey: 'anthropic-key', model: 'kimi-k2.6',
      maxTokens: 8192, enabled: true, configured: true, missing: [], hasApiKey: true,
      supportsVision: true, visionCostPerRequest: 0,
    });
    cancellation.abort();
    await assert.rejects(cancelledRequest, /脚本生成已取消/);

    const registryCancellation = new AbortController();
    const registryCancelledRequest = completeJson({
      providerId: 'kimi', systemPrompt: 'system', userPrompt: 'user',
      timeoutMs: 100, signal: registryCancellation.signal,
    });
    registryCancellation.abort();
    await assert.rejects(registryCancelledRequest, /脚本生成已取消/);

    closeDb();
  `);

  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-loader', path.resolve('scripts/typescript-extension-loader.mjs'),
    '--experimental-strip-types',
    childPath,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot },
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    0,
    `Anthropic Messages 注册表分发测试失败：\n${result.stderr}\n${result.stdout}`,
  );
} finally {
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log('anthropic messages adapter tests passed');
