import type { ApiStyle, ProviderConfig, ProviderExecutionScope, ProviderMeta } from './types';

type EnvMap = Record<string, string | undefined>;

export interface ScriptProviderDbConfig {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  /** The persisted adapter identity; do not derive usage identity from apiStyle. */
  type?: string | null;
  apiStyle?: ApiStyle | null;
  enabled?: number | boolean | null;
  maxTokens?: number | null;
  supportsVision?: number | boolean | null;
  visionCostPerRequest?: number | null;
  executionScope?: ProviderExecutionScope | string | null;
}

export interface ScriptProviderRuntimeConfig {
  id: string;
  name: string;
  /** The database's real provider type, kept separate from the transport protocol. */
  type?: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  enabled: boolean;
  configured: boolean;
  missing: string[];
  hasApiKey: boolean;
  supportsVision: boolean;
  visionCostPerRequest: number;
  executionScope: ProviderExecutionScope;
}

export const scriptProviderApiStyleOptions: ReadonlyArray<{
  value: ApiStyle;
  label: string;
}> = [
  { value: 'openai-compatible', label: 'OpenAI-compatible（/v1/chat/completions）' },
  { value: 'openai-responses', label: 'OpenAI Responses（/v1/responses）' },
  { value: 'anthropic-messages', label: 'Anthropic Messages（/v1/messages）' },
  { value: 'native-gemini', label: 'Native Gemini（generateContent）' },
];

export function scriptProviderProtocolFields(apiStyle: ApiStyle): {
  type: ApiStyle;
  apiStyle: ApiStyle;
} {
  return { type: apiStyle, apiStyle };
}

export const defaultScriptProviderConfigs: ProviderConfig[] = [
  {
    id: 'gemini',
    name: 'Gemini',
    apiStyle: 'openai-compatible',
    keyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-3.5-flash',
    defaultBaseUrl: 'https://geekai.co/api',
    maxTokens: 8192,
  },
  {
    id: 'qwen',
    name: '通义千问',
    apiStyle: 'openai-compatible',
    keyEnv: 'QWEN_API_KEY',
    baseUrlEnv: 'QWEN_BASE_URL',
    modelEnv: 'QWEN_MODEL',
    defaultModel: 'qwen-max',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    maxTokens: 8192,
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    apiStyle: 'openai-compatible',
    keyEnv: 'KIMI_API_KEY',
    baseUrlEnv: 'KIMI_BASE_URL',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'moonshot-v1-8k',
    defaultBaseUrl: 'https://api.moonshot.cn',
    maxTokens: 4096,
  },
  {
    id: 'gpt',
    name: 'GPT / OpenAI',
    apiStyle: 'openai-compatible',
    keyEnv: 'GPT_API_KEY',
    baseUrlEnv: 'GPT_BASE_URL',
    modelEnv: 'GPT_MODEL',
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com',
    maxTokens: 16384,
  },
];

function clean(value: string | null | undefined): string {
  return (value || '').trim();
}

export function isConfiguredScriptProviderValue(value: string | null | undefined): boolean {
  const s = clean(value);
  return Boolean(s) && !['your_', 'xxx', 'placeholder', 'todo'].some((marker) =>
    s.toLowerCase().includes(marker)
  );
}

function enabledValue(value: number | boolean | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'boolean' ? value : value === 1;
}

/** Unlike enabledValue, this defaults to false — supportsVision's DB column default is 0. */
function supportsVisionValue(value: number | boolean | null | undefined): boolean {
  if (value === undefined || value === null) return false;
  return typeof value === 'boolean' ? value : value === 1;
}

function executionScopeValue(value: string | null | undefined): ProviderExecutionScope {
  return value === 'company' ? 'company' : 'external';
}

export function resolveScriptProviderRuntimeConfig(
  defaults: ProviderConfig,
  dbConfig: ScriptProviderDbConfig | undefined,
  _env: EnvMap = process.env
): ScriptProviderRuntimeConfig {
  void _env;
  const baseUrl = clean(dbConfig?.baseUrl) || defaults.defaultBaseUrl;
  const apiKey = clean(dbConfig?.apiKey);
  const model = clean(dbConfig?.model) || defaults.defaultModel;
  const type = clean(dbConfig?.type);
  const apiStyle = dbConfig?.apiStyle || defaults.apiStyle;
  const maxTokens = Number(dbConfig?.maxTokens || defaults.maxTokens);
  const enabled = enabledValue(dbConfig?.enabled);
  const supportsVision = supportsVisionValue(dbConfig?.supportsVision);
  const visionCostPerRequest = Math.max(0, Number(dbConfig?.visionCostPerRequest || 0));
  const executionScope = executionScopeValue(dbConfig?.executionScope);
  const missing: string[] = [];

  if (!isConfiguredScriptProviderValue(baseUrl)) missing.push('Base URL');
  if (!isConfiguredScriptProviderValue(apiKey)) missing.push('API Key');
  if (!isConfiguredScriptProviderValue(model)) missing.push('模型');

  return {
    id: defaults.id,
    name: defaults.name,
    type,
    apiStyle,
    baseUrl,
    apiKey,
    model,
    maxTokens,
    enabled,
    configured: enabled && missing.length === 0,
    missing,
    hasApiKey: isConfiguredScriptProviderValue(apiKey),
    supportsVision,
    visionCostPerRequest,
    executionScope,
  };
}

export function toScriptProviderMeta(runtime: ScriptProviderRuntimeConfig): ProviderMeta {
  return {
    id: runtime.id,
    name: runtime.name,
    model: runtime.model,
    type: runtime.type || '',
    configured: runtime.configured,
    apiStyle: runtime.apiStyle,
    supportsVision: runtime.supportsVision,
    category: 'script',
    enabled: runtime.enabled ? 1 : 0,
    hasApiKey: runtime.hasApiKey,
    missing: runtime.missing,
    maxTokens: runtime.maxTokens,
    visionCostPerRequest: runtime.visionCostPerRequest,
    executionScope: runtime.executionScope,
  };
}
