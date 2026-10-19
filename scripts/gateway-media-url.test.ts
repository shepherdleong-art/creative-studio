import assert from 'node:assert/strict';
import {
  downloadGatewayMedia,
  redactMediaUrlForLog,
  sanitizeGatewayMediaDiagnostic,
} from '../lib/gateway-media-url.ts';

const originalFetch = globalThis.fetch;

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  console.log(`ok - ${name}`);
}

try {
  await test('preserves compact JSON fields while redacting a URL query', () => {
    const sanitized = sanitizeGatewayMediaDiagnostic(JSON.stringify({
      error: 'https://blob.example.com/x?sig=secret',
      code: 'E_BAD',
      retry: false,
    }));
    const parsed = JSON.parse(sanitized) as { error: string; code: string; retry: boolean };
    assert.deepEqual(parsed, {
      error: 'https://blob.example.com/x?[query redacted]',
      code: 'E_BAD',
      retry: false,
    });
  });

  await test('preserves compact JSON fields while redacting a Bearer value', () => {
    const sanitized = sanitizeGatewayMediaDiagnostic(JSON.stringify({
      authorization: 'Bearer bearer-secret',
      credential: 'token=token-secret',
      code: 'E_AUTH',
      retry: false,
    }));
    const parsed = JSON.parse(sanitized) as { authorization: string; credential: string; code: string; retry: boolean };
    assert.deepEqual(parsed, {
      authorization: 'Bearer [REDACTED]',
      credential: 'token=[REDACTED]',
      code: 'E_AUTH',
      retry: false,
    });
  });

  await test('returns a structured success buffer and authenticates the gateway origin', async () => {
    let capturedHeaders = new Headers();
    let capturedRedirect: RequestRedirect | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedRedirect = init?.redirect;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/media/result.png',
      'https://gateway.example.com/v1',
      'gateway-key',
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Array.from(result.buffer), [1, 2, 3]);
    }
    assert.equal(capturedHeaders.get('authorization'), 'Bearer gateway-key');
    assert.equal(capturedRedirect, 'manual');
  });

  await test('treats an HTTP 200 JSON error body as a failure', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: 'request blocked: port 3000 is not allowed', type: 'server_error' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/v1/videos/task-1/content',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.errorMessage, /port 3000 is not allowed/);
    }
  });

  await test('treats an HTTP 200 JSON error body without JSON content-type as a failure', async () => {
    // 公司网关经 LiteLLM 代理返回错误时 content-type 是 video/mp4，但内容是 JSON
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: 'request blocked', type: 'server_error' } }),
      { status: 200, headers: { 'Content-Type': 'video/mp4' } },
    )) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/v1/videos/task-1/content',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.errorMessage, /request blocked/);
    }
  });

  await test('does not mistake binary media starting near-brace bytes for JSON', async () => {
    // JPEG 魔数开头，不应被 JSON 检测误判
    globalThis.fetch = (async () => new Response(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]),
      { status: 200, headers: { 'Content-Type': 'image/jpeg' } },
    )) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/v1/videos/task-1/content',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.buffer[0], 0xff);
    }
  });

  await test('does not authenticate a direct third-party CDN request', async () => {
    let capturedHeaders = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://cdn.example.com/result.png',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, true);
    assert.equal(capturedHeaders.get('authorization'), null);
  });

  await test('returns sanitized status and body detail for non-2xx responses', async () => {
    const apiKey = 'top-secret-api-key';
    const secrets = [
      apiKey,
      'bearer-secret',
      'json-token-secret',
      'access-secret',
      'api-key-secret',
      'signature-secret',
      'query-secret',
    ];
    const responseBody = JSON.stringify({
      error: 'permission denied',
      authorization: 'Bearer bearer-secret',
      token: 'json-token-secret',
      access_token: 'access-secret',
      api_key: 'api-key-secret',
      signature: 'signature-secret',
      download: 'https://cdn.example.com/file?token=query-secret',
      detail: 'x'.repeat(800),
    });
    globalThis.fetch = (async () => new Response(responseBody, { status: 403 })) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/result.png',
      'https://gateway.example.com',
      apiKey,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.match(result.errorMessage, /HTTP 403/);
      assert.match(result.errorMessage, /permission denied/);
      assert.ok(result.errorMessage.length <= 'HTTP 403: '.length + 500);
      for (const secret of secrets) {
        assert.equal(result.errorMessage.includes(secret), false, `leaked secret: ${secret}`);
      }
    }
  });

  await test('redacts the complete query from embedded Azure SAS URLs', async () => {
    const sasUrl = 'https://account.blob.core.windows.net/container/result.mp4?sv=2025-01-05&se=2030-01-01&sp=r&sig=azure-sas-secret';
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: `upstream download failed: ${sasUrl}` }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/content',
      'https://gateway.example.com',
      'gateway-key',
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.errorMessage, /https:\/\/account\.blob\.core\.windows\.net\/container\/result\.mp4\?\[query redacted\]/);
      assert.doesNotMatch(result.errorMessage, /azure-sas-secret|(?:^|[?&])sig=|(?:^|[?&])sv=/i);
    }
  });

  await test('strips gateway authorization after relative and absolute redirects to a CDN', async () => {
    const calls: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { Location: '/media/step-two' } });
      }
      if (calls.length === 2) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://cdn.example.com/final.png?signature=cdn-secret' },
        });
      }
      return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/media/start',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.url), [
      'https://gateway.example.com/media/start',
      'https://gateway.example.com/media/step-two',
      'https://cdn.example.com/final.png?signature=cdn-secret',
    ]);
    assert.deepEqual(calls.map((call) => call.authorization), [
      'Bearer gateway-key',
      'Bearer gateway-key',
      null,
    ]);
    assert.ok(calls.every((call) => call.redirect === 'manual'));
  });

  await test('stops after five redirect hops', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(null, { status: 302, headers: { Location: '/loop' } });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/start',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.errorMessage, /redirect limit/i);
    }
    assert.equal(callCount, 6);
  });

  await test('returns a sanitized structured failure for network exceptions', async () => {
    globalThis.fetch = (async () => {
      throw new Error('socket failed with Bearer network-secret and api_key=query-secret');
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://gateway.example.com/file?token=url-secret',
      'https://gateway.example.com',
      'network-secret',
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, undefined);
      assert.match(result.errorMessage, /network/i);
      assert.equal(result.errorMessage.includes('network-secret'), false);
      assert.equal(result.errorMessage.includes('query-secret'), false);
      assert.equal(result.errorMessage.includes('url-secret'), false);
    }
  });

  await test('redacts raw and encoded API keys from network error URL paths', async () => {
    const apiKey = 'path/key+secret';
    const encodedApiKey = encodeURIComponent(apiKey);
    const lowerCaseEncodedApiKey = encodedApiKey.toLowerCase();
    globalThis.fetch = (async () => {
      throw new Error('socket closed');
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      `https://cdn.example.com/media/${apiKey}/${lowerCaseEncodedApiKey}/result.png`,
      'https://gateway.example.com',
      apiKey,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorMessage.includes(apiKey), false);
      assert.equal(result.errorMessage.toLowerCase().includes(encodedApiKey.toLowerCase()), false);
    }
  });

  await test('returns a structured network failure when the API key has a lone surrogate', async () => {
    const apiKey = 'invalid-\uD800-key';
    globalThis.fetch = (async () => {
      throw new Error(`socket failed for ${apiKey}`);
    }) as typeof fetch;

    const outcome = await downloadGatewayMedia(
      `https://cdn.example.com/media/${apiKey}/result.png`,
      'https://gateway.example.com',
      apiKey,
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    if ('error' in outcome) {
      assert.fail(`downloadGatewayMedia threw: ${String(outcome.error)}`);
    }
    assert.equal(outcome.result.ok, false);
    if (!outcome.result.ok) {
      assert.match(outcome.result.errorMessage, /network error/i);
      assert.equal(outcome.result.errorMessage.includes(apiKey), false);
    }
  });

  await test('returns a structured failure when a successful response body cannot be read', async () => {
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('response stream failed'));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://cdn.example.com/result.png',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, undefined);
      assert.match(result.errorMessage, /network error reading/i);
    }
  });

  await test('retries transient network failures and eventually succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount < 3) {
        throw new Error('read ECONNRESET');
      }
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://cdn.example.com/result.mp4',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, true);
    assert.equal(callCount, 3);
    if (result.ok) {
      assert.deepEqual([...result.buffer], [9, 9, 9]);
    }
  });

  await test('gives up after bounded retries on persistent network failures', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      throw new Error('read ECONNRESET');
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://cdn.example.com/result.mp4',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, false);
    assert.equal(callCount, 3);
    if (!result.ok) {
      assert.equal(result.status, undefined);
      assert.match(result.errorMessage, /network error/i);
    }
  });

  await test('does not retry deterministic HTTP failures', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response('denied', { status: 403 });
    }) as typeof fetch;

    const result = await downloadGatewayMedia(
      'https://cdn.example.com/result.mp4',
      'https://gateway.example.com',
      'gateway-key',
    );

    assert.equal(result.ok, false);
    assert.equal(callCount, 1);
    if (!result.ok) {
      assert.equal(result.status, 403);
    }
  });

  await test('redacts media URL queries while retaining origin and path', () => {
    assert.equal(
      redactMediaUrlForLog(
        'https://gateway.example.com/media/result.png?token=secret&signature=also-secret#preview',
      ),
      'https://gateway.example.com/media/result.png?[query redacted]',
    );
    assert.equal(
      redactMediaUrlForLog('https://gateway.example.com/media/result.png'),
      'https://gateway.example.com/media/result.png',
    );
  });

  await test('does not throw or expose content for invalid media URLs', () => {
    assert.equal(redactMediaUrlForLog('not a url?token=secret'), '[invalid media URL]');
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('gateway-media-url tests passed');
