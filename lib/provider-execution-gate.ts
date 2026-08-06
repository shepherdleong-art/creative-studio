import { dataRoot } from './data-root.ts';
import {
  inspectCompanyProviderRuntime,
  type CompanyProviderRuntimeStatus,
  type InspectCompanyProviderRuntimeOptions,
} from './company-provider-runtime.ts';
import { isManagedDeployment } from './managed-deployment.ts';
import {
  evaluateManagedProvider,
  loadManagedProviderAllowlist,
  type ManagedProviderKind,
} from './managed-provider-policy.ts';
import { readProvisioningState } from './provisioning/service.ts';
import type { ManagedProviderAllowlist } from './provisioning/types.ts';
import type { ProviderExecutionScope } from './script-providers/types.ts';

export type ProviderExecutionCapability = 'model' | 'media';

export type ProviderExecutionGateCode =
  | 'ready'
  | 'managed_workbench_locked'
  | 'managed_provider_not_allowed'
  | 'managed_provider_role_invalid'
  | 'provider_disabled'
  | 'provider_unconfigured'
  | 'provider_route_invalid'
  | 'runtime_not_configured'
  | 'runtime_stopped'
  | 'runtime_unavailable'
  | 'transport_unavailable';

/** Identity projection used at execution boundaries. */
export interface ProviderExecutionIdentity {
  id: string;
  executionScope: ProviderExecutionScope;
  baseUrl: string;
  enabled: boolean;
  configured: boolean;
  type?: string;
  apiStyle?: string;
  apiKeyEnv?: string;
  keyEnv?: string;
  /** Runtime values are included only at execution boundaries; never log them. */
  apiKey?: string;
  model?: string;
  /** Stable non-secret adapter/config fields captured for a managed run. */
  configSignature?: string | null;
  /** Non-secret provisioning generation captured for a managed execution. */
  managedGeneration?: string | null;
}

const EXECUTION_IDENTITY_FIELDS = [
  'id', 'type', 'apiStyle', 'executionScope', 'baseUrl', 'apiKeyEnv', 'keyEnv',
  'apiKey', 'model', 'enabled', 'configured', 'configSignature', 'managedGeneration',
] as const;

/**
 * Return the non-secret generation of the authoritative managed provisioning
 * state. A missing or invalid state returns null; managed execution itself is
 * still denied by the readiness/allowlist gate, while a run that began with a
 * valid generation will fail closed if the state disappears or changes.
 */
export function readManagedExecutionGeneration(root = dataRoot()): string | null {
  const state = readProvisioningState(root);
  return state ? `${state.importedAt}|${state.configHash}` : null;
}

/**
 * Compare a queued execution identity with the current provider row. Managed
 * runs must not continue with a stale key, route, role, or model after a
 * same-id provisioning rotation. The message deliberately contains no field
 * values, paths, or credentials.
 */
export function assertProviderExecutionIdentityStable(
  previous: ProviderExecutionIdentity,
  current: ProviderExecutionIdentity,
): void {
  for (const field of EXECUTION_IDENTITY_FIELDS) {
    if ((previous[field] ?? null) !== (current[field] ?? null)) {
      throw new ProviderExecutionGateError(
        'managed_provider_not_allowed',
        '\u53d7\u7ba1\u4f9b\u5e94\u5546\u914d\u7f6e\u5df2\u53d8\u66f4\uff0c\u8bf7\u91cd\u8bd5',
        current.executionScope,
      );
    }
  }
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
  /** Only a real task-level MediaTransport may set this to true. */
  mediaTransportAvailable?: boolean;
  /** Managed mode is derived from the exact env flag when omitted. */
  managed?: boolean;
  env?: NodeJS.ProcessEnv;
  kind?: ManagedProviderKind;
  allowlist?: ManagedProviderAllowlist | null;
}

type RuntimeInspector = (
  options: InspectCompanyProviderRuntimeOptions,
) => Promise<CompanyProviderRuntimeStatus>;

export interface AssertProviderExecutionAvailableOptions {
  root?: string;
  capability: ProviderExecutionCapability;
  mediaTransportAvailable?: boolean;
  inspectRuntime?: RuntimeInspector;
  companyRuntime?: CompanyProviderRuntimeStatus;
  /** Explicit role and allowlist seams keep queue checks tied to job identity. */
  kind?: ManagedProviderKind;
  allowlist?: ManagedProviderAllowlist | null;
  env?: NodeJS.ProcessEnv;
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
      && (parsed.hostname === '127.0.0.1'
        || parsed.hostname === '[::1]'
        || parsed.hostname === 'localhost'
        || parsed.hostname === '::1');
  } catch {
    return false;
  }
}

function inferManagedProviderKind(provider: ProviderExecutionIdentity): ManagedProviderKind | undefined {
  switch (provider.type) {
    case 'gateway-task-image':
      return 'image';
    case 'openai-video':
      return 'video';
    case 'doubao-http-chunked':
      return 'tts';
    case 'openai-compatible':
    case 'openai-responses':
    case 'anthropic-messages':
      return 'script';
    default:
      return provider.executionScope === 'company' ? 'script' : undefined;
  }
}

