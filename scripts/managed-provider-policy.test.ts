import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  MANAGED_DEPLOYMENT_ENV,
  isManagedDeployment,
} from '../lib/managed-deployment.ts';
import {
  ManagedProviderPolicyError,
  assertManagedProviderAllowed,
  evaluateManagedProvider,
  filterManagedProviders,
  loadManagedProviderAllowlist,
} from '../lib/managed-provider-policy.ts';
import type {
  ManagedProviderIdentity,
  ManagedProviderKind,
  ManagedProviderPolicyCode,
  ManagedProviderPolicyVerdict,
} from '../lib/managed-provider-policy.ts';
import type { ManagedProviderAllowlist } from '../lib/provisioning/types.ts';

const managedEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', [MANAGED_DEPLOYMENT_ENV]: '1' };
const unrestrictedEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

const allowlist: ManagedProviderAllowlist = {
  image: ['company-image'],
  script: ['company-script'],
  video: ['company-video'],
  tts: ['doubao-seed-tts-2'],
};

const imageProvider = {
  id: 'company-image',
  type: 'gateway-task-image',
  baseUrl: 'http://127.0.0.1:4000/v1',
  apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY',
};

const scriptProvider = {
  id: 'company-script',
  type: 'openai-compatible',
  apiStyle: 'openai-compatible',
  executionScope: 'company',
  baseUrl: 'http://localhost:4000/v1',
  apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY',
};

const videoProvider = {
  id: 'company-video',
  type: 'openai-video',
  baseUrl: 'http://[::1]:4000/v1',
  apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY',
};

const ttsProvider = {
  id: 'doubao-seed-tts-2',
  type: 'doubao-http-chunked',
  baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  keyEnv: 'DOUBAO_TTS_API_KEY',
};

function evaluate(
  kind: ManagedProviderKind,
  provider: ManagedProviderIdentity,
  overrides: Partial<Parameters<typeof evaluateManagedProvider>[0]> = {},
) {
  return evaluateManagedProvider({
    managed: true,
    kind,
    allowlist,
    provider,
    ...overrides,
  });
}

function verdictCode(verdict: ManagedProviderPolicyVerdict): ManagedProviderPolicyCode | undefined {
  return verdict.allowed ? undefined : verdict.code;
}

test('isManagedDeployment is false unless the env value is exactly 1', () => {
  assert.equal(isManagedDeployment(unrestrictedEnv), false);
  assert.equal(isManagedDeployment({ NODE_ENV: 'test', [MANAGED_DEPLOYMENT_ENV]: '0' }), false);
  assert.equal(isManagedDeployment({ NODE_ENV: 'test', [MANAGED_DEPLOYMENT_ENV]: '' }), false);
  assert.equal(isManagedDeployment({ NODE_ENV: 'test', [MANAGED_DEPLOYMENT_ENV]: 'true' }), false);
  assert.equal(isManagedDeployment(managedEnv), true);
});

test('unmanaged policy is explicitly unrestricted and does not inspect state or shape', () => {
  const verdict = evaluateManagedProvider({
    managed: false,
    kind: 'image',
    allowlist: null,
    provider: { id: '', type: '', baseUrl: '' },
  });
  assert.deepEqual(verdict, { allowed: true, mode: 'unrestricted' });

  const providers = [imageProvider, { ...imageProvider, id: 'legacy' }];
  const filtered = filterManagedProviders('image', providers, null, { env: unrestrictedEnv });
  assert.equal(filtered, providers, 'unmanaged filtering must preserve the input array');
});

test('provider helpers derive managed mode from env and cannot be disabled by an extra managed:false field', () => {
  const bypassAttempt = { env: managedEnv, managed: false } as unknown as { env: NodeJS.ProcessEnv };
  assert.throws(
    () => assertManagedProviderAllowed('image', { ...imageProvider, id: 'hidden' }, allowlist, bypassAttempt),
    (error: unknown) => error instanceof ManagedProviderPolicyError
      && error.code === 'managed_provider_not_allowed',
  );

  const providers = [imageProvider, { ...imageProvider, id: 'hidden' }];
  const filtered = filterManagedProviders('image', providers, allowlist, bypassAttempt);
  assert.deepEqual(filtered, [imageProvider]);
  assert.notEqual(filtered, providers);

  const unrestricted = filterManagedProviders('image', providers, allowlist, { env: unrestrictedEnv });
  assert.equal(unrestricted, providers, 'unmanaged helper keeps historical array behavior');
});

