import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompanyProviderRuntimeStatus } from '../lib/company-provider-runtime.ts';
import { MANAGED_DEPLOYMENT_ENV } from '../lib/managed-deployment.ts';
import type { ManagedProviderAllowlist } from '../lib/provisioning/types.ts';
import type { ImageQueueAdapterOverrides } from '../lib/queue.ts';
import type { VideoProviderAdapter } from '../lib/video-providers/types.ts';

// Set the isolated root before importing the database/queue modules. No test
// in this file is allowed to reach the real workbench or an upstream service.
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
const previousManaged = process.env[MANAGED_DEPLOYMENT_ENV];
const fixtureRoot = mkdtempSync(join(tmpdir(), 'creative-studio-managed-execution-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;
process.env[MANAGED_DEPLOYMENT_ENV] = '1';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
register(
  pathToFileURL(join(repoRoot, 'scripts', 'typescript-extension-loader.mjs')).href,
  { parentURL: import.meta.url },
);

const {
  ProviderExecutionGateError,
  assertProviderExecutionAvailable,
  readManagedExecutionGeneration,
} = await import('../lib/provider-execution-gate.ts');
const { dataRoot } = await import('../lib/data-root.ts');
assert.equal(dataRoot(), fixtureRoot, 'managed execution fixtures must use the temporary data root');
const { getDb, closeDb } = await import('../lib/db.ts');
const { runQueue } = await import('../lib/queue.ts');
const { runVideoQueue } = await import('../lib/video-queue.ts');
const { registerTestVideoAdapter } = await import('../lib/video-providers/index.ts');
const scriptProviders = await import('../lib/script-providers/index.ts');

const managedEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  [MANAGED_DEPLOYMENT_ENV]: '1',
};
const unrestrictedEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

function allowlistFor(ids: Partial<Record<'image' | 'script' | 'video', string>> = {}): ManagedProviderAllowlist {
  return {
    image: [ids.image || 'company-image'],
    script: [ids.script || 'company-script'],
    video: [ids.video || 'company-video'],
    tts: ['doubao-seed-tts-2'],
  };
}

function writeProvisioningGeneration(root: string, importedAt: string, configText: string): void {
  const provisioningRoot = join(root, 'data', 'provisioning');
  mkdirSync(provisioningRoot, { recursive: true });
  writeFileSync(join(root, 'config.yaml'), configText, 'utf8');
  writeFileSync(join(provisioningRoot, 'runtime.env'), [
    'CREATIVE_STUDIO_GATEWAY_API_KEY=fixture-secret',
    'COMPANY_GATEWAY_API_KEY=fixture-secret',
    'GATEWAY_API_KEY=fixture-secret',
    'CREATIVE_STUDIO_COS_SECRET_ID=fixture-cos-id',
    'CREATIVE_STUDIO_COS_SECRET_KEY=fixture-cos-key',
    'CREATIVE_STUDIO_COS_DOMAIN=fixture.cos.example',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(provisioningRoot, 'state.json'), JSON.stringify({
    schemaVersion: 2,
    profileName: 'fixture',
    importedAt,
    configHash: createHash('sha256').update(configText, 'utf8').digest('hex'),
    managedProviders: allowlistFor(),
  }), 'utf8');
}

function runtimeFixture(
  status: CompanyProviderRuntimeStatus['status'] = 'ready',
  proxyAvailable = status === 'ready',
): CompanyProviderRuntimeStatus {
  return {
    status,
    reason: status === 'ready' ? 'fixture ready' : 'fixture unavailable',
    proxyAvailable,
    cosConfigured: true,
    startedAt: null,
  };
}

const imageProvider = {
  id: 'company-image',
  type: 'gateway-task-image',
  apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY',
  executionScope: 'company' as const,
  baseUrl: 'http://127.0.0.1:4000/v1',
  enabled: true,
  configured: true,
};

async function executeImage(
  provider: typeof imageProvider,
  env: NodeJS.ProcessEnv,
  adapter: () => Promise<void> | void,
  options: {
    allowlist?: ManagedProviderAllowlist | null;
    runtime?: CompanyProviderRuntimeStatus;
    inspectRuntime?: () => Promise<CompanyProviderRuntimeStatus>;
  } = {},
): Promise<void> {
  await assertProviderExecutionAvailable(provider, {
    capability: 'model',
    kind: 'image',
    env,
    allowlist: options.allowlist ?? allowlistFor({ image: provider.id }),
    companyRuntime: options.runtime ?? (options.inspectRuntime ? undefined : runtimeFixture()),
    inspectRuntime: options.inspectRuntime,
  });
  await adapter();
}

test('managed gate blocks a locked workbench and never invokes its adapter', async () => {
  let adapterCalls = 0;
  await assert.rejects(
    executeImage(imageProvider, managedEnv, () => { adapterCalls += 1; }, {
      runtime: runtimeFixture('unavailable', false),
    }),
    (error: unknown) => error instanceof ProviderExecutionGateError
      && error.code === 'managed_workbench_locked',
  );
  assert.equal(adapterCalls, 0);
});

test('managed gate fails closed when runtime inspection throws', async () => {
  let adapterCalls = 0;
  let inspected = 0;
  await assert.rejects(
    executeImage(imageProvider, managedEnv, () => { adapterCalls += 1; }, {
      inspectRuntime: async () => {
        inspected += 1;
        throw new Error('secret path must not escape');
      },
    }),
    (error: unknown) => error instanceof ProviderExecutionGateError
      && error.code === 'managed_workbench_locked'
      && error.message === '受管工作台尚未就绪，无法执行生产',
  );
  assert.equal(inspected, 1);
  assert.equal(adapterCalls, 0);
});

test('managed gate rejects hidden and role-invalid providers before adapters', async () => {
  const cases = [
    { provider: { ...imageProvider, id: 'rotated-image' }, code: 'managed_provider_not_allowed' as const },
    { provider: { ...imageProvider, id: 'role-invalid-image', type: 'openai-compatible' }, code: 'managed_provider_role_invalid' as const },
  ];
  for (const item of cases) {
    let adapterCalls = 0;
    await assert.rejects(
      executeImage(item.provider, managedEnv, () => { adapterCalls += 1; }, {
        allowlist: allowlistFor({ image: item.provider.id === 'rotated-image' ? 'company-image' : item.provider.id }),
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError && error.code === item.code,
    );
    assert.equal(adapterCalls, 0);
  }
});

test('managed ready allowlisted provider invokes the injected adapter once', async () => {
  let adapterCalls = 0;
  await executeImage(imageProvider, managedEnv, () => { adapterCalls += 1; });
  assert.equal(adapterCalls, 1);
});

test('unrestricted external providers keep their direct execution semantics', async () => {
  let inspectCalls = 0;
  await assertProviderExecutionAvailable({
    id: 'legacy-image',
    type: 'openai-compatible',
    executionScope: 'external',
    baseUrl: 'https://provider.example/v1',
    enabled: true,
    configured: true,
  }, {
    capability: 'model',
    env: unrestrictedEnv,
    inspectRuntime: async () => {
      inspectCalls += 1;
      throw new Error('unrestricted external provider must not inspect managed runtime');
    },
  });
  assert.equal(inspectCalls, 0);
});

test('image queue places an execution gate before the GeekAI immediate download', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/queue.ts', import.meta.url)), 'utf8');
  const immediateStart = source.indexOf('if (submitResult.immediateImageUrl || submitResult.immediateImageBase64)');
  const fetchIndex = source.indexOf('fetch(immediateUrl', immediateStart);
  const gateIndex = source.indexOf('await assertImageExecution();', immediateStart);
  assert.ok(immediateStart >= 0);
  assert.ok(gateIndex >= 0 && gateIndex < fetchIndex);
});

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${randomUUID()}`;
}

function insertImageFixture(options: {
  providerId: string;
  providerType?: string;
  apiKey?: string;
  enabled?: number;
  providerTaskId?: string | null;
  status?: string;
  providerStatus?: string | null;
  remoteImageUrl?: string | null;
  providerRawResponse?: string | null;
}): { projectId: string; jobId: string } {
  const db = getDb();
  const projectId = nextId('project');
  const jobId = nextId('image-job');
  const inputImageId = nextId('input-image');
  const projectProviderId = nextId('project-provider');
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectProviderId, 'Fixture project provider', 'http://127.0.0.1:4000/v1',
    'CREATIVE_STUDIO_GATEWAY_API_KEY', 'fixture-key', 'fixture-model', 'gateway-task-image', 1,
  );
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    options.providerId, 'Fixture image provider', 'http://127.0.0.1:4000/v1',
    'CREATIVE_STUDIO_GATEWAY_API_KEY', options.apiKey ?? 'fixture-key', 'fixture-model',
    options.providerType ?? 'gateway-task-image', options.enabled ?? 1,
  );
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, quality, concurrency, maxAttempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectId, 'Fixture image project', projectProviderId, 'fixture-model', 'fixture prompt',
    '1024x1024', 'standard', 1, 1,
  );
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES (?, ?, 'input', ?, ?, 'image/png')`).run(inputImageId, projectId, 'input.png', 'fixture-input.png');
  db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, providerTaskId, providerStatus, remoteImageUrl, providerRawResponse)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`).run(
    jobId, projectId, inputImageId, options.providerId, 'fixture-model', 'fixture prompt',
    '1024x1024', 'standard', options.status ?? 'pending', options.providerTaskId ?? null,
    options.providerStatus ?? null, options.remoteImageUrl ?? null, options.providerRawResponse ?? null,
  );
  return { projectId, jobId };
}

function imageJobState(jobId: string): { status: string; providerTaskId: string | null; providerStatus: string | null; remoteImageUrl: string | null; providerRawResponse: string | null; errorMessage: string | null } {
  return getDb().prepare(`SELECT status, providerTaskId, providerStatus, remoteImageUrl, providerRawResponse, errorMessage FROM jobs WHERE id = ?`).get(jobId) as {
    status: string; providerTaskId: string | null; providerStatus: string | null; remoteImageUrl: string | null; providerRawResponse: string | null; errorMessage: string | null;
  };
}

function readyQueueGate(allowlist: ManagedProviderAllowlist = allowlistFor()) {
  return {
    env: managedEnv,
    allowlist,
    inspectRuntime: async () => runtimeFixture(),
  };
}

test('runQueue startup recovery preserves remote image identity as needs_check', async () => {
  const remoteTaskId = nextId('recover-task-image');
  const remoteTask = insertImageFixture({
    providerId: remoteTaskId,
    status: 'running',
    providerTaskId: 'recovery-remote-task',
    providerStatus: 'succeeded',
  });
  let taskSubmitCalls = 0;
  await runQueue({
    projectId: remoteTask.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 100,
    adapters: {
      submitGatewayTaskImage: async () => {
        taskSubmitCalls += 1;
        throw new Error('remote task must not resubmit');
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: remoteTaskId })),
  });
  const taskState = imageJobState(remoteTask.jobId);
  assert.equal(taskSubmitCalls, 0);
  assert.equal(taskState.status, 'needs_check');
  assert.equal(taskState.providerTaskId, 'recovery-remote-task');

  const remoteUrlId = nextId('recover-url-image');
  const remoteUrl = insertImageFixture({
    providerId: remoteUrlId,
    status: 'running',
    remoteImageUrl: 'http://127.0.0.1:4000/v1/content/recovery-image',
    providerStatus: 'succeeded',
  });
  let urlSubmitCalls = 0;
  await runQueue({
    projectId: remoteUrl.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 100,
    adapters: {
      submitGatewayTaskImage: async () => {
        urlSubmitCalls += 1;
        throw new Error('remote URL must not resubmit');
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: remoteUrlId })),
  });
  const urlState = imageJobState(remoteUrl.jobId);
  assert.equal(urlSubmitCalls, 0);
  assert.equal(urlState.status, 'needs_check');
  assert.equal(urlState.providerTaskId, null);
  assert.equal(urlState.remoteImageUrl, 'http://127.0.0.1:4000/v1/content/recovery-image');

  for (const status of ['pending', 'retrying'] as const) {
    const providerId = nextId(`recover-${status}-image`);
    const fixture = insertImageFixture({
      providerId,
      status,
      providerTaskId: `recovery-${status}-remote-task`,
    });
    let submitCalls = 0;
    await runQueue({
      projectId: fixture.projectId,
      concurrency: 1,
      maxAttempts: 1,
      timeoutMs: 100,
      adapters: {
        submitGatewayTaskImage: async () => {
          submitCalls += 1;
          throw new Error('recovered remote job must not resubmit');
        },
      },
      executionGate: readyQueueGate(allowlistFor({ image: providerId })),
    });
    const state = imageJobState(fixture.jobId);
    assert.equal(submitCalls, 0);
    assert.equal(state.status, 'needs_check');
    assert.equal(state.providerTaskId, `recovery-${status}-remote-task`);
  }
});

test('image queue gates locked, rotated, role-invalid, and ready adapter branches', async () => {
  const lockedId = nextId('locked-image');
  const lockedFixture = insertImageFixture({ providerId: lockedId });
  let lockedSubmitCalls = 0;
  const lockedAdapters: ImageQueueAdapterOverrides = {
    submitGatewayTaskImage: async () => {
      lockedSubmitCalls += 1;
      throw new Error('network must not run');
    },
  };
  await runQueue({
    projectId: lockedFixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 100,
    adapters: lockedAdapters,
    executionGate: {
      ...readyQueueGate(allowlistFor({ image: lockedId })),
      inspectRuntime: async () => runtimeFixture('unavailable', false),
    },
  });
  assert.equal(lockedSubmitCalls, 0);
  assert.equal(imageJobState(lockedFixture.jobId).status, 'failed');
  assert.match(imageJobState(lockedFixture.jobId).errorMessage || '', /managed_workbench_locked/);

  const hiddenId = nextId('hidden-image');
  const hiddenFixture = insertImageFixture({ providerId: hiddenId });
  let hiddenSubmitCalls = 0;
  await runQueue({
    projectId: hiddenFixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 100,
    adapters: {
      submitGatewayTaskImage: async () => {
        hiddenSubmitCalls += 1;
        throw new Error('network must not run');
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: nextId('different-image') })),
  });
  assert.equal(hiddenSubmitCalls, 0);
  assert.match(imageJobState(hiddenFixture.jobId).errorMessage || '', /managed_provider_not_allowed/);

  const roleId = nextId('role-image');
  const roleFixture = insertImageFixture({ providerId: roleId, providerType: 'openai-compatible' });
  let roleEditCalls = 0;
  await runQueue({
    projectId: roleFixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 100,
    adapters: {
      editImageOpenAI: async () => {
        roleEditCalls += 1;
        throw new Error('network must not run');
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: roleId })),
  });
  assert.equal(roleEditCalls, 0);
  assert.match(imageJobState(roleFixture.jobId).errorMessage || '', /managed_provider_role_invalid/);

  const readyId = nextId('ready-image');
  const readyFixture = insertImageFixture({ providerId: readyId });
  let readySubmitCalls = 0;
  await runQueue({
    projectId: readyFixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 100,
    adapters: {
      submitGatewayTaskImage: async () => {
        readySubmitCalls += 1;
        throw new Error('offline fake adapter');
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: readyId })),
  });
  assert.equal(readySubmitCalls, 1);
});

test('image queue marks gateway download failure needs_check and preserves remote identity', async () => {
  const providerId = nextId('download-failed-gateway');
  const fixture = insertImageFixture({ providerId });
  const remoteUrl = 'http://127.0.0.1:4000/v1/content/download-failed-gateway';
  let submitCalls = 0;
  let pollCalls = 0;
  let downloadCalls = 0;
  await runQueue({
    projectId: fixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 1000,
    adapters: {
      submitGatewayTaskImage: async () => {
        submitCalls += 1;
        return { taskId: 'download-failed-gateway-task', rawResponse: { id: 'download-failed-gateway-task' } };
      },
      pollGatewayTaskImage: async () => {
        pollCalls += 1;
        return { status: 'succeeded', imageUrl: remoteUrl, rawResponse: { status: 'completed', url: remoteUrl } };
      },
      downloadGatewayTaskImage: async () => {
        downloadCalls += 1;
        return { ok: false, errorMessage: 'fixture download failed' };
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: providerId })),
  });
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(state.status, 'needs_check');
  assert.equal(state.providerTaskId, 'download-failed-gateway-task');
  assert.equal(state.remoteImageUrl, remoteUrl);
  assert.equal(state.providerStatus, 'download_failed');
});

test('image queue marks GeekAI download failure needs_check and preserves remote identity', async () => {
  const providerId = nextId('download-failed-geekai');
  const fixture = insertImageFixture({ providerId, providerType: 'geekai-json' });
  const remoteUrl = 'https://geekai.example/content/download-failed-geekai';
  let submitCalls = 0;
  let pollCalls = 0;
  let downloadCalls = 0;
  await runQueue({
    projectId: fixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 1000,
    adapters: {
      submitGeekAITask: async () => {
        submitCalls += 1;
        return { taskId: 'download-failed-geekai-task', rawResponse: { id: 'download-failed-geekai-task' } };
      },
      pollGeekAITask: async () => {
        pollCalls += 1;
        return { status: 'succeeded', imageUrl: remoteUrl, rawResponse: { status: 'succeeded', url: remoteUrl } };
      },
      downloadGeekAIImage: async () => {
        downloadCalls += 1;
        return null;
      },
    },
    executionGate: { env: unrestrictedEnv },
  });
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(state.status, 'needs_check');
  assert.equal(state.providerTaskId, 'download-failed-geekai-task');
  assert.equal(state.remoteImageUrl, remoteUrl);
  assert.equal(state.providerStatus, 'download_failed');
});

test('image queue isolates generic remote errors from automatic retry', async () => {
  const providerId = nextId('generic-error-img');
  const fixture = insertImageFixture({ providerId });
  let submitCalls = 0;
  let pollCalls = 0;
  await runQueue({
    projectId: fixture.projectId,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 1000,
    adapters: {
      submitGatewayTaskImage: async () => {
        submitCalls += 1;
        return { taskId: 'generic-remote-error-task', rawResponse: { id: 'generic-remote-error-task' } };
      },
      pollGatewayTaskImage: async () => {
        pollCalls += 1;
        throw new Error('upstream connection lost after submit');
      },
    },
    executionGate: readyQueueGate(allowlistFor({ image: providerId })),
  });
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(state.status, 'needs_check');
  assert.equal(state.providerTaskId, 'generic-remote-error-task');
  assert.equal(state.errorMessage, 'Remote image task may still be running; manual inspection required');
});

test('image queue saves immediate GeekAI base64 without a second gate or network fetch', async () => {
  const providerId = nextId('immediate-base64-geekai');
  const fixture = insertImageFixture({ providerId, providerType: 'geekai-json' });
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let submitCalls = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('immediate base64 must not fetch');
  };
  try {
    await runQueue({
      projectId: fixture.projectId,
      concurrency: 1,
      maxAttempts: 1,
      timeoutMs: 1000,
      adapters: {
        submitGeekAITask: async () => {
          submitCalls += 1;
          getDb().prepare(`UPDATE providers SET apiKey = ? WHERE id = ?`).run('rotated-immediate-base64-secret', providerId);
          return { immediateImageBase64: imageBase64, rawResponse: { status: 'succeeded', b64_json: true } };
        },
      },
      // GeekAI is an external-only legacy provider and is intentionally not
      // admissible under the managed image role policy. Keep the queue path
      // unrestricted here while rotating the key after submit: the assertion
      // is that the already-returned base64 bytes are saved without a second
      // gate or any network fetch.
      executionGate: { env: unrestrictedEnv },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.providerTaskId, null);
  assert.equal(state.remoteImageUrl, null);
});

test('image queue rechecks before download and preserves a remote task on rotation', async () => {
  const providerId = nextId('download-rotation-image');
  const fixture = insertImageFixture({ providerId });
  const mutableAllowlist = allowlistFor({ image: providerId });
  let submitCalls = 0;
  let pollCalls = 0;
  let downloadCalls = 0;
  const adapters: ImageQueueAdapterOverrides = {
    submitGatewayTaskImage: async () => {
      submitCalls += 1;
      return { taskId: 'remote-image-task', rawResponse: { id: 'remote-image-task' } };
    },
    pollGatewayTaskImage: async () => {
      pollCalls += 1;
      mutableAllowlist.image = ['rotated-image-provider'];
      return { status: 'succeeded', imageUrl: 'http://127.0.0.1:4000/v1/content/image', rawResponse: { status: 'completed' } };
    },
    downloadGatewayTaskImage: async () => {
      downloadCalls += 1;
      return { ok: true, buffer: Buffer.from('should not download') };
    },
  };
  await runQueue({
    projectId: fixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 1000,
    adapters,
    executionGate: readyQueueGate(mutableAllowlist),
  });
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(downloadCalls, 0);
  assert.equal(state.status, 'needs_check');
  assert.equal(state.providerTaskId, 'remote-image-task');
  assert.equal(state.providerStatus, 'managed_provider_not_allowed');
});

test('image queue rejects same-id key rotation before the next poll/download', async () => {
  const providerId = nextId('same-id-key-image');
  const fixture = insertImageFixture({ providerId });
  let submitCalls = 0;
  let pollCalls = 0;
  let downloadCalls = 0;
  const adapters: ImageQueueAdapterOverrides = {
    submitGatewayTaskImage: async () => {
      submitCalls += 1;
      getDb().prepare(`UPDATE providers SET apiKey = ? WHERE id = ?`).run('rotated-secret', providerId);
      return { taskId: 'same-id-remote-image-task', rawResponse: { id: 'same-id-remote-image-task' } };
    },
    pollGatewayTaskImage: async () => {
      pollCalls += 1;
      return { status: 'succeeded', imageUrl: 'http://127.0.0.1:4000/v1/content/image', rawResponse: { status: 'completed' } };
    },
    downloadGatewayTaskImage: async () => {
      downloadCalls += 1;
      return { ok: true, buffer: Buffer.from('should not download') };
    },
  };
  await runQueue({
    projectId: fixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 1000,
    adapters,
    executionGate: readyQueueGate(allowlistFor({ image: providerId })),
  });
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 0);
  assert.equal(downloadCalls, 0);
  assert.equal(state.status, 'needs_check');
  assert.equal(state.providerTaskId, 'same-id-remote-image-task');
  assert.equal(state.providerStatus, 'managed_provider_not_allowed');
});

test('image queue rejects key rotation before an immediate gateway download', async () => {
  const providerId = nextId('immediate-key-image');
  const fixture = insertImageFixture({ providerId });
  let submitCalls = 0;
  let downloadCalls = 0;
  const adapters: ImageQueueAdapterOverrides = {
    submitGatewayTaskImage: async () => {
      submitCalls += 1;
      getDb().prepare(`UPDATE providers SET apiKey = ? WHERE id = ?`).run('rotated-immediate-image-secret', providerId);
      return { immediateImageUrl: 'http://127.0.0.1:4000/v1/content/immediate-image', rawResponse: { status: 'completed' } };
    },
    downloadGatewayTaskImage: async () => {
      downloadCalls += 1;
      return { ok: true, buffer: Buffer.from('should not download') };
    },
  };
  await runQueue({
    projectId: fixture.projectId,
    concurrency: 1,
    maxAttempts: 1,
    timeoutMs: 1000,
    adapters,
    executionGate: readyQueueGate(allowlistFor({ image: providerId })),
  });
  const state = imageJobState(fixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(downloadCalls, 0);
  assert.equal(state.status, 'needs_check');
  assert.equal(state.providerTaskId, null);
  assert.equal(state.remoteImageUrl, 'http://127.0.0.1:4000/v1/content/immediate-image');
  assert.equal(state.providerStatus, 'managed_provider_not_allowed');
});

test('image queue rejects a provisioning generation change before poll/download', async () => {
  const providerId = nextId('gen-image');
  const fixture = insertImageFixture({ providerId });
  const generationRoot = mkdtempSync(join(tmpdir(), 'creative-studio-managed-generation-'));
  const firstConfig = 'gateway: generation-one\n';
  const secondConfig = 'gateway: generation-two\n';
  writeProvisioningGeneration(generationRoot, '2026-08-07T00:00:00.000Z', firstConfig);
  const firstGeneration = readManagedExecutionGeneration(generationRoot);
  assert.equal(firstGeneration, `2026-08-07T00:00:00.000Z|${createHash('sha256').update(firstConfig, 'utf8').digest('hex')}`);
  let submitCalls = 0;
  let pollCalls = 0;
  let downloadCalls = 0;
  const adapters: ImageQueueAdapterOverrides = {
    submitGatewayTaskImage: async () => {
      submitCalls += 1;
      writeProvisioningGeneration(generationRoot, '2026-08-07T00:00:01.000Z', secondConfig);
      return { taskId: 'generation-remote-image-task', rawResponse: { id: 'generation-remote-image-task' } };
    },
    pollGatewayTaskImage: async () => {
      pollCalls += 1;
      return { status: 'succeeded', imageUrl: 'http://127.0.0.1:4000/v1/content/image', rawResponse: { status: 'completed' } };
    },
    downloadGatewayTaskImage: async () => {
      downloadCalls += 1;
      return { ok: true, buffer: Buffer.from('should not download') };
    },
  };
  try {
    await runQueue({
      projectId: fixture.projectId,
      concurrency: 1,
      maxAttempts: 1,
      timeoutMs: 1000,
      adapters,
      executionGate: {
        ...readyQueueGate(allowlistFor({ image: providerId })),
        root: generationRoot,
      },
    });
    assert.equal(submitCalls, 1);
    const secondGeneration = readManagedExecutionGeneration(generationRoot);
    assert.notEqual(secondGeneration, firstGeneration);
    const state = imageJobState(fixture.jobId);
    assert.equal(pollCalls, 0);
    assert.equal(downloadCalls, 0);
    assert.equal(state.status, 'needs_check');
    assert.equal(state.providerTaskId, 'generation-remote-image-task');
    assert.equal(state.providerStatus, 'managed_provider_not_allowed');
  } finally {
    rmSync(generationRoot, { recursive: true, force: true });
  }
});
function insertScriptProvider(options: {
  id: string;
  executionScope?: 'company' | 'external';
  type?: string;
  apiStyle?: string;
}): void {
  getDb().prepare(`INSERT OR IGNORE INTO script_providers
    (id, name, type, apiStyle, baseUrl, apiKey, model, keyEnv, baseUrlEnv, modelEnv, defaultBaseUrl, defaultModel, maxTokens, enabled, isBuiltin, supportsVision, visionCostPerRequest, executionScope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 0, ?)`).run(
    options.id,
    'Fixture script provider',
    options.type ?? 'openai-compatible',
    options.apiStyle ?? 'openai-compatible',
    'http://127.0.0.1:4000/v1',
    'fixture-script-key',
    'fixture-script-model',
    'CREATIVE_STUDIO_GATEWAY_API_KEY',
    'CREATIVE_STUDIO_GATEWAY_BASE_URL',
    'CREATIVE_STUDIO_GATEWAY_MODEL',
    'http://127.0.0.1:4000/v1',
    'fixture-script-model',
    2048,
    options.executionScope ?? 'company',
  );
}

async function withFakeFetch<T>(handler: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return { value: await handler(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('script completeJson rechecks before normal and visual adapter paths', async () => {
  const providerId = nextId('script-ready');
  insertScriptProvider({ id: providerId });
  const readyResult = await withFakeFetch(() => scriptProviders.completeJson<{ ok: boolean }>({
    providerId,
    systemPrompt: 'fixture system',
    userPrompt: 'fixture user',
    executionGate: {
      ...readyQueueGate(allowlistFor({ script: providerId })),
    },
  }));
  assert.deepEqual(readyResult.value, { ok: true });
  assert.equal(readyResult.calls, 1);

  const lockedProviderId = nextId('script-visual-locked');
  insertScriptProvider({ id: lockedProviderId });
  let visualFetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    visualFetchCalls += 1;
    throw new Error('visual network must not run');
  };
  try {
    await assert.rejects(
      scriptProviders.completeJson({
        providerId: lockedProviderId,
        systemPrompt: 'fixture system',
        userPrompt: 'fixture visual',
        images: [{ mimeType: 'image/png', imageBase64: 'AA==' }],
        executionGate: {
          ...readyQueueGate(allowlistFor({ script: lockedProviderId })),
          inspectRuntime: async () => runtimeFixture('unavailable', false),
        },
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_workbench_locked',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(visualFetchCalls, 0);
});

test('script completeJson rejects same-id key rotation after the managed gate', async () => {
  const providerId = nextId('same-id-key-script');
  insertScriptProvider({ id: providerId });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('rotated script adapter must not run');
  };
  try {
    await assert.rejects(
      scriptProviders.completeJson({
        providerId,
        systemPrompt: 'fixture system',
        userPrompt: 'fixture rotation',
        executionGate: {
          env: managedEnv,
          allowlist: allowlistFor({ script: providerId }),
          inspectRuntime: async () => {
            getDb().prepare(`UPDATE script_providers SET apiKey = ? WHERE id = ?`).run('rotated-script-secret', providerId);
            return runtimeFixture();
          },
        },
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_provider_not_allowed',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});
test('managed hidden external script rows cannot bypass completeJson or analysis', async () => {
  const providerId = nextId('hidden-external-script');
  insertScriptProvider({ id: providerId, executionScope: 'external' });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('hidden provider network must not run');
  };
  const gate = {
    env: managedEnv,
    allowlist: allowlistFor({ script: nextId('different-script') }),
    inspectRuntime: async () => runtimeFixture(),
  };
  try {
    await assert.rejects(
      scriptProviders.completeJson({
        providerId,
        systemPrompt: 'fixture system',
        userPrompt: 'fixture hidden',
        executionGate: gate,
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_provider_not_allowed',
    );
    await assert.rejects(
      scriptProviders.analyzeSellingPoints({
        sellingPoints: ['fixture selling point'],
        targetAudience: 'fixture audience',
        platform: 'fixture platform',
      }, providerId, gate),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_provider_not_allowed',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

function insertVideoFixture(options: {
  providerId: string;
  providerType?: 'openai-video' | 'jimeng';
  providerTaskId?: string | null;
}): { projectId: string; jobId: string } {
  const db = getDb();
  const projectId = nextId('video-project');
  const jobId = nextId('video-job');
  const sourceImageId = nextId('video-source');
  const projectProviderId = nextId('video-project-provider');
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
    projectProviderId, 'Fixture project provider', 'http://127.0.0.1:4000/v1',
    'CREATIVE_STUDIO_GATEWAY_API_KEY', 'fixture-key', 'fixture-model', 'gateway-task-image',
  );
  db.prepare(`INSERT OR IGNORE INTO video_providers
    (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 5, ?, ?)`).run(
    options.providerId, 'Fixture video provider', options.providerType ?? 'openai-video',
    'CREATIVE_STUDIO_GATEWAY_BASE_URL', 'CREATIVE_STUDIO_GATEWAY_API_KEY', 'CREATIVE_STUDIO_GATEWAY_MODEL',
    'fixture-video-model', 'http://127.0.0.1:4000/v1', 'fixture-video-key',
  );
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, quality, concurrency, maxAttempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 2)`).run(
    projectId, 'Fixture video project', projectProviderId, 'fixture-model', 'fixture prompt', '1024x1024', 'standard',
  );
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES (?, ?, 'input', ?, ?, 'image/png')`).run(sourceImageId, projectId, 'source.png', 'fixture-source.png');
  db.prepare(`INSERT INTO video_jobs
    (id, projectId, sourceImageId, providerId, model, prompt, durationSec, status, providerTaskId, attempt, maxAttempts)
    VALUES (?, ?, ?, ?, ?, ?, 5, 'pending', ?, 0, 2)`).run(
    jobId, projectId, sourceImageId, options.providerId, 'fixture-video-model', 'fixture video prompt', options.providerTaskId ?? null,
  );
  return { projectId, jobId };
}

function videoJobState(jobId: string): { status: string; providerTaskId: string | null; providerStatus: string | null; errorMessage: string | null } {
  return getDb().prepare(`SELECT status, providerTaskId, providerStatus, errorMessage FROM video_jobs WHERE id = ?`).get(jobId) as {
    status: string; providerTaskId: string | null; providerStatus: string | null; errorMessage: string | null;
  };
}

test('video queue blocks hidden and role-invalid providers before submit', async () => {
  const hiddenId = nextId('hidden-video');
  const hiddenFixture = insertVideoFixture({ providerId: hiddenId });
  let hiddenSubmitCalls = 0;
  registerTestVideoAdapter('openai-video', {
    submit: async () => {
      hiddenSubmitCalls += 1;
      throw new Error('hidden video adapter must not run');
    },
    poll: async () => ({ status: 'failed', rawResponse: {} }),
  });
  await runVideoQueue({
    projectId: hiddenFixture.projectId,
    concurrency: 1,
    timeoutMs: 100,
    executionGate: readyQueueGate(allowlistFor({ video: nextId('different-video') })),
  });
  assert.equal(hiddenSubmitCalls, 0);
  assert.match(videoJobState(hiddenFixture.jobId).errorMessage || '', /managed_provider_not_allowed/);

  const roleId = nextId('role-video');
  const roleFixture = insertVideoFixture({ providerId: roleId, providerType: 'jimeng' });
  let roleSubmitCalls = 0;
  registerTestVideoAdapter('jimeng', {
    submit: async () => {
      roleSubmitCalls += 1;
      throw new Error('role-invalid video adapter must not run');
    },
    poll: async () => ({ status: 'failed', rawResponse: {} }),
  });
  await runVideoQueue({
    projectId: roleFixture.projectId,
    concurrency: 1,
    timeoutMs: 100,
    executionGate: readyQueueGate(allowlistFor({ video: roleId })),
  });
  assert.equal(roleSubmitCalls, 0);
  assert.match(videoJobState(roleFixture.jobId).errorMessage || '', /managed_provider_role_invalid/);
});

test('video queue invokes ready submit retries, then rechecks before poll/download on rotation', async () => {
  const retryId = nextId('retry-video');
  const retryFixture = insertVideoFixture({ providerId: retryId });
  let retrySubmitCalls = 0;
  registerTestVideoAdapter('openai-video', {
    submit: async () => {
      retrySubmitCalls += 1;
      throw new Error('offline retry adapter');
    },
    poll: async () => ({ status: 'failed', rawResponse: {} }),
  });
  await runVideoQueue({
    projectId: retryFixture.projectId,
    concurrency: 1,
    timeoutMs: 100,
    executionGate: readyQueueGate(allowlistFor({ video: retryId })),
  });
  assert.equal(retrySubmitCalls, 2);

  const rotationId = nextId('rotation-video');
  const rotationFixture = insertVideoFixture({ providerId: rotationId });
  const mutableAllowlist = allowlistFor({ video: rotationId });
  let submitCalls = 0;
  let pollCalls = 0;
  let fetchCalls = 0;
  registerTestVideoAdapter('openai-video', {
    minimumPollingTimeoutMs: () => 5_001,
    submit: async () => {
      submitCalls += 1;
      return { providerTaskId: 'remote-video-task', rawResponse: { id: 'remote-video-task' } };
    },
    poll: async () => {
      pollCalls += 1;
      getDb().prepare(`UPDATE video_providers SET apiKey = ? WHERE id = ?`).run('rotated-video-secret', rotationId);
      mutableAllowlist.video = ['rotated-video-provider'];
      return { status: 'succeeded', videoUrl: 'http://127.0.0.1:4000/v1/content/video', rawResponse: { status: 'completed' } };
    },
  } satisfies VideoProviderAdapter);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(Buffer.from('should not download'), { status: 200 });
  };
  try {
    await runVideoQueue({
      projectId: rotationFixture.projectId,
      concurrency: 1,
      timeoutMs: 6_000,
      executionGate: readyQueueGate(mutableAllowlist),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const state = videoJobState(rotationFixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(state.status, 'failed');
  assert.equal(state.providerTaskId, 'remote-video-task');
  assert.equal(state.providerStatus, 'managed_provider_not_allowed');
  assert.match(state.errorMessage || '', /^provider_execution_gate:managed_provider_not_allowed/);
});

test('video queue rejects same-id key-only rotation before download', async () => {
  const rotationId = nextId('same-id-key-video');
  const rotationFixture = insertVideoFixture({ providerId: rotationId });
  let submitCalls = 0;
  let pollCalls = 0;
  let fetchCalls = 0;
  registerTestVideoAdapter('openai-video', {
    minimumPollingTimeoutMs: () => 5_001,
    submit: async () => {
      submitCalls += 1;
      getDb().prepare(`UPDATE video_providers SET apiKey = ? WHERE id = ?`).run('rotated-key-only-video-secret', rotationId);
      return { providerTaskId: 'same-id-key-only-video-task', rawResponse: { id: 'same-id-key-only-video-task' } };
    },
    poll: async () => {
      pollCalls += 1;
      return { status: 'succeeded', videoUrl: 'http://127.0.0.1:4000/v1/content/video', rawResponse: { status: 'completed' } };
    },
  } satisfies VideoProviderAdapter);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(Buffer.from('should not download'), { status: 200 });
  };
  try {
    await runVideoQueue({
      projectId: rotationFixture.projectId,
      concurrency: 1,
      timeoutMs: 6_000,
      executionGate: readyQueueGate(allowlistFor({ video: rotationId })),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const state = videoJobState(rotationFixture.jobId);
  assert.equal(submitCalls, 1);
  assert.equal(pollCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(state.status, 'failed');
  assert.equal(state.providerTaskId, 'same-id-key-only-video-task');
  assert.equal(state.providerStatus, 'managed_provider_not_allowed');
  assert.match(state.errorMessage || '', /^provider_execution_gate:managed_provider_not_allowed/);
});

after(() => {
  closeDb();
  rmSync(fixtureRoot, { recursive: true, force: true });
  assert.equal(existsSync(fixtureRoot), false, 'managed execution fixture root must be removed');
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  if (previousManaged === undefined) delete process.env[MANAGED_DEPLOYMENT_ENV];
  else process.env[MANAGED_DEPLOYMENT_ENV] = previousManaged;
});
