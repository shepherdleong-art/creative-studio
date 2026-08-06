import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COMPANY_PROVIDER_HEALTH_URL,
  COMPANY_PROVIDER_SAFE_REASONS,
  COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
  inspectCompanyProviderRuntime,
  isOwnedCompanyProviderProcessRecord,
  parseNetstatListenerLine,
  type CompanyProviderRuntimeStatus,
} from '../lib/company-provider-runtime.ts';

const COS_ENV_KEYS = [
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN',
];

function clearCosEnv(): void {
  for (const key of COS_ENV_KEYS) delete process.env[key];
}

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
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LiteLLM 健康时报告 ready，只访问本机 loopback 地址', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, {
    startedAt: '2026-08-04T12:00:00',
    litellmPid: 101,
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
    proxyPort: 4100,
    litellmPid: 101,
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

test('LiteLLM 健康检查失败时报告 unavailable', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, { litellmPid: 101 });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response('secret upstream diagnostic', { status: 503 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
    assert.doesNotMatch(status.reason, /secret|example\.invalid/);
    assertSafeStatus(status);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LiteLLM liveliness 只有 200 才算健康', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, { litellmPid: 101 });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('健康检查超时只访问固定 loopback 地址并报告 unavailable', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, { litellmPid: 101 });
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

test('LiteLLM 进程已退出时不会把陈旧 stack 状态误报为 ready', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, { litellmPid: 101 });
  try {
    const status = await inspectCompanyProviderRuntime({
      root,
      processCheck: (pid) => pid !== 101,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });

    assert.equal(status.status, 'unavailable');
    assert.equal(status.proxyAvailable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('损坏的 stack 状态不泄露原始解析错误', async () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model_list: []\n', 'utf8');
  fs.writeFileSync(path.join(root, 'storage', 'run', 'stack.json'), '{"litellmPid":101\n', 'utf8');
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
    assert.equal(calls, 0);
    assert.doesNotMatch(status.reason, /SyntaxError|secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cosConfigured 反映 CREATIVE_STUDIO_COS_* 是否配置，不影响 ready 判定', async () => {
  const root = makeRoot();
  writeConfiguredRoot(root, { litellmPid: 101 });
  const savedEnv = { ...process.env };
  try {
    clearCosEnv();
    const withoutCos = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });
    assert.equal(withoutCos.status, 'ready');
    assert.equal(withoutCos.cosConfigured, false);

    process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'id';
    process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'key';
    process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos.example.com';
    const withCos = await inspectCompanyProviderRuntime({
      root,
      processCheck: processIsAlive,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });
    assert.equal(withCos.status, 'ready');
    assert.equal(withCos.cosConfigured, true);
  } finally {
    process.env = savedEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeManagedFixture(
  root: string,
  status: 'starting' | 'ready' | 'failed',
  code: string = status,
  stack: Record<string, unknown> | null = {
    sidecarKind: 'company-litellm',
    runtimeRelativePath: 'runtime-litellm/python.exe',
    configRelativePath: 'config.yaml',
    proxyPort: 4000,
    litellmPid: 101,
  },
  reason: string = code,
): void {
  fs.mkdirSync(path.join(root, 'storage', 'run'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime-litellm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model_list: []\n', 'utf8');
  fs.writeFileSync(path.join(root, 'runtime-litellm', 'python.exe'), 'test-runtime', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
  fs.writeFileSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'), JSON.stringify({
    schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
    status,
    code,
    reason,
    updatedAt: '2026-08-06T00:00:00.000Z',
  }), 'utf8');
  if (stack) fs.writeFileSync(path.join(root, 'storage', 'run', 'stack.json'), JSON.stringify(stack), 'utf8');
}

async function inspectManagedFixture(
  root: string,
  overrides: Partial<Parameters<typeof inspectCompanyProviderRuntime>[0]> = {},
): Promise<CompanyProviderRuntimeStatus> {
  return inspectCompanyProviderRuntime({
    root,
    managed: true,
    processCheck: () => true,
    listenerCheck: () => true,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    ...overrides,
  });
}

test('managed starting status does not probe process, listener, or health', async () => {
  const root = makeRoot();
  let fetchCalls = 0;
  try {
    writeManagedFixture(root, 'starting');
    const status = await inspectCompanyProviderRuntime({
      root,
      managed: true,
      processCheck: () => { throw new Error('must not check'); },
      listenerCheck: () => { throw new Error('must not check'); },
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    });
    assert.equal(status.status, 'starting');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.starting);
    assert.equal(fetchCalls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing status only starts without a stack, never hides a stale managed stack', async () => {
  const noStackRoot = makeRoot();
  try {
    writeManagedFixture(noStackRoot, 'starting', 'starting', null);
    fs.unlinkSync(path.join(noStackRoot, 'storage', 'run', 'company-sidecar-status.json'));
    const status = await inspectManagedFixture(noStackRoot, {
      processCheck: () => { throw new Error('no stack must remain transient'); },
      listenerCheck: () => { throw new Error('no stack must remain transient'); },
      fetchImpl: async () => { throw new Error('no stack must remain transient'); },
    });
    assert.equal(status.status, 'starting');
  } finally { fs.rmSync(noStackRoot, { recursive: true, force: true }); }

  const cases: Array<{
    stack: Record<string, unknown>;
    processCheck?: (pid: number) => boolean;
    expectedStatus: CompanyProviderRuntimeStatus['status'];
    expectedReason: string;
  }> = [
    {
      stack: { sidecarKind: 'company-litellm', runtimeRelativePath: 'runtime-litellm/python.exe', configRelativePath: 'config.yaml', proxyPort: 4100, litellmPid: 101 },
      expectedStatus: 'unavailable',
      expectedReason: COMPANY_PROVIDER_SAFE_REASONS.port_in_use,
    },
    {
      stack: { sidecarKind: 'company-litellm', runtimeRelativePath: 'runtime-litellm/python.exe', configRelativePath: 'config.yaml', proxyPort: 4000, litellmPid: 101 },
      processCheck: () => false,
      expectedStatus: 'unavailable',
      expectedReason: COMPANY_PROVIDER_SAFE_REASONS.process_exited,
    },
    {
      stack: { sidecarKind: 'other', runtimeRelativePath: 'runtime-litellm/python.exe', configRelativePath: 'config.yaml', proxyPort: 4000, litellmPid: 101 },
      expectedStatus: 'unavailable',
      expectedReason: COMPANY_PROVIDER_SAFE_REASONS.provision_invalid,
    },
    {
      stack: { sidecarKind: 'company-litellm', runtimeRelativePath: 'runtime-litellm/python.exe', configRelativePath: 'config.yaml', proxyPort: 4000, litellmPid: 101 },
      expectedStatus: 'ready',
      expectedReason: COMPANY_PROVIDER_SAFE_REASONS.ready,
    },
  ];

  for (const item of cases) {
    const root = makeRoot();
    try {
      writeManagedFixture(root, 'starting', 'starting', item.stack);
      fs.unlinkSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'));
      const status = await inspectManagedFixture(root, {
        processCheck: item.processCheck ?? (() => true),
        listenerCheck: () => true,
        fetchImpl: async () => new Response('ok', { status: 200 }),
      });
      assert.equal(status.status, item.expectedStatus);
      assert.equal(status.reason, item.expectedReason);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test('managed health 200 must recheck owned process before ready', async () => {
  const root = makeRoot();
  let processCalls = 0;
  let listenerCalls = 0;
  try {
    writeManagedFixture(root, 'ready', 'ready');
    const status = await inspectCompanyProviderRuntime({
      root,
      managed: true,
      processCheck: () => {
        processCalls += 1;
        return processCalls < 2;
      },
      listenerCheck: () => {
        listenerCalls += 1;
        return true;
      },
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });
    assert.equal(status.status, 'unavailable');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.process_exited);
    assert.ok(processCalls >= 2);
    assert.ok(listenerCalls >= 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('managed health 200 must recheck listener ownership before ready', async () => {
  const root = makeRoot();
  let processCalls = 0;
  let listenerCalls = 0;
  try {
    writeManagedFixture(root, 'ready', 'ready');
    const status = await inspectCompanyProviderRuntime({
      root,
      managed: true,
      processCheck: () => {
        processCalls += 1;
        return true;
      },
      listenerCheck: () => {
        listenerCalls += 1;
        return listenerCalls < 2;
      },
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });
    assert.equal(status.status, 'unavailable');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.start_failed);
    assert.ok(processCalls >= 2);
    assert.ok(listenerCalls >= 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unmanaged inspection ignores stale managed status files', async () => {
  const root = makeRoot();
  try {
    writeConfiguredRoot(root, { litellmPid: 101 });
    fs.writeFileSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'), JSON.stringify({
      schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
      status: 'starting',
      code: 'starting',
      reason: COMPANY_PROVIDER_SAFE_REASONS.starting,
      updatedAt: '2026-08-06T00:00:00.000Z',
    }), 'utf8');
    const status = await inspectCompanyProviderRuntime({
      root,
      managed: false,
      processCheck: () => true,
      fetchImpl: async () => new Response('ok', { status: 200 }),
    });
    assert.equal(status.status, 'ready');
    assert.equal(status.proxyAvailable, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('process ownership predicate requires the bundled command and exact paths', () => {
  const root = 'C:/Creative Studio';
  const executable = path.join(root, 'runtime-litellm', 'python.exe');
  const config = path.join(root, 'config.yaml');
  const commandLine = `"${executable}" -m litellm.proxy.proxy_cli --config "${config}" --host 127.0.0.1 --port 4000`;
  assert.equal(isOwnedCompanyProviderProcessRecord({ ExecutablePath: executable, CommandLine: commandLine }, root), true);
  assert.equal(isOwnedCompanyProviderProcessRecord({ ExecutablePath: executable, CommandLine: commandLine.replace('--port 4000', '--port 4001') }, root), false);
  assert.equal(isOwnedCompanyProviderProcessRecord({ ExecutablePath: path.join(root, 'other.exe'), CommandLine: commandLine }, root), false);
});

test('netstat parser preserves loopback, wildcard, and listener ownership fields', () => {
  assert.deepEqual(parseNetstatListenerLine('  TCP    127.0.0.1:4000    0.0.0.0:0    LISTENING    101'), {
    localAddress: '127.0.0.1', port: 4000, state: 'LISTENING', pid: 101,
  });
  assert.deepEqual(parseNetstatListenerLine('TCP    0.0.0.0:4000    0.0.0.0:0    LISTENING    202'), {
    localAddress: '0.0.0.0', port: 4000, state: 'LISTENING', pid: 202,
  });
  assert.equal(parseNetstatListenerLine('UDP    127.0.0.1:4000    *:*    101'), null);
});
test('managed ready requires live PID, owned listener, and exactly HTTP 200', async () => {
  const root = makeRoot();
  const checks: string[] = [];
  try {
    writeManagedFixture(root, 'ready', 'ready');
    const status = await inspectCompanyProviderRuntime({
      root,
      managed: true,
      processCheck: (pid) => { checks.push(`pid:${pid}`); return pid === 101; },
      listenerCheck: (pid, port) => { checks.push(`listener:${pid}:${port}`); return pid === 101 && port === 4000; },
      fetchImpl: async (input) => { checks.push(String(input)); return new Response('ok', { status: 200 }); },
    });
    assert.equal(status.status, 'ready');
    assert.equal(status.proxyAvailable, true);
    assert.deepEqual(checks, ['pid:101', 'listener:101:4000', COMPANY_PROVIDER_HEALTH_URL, 'pid:101', 'listener:101:4000']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('managed stale PID and wrong listener fail closed without health fetch', async () => {
  const staleRoot = makeRoot();
  const listenerRoot = makeRoot();
  try {
    writeManagedFixture(staleRoot, 'ready', 'ready');
    let staleFetches = 0;
    const stale = await inspectManagedFixture(staleRoot, {
      processCheck: () => false,
      fetchImpl: async () => { staleFetches += 1; return new Response('ok', { status: 200 }); },
    });
    assert.equal(stale.status, 'unavailable');
    assert.equal(stale.reason, COMPANY_PROVIDER_SAFE_REASONS.process_exited);
    assert.equal(staleFetches, 0);

    writeManagedFixture(listenerRoot, 'ready', 'ready');
    const wrong = await inspectManagedFixture(listenerRoot, {
      listenerCheck: () => false,
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    assert.equal(wrong.status, 'unavailable');
    assert.equal(wrong.reason, COMPANY_PROVIDER_SAFE_REASONS.start_failed);
  } finally {
    fs.rmSync(staleRoot, { recursive: true, force: true });
    fs.rmSync(listenerRoot, { recursive: true, force: true });
  }
});

test('managed listener reports port ownership conflicts with a fixed safe reason', async () => {
  const root = makeRoot();
  try {
    writeManagedFixture(root, 'ready', 'ready');
    const status = await inspectManagedFixture(root, {
      listenerCheck: () => ({ owned: false, inUse: true }),
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    assert.equal(status.status, 'unavailable');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.port_in_use);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('managed health 204 or rejection is unavailable with health_timeout', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 204 }),
    async () => { throw new Error('private network diagnostic'); },
  ]) {
    const root = makeRoot();
    try {
      writeManagedFixture(root, 'ready', 'ready');
      const status = await inspectManagedFixture(root, { fetchImpl });
      assert.equal(status.status, 'unavailable');
      assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.health_timeout);
      assert.doesNotMatch(status.reason, /private|diagnostic/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('managed stack identity, fixed port, and runtime/script presence are mandatory', async () => {
  const cases: Array<{ stack: Record<string, unknown> | null; expected: string }> = [
    { stack: null, expected: COMPANY_PROVIDER_SAFE_REASONS.provision_invalid },
    { stack: { sidecarKind: 'other', runtimeRelativePath: 'runtime-litellm/python.exe', configRelativePath: 'config.yaml', proxyPort: 4000, litellmPid: 101 }, expected: COMPANY_PROVIDER_SAFE_REASONS.provision_invalid },
    { stack: { sidecarKind: 'company-litellm', runtimeRelativePath: 'runtime-litellm/python.exe', configRelativePath: 'config.yaml', proxyPort: 4100, litellmPid: 101 }, expected: COMPANY_PROVIDER_SAFE_REASONS.port_in_use },
  ];
  for (const item of cases) {
    const root = makeRoot();
    try {
      writeManagedFixture(root, 'ready', 'ready', item.stack);
      const status = await inspectManagedFixture(root, { fetchImpl: async () => new Response('ok', { status: 200 }) });
      assert.equal(status.status, 'unavailable');
      assert.equal(status.reason, item.expected);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  const missingRuntime = makeRoot();
  try {
    writeManagedFixture(missingRuntime, 'ready', 'ready');
    fs.unlinkSync(path.join(missingRuntime, 'runtime-litellm', 'python.exe'));
    const status = await inspectCompanyProviderRuntime({ root: missingRuntime, managed: true });
    assert.equal(status.status, 'unavailable');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.runtime_missing);
  } finally { fs.rmSync(missingRuntime, { recursive: true, force: true }); }

  const missingScript = makeRoot();
  try {
    writeManagedFixture(missingScript, 'starting');
    fs.unlinkSync(path.join(missingScript, 'scripts', 'start-company-sidecar.ps1'));
    const status = await inspectCompanyProviderRuntime({ root: missingScript, managed: true });
    assert.equal(status.status, 'unavailable');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.start_failed);
  } finally { fs.rmSync(missingScript, { recursive: true, force: true }); }
});

test('managed failed status codes map to fixed reasons without echoing status text', async () => {
  const codes = ['runtime_missing', 'port_in_use', 'process_exited', 'health_timeout', 'start_failed'] as const;
  for (const code of codes) {
    const root = makeRoot();
    try {
      writeManagedFixture(root, 'failed', code, null, code);
      const status = await inspectManagedFixture(root);
      assert.equal(status.status, 'unavailable');
      assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS[code]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('malformed status files fail closed and never echo arbitrary reason or secret', async () => {
  const cases: Array<{ bytes: Buffer | string; marker: string }> = [
    { bytes: JSON.stringify({ schemaVersion: 1, status: 'ready', code: 'ready', reason: 'SECRET_REASON', updatedAt: '2026-08-06T00:00:00.000Z', extra: 'key' }), marker: 'SECRET_REASON' },
    { bytes: JSON.stringify({ schemaVersion: 1, status: 'ready', code: 'ready', reason: 'SECRET_REASON', updatedAt: '2026-08-06T00:00:00.000Z' }), marker: 'SECRET_REASON' },
    { bytes: Buffer.from([0xff, 0xfe, 0xfd]), marker: '' },
    { bytes: JSON.stringify({ schemaVersion: 1, status: 'ready', code: 'ready', reason: 'ready', updatedAt: 'not-a-timestamp' }), marker: 'not-a-timestamp' },
  ];
  for (const item of cases) {
    const root = makeRoot();
    try {
      writeManagedFixture(root, 'ready', 'ready');
      fs.writeFileSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'), item.bytes);
      const status = await inspectManagedFixture(root);
      assert.equal(status.status, 'unavailable');
      assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.provision_invalid);
      if (item.marker) assert.doesNotMatch(status.reason, new RegExp(item.marker));
      const serialized = JSON.stringify(status);
      assert.doesNotMatch(serialized, /root|PID|SECRET_REASON|command|key|log/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