test('managed deployment without a valid allowlist rejects every provider kind', () => {
  const providersByKind: Array<[ManagedProviderKind, ManagedProviderIdentity]> = [
    ['image', imageProvider],
    ['script', scriptProvider],
    ['video', videoProvider],
    ['tts', ttsProvider],
  ];
  for (const [kind, provider] of providersByKind) {
    assert.deepEqual(
      evaluateManagedProvider({ managed: true, kind, allowlist: null, provider }),
      { allowed: false, code: 'managed_state_missing', message: '公司受管配置尚未导入' },
    );
  }
  assert.deepEqual(filterManagedProviders('image', [imageProvider], null, { env: managedEnv }), []);
});

test('managed policy rejects any malformed full allowlist before checking a provider role', () => {
  const validProviders: Array<[ManagedProviderKind, ManagedProviderIdentity]> = [
    ['image', imageProvider],
    ['script', scriptProvider],
    ['video', videoProvider],
    ['tts', ttsProvider],
  ];
  const malformedAllowlists: unknown[] = [
    { image: ['company-image'], script: null, video: 'bad', tts: ['wrong'] },
    [],
    { ...allowlist, extra: ['unexpected'] },
    { ...allowlist, image: [] },
    { ...allowlist, script: [] },
    { ...allowlist, video: [] },
    { ...allowlist, image: ['company-image', 'company-image-2'] },
    { ...allowlist, script: ['company-script', 'company-script-2'] },
    { ...allowlist, video: Array.from({ length: 9 }, (_, index) => `company-video-${index}`) },
    { ...allowlist, image: ['company-image', 'company-image'] },
    { ...allowlist, script: ['company-script', 'company-script'] },
    { ...allowlist, video: ['company-video', 'company-video'] },
    { ...allowlist, image: ['company image'] },
    { ...allowlist, script: ['Company-script'] },
    { ...allowlist, video: ['company/video'] },
    { ...allowlist, image: [''] },
    { ...allowlist, script: ['a'.repeat(65)] },
    { ...allowlist, tts: ['other-tts'] },
    { ...allowlist, tts: ['doubao-seed-tts-2', 'other-tts'] },
  ];

  for (const malformed of malformedAllowlists) {
    for (const [kind, provider] of validProviders) {
      const verdict = evaluateManagedProvider({
        managed: true,
        kind,
        allowlist: malformed as ManagedProviderAllowlist,
        provider,
      });
      assert.deepEqual(
        verdict,
        { allowed: false, code: 'managed_state_missing', message: '公司受管配置尚未导入' },
        `malformed allowlist must be rejected for requested role ${kind}`,
      );
    }
  }
});

test('provider IDs outside their role allowlist are rejected without fallback', () => {
  assert.equal(verdictCode(evaluate('image', { ...imageProvider, id: 'rotated-image' })), 'managed_provider_not_allowed');
  assert.equal(verdictCode(evaluate('script', { ...scriptProvider, id: 'rotated-script' })), 'managed_provider_not_allowed');
  assert.equal(verdictCode(evaluate('video', { ...videoProvider, id: 'rotated-video' })), 'managed_provider_not_allowed');
  assert.equal(verdictCode(evaluate('tts', { ...ttsProvider, id: 'rotated-tts' })), 'managed_provider_not_allowed');

  const rotated = { ...allowlist, video: ['rotated-video'] };
  assert.equal(
    verdictCode(evaluateManagedProvider({ managed: true, kind: 'video', allowlist: rotated, provider: videoProvider })),
    'managed_provider_not_allowed',
  );
});

test('an allowlisted provider with the wrong role shape is rejected with the stable role error', () => {
  assert.deepEqual(
    evaluateManagedProvider({
      managed: true,
      kind: 'video',
      allowlist,
      provider: { ...videoProvider, type: 'kling' },
    }),
    { allowed: false, code: 'managed_provider_role_invalid', message: '该供应商不符合公司受管配置' },
  );
});

