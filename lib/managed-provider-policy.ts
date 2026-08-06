import { dataRoot } from './data-root.ts';
import { isManagedDeployment } from './managed-deployment.ts';
import { readProvisioningState } from './provisioning/service.ts';
import type { ManagedProviderAllowlist } from './provisioning/types.ts';

export type ManagedProviderKind = 'image' | 'script' | 'video' | 'tts';

/** Stable response body used by every managed provider CRUD guard. */
export function managedProviderReadOnlyBody(): { error: string; code: 'managed_provider_read_only' } {
  return {
    error: '\u53d7\u7ba1\u5b89\u88c5\u7248\u53ea\u80fd\u901a\u8fc7\u7edf\u4e00\u914d\u7f6e\u5bfc\u5165\u66f4\u65b0\u4f9b\u5e94\u5546',
    code: 'managed_provider_read_only',
  };
}

/** Return the read-only denial body only in managed mode; unrestricted is null. */
export function managedProviderMutationResponse(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof managedProviderReadOnlyBody> | null {
  return isManagedDeployment(env) ? managedProviderReadOnlyBody() : null;
}

/**
 * The policy deliberately accepts only the provider fields it needs. Database
 * rows may carry many more fields, but those fields are not trusted by this
 * boundary and are ignored.
 */
export interface ManagedProviderIdentity {
  id: string;
  type: string;
  baseUrl: string;
  apiStyle?: string;
  executionScope?: string;
  apiKeyEnv?: string;
  keyEnv?: string;
}

export type ManagedProviderPolicyCode =
  | 'managed_state_missing'
  | 'managed_provider_not_allowed'
  | 'managed_provider_role_invalid';

export type ManagedProviderPolicyVerdict =
  | { allowed: true; mode: 'unrestricted' | 'managed' }
  | {
    allowed: false;
    code: ManagedProviderPolicyCode;
    message: string;
  };

export interface EvaluateManagedProviderInput {
  managed: boolean;
  kind: ManagedProviderKind;
  allowlist?: ManagedProviderAllowlist | null;
  provider: ManagedProviderIdentity;
}

export interface ManagedProviderPolicyOptions {
  env?: NodeJS.ProcessEnv;
}

const COMPANY_GATEWAY_KEY_ENV = 'CREATIVE_STUDIO_GATEWAY_API_KEY';
const DOUBAO_TTS_KEY_ENV = 'DOUBAO_TTS_API_KEY';
const SCRIPT_PROTOCOLS = new Set([
  'openai-compatible',
  'openai-responses',
  'anthropic-messages',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SAFE_PROVIDER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const ROLE_INVALID_MESSAGE = '该供应商不符合公司受管配置';
const STATE_MISSING_MESSAGE = '公司受管配置尚未导入';
const NOT_ALLOWED_MESSAGE = '该供应商不在公司受管配置中';

function denied(
  code: ManagedProviderPolicyCode,
): Extract<ManagedProviderPolicyVerdict, { allowed: false }> {
  const message = code === 'managed_state_missing'
    ? STATE_MISSING_MESSAGE
    : code === 'managed_provider_not_allowed'
      ? NOT_ALLOWED_MESSAGE
      : ROLE_INVALID_MESSAGE;
  return { allowed: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProviderKind(value: unknown): value is ManagedProviderKind {
  return value === 'image' || value === 'script' || value === 'video' || value === 'tts';
}

function isValidProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && SAFE_PROVIDER_ID.test(value);
}

function isValidProviderIdArray(value: unknown, minLength: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) return false;
  const seen = new Set<string>();
  for (const id of value) {
    if (!isValidProviderId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * A state object normally comes from readProvisioningState, which already
 * validates this shape. The policy repeats the complete guard so callers
 * cannot accidentally bypass a malformed role by requesting another role.
 */
function isValidManagedAllowlist(value: unknown): value is ManagedProviderAllowlist {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.every((key) => (
    key === 'image' || key === 'script' || key === 'video' || key === 'tts'
  ))) return false;
  if (!isValidProviderIdArray(value.image, 1, 1)) return false;
  if (!isValidProviderIdArray(value.script, 1, 1)) return false;
  if (!isValidProviderIdArray(value.video, 1, 8)) return false;
  return Array.isArray(value.tts)
    && value.tts.length === 1
    && value.tts[0] === 'doubao-seed-tts-2';
}

function providerId(provider: unknown): string | null {
  if (!isRecord(provider) || typeof provider.id !== 'string') return null;
  return provider.id;
}

function hasRequiredProviderStrings(provider: unknown): provider is ManagedProviderIdentity {
  if (!isRecord(provider)) return false;
  return typeof provider.id === 'string'
    && provider.id.trim() === provider.id
    && provider.id.length > 0
    && typeof provider.type === 'string'
    && provider.type.trim() === provider.type
    && provider.type.length > 0
    && typeof provider.baseUrl === 'string'
    && provider.baseUrl.trim() === provider.baseUrl
    && provider.baseUrl.length > 0;
}

function hasForbiddenRawUrlSyntax(value: string): boolean {
  // URL normalizes a bare trailing '?'/'#' away, so inspect the original
  // spelling before relying on URL.search/URL.hash.
  if (value.includes('?') || value.includes('#')) return true;

  // Only an '@' in the authority is userinfo. Colons in an IPv6 authority
  // are valid and must not be treated as credentials.
  const schemeSeparator = value.indexOf('://');
  if (schemeSeparator < 0) return false;
  const authorityStart = schemeSeparator + 3;
  const pathStart = value.indexOf('/', authorityStart);
  const authorityEnd = pathStart < 0 ? value.length : pathStart;
  return value.slice(authorityStart, authorityEnd).includes('@');
}

function isSafeUrl(value: string, protocol: 'http:' | 'https:', loopbackOnly: boolean, paths?: readonly string[]): boolean {
  if (hasForbiddenRawUrlSyntax(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== protocol || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (loopbackOnly && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  if (paths && !paths.includes(parsed.pathname)) return false;
  return true;
}

function isOfficialDoubaoTtsUrl(value: string): boolean {
  if (!isSafeUrl(value, 'https:', false, ['/', '/api/v3/tts/unidirectional'])) return false;
  try {
    return new URL(value).origin === 'https://openspeech.bytedance.com';
  } catch {
    return false;
  }
}

function hasValidRoleShape(
  kind: ManagedProviderKind,
  provider: unknown,
): provider is ManagedProviderIdentity {
  if (!hasRequiredProviderStrings(provider)) return false;
  const candidate = provider;
  switch (kind) {
    case 'image':
      return candidate.type === 'gateway-task-image'
        && candidate.apiKeyEnv === COMPANY_GATEWAY_KEY_ENV
        && isSafeUrl(candidate.baseUrl, 'http:', true);
    case 'script':
      return candidate.executionScope === 'company'
        && typeof candidate.apiStyle === 'string'
        && candidate.type === candidate.apiStyle
        && SCRIPT_PROTOCOLS.has(candidate.type)
        && isSafeUrl(candidate.baseUrl, 'http:', true);
    case 'video':
      return candidate.type === 'openai-video'
        && candidate.apiKeyEnv === COMPANY_GATEWAY_KEY_ENV
        && isSafeUrl(candidate.baseUrl, 'http:', true);
    case 'tts':
      return candidate.id === 'doubao-seed-tts-2'
        && candidate.type === 'doubao-http-chunked'
        && candidate.keyEnv === DOUBAO_TTS_KEY_ENV
        && isOfficialDoubaoTtsUrl(candidate.baseUrl);
    default:
      return false;
  }
}

/**
 * Pure role and identity policy. In unrestricted mode this returns before
 * reading or validating any allowlist/provider fields, preserving development
 * mode behavior even for legacy rows.
 */
export function evaluateManagedProvider(input: EvaluateManagedProviderInput): ManagedProviderPolicyVerdict {
  if (!input.managed) return { allowed: true, mode: 'unrestricted' };

  const candidateAllowlist = input.allowlist;
  if (!isProviderKind(input.kind) || !isValidManagedAllowlist(candidateAllowlist)) {
    return denied('managed_state_missing');
  }

  const id = providerId(input.provider);
  const ids: readonly string[] = candidateAllowlist[input.kind];
  if (!id || !ids.includes(id)) return denied('managed_provider_not_allowed');

  if (!hasValidRoleShape(input.kind, input.provider)) return denied('managed_provider_role_invalid');
  return { allowed: true, mode: 'managed' };
}

export class ManagedProviderPolicyError extends Error {
  readonly code: ManagedProviderPolicyCode;
  readonly kind: ManagedProviderKind;

  constructor(code: ManagedProviderPolicyCode, kind: ManagedProviderKind, message: string) {
    super(message);
    this.name = 'ManagedProviderPolicyError';
    this.code = code;
    this.kind = kind;
  }
}

function isManagedForHelper(options?: ManagedProviderPolicyOptions): boolean {
  return isManagedDeployment(options?.env ?? process.env);
}

export function assertManagedProviderAllowed(
  kind: ManagedProviderKind,
  provider: ManagedProviderIdentity,
  allowlist: ManagedProviderAllowlist | null | undefined,
  options?: ManagedProviderPolicyOptions,
): void;
export function assertManagedProviderAllowed(
  kind: ManagedProviderKind,
  provider: ManagedProviderIdentity,
  allowlist: ManagedProviderAllowlist | null | undefined,
  options?: ManagedProviderPolicyOptions,
): void {
  const input: EvaluateManagedProviderInput = {
    kind,
    provider,
    allowlist,
    managed: isManagedForHelper(options),
  };
  const verdict = evaluateManagedProvider(input);
  if (!verdict.allowed) throw new ManagedProviderPolicyError(verdict.code, kind, verdict.message);
}

export function filterManagedProviders<T extends ManagedProviderIdentity>(
  kind: ManagedProviderKind,
  providers: T[],
  allowlist: ManagedProviderAllowlist | null | undefined,
  options?: ManagedProviderPolicyOptions,
): T[];
export function filterManagedProviders<T extends ManagedProviderIdentity>(
  kind: ManagedProviderKind,
  providers: T[],
  allowlist: ManagedProviderAllowlist | null | undefined,
  options?: ManagedProviderPolicyOptions,
): T[] {
  if (!isManagedForHelper(options)) return providers;
  return providers.filter((provider) => evaluateManagedProvider({
    managed: true,
    kind,
    allowlist,
    provider,
  }).allowed);
}

/** Read the sole authoritative v2 allowlist and isolate the caller from it. */
export function loadManagedProviderAllowlist(root = dataRoot()): ManagedProviderAllowlist | null {
  const state = readProvisioningState(root);
  if (!state) return null;
  return {
    image: state.managedProviders.image.slice(),
    script: state.managedProviders.script.slice(),
    video: state.managedProviders.video.slice(),
    tts: ['doubao-seed-tts-2'],
  };
}