function managedLockMessage(runtime?: CompanyProviderRuntimeStatus): string {
  return runtime?.reason || '受管工作台尚未就绪，无法执行生产';
}

function evaluateManagedBoundary(
  input: EvaluateProviderExecutionGateInput,
  managed: boolean,
): ProviderExecutionGateResult | null {
  if (!managed) return null;

  // A managed install is globally locked until its controlled sidecar is
  // healthy. This precedes provider-specific checks so no hidden provider can
  // bypass a starting or failed workbench.
  const runtime = input.companyRuntime;
  if (!runtime || runtime.status !== 'ready' || !runtime.proxyAvailable) {
    return denied(input.provider, 'managed_workbench_locked', managedLockMessage(runtime));
  }

  const kind = input.kind ?? inferManagedProviderKind(input.provider);
  if (!kind) {
    return denied(input.provider, 'managed_provider_role_invalid', '供应商不符合公司受管配置');
  }

  const verdict = evaluateManagedProvider({
    managed: true,
    kind,
    allowlist: input.allowlist,
    provider: {
      id: input.provider.id,
      type: input.provider.type ?? '',
      baseUrl: input.provider.baseUrl,
      apiStyle: input.provider.apiStyle,
      executionScope: input.provider.executionScope,
      apiKeyEnv: input.provider.apiKeyEnv,
      keyEnv: input.provider.keyEnv,
    },
  });
  if (!verdict.allowed) {
    if (verdict.code === 'managed_state_missing') {
      return denied(input.provider, 'managed_workbench_locked', verdict.message);
    }
    return denied(input.provider, verdict.code, verdict.message);
  }
  return null;
}

/** Pure gate used by route/queue tests. It performs no I/O. */
export function evaluateProviderExecutionGate(
  input: EvaluateProviderExecutionGateInput,
): ProviderExecutionGateResult {
  const managed = input.managed ?? isManagedDeployment(input.env ?? process.env);
  const managedDenied = evaluateManagedBoundary(input, managed);
  if (managedDenied) return managedDenied;

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
  if (input.capability === 'media' && !input.mediaTransportAvailable) {
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

/** Read-only execution preflight. No upstream model probe is ever performed. */
export async function assertProviderExecutionAvailable(
  provider: ProviderExecutionIdentity,
  options: AssertProviderExecutionAvailableOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const managed = isManagedDeployment(env);
  const root = options.root ?? dataRoot();

  if (managed) {
    let companyRuntime: CompanyProviderRuntimeStatus;
    let allowlist: ManagedProviderAllowlist | null | undefined;
    try {
      companyRuntime = options.companyRuntime ?? await (options.inspectRuntime ?? inspectCompanyProviderRuntime)({
        root,
        managed: true,
      });
      allowlist = options.allowlist === undefined
        ? loadManagedProviderAllowlist(root)
        : options.allowlist;
    } catch {
      throw new ProviderExecutionGateError(
        'managed_workbench_locked',
        '\u53d7\u7ba1\u5de5\u4f5c\u53f0\u5c1a\u672a\u5c31\u7eea\uff0c\u65e0\u6cd5\u6267\u884c\u751f\u4ea7',
        provider.executionScope,
      );
    }
    const result = evaluateProviderExecutionGate({
      provider,
      capability: options.capability,
      mediaTransportAvailable: options.mediaTransportAvailable,
      managed: true,
      kind: options.kind,
      allowlist,
      companyRuntime,
    });
    if (!result.allowed) {
      throw new ProviderExecutionGateError(result.code, result.message, result.executionScope);
    }
    return;
  }

  const preflight = evaluateProviderExecutionGate({
    provider,
    capability: options.capability,
    mediaTransportAvailable: options.mediaTransportAvailable,
    managed: false,
  });
  if (provider.executionScope === 'external') {
    if (!preflight.allowed) {
      throw new ProviderExecutionGateError(preflight.code, preflight.message, preflight.executionScope);
    }
    return;
  }

  // In developer mode a missing runtime is checked by the I/O inspector so
  // old local provider rows retain their historical behavior.
  if (!preflight.allowed && preflight.code !== 'runtime_not_configured') {
    throw new ProviderExecutionGateError(preflight.code, preflight.message, preflight.executionScope);
  }
  const companyRuntime = options.companyRuntime ?? await (options.inspectRuntime ?? inspectCompanyProviderRuntime)({ root });
  const result = evaluateProviderExecutionGate({
    provider,
    capability: options.capability,
    mediaTransportAvailable: options.mediaTransportAvailable,
    managed: false,
    companyRuntime,
  });
  if (!result.allowed) {
    throw new ProviderExecutionGateError(result.code, result.message, result.executionScope);
  }
}