test('managed image providers require the gateway adapter, company key env, and HTTP loopback URL', () => {
  assert.equal(evaluate('image', imageProvider).allowed, true);
  for (const provider of [
    { ...imageProvider, type: 'openai-compatible' },
    { ...imageProvider, apiKeyEnv: 'OTHER_KEY' },
    { ...imageProvider, baseUrl: 'https://127.0.0.1:4000/v1' },
    { ...imageProvider, baseUrl: 'http://remote.example/v1' },
    { ...imageProvider, baseUrl: 'http://127.0.0.1:4000/v1?x=1' },
    { ...imageProvider, baseUrl: 'http://127.0.0.1:4000/v1?' },
    { ...imageProvider, baseUrl: 'http://127.0.0.1:4000/v1#' },
    { ...imageProvider, baseUrl: 'http://user:pass@127.0.0.1:4000/v1' },
    { ...imageProvider, baseUrl: 'http://@127.0.0.1:4000/v1' },
  ]) {
    assert.equal(verdictCode(evaluate('image', provider)), 'managed_provider_role_invalid');
  }
});

test('managed script providers require company scope, matching supported protocol, and HTTP loopback URL', () => {
  assert.equal(evaluate('script', scriptProvider).allowed, true);
  for (const provider of [
    { ...scriptProvider, executionScope: 'external' },
    { ...scriptProvider, type: 'openai-responses' },
    { ...scriptProvider, apiStyle: 'anthropic-messages' },
    { ...scriptProvider, type: 'unsupported', apiStyle: 'unsupported' },
    { ...scriptProvider, baseUrl: 'https://localhost:4000/v1' },
    { ...scriptProvider, baseUrl: 'http://remote.example/v1' },
  ]) {
    assert.equal(verdictCode(evaluate('script', provider)), 'managed_provider_role_invalid');
  }
  for (const apiStyle of ['openai-compatible', 'openai-responses', 'anthropic-messages']) {
    assert.equal(
      evaluate('script', { ...scriptProvider, type: apiStyle, apiStyle }).allowed,
      true,
      `supported script protocol ${apiStyle} should be accepted`,
    );
  }
});

test('managed video providers require openai-video, company key env, and HTTP loopback URL', () => {
  assert.equal(evaluate('video', videoProvider).allowed, true);
  for (const provider of [
    { ...videoProvider, type: 'kling' },
    { ...videoProvider, apiKeyEnv: 'OTHER_KEY' },
    { ...videoProvider, baseUrl: 'https://[::1]:4000/v1' },
    { ...videoProvider, baseUrl: 'http://remote.example/v1' },
    { ...videoProvider, baseUrl: 'http://[::1]:4000/v1#fragment' },
  ]) {
    assert.equal(verdictCode(evaluate('video', provider)), 'managed_provider_role_invalid');
  }
});

