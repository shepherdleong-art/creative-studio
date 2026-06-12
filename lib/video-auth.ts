type EnvMap = Record<string, string | undefined>;

export interface KlingCredentialPair {
  accessKey: string;
  secretKey: string;
  source: 'split-env' | 'legacy-combined';
}

export interface VideoProviderEnvConfig {
  type: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
}

function readEnv(env: EnvMap, name: string): string {
  return (env[name] || '').trim();
}

export function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized.includes('example.com') || normalized.includes('your-');
}

export function resolveKlingCredentialPair(
  env: EnvMap = process.env,
  legacyApiKeyEnv = 'KLING_VIDEO_API_KEY'
): KlingCredentialPair | null {
  const accessKey = readEnv(env, 'KLING_VIDEO_ACCESS_KEY');
  const secretKey = readEnv(env, 'KLING_VIDEO_SECRET_KEY');

  if (accessKey || secretKey) {
    if (!accessKey || !secretKey) {
      throw new Error('Set both KLING_VIDEO_ACCESS_KEY and KLING_VIDEO_SECRET_KEY for Kling video.');
    }
    return { accessKey, secretKey, source: 'split-env' };
  }

  const legacyApiKey = readEnv(env, legacyApiKeyEnv);
  if (!legacyApiKey) return null;

  const separatorIndex = legacyApiKey.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === legacyApiKey.length - 1) return null;

  return {
    accessKey: legacyApiKey.slice(0, separatorIndex).trim(),
    secretKey: legacyApiKey.slice(separatorIndex + 1).trim(),
    source: 'legacy-combined',
  };
}

export function getVideoProviderConfigState(
  provider: VideoProviderEnvConfig,
  env: EnvMap = process.env
): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  const baseUrl = readEnv(env, provider.baseUrlEnv);

  if (isPlaceholderValue(baseUrl)) missing.push(provider.baseUrlEnv);

  if (provider.type === 'kling') {
    try {
      const pair = resolveKlingCredentialPair(env, provider.apiKeyEnv);
      if (!pair) missing.push('KLING_VIDEO_ACCESS_KEY/KLING_VIDEO_SECRET_KEY');
    } catch {
      missing.push('KLING_VIDEO_ACCESS_KEY/KLING_VIDEO_SECRET_KEY');
    }
  } else {
    const apiKey = readEnv(env, provider.apiKeyEnv);
    if (isPlaceholderValue(apiKey)) missing.push(provider.apiKeyEnv);
  }

  return { configured: missing.length === 0, missing };
}
