import { dataRoot } from './data-root.ts';
import {
  inspectCompanyProviderRuntime,
  invalidateCompanyProviderRuntimeInspection,
  COMPANY_PROVIDER_SAFE_REASONS,
  type CompanyProviderRuntimeStatus,
  type InspectCompanyProviderRuntimeOptions,
} from './company-provider-runtime.ts';
import { isManagedDeployment, type ManagedWorkbenchPhase } from './managed-deployment.ts';
import { readProvisioningState } from './provisioning/service.ts';
import type { ProvisioningStateV2 } from './provisioning/types.ts';

export type { ManagedWorkbenchPhase } from './managed-deployment.ts';

export interface ManagedWorkbenchStatus {
  managed: boolean;
  phase: ManagedWorkbenchPhase;
  configured: boolean;
  profileName: string | null;
  importedAt: string | null;
  configHashPrefix: string | null;
  proxyAvailable: boolean;
  reason: string;
}

export type ManagedWorkbenchStateReader = (root: string) => unknown | Promise<unknown>;
export type ManagedWorkbenchRuntimeInspector = (
  options: InspectCompanyProviderRuntimeOptions,
) => CompanyProviderRuntimeStatus | Promise<CompanyProviderRuntimeStatus>;

export interface InspectManagedWorkbenchOptions {
  /** Test-only root; production defaults to dataRoot(). */
  root?: string;
  /** Test-only environment object; production defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Test-only injection of the authoritative provisioning-state reader. */
  readState?: ManagedWorkbenchStateReader;
  /** Alias accepted for tests that name the dependency after its source API. */
  readProvisioningState?: ManagedWorkbenchStateReader;
  /** Alias accepted by tests that provide a generic state reader. */
  stateReader?: ManagedWorkbenchStateReader;
  /** Test-only runtime inspection injection. */
  inspectRuntime?: ManagedWorkbenchRuntimeInspector;
  /** Alias accepted by integration tests and service callers. */
  runtimeInspector?: ManagedWorkbenchRuntimeInspector;
}

const UNRESTRICTED_REASON = '开发模式不受公司网关限制';
const UNCONFIGURED_REASON = '请先导入公司配置';

/**
 * The managed runtime inspect shells out to PowerShell/CIM via spawnSync,
 * which blocks the whole event loop for seconds on a real machine. A 1 s UI
 * poll would otherwise pile up queued inspects faster than they finish and
 * wedge the server. Coalesce concurrent production inspects and reuse the
 * result for a short TTL. Test-injected calls always bypass both mechanisms.
 */
const PRODUCTION_INSPECT_TTL_MS = 2500;
const productionInspectCache = new Map<string, { at: number; status: ManagedWorkbenchStatus }>();
const productionInspectInFlight = new Map<string, Promise<ManagedWorkbenchStatus>>();

/** Drop the cached production verdict, e.g. right after a provision import. */
export function invalidateManagedWorkbenchStatus(root?: string): void {
  invalidateCompanyProviderRuntimeInspection(root);
  if (root) {
    productionInspectCache.delete(root);
    return;
  }
  productionInspectCache.clear();
}

/** Test-only hook to reset memoization between scenarios. */
export function resetManagedWorkbenchInspectMemoForTests(): void {
  productionInspectCache.clear();
  productionInspectInFlight.clear();
}

function statusBase(managed: boolean, phase: ManagedWorkbenchPhase, reason: string): ManagedWorkbenchStatus {
  return {
    managed,
    phase,
    configured: false,
    profileName: null,
    importedAt: null,
    configHashPrefix: null,
    proxyAvailable: false,
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9](?:[a-z0-9._-]{0,63})$/.test(value);
}

function isValidProvisioningState(value: unknown): value is ProvisioningStateV2 {
  if (!isRecord(value)
    || Object.keys(value).length !== 5
    || value.schemaVersion !== 2
    || typeof value.profileName !== 'string'
    || value.profileName.length < 1
    || value.profileName.length > 128
    || value.profileName.trim() !== value.profileName
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.profileName)
    || typeof value.importedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.importedAt)
    || Number.isNaN(new Date(value.importedAt).getTime())
    || new Date(value.importedAt).toISOString() !== value.importedAt
    || typeof value.configHash !== 'string'
    || !/^[a-f0-9]{64}$/i.test(value.configHash)
    || !isRecord(value.managedProviders)
    || Object.keys(value.managedProviders).length !== 4) {
    return false;
  }
  const allowlist = value.managedProviders;
  const arrays: Array<[unknown, number, number]> = [
    [allowlist.image, 1, 1],
    [allowlist.script, 1, 1],
    [allowlist.video, 1, 8],
  ];
  for (const [candidate, min, max] of arrays) {
    if (!Array.isArray(candidate) || candidate.length < min || candidate.length > max
      || !candidate.every((id) => isValidId(id)) || new Set(candidate).size !== candidate.length) return false;
  }
  return Array.isArray(allowlist.tts)
    && allowlist.tts.length === 1
    && allowlist.tts[0] === 'doubao-seed-tts-2';
}