test('managed Doubao TTS requires its fixed identity, type, key env, HTTPS, and safe endpoint path', () => {
  assert.equal(evaluate('tts', ttsProvider).allowed, true);
  assert.equal(evaluate('tts', { ...ttsProvider, baseUrl: 'https://openspeech.bytedance.com:443/' }).allowed, true);
  assert.equal(evaluate('tts', { ...ttsProvider, baseUrl: 'https://openspeech.bytedance.com' }).allowed, true);
  assert.equal(verdictCode(evaluate('tts', { ...ttsProvider, id: 'other-tts' })), 'managed_provider_not_allowed');
  for (const provider of [
    { ...ttsProvider, type: 'other' },
    { ...ttsProvider, keyEnv: 'OTHER_KEY' },
    { ...ttsProvider, baseUrl: 'http://openspeech.bytedance.com' },
    { ...ttsProvider, baseUrl: 'https://evil.example/' },
    { ...ttsProvider, baseUrl: 'https://1.2.3.4/' },
    { ...ttsProvider, baseUrl: 'https://api.openspeech.bytedance.com/' },
    { ...ttsProvider, baseUrl: 'https://openspeech.bytedance.com:8443/' },
    { ...ttsProvider, baseUrl: 'https://user:pass@openspeech.bytedance.com' },
    { ...ttsProvider, baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional?x=1' },
    { ...ttsProvider, baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional#x' },
    { ...ttsProvider, baseUrl: 'https://openspeech.bytedance.com/other' },
  ]) {
    assert.equal(verdictCode(evaluate('tts', provider)), 'managed_provider_role_invalid');
  }
});

test('filterManagedProviders reuses policy and keeps only valid allowlisted role identities', () => {
  const providers = [
    imageProvider,
    { ...imageProvider, id: 'legacy-image' },
    { ...imageProvider, type: 'wrong' },
  ];
  const filtered = filterManagedProviders('image', providers, allowlist, { env: managedEnv });
  assert.deepEqual(filtered, [imageProvider]);
  assert.notEqual(filtered, providers);
  assert.deepEqual(providers, [
    imageProvider,
    { ...imageProvider, id: 'legacy-image' },
    { ...imageProvider, type: 'wrong' },
  ], 'filtering must not mutate the input array');
});

test('assertManagedProviderAllowed throws a stable, non-secret policy error', () => {
  assert.doesNotThrow(() => assertManagedProviderAllowed('image', imageProvider, allowlist, { env: managedEnv }));
  assert.throws(
    () => assertManagedProviderAllowed('video', { ...videoProvider, id: 'hidden' }, allowlist, { env: managedEnv }),
    (error: unknown) => error instanceof ManagedProviderPolicyError
      && error.code === 'managed_provider_not_allowed'
      && error.kind === 'video'
      && error.message === '该供应商不在公司受管配置中'
      && !error.message.includes('hidden')
      && !error.message.includes('http'),
  );
});

function writeProvisioningFixture(root: string, state: unknown, config = 'gateway: 配置\n'): void {
  const statePath = join(root, 'data', 'provisioning', 'state.json');
  const runtimePath = join(root, 'data', 'provisioning', 'runtime.env');
  const configPath = join(root, 'config.yaml');
  mkdirSync(join(root, 'data', 'provisioning'), { recursive: true });
  writeFileSync(configPath, config, 'utf8');
  writeFileSync(runtimePath, [
    'CREATIVE_STUDIO_GATEWAY_API_KEY="gateway-secret"',
    'COMPANY_GATEWAY_API_KEY="gateway-secret"',
    'GATEWAY_API_KEY="gateway-secret"',
    'CREATIVE_STUDIO_COS_SECRET_ID="id"',
    'CREATIVE_STUDIO_COS_SECRET_KEY="key"',
    'CREATIVE_STUDIO_COS_DOMAIN="bucket.cos.example"',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(statePath, JSON.stringify(state) + '\n', 'utf8');
}

function validState(config = 'gateway: 配置\n'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    profileName: '公司统一配置',
    importedAt: '2026-08-06T00:00:00.000Z',
    configHash: createHash('sha256').update(config, 'utf8').digest('hex'),
    managedProviders: allowlist,
  };
}

test('loadManagedProviderAllowlist reads only a valid v2 provisioning state and returns a clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-policy-'));
  writeProvisioningFixture(root, validState());
  const loaded = loadManagedProviderAllowlist(root);
  assert.deepEqual(loaded, allowlist);
  assert.notEqual(loaded, allowlist);
  assert.notEqual(loaded?.image, allowlist.image);
  loaded!.image.push('mutated');
  assert.deepEqual(loadManagedProviderAllowlist(root), allowlist, 'caller mutation must not alter subsequent reads');

  const statePath = join(root, 'data', 'provisioning', 'state.json');
  const original = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  writeFileSync(statePath, JSON.stringify({ ...original, schemaVersion: 1 }), 'utf8');
  assert.equal(loadManagedProviderAllowlist(root), null);
  writeFileSync(statePath, '{ invalid json', 'utf8');
  assert.equal(loadManagedProviderAllowlist(root), null);
});

test('loadManagedProviderAllowlist returns null for missing state and never guesses from provider names or URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-policy-'));
  assert.equal(loadManagedProviderAllowlist(root), null);
  writeProvisioningFixture(root, {
    schemaVersion: 2,
    profileName: 'guess',
    importedAt: '2026-08-06T00:00:00.000Z',
    configHash: '0'.repeat(64),
    managedProviders: {
      image: ['gateway-task-image'],
      script: ['openai-compatible'],
      video: ['openai-video'],
      tts: ['doubao-seed-tts-2'],
    },
  });
  assert.equal(loadManagedProviderAllowlist(root), null);
});
