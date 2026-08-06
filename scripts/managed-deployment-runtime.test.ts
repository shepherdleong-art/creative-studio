import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertManagedWorkbenchReady,
  inspectManagedWorkbench,
  type ManagedWorkbenchStatus,
} from '../lib/managed-workbench.ts';
import {
  COMPANY_PROVIDER_SAFE_REASONS,
  COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
  type CompanyProviderRuntimeStatus,
} from '../lib/company-provider-runtime.ts';
import {
  guardManagedWorkbench,
  MANAGED_WORKBENCH_LOCKED_BODY,
} from '../app/api/managed-deployment/guard.ts';
import {
  requestCompanySidecar,
  resetCompanySidecarControllerForTests,
  type CompanySidecarSpawn,
} from '../lib/company-sidecar-control.ts';

const TEST_REQUEST_ID_A = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-managed-runtime-'));
}

function validState() {
  return {
    schemaVersion: 2,
    profileName: '公司统一配置',
    importedAt: '2026-08-06T00:00:00.000Z',
    configHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    managedProviders: {
      image: ['company-image'],
      script: ['company-script'],
      video: ['company-video'],
      tts: ['doubao-seed-tts-2'],
    },
  };
}

test('unrestricted inspection does not read state or runtime', async () => {
  const status = await inspectManagedWorkbench({
    env: {} as unknown as NodeJS.ProcessEnv,
    readState: () => { throw new Error('state must not be read'); },
    inspectRuntime: async () => { throw new Error('runtime must not be inspected'); },
  });
  assert.deepEqual(status, {
    managed: false,
    phase: 'unrestricted',
    configured: false,
    profileName: null,
    importedAt: null,
    configHashPrefix: null,
    proxyAvailable: false,
    reason: '开发模式不受公司网关限制',
  } satisfies ManagedWorkbenchStatus);
});

