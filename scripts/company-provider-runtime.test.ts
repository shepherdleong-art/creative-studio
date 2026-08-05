import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COMPANY_PROVIDER_HEALTH_URL,
  inspectCompanyProviderRuntime,
  type CompanyProviderRuntimeStatus,
} from '../lib/company-provider-runtime.ts';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-company-provider-'));
  fs.mkdirSync(path.join(root, 'storage', 'run'), { recursive: true });
  return root;
}

function writeConfiguredRoot(root: string, stack: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model_list: []\n', 'utf8');
  fs.writeFileSync(path.join(root, 'storage', 'run', 'stack.json'), JSON.stringify(stack), 'utf8');
}

function assertSafeStatus(status: CompanyProviderRuntimeStatus): void {
  assert.equal('apiKey' in status, false);
  assert.equal('pid' in status, false);
  assert.equal('tunnelUrl' in status, false);
}

const processIsAlive = () => true;

test('未配置公司运行环境时不探测网络', async () => {
  const root = makeRoot();
  let calls = 0;
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      fetchImpl: async () => {
        calls += 1;
        return new Response('unexpected', { status: 200 });
      },
    });

    assert.equal(status.status, 'not_configured');
    assert.equal(status.proxyAvailable, false);
    assert.equal(status.tunnelAvailable, false);
    assert.equal(calls, 0);
    assertSafeStatus(status);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('已配置但没有 stack 状态时报告 stopped 且不探测网络', async () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model_list: []\n', 'utf8');
  let calls = 0;
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      fetchImpl: async () => {
        calls += 1;
        return new Response('unexpected', { status: 200 });
      },
    });

    assert.equal(status.status, 'stopped');
    assert.equal(status.proxyAvailable, false);
    assert.equal(status.tunnelAvailable, false);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LiteLLM loop回健康且有隧道状态时报告 ready，但不回传隧道地址', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://fixture.trycloudflare.com',
    tunnelEngine: 'cloudflared',
    startedAt: '2026-08-04T12:00:00',
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  const requests: Array<{ input: string; signal?: AbortSignal }> = [];
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async (input, init) => {
        requests.push({ input: String(input), signal: init?.signal ?? undefined });
        return new Response('ok', { status: 200 });
      },
    });

    assert.equal(status.status, 'ready');
    assert.equal(status.proxyAvailable, true);
    assert.equal(status.tunnelAvailable, true);
    assert.equal(status.tunnelEngine, 'cloudflared');
    assert.equal(status.startedAt, '2026-08-04T12:00:00');
    assert.deepEqual(requests.map(({ input }) => input), [COMPANY_PROVIDER_HEALTH_URL]);
    assertSafeStatus(status);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('受控状态指定合法端口时仍只访问对应的本机 LiteLLM 地址', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://fixture.trycloudflare.com',
    tunnelEngine: 'cloudflared',
    proxyPort: 4100,
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  let requested = '';
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async (input) => {
        requested = String(input);
        return new Response('ok', { status: 200 });
      },
    });

    assert.equal(status.status, 'ready');
    assert.equal(requested, 'http://127.0.0.1:4100/health/liveliness');
    assertSafeStatus(status);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LiteLLM 健康检查失败时报告 unavailable 并保留脱敏的隧道可用性', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://fixture.run.pinggy-free.link',
    tunnelEngine: 'pinggy',
    litellmPid: 101,
    pinggyPid: 102,
  });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response('secret upstream diagnostic', { status: 503 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
    assert.equal(status.tunnelAvailable, true);
    assert.equal(status.tunnelEngine, 'pinggy');
    assert.doesNotMatch(status.reason, /secret|example\.invalid/);
    assertSafeStatus(status);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LiteLLM liveliness 只有 200 才算健康', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://fixture.trycloudflare.com',
    tunnelEngine: 'cloudflared',
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
    assert.equal(status.tunnelAvailable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('健康检查超时只访问固定 loopback 地址并报告 unavailable', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://fixture.trycloudflare.com',
    tunnelEngine: 'cloudflared',
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  let requested = '';
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      timeoutMs: 5,
      processCheck: processIsAlive,
      fetchImpl: (input, init) => new Promise<Response>((_resolve, reject) => {
        requested = String(input);
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
    assert.equal(requested, COMPANY_PROVIDER_HEALTH_URL);
    assert.doesNotMatch(status.reason, /aborted|example\.invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没有受控隧道状态时不会把 LiteLLM 健康误报为 ready', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelEngine: 'cloudflared',
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, true);
    assert.equal(status.tunnelAvailable, false);
    assert.match(status.reason, /隧道/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('隧道进程已退出时不会把陈旧 stack 状态误报为 ready', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://fixture.trycloudflare.com',
    tunnelEngine: 'cloudflared',
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: (pid) => pid === 101,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, true);
    assert.equal(status.tunnelAvailable, false);
    assert.match(status.reason, /隧道/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('非受控 HTTPS 域名不能成为媒体传输隧道', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    tunnelUrl: 'https://example.invalid/looks-valid',
    tunnelEngine: 'cloudflared',
    litellmPid: 101,
    cloudflaredPid: 102,
  });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, true);
    assert.equal(status.tunnelAvailable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('损坏的 stack 状态不泄露原始解析错误', async () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model_list: []\n', 'utf8');
  fs.writeFileSync(path.join(root, 'storage', 'run', 'stack.json'), '{"tunnelUrl":"secret\n', 'utf8');
  let calls = 0;
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      fetchImpl: async () => {
        calls += 1;
        return new Response('unexpected', { status: 200 });
      },
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
    assert.equal(status.tunnelAvailable, false);
    assert.equal(calls, 0);
    assert.doesNotMatch(status.reason, /SyntaxError|secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
