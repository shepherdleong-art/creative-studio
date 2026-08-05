import assert from 'node:assert/strict';
import {
  ProviderExecutionGateError,
  assertProviderExecutionAvailable,
  evaluateProviderExecutionGate,
} from '../lib/provider-execution-gate.ts';

const externalProvider = {
  id: 'external-vision',
  executionScope: 'external' as const,
  baseUrl: 'https://provider.example/v1',
  enabled: true,
  configured: true,
};

let inspectCalls = 0;
await assertProviderExecutionAvailable(externalProvider, {
  root: '/must-not-be-inspected',
  capability: 'media',
  inspectRuntime: async () => {
    inspectCalls += 1;
    throw new Error('external provider must bypass company runtime');
  },
});
assert.equal(inspectCalls, 0, '直连供应商不得触发公司运行环境检查');

assert.deepEqual(
  evaluateProviderExecutionGate({
    provider: { ...externalProvider, enabled: false },
    capability: 'model',
  }),
  { allowed: false, code: 'provider_disabled', executionScope: 'external', message: '供应商已停用' },
);

const companyProvider = {
  id: 'company-vision',
  executionScope: 'company' as const,
  baseUrl: 'http://127.0.0.1:4000/v1',
  enabled: true,
  configured: true,
};

assert.deepEqual(
  evaluateProviderExecutionGate({
    provider: { ...companyProvider, baseUrl: 'https://provider.example/v1' },
    capability: 'model',
    companyRuntime: {
      status: 'ready', reason: 'ready', proxyAvailable: true, cosConfigured: true, startedAt: null,
    },
  }),
  {
    allowed: false,
    code: 'provider_route_invalid',
    executionScope: 'company',
    message: '公司供应商必须通过本机 LiteLLM 地址访问',
  },
  '公司 scope 不能借门禁后直连外部地址',
);

const proxyOnlyRuntime = {
  status: 'ready' as const,
  reason: 'LiteLLM 已就绪',
  proxyAvailable: true,
  cosConfigured: false,
  startedAt: null,
};
assert.equal(
  evaluateProviderExecutionGate({
    provider: companyProvider,
    capability: 'model',
    companyRuntime: proxyOnlyRuntime,
  }).allowed,
  true,
  '纯文本公司调用只依赖本机 LiteLLM，不应被媒体传输状态误伤',
);
assert.deepEqual(
  evaluateProviderExecutionGate({
    provider: companyProvider,
    capability: 'media',
    companyRuntime: proxyOnlyRuntime,
    mediaTransportAvailable: false,
  }),
  {
    allowed: false,
    code: 'transport_unavailable',
    executionScope: 'company',
    message: '公司供应商的受控媒体传输尚未就绪',
  },
  '公司运行环境就绪但没有真实任务级 MediaTransport 时，media 能力仍必须拒绝',
);
assert.equal(
  evaluateProviderExecutionGate({
    provider: companyProvider,
    capability: 'media',
    companyRuntime: proxyOnlyRuntime,
    mediaTransportAvailable: true,
  }).allowed,
  true,
  '真实任务级 MediaTransport 就绪时，media 能力不应再被旧的隧道概念误伤',
);

await assert.rejects(
  assertProviderExecutionAvailable(companyProvider, {
    root: '/fixture',
    capability: 'model',
    inspectRuntime: async () => ({
      status: 'stopped', reason: '公司供应商已配置但当前未启动',
      proxyAvailable: false, cosConfigured: false, startedAt: null,
    }),
  }),
  (error: unknown) => (
    error instanceof ProviderExecutionGateError
    && error.code === 'runtime_stopped'
    && /未启动/.test(error.message)
  ),
);

let unconfiguredInspectCalls = 0;
await assert.rejects(
  assertProviderExecutionAvailable({ ...companyProvider, configured: false }, {
    root: '/fixture',
    capability: 'media',
    inspectRuntime: async () => {
      unconfiguredInspectCalls += 1;
      throw new Error('unconfigured provider must fail before runtime inspection');
    },
  }),
  (error: unknown) => error instanceof ProviderExecutionGateError && error.code === 'provider_unconfigured',
);
assert.equal(unconfiguredInspectCalls, 0, '供应商配置已失效时不得先检查 sidecar');

console.log('provider execution gate tests passed');
