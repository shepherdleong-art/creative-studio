// lib/narration-providers/config.ts
import type { NarrationProviderConfig, NarrationProviderMeta } from './types';

export interface NarrationProviderDbRow {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 逗号分隔的音色列表原始字符串，来自 DB 列（用户在 Settings 里配置）。 */
  voices: string;
  enabled: number;
  isBuiltin: number;
}

export interface NarrationProviderRuntimeConfig {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voices: string[];
  enabled: boolean;
  configured: boolean;
  hasApiKey: boolean;
  missing: string[];
}

export const defaultNarrationProviderConfigs: NarrationProviderConfig[] = [
  {
    id: 'qwen-tts',
    name: 'Qwen TTS（阿里云 DashScope）',
    type: 'qwen-tts',
    defaultBaseUrl: '',
    defaultModel: 'qwen-tts',
    // 直连 DashScope 的 qwen-tts 端点，这是已知真实存在的官方音色，可以安全作为默认值。
    defaultVoices: ['Cherry', 'Serena', 'Ethan', 'Chelsie'],
  },
  {
    id: 'openai-tts',
    name: 'OpenAI 兼容 TTS',
    type: 'openai-compatible-tts',
    defaultBaseUrl: '',
    defaultModel: 'tts-1',
    // 故意留空：“OpenAI 兼容”只是传输协议，baseUrl 背后可能是任意模型（例如 qwen3-tts-flash），
    // 音色词表由该模型决定而非协议本身。绝不能在这里假设一套 OpenAI 官方音色名，
    // 否则会在用户接入非 OpenAI 官方后端时产生"看似已配置、实际音色不存在"的静默故障。
    defaultVoices: [],
  },
];

function isReal(value: string | null | undefined): boolean {
  const s = (value || '').trim();
  return Boolean(s) && !['your_', 'xxx', 'placeholder', 'todo'].some((marker) =>
    s.toLowerCase().includes(marker)
  );
}

/** 解析 DB 里逗号分隔的音色原始字符串：按逗号切分、trim、丢弃空值。 */
function parseVoicesColumn(raw: string | null | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function resolveNarrationProviderRuntimeConfig(
  defaults: NarrationProviderConfig,
  dbRow: NarrationProviderDbRow | undefined
): NarrationProviderRuntimeConfig {
  const apiKey = (dbRow?.apiKey || '').trim();
  const baseUrl = (dbRow?.baseUrl || '').trim() || defaults.defaultBaseUrl || '';
  const model = (dbRow?.model || '').trim() || defaults.defaultModel || '';
  const type = dbRow?.type || defaults.type;
  const enabled = dbRow?.enabled !== undefined ? dbRow.enabled === 1 : true;
  // 音色不再按协议类型硬编码：优先取 DB 里用户自己配置的值，DB 为空时才用 seed 建议的默认值兜底
  // （目前只有 qwen-tts 有安全默认值；openai-compatible-tts 的 defaultVoices 是空数组）。
  const dbVoices = parseVoicesColumn(dbRow?.voices);
  const voices = dbVoices.length > 0 ? dbVoices : defaults.defaultVoices ?? [];
  const missing: string[] = [];

  if (!isReal(apiKey)) missing.push('API Key');
  if (type === 'openai-compatible-tts') {
    if (!isReal(baseUrl)) missing.push('Base URL');
    if (!isReal(model)) missing.push('模型');
  }
  // 对所有供应商类型统一要求：音色列表不能为空。协议类型不能决定背后模型支持哪些音色，
  // 没有配置或没有安全默认值时，绝不能替用户瞎猜一个可能对不上模型的音色名。
  if (voices.length === 0) missing.push('音色');

  return {
    id: defaults.id,
    name: dbRow?.name || defaults.name,
    type,
    apiKey,
    baseUrl,
    model,
    voices,
    enabled,
    configured: enabled && missing.length === 0,
    hasApiKey: isReal(apiKey),
    missing,
  };
}

export function toNarrationProviderMeta(runtime: NarrationProviderRuntimeConfig): NarrationProviderMeta {
  return {
    id: runtime.id,
    name: runtime.name,
    category: 'narration',
    type: runtime.type,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    voices: runtime.voices,
    enabled: runtime.enabled ? 1 : 0,
    configured: runtime.configured,
    hasApiKey: runtime.hasApiKey,
    missing: runtime.missing,
  };
}
