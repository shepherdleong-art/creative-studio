import { getDb } from '@/lib/db';
import { seedScriptProviders } from '@/lib/seed';
import type { ApiStyle, ProviderConfig, ProviderExecutionScope } from './types';
import { filterManagedProviders, loadManagedProviderAllowlist } from '../managed-provider-policy';
import { isManagedDeployment } from '../managed-deployment';
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
  supportsVision: number;
  visionCostPerRequest: number;
  executionScope: ProviderExecutionScope;
}

function unknownScriptProvider(providerId: string): never {
  throw new Error('未知的脚本模型 ' + providerId);
}

function managedScriptProviderRow(providerId: string): ScriptProviderRow {
  const row = getDb().prepare(`SELECT * FROM script_providers WHERE id = ?`).get(providerId) as ScriptProviderRow | undefined;
  if (!row) return unknownScriptProvider(providerId);
  const allowlist = loadManagedProviderAllowlist();
  if (filterManagedProviders('script', [row], allowlist).length === 0) return unknownScriptProvider(providerId);
  return row;
}

export function getScriptProviderRows(): ScriptProviderRow[] {
  seedScriptProviders();
  const rows = getDb()
    .prepare(`SELECT * FROM script_providers ORDER BY name`)
    .all() as ScriptProviderRow[];
  if (!isManagedDeployment()) return rows;
  return filterManagedProviders('script', rows, loadManagedProviderAllowlist());
}

export function getScriptProviderDefaults(providerId: string): ProviderConfig {
  if (isManagedDeployment()) {
    const row = managedScriptProviderRow(providerId);
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
  const row = isManagedDeployment()
    ? managedScriptProviderRow(providerId)
    : getDb().prepare(`SELECT * FROM script_providers WHERE id = ?`).get(providerId) as ScriptProviderRow | undefined;
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