function configuredStatus(state: ProvisioningStateV2, phase: ManagedWorkbenchPhase, reason: string, proxyAvailable = false): ManagedWorkbenchStatus {
  return {
    managed: true,
    phase,
    configured: true,
    profileName: state.profileName,
    importedAt: state.importedAt,
    configHashPrefix: state.configHash.slice(0, 12).toLowerCase(),
    proxyAvailable,
    reason,
  };
}

function runtimeSafeReason(runtime: CompanyProviderRuntimeStatus, fallback: string): string {
  const known = Object.values(COMPANY_PROVIDER_SAFE_REASONS).find((reason) => reason === runtime.reason);
  return known || fallback;
}

async function readStateSafely(reader: ManagedWorkbenchStateReader, root: string): Promise<ProvisioningStateV2 | null> {
  try {
    const value = await reader(root);
    return isValidProvisioningState(value) ? {
      schemaVersion: 2,
      profileName: value.profileName,
      importedAt: value.importedAt,
      configHash: value.configHash.toLowerCase(),
      managedProviders: {
        image: value.managedProviders.image.slice(),
        script: value.managedProviders.script.slice(),
        video: value.managedProviders.video.slice(),
        tts: ['doubao-seed-tts-2'],
      },
    } : null;
  } catch {
    return null;
  }
}

/**
 * Compose the non-secret provisioning state with the local sidecar runtime.
 * The exact managed flag is checked before reading either dependency.
 */
export async function inspectManagedWorkbench(
  options: InspectManagedWorkbenchOptions = {},
): Promise<ManagedWorkbenchStatus> {
  const env = options.env ?? process.env;
  if (!isManagedDeployment(env as NodeJS.ProcessEnv)) return statusBase(false, 'unrestricted', UNRESTRICTED_REASON);

  const root = options.root ?? dataRoot();
  const hasTestInjection = Boolean(options.root || options.env || options.readState
    || options.readProvisioningState || options.stateReader || options.inspectRuntime || options.runtimeInspector);
  if (!hasTestInjection) {
    const cached = productionInspectCache.get(root);
    if (cached && Date.now() - cached.at < PRODUCTION_INSPECT_TTL_MS) return cached.status;
    const pending = productionInspectInFlight.get(root);
    if (pending) return pending;
    const shared = inspectManagedWorkbenchUncached(options)
      .then((status) => {
        productionInspectCache.set(root, { at: Date.now(), status });
        return status;
      })
      .finally(() => {
        if (productionInspectInFlight.get(root) === shared) productionInspectInFlight.delete(root);
      });
    productionInspectInFlight.set(root, shared);
    return shared;
  }
  return inspectManagedWorkbenchUncached(options);
}

async function inspectManagedWorkbenchUncached(
  options: InspectManagedWorkbenchOptions,
): Promise<ManagedWorkbenchStatus> {
  const root = options.root ?? dataRoot();
  const stateReader = options.readState ?? options.readProvisioningState ?? options.stateReader ?? ((stateRoot: string) => readProvisioningState(stateRoot));
  const state = await readStateSafely(stateReader, root);
  if (!state) return statusBase(true, 'unconfigured', UNCONFIGURED_REASON);

  const runtimeInspector = options.inspectRuntime ?? options.runtimeInspector ?? inspectCompanyProviderRuntime;
  let runtime: CompanyProviderRuntimeStatus;
  try {
    runtime = await runtimeInspector({ root, managed: true });
  } catch {
    return configuredStatus(state, 'failed', COMPANY_PROVIDER_SAFE_REASONS.start_failed);
  }

  if (runtime.status === 'starting') {
    return configuredStatus(state, 'starting', COMPANY_PROVIDER_SAFE_REASONS.starting, false);
  }
  if (runtime.status === 'ready' && runtime.proxyAvailable) {
    return configuredStatus(state, 'ready', COMPANY_PROVIDER_SAFE_REASONS.ready, true);
  }

  const fallback = runtime.status === 'not_configured'
    ? COMPANY_PROVIDER_SAFE_REASONS.runtime_missing
    : runtime.status === 'stopped'
      ? COMPANY_PROVIDER_SAFE_REASONS.process_exited
      : runtime.status === 'ready'
        ? COMPANY_PROVIDER_SAFE_REASONS.health_timeout
        : COMPANY_PROVIDER_SAFE_REASONS.start_failed;
  return configuredStatus(state, 'failed', runtimeSafeReason(runtime, fallback), false);
}

export class ManagedWorkbenchLockedError extends Error {
  readonly code = 'managed_workbench_locked' as const;
  readonly phase: Exclude<ManagedWorkbenchPhase, 'unrestricted' | 'ready'>;

  constructor(phase: Exclude<ManagedWorkbenchPhase, 'unrestricted' | 'ready'>) {
    super('请先导入公司配置并等待 LiteLLM 就绪');
    this.name = 'ManagedWorkbenchLockedError';
    this.phase = phase;
  }
}

export async function assertManagedWorkbenchReady(
  options: InspectManagedWorkbenchOptions = {},
): Promise<void> {
  const status = await inspectManagedWorkbench(options);
  if (status.phase === 'unrestricted' || status.phase === 'ready') return;
  throw new ManagedWorkbenchLockedError(status.phase);
}
