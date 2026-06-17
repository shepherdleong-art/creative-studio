import type Database from 'better-sqlite3';

interface ImageProviderRow {
  id: string;
  apiKey: string;
  apiKeyEnv: string;
  enabled: number;
  model: string;
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
  const fromEnv = (process.env[provider.apiKeyEnv] || '').trim();
  return (!!stored && !isPlaceholderValue(stored)) || (!!fromEnv && !isPlaceholderValue(fromEnv));
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes('example.com')) return true;
  if (/(?<![a-zA-Z-])your-/i.test(normalized)) return true;
  return false;
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
    SELECT id, apiKey, apiKeyEnv, enabled, model
    FROM providers
    WHERE id = ?
  `).get(providerId) as ImageProviderRow | undefined;

  if (!provider) throw new Error('供应商不存在');
  if (!provider.enabled) throw new Error('供应商已禁用');
  if (!hasUsableKey(provider)) throw new Error('供应商 API Key 未配置');

  return {
    providerId: provider.id,
    model: provider.model || defaults.model,
  };
}
