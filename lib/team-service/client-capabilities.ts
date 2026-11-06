import { TeamAuthError } from './auth/types.ts';
import type { ServerRuntimeConfig } from './config.ts';
import { getTeamRuntimeState } from './runtime/state.ts';

export const TEAM_CLIENT_API_VERSION = 1;
export const DEFAULT_TEAM_CLIENT_RANGE = '>=0.7.0 <1.0.0';

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

function compare(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function satisfiesClientRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed || !range.trim() || range.length > 200) return false;
  for (const clause of range.trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!match) return false;
    const boundary = parseVersion(match[2]);
    if (!boundary) return false;
    const result = compare(parsed, boundary);
    const operator = match[1] ?? '=';
    if (operator === '>=' && result < 0) return false;
    if (operator === '<=' && result > 0) return false;
    if (operator === '>' && result <= 0) return false;
    if (operator === '<' && result >= 0) return false;
    if (operator === '=' && result !== 0) return false;
  }
  return true;
}

export function supportedClientRange(env: Record<string, string | undefined> = process.env): string {
  return env.CREATIVE_STUDIO_CLIENT_SUPPORTED_RANGE?.trim() || DEFAULT_TEAM_CLIENT_RANGE;
}

function controlledUpdate(env: Record<string, string | undefined>): { manifestUrl: string } | null {
  const value = env.CREATIVE_STUDIO_CLIENT_UPDATE_MANIFEST_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return { manifestUrl: url.href };
  } catch {
    return null;
  }
}

export function clientCompatibility(
  version: string | null,
  apiVersion: string | null,
  env: Record<string, string | undefined> = process.env,
): { compatible: boolean; reason?: 'client_update_required'; update?: { manifestUrl: string } } {
  if (version === null && apiVersion === null) return { compatible: true };
  const compatible = version !== null && apiVersion === String(TEAM_CLIENT_API_VERSION)
    && satisfiesClientRange(version, supportedClientRange(env));
  if (compatible) return { compatible: true };
  const update = controlledUpdate(env);
  return { compatible: false, reason: 'client_update_required', ...(update ? { update } : {}) };
}

export function assertCompatibleClientWrite(request: Request): void {
  const version = request.headers.get('x-creative-studio-client-version');
  const apiVersion = request.headers.get('x-creative-studio-client-api');
  if (version === null && apiVersion === null) return;
  if (!clientCompatibility(version, apiVersion).compatible) {
    throw new TeamAuthError('client_update_required', '客户端版本不再受支持，请先修复并更新客户端。', 426);
  }
}

export function teamClientCapabilities(
  config: ServerRuntimeConfig,
  request: Request,
): Record<string, unknown> {
  const compatibility = clientCompatibility(
    request.headers.get('x-creative-studio-client-version'),
    request.headers.get('x-creative-studio-client-api'),
  );
  if (compatibility.update) {
    try {
      if (new URL(compatibility.update.manifestUrl).origin !== new URL(config.trustedOrigin).origin) {
        delete compatibility.update;
      }
    } catch { delete compatibility.update; }
  }
  return {
    deploymentId: config.deploymentId,
    apiVersion: TEAM_CLIENT_API_VERSION,
    supportedClientRange: supportedClientRange(),
    uploadConstraints: {
      partSize: 8 * 1024 * 1024,
      maxFilesPerBatch: 100,
      maxFileSize: 1024 * 1024 * 1024 * 1024,
    },
    maintenance: getTeamRuntimeState().maintenance,
    ...compatibility,
  };
}
