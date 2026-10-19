type EnvMap = Record<string, string | undefined>;

export interface KlingCredentialPair {
  accessKey: string;
  secretKey: string;
  source: 'split-db' | 'legacy-combined';
}

export interface VideoProviderEnvConfig {
  type: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  id?: string;
  name?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  modelEnv?: string;
  defaultModel?: string;
  defaultDurationSec?: number;
  enabled?: number | boolean;
}

export function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes('example.com')) return true;
  // Match "your-" when NOT preceded by a letter or hyphen — prevents false
  // positives on compound tokens like "sk-your-key" or "get-your-data".
  if (/(?<![a-zA-Z-])your-/i.test(normalized)) return true;
  return false;
}

export function resolveKlingCredentialPair(
  _env: EnvMap = process.env,
  _legacyApiKeyEnv = 'KLING_VIDEO_API_KEY',
  dbCredentials?: { accessKey?: string | null; secretKey?: string | null; apiKey?: string | null }
): KlingCredentialPair | null {
  void _env;
  void _legacyApiKeyEnv;
  const dbAccessKey = (dbCredentials?.accessKey || '').trim();
  const dbSecretKey = (dbCredentials?.secretKey || '').trim();

  if (dbAccessKey || dbSecretKey) {
    if (!dbAccessKey || !dbSecretKey) {
      throw new Error('Set both KLING_VIDEO_ACCESS_KEY and KLING_VIDEO_SECRET_KEY for Kling video.');
    }
    return { accessKey: dbAccessKey, secretKey: dbSecretKey, source: 'split-db' };
  }

  const dbLegacyApiKey = (dbCredentials?.apiKey || '').trim();
  if (dbLegacyApiKey) {
    const separatorIndex = dbLegacyApiKey.indexOf(':');
    if (separatorIndex > 0 && separatorIndex < dbLegacyApiKey.length - 1) {
      return {
        accessKey: dbLegacyApiKey.slice(0, separatorIndex).trim(),
        secretKey: dbLegacyApiKey.slice(separatorIndex + 1).trim(),
        source: 'legacy-combined',
      };
    }
  }

  if (dbCredentials) return null;
  return null;
}

export function getVideoProviderConfigState(
  provider: VideoProviderEnvConfig,
  env: EnvMap = process.env
): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  const baseUrl = (provider.baseUrl || '').trim();

  if (isPlaceholderValue(baseUrl)) missing.push('Base URL');

  if (provider.type === 'kling') {
    try {
      const pair = resolveKlingCredentialPair(env, provider.apiKeyEnv, provider);
      if (!pair) missing.push('Access Key/Secret Key');
    } catch {
      missing.push('Access Key/Secret Key');
    }
  } else {
    const apiKey = (provider.apiKey || '').trim();
    if (isPlaceholderValue(apiKey)) missing.push('API Key');
  }

  return { configured: missing.length === 0, missing };
}

export interface VideoProviderRuntimeConfig {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  accessKey: string;
  secretKey: string;
  model: string;
  durationSec: number;
  enabled: boolean;
  configured: boolean;
  missing: string[];
  hasApiKey: boolean;
}

export function resolveVideoProviderRuntimeConfig(
  provider: VideoProviderEnvConfig,
  env: EnvMap = process.env
): VideoProviderRuntimeConfig {
  const baseUrl = (provider.baseUrl || '').trim();
  const model = (provider.defaultModel || '').trim();
  const durationSec = Number(provider.defaultDurationSec || 5);
  const enabled = typeof provider.enabled === 'boolean' ? provider.enabled : provider.enabled !== 0;
  let apiKey = (provider.apiKey || '').trim();
  let accessKey = (provider.accessKey || '').trim();
  let secretKey = (provider.secretKey || '').trim();

  if (provider.type === 'kling') {
    const pair = resolveKlingCredentialPair(env, provider.apiKeyEnv, provider);
    if (pair) {
      accessKey = pair.accessKey;
      secretKey = pair.secretKey;
      apiKey = '';
    }
  }

  const state = getVideoProviderConfigState(provider, env);

  return {
    id: provider.id || '',
    name: provider.name || '',
    type: provider.type,
    baseUrl,
    apiKey: provider.type === 'kling' ? '' : apiKey,
    accessKey,
    secretKey,
    model,
    durationSec,
    enabled,
    configured: state.configured,
    missing: state.missing,
    hasApiKey: provider.type === 'kling'
      ? Boolean(accessKey && secretKey)
      : Boolean(apiKey && !isPlaceholderValue(apiKey)),
  };
}
