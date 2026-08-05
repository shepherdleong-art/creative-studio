import { dataRoot } from './data-root.ts';
import {
  inspectCompanyProviderRuntime,
  type CompanyProviderRuntimeStatus,
  type InspectCompanyProviderRuntimeOptions,
} from './company-provider-runtime.ts';
import type { ProviderExecutionScope } from './script-providers/types.ts';

export type ProviderExecutionCapability = 'model' | 'media';

export type ProviderExecutionGateCode =
  | 'ready'
  | 'provider_disabled'
  | 'provider_unconfigured'
  | 'provider_route_invalid'
  | 'runtime_not_configured'
  | 'runtime_stopped'
  | 'runtime_unavailable'
  | 'transport_unavailable';

export interface ProviderExecutionIdentity {
  id: string;
  executionScope: ProviderExecutionScope;
  baseUrl: string;
  enabled: boolean;
  configured: boolean;
}

export type ProviderExecutionGateResult = {
  allowed: true;
  code: 'ready';
  executionScope: ProviderExecutionScope;
  message: string;
} | {
  allowed: false;
  code: Exclude<ProviderExecutionGateCode, 'ready'>;
  executionScope: ProviderExecutionScope;
  message: string;
};

export interface EvaluateProviderExecutionGateInput {
  provider: ProviderExecutionIdentity;
  capability: ProviderExecutionCapability;
  companyRuntime?: CompanyProviderRuntimeStatus;
  /** 只有真实任务级 MediaTransport 接入后才能设为 true；开发期整站隧道不算。 */
  mediaTransportAvailable?: boolean;
}

type RuntimeInspector = (
  options: InspectCompanyProviderRuntimeOptions,
) => Promise<CompanyProviderRuntimeStatus>;

export interface AssertProviderExecutionAvailableOptions {
  root?: string;
  capability: ProviderExecutionCapability;
  mediaTransportAvailable?: boolean;
  inspectRuntime?: RuntimeInspector;
}

function denied(
  provider: ProviderExecutionIdentity,
  code: Exclude<ProviderExecutionGateCode, 'ready'>,
  message: string,
): ProviderExecutionGateResult {
  return { allowed: false, code, executionScope: provider.executionScope, message };
}

function isLoopbackLiteLlmUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && !parsed.username
      && !parsed.password
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

/**
 * 纯策略门禁：不访问网络、不读取文件。调用方必须显式传入公司运行状态。
 * 外部供应商永远旁路公司运行环境；公司供应商则只能走本机 LiteLLM。
 */
export function evaluateProviderExecutionGate(
  input: EvaluateProviderExecutionGateInput,
): ProviderExecutionGateResult {
  const { provider } = input;
  if (!provider.enabled) return denied(provider, 'provider_disabled', '供应商已停用');
  if (!provider.configured) return denied(provider, 'provider_unconfigured', '供应商尚未配置完整');

  if (provider.executionScope === 'external') {
    return { allowed: true, code: 'ready', executionScope: 'external', message: '直连供应商可用' };
  }
  if (!isLoopbackLiteLlmUrl(provider.baseUrl)) {
    return denied(provider, 'provider_route_invalid', '公司供应商必须通过本机 LiteLLM 地址访问');
  }

  const runtime = input.companyRuntime;
  if (!runtime || runtime.status === 'not_configured') {
    return denied(provider, 'runtime_not_configured', runtime?.reason || '尚未配置公司供应商运行环境');
  }
  if (runtime.status === 'stopped') {
    return denied(provider, 'runtime_stopped', runtime.reason);
  }
  if (!runtime.proxyAvailable) {
    return denied(provider, 'runtime_unavailable', runtime.reason || 'LiteLLM 本机健康检查失败');
  }
  if (input.capability === 'media' && (!runtime.tunnelAvailable || !input.mediaTransportAvailable)) {
    return denied(provider, 'transport_unavailable', '公司供应商的受控媒体传输尚未就绪');
  }
  return { allowed: true, code: 'ready', executionScope: 'company', message: '公司供应商运行环境可用' };
}

export class ProviderExecutionGateError extends Error {
  readonly code: Exclude<ProviderExecutionGateCode, 'ready'>;
  readonly executionScope: ProviderExecutionScope;

  constructor(
    code: Exclude<ProviderExecutionGateCode, 'ready'>,
    message: string,
    executionScope: ProviderExecutionScope,
  ) {
    super(message);
    this.name = 'ProviderExecutionGateError';
    this.code = code;
    this.executionScope = executionScope;
  }
}

/**
 * I/O 包装：只有 company scope 才会执行只读本机健康检查。
 * 这不会探测公司中转站、模型或腾讯云，也不会发起真实供应商请求。
 */
export async function assertProviderExecutionAvailable(
  provider: ProviderExecutionIdentity,
  options: AssertProviderExecutionAvailableOptions,
): Promise<void> {
  const preflight = evaluateProviderExecutionGate({
    provider,
    capability: options.capability,
    mediaTransportAvailable: options.mediaTransportAvailable,
  });
  if (provider.executionScope === 'external') {
    if (!preflight.allowed) {
      throw new ProviderExecutionGateError(preflight.code, preflight.message, preflight.executionScope);
    }
    return;
  }
  // company 且运行状态尚未注入时，runtime_not_configured 只是“需要继续检查”；
  // 供应商自身停用、缺配置或路由非法则必须在读取 sidecar 前直接失败。
  if (!preflight.allowed && preflight.code !== 'runtime_not_configured') {
    throw new ProviderExecutionGateError(preflight.code, preflight.message, preflight.executionScope);
  }
  const companyRuntime = provider.executionScope === 'company'
    ? await (options.inspectRuntime ?? inspectCompanyProviderRuntime)({ root: options.root ?? dataRoot() })
    : undefined;
  const result = evaluateProviderExecutionGate({
    provider,
    capability: options.capability,
    companyRuntime,
    mediaTransportAvailable: options.mediaTransportAvailable,
  });
  if (!result.allowed) {
    throw new ProviderExecutionGateError(result.code, result.message, result.executionScope);
  }
}
