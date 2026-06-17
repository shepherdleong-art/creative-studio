import { getDb } from '@/lib/db';
import { seedScriptProviders } from '@/lib/seed';
import type { ApiStyle, ProviderConfig } from './types';
import {
  defaultScriptProviderConfigs,
  resolveScriptProviderRuntimeConfig,
  toScriptProviderMeta,
  type ScriptProviderRuntimeConfig,
} from './config';

export interface ScriptProviderRow {
  id: string;
  name: string;
  type: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  model: string;
  keyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  maxTokens: number;
  enabled: number;
  isBuiltin: number;
}

export function getScriptProviderRows(): ScriptProviderRow[] {
  seedScriptProviders();
  return getDb()
    .prepare(`SELECT * FROM script_providers ORDER BY name`)
    .all() as ScriptProviderRow[];
}

export function getScriptProviderDefaults(providerId: string): ProviderConfig {
  const builtin = defaultScriptProviderConfigs.find((config) => config.id === providerId);
  if (builtin) return builtin;

  const row = getDb().prepare(`SELECT * FROM script_providers WHERE id = ?`).get(providerId) as ScriptProviderRow | undefined;
  if (!row) throw new Error(`未知的脚本模型 ${providerId}`);

  return {
    id: row.id,
    name: row.name,
    apiStyle: row.apiStyle,
    keyEnv: row.keyEnv,
    baseUrlEnv: row.baseUrlEnv,
    modelEnv: row.modelEnv,
    defaultModel: row.defaultModel,
    defaultBaseUrl: row.defaultBaseUrl,
    maxTokens: row.maxTokens,
  };
}

export function resolveStoredScriptProvider(providerId: string): ScriptProviderRuntimeConfig {
  seedScriptProviders();
  const row = getDb().prepare(`SELECT * FROM script_providers WHERE id = ?`).get(providerId) as ScriptProviderRow | undefined;
  if (!row) throw new Error(`未知的脚本模型 ${providerId}`);

  return resolveScriptProviderRuntimeConfig(getScriptProviderDefaults(providerId), row);
}

export function listScriptProviderMeta() {
  return getScriptProviderRows().map((row) =>
    toScriptProviderMeta(
      resolveScriptProviderRuntimeConfig(getScriptProviderDefaults(row.id), row)
    )
  );
}