test('valid state and starting sidecar produce a safe starting status', async () => {
  const root = makeRoot();
  try {
    const status = await inspectManagedWorkbench({
      root,
      env: { CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' } as unknown as NodeJS.ProcessEnv,
      readState: () => validState(),
      inspectRuntime: async () => ({
        status: 'starting',
        reason: 'arbitrary private detail',
        proxyAvailable: false,
        cosConfigured: false,
        startedAt: null,
      }),
    });
    assert.equal(status.phase, 'starting');
    assert.equal(status.profileName, '公司统一配置');
    assert.equal(status.configHashPrefix, '0123456789ab');
    assert.doesNotMatch(status.reason, /arbitrary|private/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar controller accepts only fixed start/restart actions and coalesces starts', async () => {
  const root = makeRoot();
  const calls: Array<{ command: string; args: readonly string[]; options: Parameters<CompanySidecarSpawn>[2] }> = [];
  const child = { unrefCalled: 0, unref() { this.unrefCalled += 1; } };
  let startingObservedDuringSpawn: Record<string, unknown> | null = null;
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts', 'restart-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    const spawnImpl = (command: string, args: readonly string[], options: Parameters<CompanySidecarSpawn>[2]) => {
      calls.push({ command, args, options });
      const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
      if (fs.existsSync(statusPath)) startingObservedDuringSpawn = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
      return child;
    };
    await Promise.all([
      requestCompanySidecar('start', { root, spawnImpl }),
      requestCompanySidecar('start', { root, spawnImpl }),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(child.unrefCalled, 1);
    const startingSnapshot = startingObservedDuringSpawn as Record<string, unknown> | null;
    assert.equal(startingSnapshot?.status, 'starting');
    assert.equal(startingSnapshot?.schemaVersion, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION);
    assert.match(String(startingSnapshot?.requestId), REQUEST_ID_PATTERN);
    assert.equal(calls[0]?.options.env?.CREATIVE_STUDIO_SIDECAR_REQUEST_ID, startingSnapshot?.requestId);
    assert.equal(calls[0]?.options.env?.PATH, process.env.PATH);
    assert.equal(calls[0]?.command, 'powershell.exe');
    assert.deepEqual(calls[0]?.args, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', path.join(root, 'scripts', 'start-company-sidecar.ps1'),
      '-Root', root,
    ]);
    assert.deepEqual({
      windowsHide: calls[0]?.options.windowsHide,
      detached: calls[0]?.options.detached,
      stdio: calls[0]?.options.stdio,
      cwd: calls[0]?.options.cwd,
    }, {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      cwd: root,
    });
    await requestCompanySidecar('restart', { root, spawnImpl });
    assert.equal(calls.length, 2);
    const restartFileIndex = calls[1]?.args.indexOf('-File') ?? -1;
    assert.equal(restartFileIndex >= 0 ? calls[1]?.args[restartFileIndex + 1] : undefined,
      path.join(root, 'scripts', 'restart-company-sidecar.ps1'));
    await assert.rejects(() => requestCompanySidecar('stop' as never, { root, spawnImpl }));
    assert.equal(calls[0]?.args.includes('company-secret'), false);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asynchronous spawn errors reject and publish safe failure', async () => {
  const root = makeRoot();
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  // Keep the pre-fix implementation from crashing the test process on the
  // intentionally unhandled error; the controller must own this listener.
  child.on('error', () => {});
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    await assert.rejects(
      () => requestCompanySidecar('start', {
        root,
        spawnImpl: () => {
          queueMicrotask(() => child.emit('error', new Error('spawn ENOENT private detail')));
          return child as unknown as ReturnType<CompanySidecarSpawn>;
        },
      }),
      (error: unknown) => error instanceof Error
        && (error as { code?: unknown }).code === 'start_failed',
    );
    const status = JSON.parse(fs.readFileSync(
      path.join(root, 'storage', 'run', 'company-sidecar-status.json'), 'utf8',
    )) as Record<string, unknown>;
    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'start_failed');
    assert.equal(status.reason, 'LiteLLM 启动失败，请重试');
    assert.equal(fs.readdirSync(path.join(root, 'storage', 'run')).some((name) => name.endsWith('.tmp')), false);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart publishes starting before invoking the fixed script', async () => {
  const root = makeRoot();
  const child = { unref() {} };
  let observedStatus: Record<string, unknown> | null = null;
  let observedEnvRequestId: string | undefined;
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'storage', 'run'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'restart-company-sidecar.ps1'), '# test', 'utf8');
    fs.writeFileSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'), JSON.stringify({
      schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
      requestId: TEST_REQUEST_ID_A,
      status: 'ready',
      code: 'ready',
      reason: COMPANY_PROVIDER_SAFE_REASONS.ready,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }), 'utf8');
    resetCompanySidecarControllerForTests();
    await requestCompanySidecar('restart', {
      root,
      spawnImpl: (_command: string, _args: readonly string[], options: Parameters<CompanySidecarSpawn>[2]) => {
        observedStatus = JSON.parse(fs.readFileSync(
          path.join(root, 'storage', 'run', 'company-sidecar-status.json'), 'utf8',
        )) as Record<string, unknown>;
        observedEnvRequestId = options.env?.CREATIVE_STUDIO_SIDECAR_REQUEST_ID;
        return child;
      },
    });
    const restartSnapshot = observedStatus as Record<string, unknown> | null;
    assert.equal(restartSnapshot?.status, 'starting');
    assert.equal(restartSnapshot?.schemaVersion, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION);
    assert.equal(restartSnapshot?.code, 'starting');
    assert.equal(restartSnapshot?.reason, COMPANY_PROVIDER_SAFE_REASONS.starting);
    assert.match(String(restartSnapshot?.requestId), REQUEST_ID_PATTERN);
    assert.equal(observedEnvRequestId, restartSnapshot?.requestId);
    assert.equal(fs.readdirSync(path.join(root, 'storage', 'run')).some((name) => name.endsWith('.tmp')), false);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('late asynchronous spawn errors after success stay owned by the controller', async () => {
  const root = makeRoot();
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    const accepted = await requestCompanySidecar('start', {
      root,
      spawnImpl: () => {
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('error', new Error('late private detail'));
        });
        return child as unknown as ReturnType<CompanySidecarSpawn>;
      },
    });
    assert.deepEqual(accepted, { accepted: true, action: 'start' });
    const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    assert.equal(status.status, 'starting');
    assert.equal(status.schemaVersion, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION);
    assert.match(String(status.requestId), REQUEST_ID_PATTERN);
    assert.equal(fs.readdirSync(path.dirname(statusPath)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('controller publishes a safe failure when the fixed script cannot spawn', async () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    await assert.rejects(
      () => requestCompanySidecar('start', {
        root,
        spawnImpl: () => { throw new Error('private spawn diagnostic'); },
      }),
      (error: unknown) => error instanceof Error
        && (error as { code?: unknown }).code === 'start_failed'
        && !error.message.includes('private'),
    );
    const status = JSON.parse(fs.readFileSync(
      path.join(root, 'storage', 'run', 'company-sidecar-status.json'), 'utf8',
    )) as Record<string, unknown>;
    assert.deepEqual(status, {
      schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
      requestId: status.requestId,
      status: 'failed',
      code: 'start_failed',
      reason: 'LiteLLM 启动失败，请重试',
      updatedAt: status.updatedAt,
    });
    assert.equal(typeof status.updatedAt, 'string');
    assert.match(String(status.requestId), REQUEST_ID_PATTERN);
    assert.doesNotMatch(JSON.stringify(status), /root|command|private|secret|key/i);
    const runDir = path.join(root, 'storage', 'run');
    const leftovers = fs.readdirSync(runDir).filter((name) => name.includes('company-sidecar-status.json.') && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('controller publishes a safe failure when its fixed script is missing', async () => {
  const root = makeRoot();
  let spawnCalled = false;
  try {
    resetCompanySidecarControllerForTests();
    await assert.rejects(
      () => requestCompanySidecar('start', {
        root,
        spawnImpl: () => {
          spawnCalled = true;
          return { unref() {} };
        },
      }),
      (error: unknown) => error instanceof Error
        && (error as { code?: unknown }).code === 'start_failed',
    );
    assert.equal(spawnCalled, false);
    const status = JSON.parse(fs.readFileSync(
      path.join(root, 'storage', 'run', 'company-sidecar-status.json'), 'utf8',
    )) as Record<string, unknown>;
    assert.equal(status.schemaVersion, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION);
    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'start_failed');
    assert.equal(status.reason, COMPANY_PROVIDER_SAFE_REASONS.start_failed);
    assert.match(String(status.requestId), REQUEST_ID_PATTERN);
    assert.match(String(status.updatedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(JSON.stringify(status), /root|command|secret|key/i);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('an older synchronous failure cannot overwrite a newer ready status', async () => {
  const root = makeRoot();
  const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
  const newer = {
    schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
    requestId: TEST_REQUEST_ID_A,
    status: 'ready',
    code: 'ready',
    reason: COMPANY_PROVIDER_SAFE_REASONS.ready,
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
  };
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    await assert.rejects(() => requestCompanySidecar('start', {
      root,
      spawnImpl: () => {
        fs.writeFileSync(statusPath, JSON.stringify(newer), 'utf8');
        throw new Error('old synchronous error');
      },
    }));
    assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), newer);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a late asynchronous failure cannot overwrite a concurrently published ready status', async () => {
  const root = makeRoot();
  const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
  const newer = {
    schemaVersion: COMPANY_PROVIDER_STATUS_SCHEMA_VERSION,
    requestId: TEST_REQUEST_ID_A,
    status: 'ready',
    code: 'ready',
    reason: COMPANY_PROVIDER_SAFE_REASONS.ready,
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  child.on('error', () => {});
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    await assert.rejects(() => requestCompanySidecar('start', {
      root,
      spawnImpl: () => {
        queueMicrotask(() => {
          fs.writeFileSync(statusPath, JSON.stringify(newer), 'utf8');
          child.emit('error', new Error('late old error'));
        });
        return child as unknown as ReturnType<CompanySidecarSpawn>;
      },
    }));
    assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), newer);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a same-millisecond PowerShell starting status is not claimed by the current failure', async () => {
  const root = makeRoot();
  const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    await assert.rejects(() => requestCompanySidecar('start', {
      root,
      spawnImpl: () => {
        const ownStarting = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
        const powershellStarting = { ...ownStarting, reason: 'starting' };
        fs.writeFileSync(statusPath, JSON.stringify(powershellStarting), 'utf8');
        throw new Error('same-millisecond old failure');
      },
    }));
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    assert.equal(status.status, 'starting');
    assert.equal(status.code, 'starting');
    assert.equal(status.reason, 'starting');
    assert.equal(status.schemaVersion, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION);
    assert.match(String(status.requestId), REQUEST_ID_PATTERN);
    assert.equal(fs.readdirSync(path.dirname(statusPath)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a same-millisecond external starting payload with reordered fields is not claimed', async () => {
  const root = makeRoot();
  const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
  let externalBytes: Buffer | null = null;
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    resetCompanySidecarControllerForTests();
    await assert.rejects(() => requestCompanySidecar('start', {
      root,
      spawnImpl: () => {
        const ownStarting = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
        const externalStarting = {
          schemaVersion: ownStarting.schemaVersion,
          requestId: ownStarting.requestId,
          status: ownStarting.status,
          code: ownStarting.code,
          updatedAt: ownStarting.updatedAt,
          reason: ownStarting.reason,
        };
        externalBytes = Buffer.from(`${JSON.stringify(externalStarting)}\n`, 'utf8');
        fs.writeFileSync(statusPath, externalBytes);
        throw new Error('same-millisecond external failure');
      },
    }));
    assert.deepEqual(fs.readFileSync(statusPath), externalBytes);
  } finally {
    resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('independent controller instances do not overwrite a same-millisecond newer request', async () => {
  const root = makeRoot();
  const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
  const moduleUrl = new URL('../lib/company-sidecar-control.ts', import.meta.url).href;
  const importSuffix = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  const [controllerA, controllerB] = await Promise.all([
    import(`${moduleUrl}?controller-a-${importSuffix}`),
    import(`${moduleUrl}?controller-b-${importSuffix}`),
  ]);
  const realDate = globalThis.Date;
  const fixedMs = realDate.now();
  class FixedDate extends realDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? fixedMs : value instanceof realDate ? value.getTime() : value);
    }

    static now(): number {
      return fixedMs;
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
  let bPromise: Promise<unknown> | null = null;
  let aStartingAt: string | null = null;
  let bStartingAt: string | null = null;
  let bRequestId: string | null = null;
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'start-company-sidecar.ps1'), '# test', 'utf8');
    controllerA.resetCompanySidecarControllerForTests();
    controllerB.resetCompanySidecarControllerForTests();
    await assert.rejects(() => controllerA.requestCompanySidecar('start', {
      root,
      spawnImpl: () => {
        const aStarting = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
        aStartingAt = String(aStarting.updatedAt);
        bPromise = controllerB.requestCompanySidecar('start', {
          root,
          spawnImpl: (_command: string, _args: readonly string[], options: Parameters<CompanySidecarSpawn>[2]) => {
            bRequestId = String(options.env?.CREATIVE_STUDIO_SIDECAR_REQUEST_ID);
            return { unref() {} };
          },
        });
        const bStarting = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
        bStartingAt = String(bStarting.updatedAt);
        throw new Error('old controller failure');
      },
    }));
    assert.ok(bPromise);
    await bPromise;
    assert.equal(bStartingAt, aStartingAt);
    const finalBytes = fs.readFileSync(statusPath);
    const finalStatus = JSON.parse(finalBytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(finalStatus.schemaVersion, COMPANY_PROVIDER_STATUS_SCHEMA_VERSION);
    assert.equal(finalStatus.status, 'starting');
    assert.equal(finalStatus.requestId, bRequestId);
    assert.match(String(finalStatus.requestId), REQUEST_ID_PATTERN);
  } finally {
    globalThis.Date = realDate;
    controllerA.resetCompanySidecarControllerForTests();
    controllerB.resetCompanySidecarControllerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('locked workbench throws a stable error', async () => {
  await assert.rejects(
    () => assertManagedWorkbenchReady({
      env: { CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' } as unknown as NodeJS.ProcessEnv,
      readState: () => null,
    }),
    (error: unknown) => error instanceof Error
      && (error as { code?: unknown }).code === 'managed_workbench_locked'
      && (error as { phase?: unknown }).phase === 'unconfigured',
  );
});

const managedEnv = { CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' } as unknown as NodeJS.ProcessEnv;

function runtimeStatus(
  status: CompanyProviderRuntimeStatus['status'],
  reason: string,
  proxyAvailable = false,
): CompanyProviderRuntimeStatus {
  return { status, reason, proxyAvailable, cosConfigured: false, startedAt: null };
}

test('invalid or legacy provisioning state remains unconfigured and never probes LiteLLM', async () => {
  const invalidStates: unknown[] = [
    null,
    { ...validState(), schemaVersion: 1 },
    { ...validState(), configHash: 'not-a-hash' },
    { ...validState(), managedProviders: { ...validState().managedProviders, tts: ['other-tts'] } },
  ];
  for (const state of invalidStates) {
    let runtimeCalled = false;
    const status = await inspectManagedWorkbench({
      env: managedEnv,
      readState: () => state,
      inspectRuntime: async () => {
        runtimeCalled = true;
        return runtimeStatus('ready', COMPANY_PROVIDER_SAFE_REASONS.ready, true);
      },
    });
    assert.equal(status.managed, true);
    assert.equal(status.phase, 'unconfigured');
    assert.equal(status.configured, false);
    assert.equal(status.profileName, null);
    assert.equal(status.importedAt, null);
    assert.equal(status.configHashPrefix, null);
    assert.equal(status.proxyAvailable, false);
    assert.equal(runtimeCalled, false);
  }
});

test('valid ready state exposes only safe metadata and unlocks the workbench', async () => {
  const state = validState();
  const status = await inspectManagedWorkbench({
    env: managedEnv,
    readState: () => state,
    inspectRuntime: async () => runtimeStatus('ready', COMPANY_PROVIDER_SAFE_REASONS.ready, true),
  });
  assert.deepEqual(status, {
    managed: true,
    phase: 'ready',
    configured: true,
    profileName: state.profileName,
    importedAt: state.importedAt,
    configHashPrefix: '0123456789ab',
    proxyAvailable: true,
    reason: COMPANY_PROVIDER_SAFE_REASONS.ready,
  } satisfies ManagedWorkbenchStatus);
  await assert.doesNotReject(() => assertManagedWorkbenchReady({
    env: managedEnv,
    readState: () => state,
    inspectRuntime: async () => runtimeStatus('ready', COMPANY_PROVIDER_SAFE_REASONS.ready, true),
  }));
});

test('runtime failures map to fixed reasons and never echo diagnostics', async () => {
  const cases: Array<{ runtime: CompanyProviderRuntimeStatus; reason: string }> = [
    { runtime: runtimeStatus('not_configured', 'private runtime path'), reason: COMPANY_PROVIDER_SAFE_REASONS.runtime_missing },
    { runtime: runtimeStatus('stopped', COMPANY_PROVIDER_SAFE_REASONS.process_exited), reason: COMPANY_PROVIDER_SAFE_REASONS.process_exited },
    { runtime: runtimeStatus('unavailable', COMPANY_PROVIDER_SAFE_REASONS.health_timeout), reason: COMPANY_PROVIDER_SAFE_REASONS.health_timeout },
    { runtime: runtimeStatus('unavailable', 'private traceback with API key'), reason: COMPANY_PROVIDER_SAFE_REASONS.start_failed },
  ];
  for (const item of cases) {
    const status = await inspectManagedWorkbench({
      env: managedEnv,
      readState: () => validState(),
      inspectRuntime: async () => item.runtime,
    });
    assert.equal(status.phase, 'failed');
    assert.equal(status.configured, true);
    assert.equal(status.proxyAvailable, false);
    assert.equal(status.reason, item.reason);
    assert.doesNotMatch(JSON.stringify(status), /private|traceback|API key|root|PID/i);
  }

  const thrown = await inspectManagedWorkbench({
    env: managedEnv,
    readState: () => validState(),
    inspectRuntime: async () => { throw new Error('private command and secret'); },
  });
  assert.equal(thrown.phase, 'failed');
  assert.equal(thrown.reason, COMPANY_PROVIDER_SAFE_REASONS.start_failed);
  assert.doesNotMatch(JSON.stringify(thrown), /private|command|secret/i);
});

test('managed API guard returns exact no-store 423 payload until ready', async () => {
  const locked = await guardManagedWorkbench({ env: managedEnv, readState: () => null });
  assert.ok(locked);
  assert.equal(locked.status, 423);
  assert.equal(locked.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await locked.json(), {
    ...MANAGED_WORKBENCH_LOCKED_BODY,
    phase: 'unconfigured',
  });

  const ready = await guardManagedWorkbench({
    env: managedEnv,
    readState: () => validState(),
    inspectRuntime: async () => runtimeStatus('ready', COMPANY_PROVIDER_SAFE_REASONS.ready, true),
  });
  assert.equal(ready, null);

  const unrestricted = await guardManagedWorkbench({
    env: {} as unknown as NodeJS.ProcessEnv,
    readState: () => { throw new Error('must not read state'); },
    inspectRuntime: async () => { throw new Error('must not inspect runtime'); },
  });
  assert.equal(unrestricted, null);
});

test('managed route wiring starts asynchronously and keeps import errors non-secret', () => {
  const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
  const statusRoute = read('app/api/managed-deployment/status/route.ts');
  const startRoute = read('app/api/company-provider/start/route.ts');
  const provisioningRoute = read('app/api/provisioning/route.ts');
  const instrumentation = read('instrumentation.ts');

  assert.match(statusRoute, /inspectManagedWorkbench/);
  assert.match(statusRoute, /Cache-Control.*no-store/);
  assert.doesNotMatch(statusRoute, /apiKey|Authorization|tunnelUrl|process\.pid/i);

  const startFunction = startRoute.indexOf('export async function POST()');
  const startManagedCheck = startRoute.indexOf('if (!isManagedDeployment())');
  const startCall = startRoute.indexOf("requestCompanySidecar('start')");
  assert.ok(startFunction >= 0 && startManagedCheck > startFunction);
  assert.ok(startCall > startManagedCheck);
  assert.match(startRoute, /status:\s*202/);
  assert.doesNotMatch(startRoute, /POST\s*\([^)]*request|POST\s*\([^)]*body/i);

  const applyIndex = provisioningRoute.indexOf('const status = applyProvisioningPayload(payload);');
  const restartIndex = provisioningRoute.indexOf("requestCompanySidecar('restart')");
  const managedRestartIndex = provisioningRoute.indexOf('if (isManagedDeployment())', applyIndex);
  assert.ok(applyIndex >= 0);
  assert.ok(managedRestartIndex > applyIndex);
  assert.ok(restartIndex > managedRestartIndex);
  const outerCatchIndex = provisioningRoute.indexOf('  } catch {');
  assert.ok(outerCatchIndex > restartIndex);
  assert.match(provisioningRoute.slice(managedRestartIndex), /if \(isManagedDeployment\(\)\) \{[\s\S]*requestCompanySidecar\('restart'\)\.catch/);
  assert.match(provisioningRoute, new RegExp(COMPANY_PROVIDER_SAFE_REASONS.starting));

  const loadIndex = instrumentation.indexOf('loadProvisionedRuntimeEnv');
  const managedIndex = instrumentation.indexOf('if (isManagedDeployment())');
  const startIndex = instrumentation.indexOf("requestCompanySidecar('start')");
  const schedulerIndex = instrumentation.indexOf('startBatchSchedulerAfterReadiness');
  assert.ok(loadIndex >= 0 && managedIndex > loadIndex && startIndex > managedIndex && schedulerIndex > startIndex);
  assert.doesNotMatch(instrumentation, /await\s+requestCompanySidecar/);
});
