// lib/narration-providers/types.ts
/** 口播（TTS）供应商的类型定义 */

export interface NarrationProviderConfig {
  id: string;
  name: string;
  type: string;
  /** 内置默认 Base URL（多为空，需用户填写，如 openai-compatible-tts） */
  defaultBaseUrl?: string;
  /** 内置默认模型名 */
  defaultModel?: string;
  /**
   * 仅用于 seed 时的建议默认音色（如直连 DashScope 的 qwen-tts 已知音色）。
   * 不是运行时的唯一真相源——运行时音色来自 narration_providers.voices 这一 DB 列，
   * 因为"协议类型"（如 openai-compatible-tts）不能决定背后模型支持哪些音色。
   * 为空表示该类型没有可以安全假设的默认音色，必须由用户手动配置。
   */
  defaultVoices?: string[];
}

export interface NarrationProviderMeta {
  id: string;
  name: string;
  category: 'narration';
  type: string;
  baseUrl: string;
  model: string;
  /** 该供应商实际可用的音色列表，来自 DB 的 voices 列（不再按协议类型硬编码）。 */
  voices: string[];
  enabled: number;
  configured: boolean;
  hasApiKey: boolean;
  missing: string[];
}
