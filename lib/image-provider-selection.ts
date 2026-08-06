import type Database from 'better-sqlite3';
import {
  assertManagedProviderAllowed,
  loadManagedProviderAllowlist,
} from './managed-provider-policy.ts';
import { isManagedDeployment } from './managed-deployment.ts';

interface ImageProviderRow {
  id: string;
  apiKey: string;
  apiKeyEnv: string;
  enabled: number;
  model: string;
  type: string;
  baseUrl: string;
}

interface ImageProviderDefaults {
  providerId: string;
  model: string;
}

export interface ResolvedImageJobProvider {
  providerId: string;
  model: string;
}

function hasUsableKey(provider: ImageProviderRow): boolean {
  const stored = (provider.apiKey || '').trim();
  return !!stored && !isPlaceholderValue(stored);
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes('example.com')) return true;
  if (/(?<![a-zA-Z-])your-/i.test(normalized)) return true;
  return false;
}

function assertImageProviderPolicy(provider: ImageProviderRow): void {
  if (!isManagedDeployment()) return;
  assertManagedProviderAllowed(
    'image',
    {
      id: provider.id,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
    },
    loadManagedProviderAllowlist(),
  );
}

export function resolveImageJobProvider(
  db: Database.Database,
  requestedProviderId: unknown,
  defaults: ImageProviderDefaults
): ResolvedImageJobProvider {
  const providerId =
    typeof requestedProviderId === 'string' && requestedProviderId.trim()
      ? requestedProviderId.trim()
      : defaults.providerId;

  const provider = db.prepare(`
    SELECT id, apiKey, apiKeyEnv, enabled, model, type, baseUrl
    FROM providers
    WHERE id = ?
  `).get(providerId) as ImageProviderRow | undefined;

  if (!provider) throw new Error('供应商不存在');
  // Keep the exact provider identity selected by the caller. In managed mode
  // a rotated/hidden id must fail here rather than silently falling back.
  assertImageProviderPolicy(provider);
  if (!provider.enabled) throw new Error('供应商已禁用');
  if (!hasUsableKey(provider)) throw new Error('供应商 API Key 未配置');

  return {
    providerId: provider.id,
    model: provider.model || defaults.model,
  };
}

export function resolveRegenerateImageJobProvider(
  db: Database.Database,
  requestedProviderId: unknown,
  originalJob: ImageProviderDefaults
): ResolvedImageJobProvider {
  return resolveImageJobProvider(db, requestedProviderId, {
    providerId: originalJob.providerId,
    model: originalJob.model,
  });
}
