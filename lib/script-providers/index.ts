/**
 * Script Provider Registry
 *
 * Unified entry point for all script generation LLM providers.
 * Dispatches analyze/generate calls to the correct provider based on providerId.
 */

import type {
  ProviderConfig,
  ProviderMeta,
  AnalysisInput,
  AnalysisResult,
  ScriptInput,
  ProviderScriptResult,
} from './types';
import { chatCompletion, buildAnalysisPrompt, buildScriptPrompt, parseJsonResponse } from './openai-compatible';
import { geminiConfig, geminiAnalyzeSellingPoints, geminiGenerateScript } from './gemini';
import type { ScriptOutput } from './types';

// ── Re-export types ──

export type {
  ProviderConfig,
  ProviderMeta,
  AnalysisInput,
  AnalysisResult,
  ScriptInput,
  ScriptOutput,
  ProviderScriptResult,
  ScriptShot,
  SellingPointMapEntry,
  SelectedSellingPoint,
  ShotContext,
  SellingPointRanking,
} from './types';

// ── Provider Registry ──

const openAiCompatibleProviders: ProviderConfig[] = [
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
    name: 'Kimi (月之暗面)',
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

function getGeminiConfig(): ProviderConfig {
  return geminiConfig;
}

function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function getGeminiModelName(): string {
  return process.env.GEMINI_MODEL || 'gemini-3.5-flash';
}

function getGeminiApiStyle(): ProviderMeta['apiStyle'] {
  return (process.env.GEMINI_API_STYLE as ProviderMeta['apiStyle']) || 'openai-compatible';
}

// ── Public: List available providers ──

export function getAvailableProviders(): ProviderMeta[] {
  const providers: ProviderMeta[] = [
    {
      id: 'gemini',
      name: 'Gemini',
      model: getGeminiModelName(),
      configured: isGeminiConfigured(),
      apiStyle: getGeminiApiStyle(),
    },
  ];

  for (const config of openAiCompatibleProviders) {
    providers.push({
      id: config.id,
      name: config.name,
      model: process.env[config.modelEnv] || config.defaultModel,
      configured: Boolean(process.env[config.keyEnv]),
      apiStyle: 'openai-compatible',
    });
  }

  return providers;
}

// ── Public: Get a single provider meta ──

export function getProviderMeta(providerId: string): ProviderMeta | undefined {
  return getAvailableProviders().find((p) => p.id === providerId);
}

// ── Private: Resolve provider config ──

function resolveConfig(providerId: string): ProviderConfig {
  if (providerId === 'gemini') {
    return getGeminiConfig();
  }
  const config = openAiCompatibleProviders.find((c) => c.id === providerId);
  if (!config) {
    throw new Error(`未知的脚本模型: ${providerId}。可选: gemini, qwen, kimi, gpt`);
  }
  return config;
}

function checkConfigured(providerId: string): void {
  const meta = getProviderMeta(providerId);
  if (!meta) {
    throw new Error(`未知的脚本模型: ${providerId}`);
  }
  if (!meta.configured) {
    const config = resolveConfig(providerId);
    throw new Error(
      `${config.name} 未配置。请在 .env.local 中设置 ${config.keyEnv}。`
    );
  }
}

// ── Public: Analyze Selling Points ──

export async function analyzeSellingPoints(
  input: AnalysisInput,
  providerId: string
): Promise<AnalysisResult> {
  checkConfigured(providerId);

  const systemPrompt =
    'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildAnalysisPrompt(input);

  // Gemini has its own native adapter
  if (providerId === 'gemini') {
    return geminiAnalyzeSellingPoints(input);
  }

  const config = resolveConfig(providerId);
  const rawText = await chatCompletion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: config.maxTokens,
    responseFormat: 'json_object',
  });

  return parseJsonResponse<AnalysisResult>(rawText, config.name);
}

// ── Public: Generate Script ──

export async function generateScript(
  input: ScriptInput,
  providerId: string
): Promise<ProviderScriptResult> {
  checkConfigured(providerId);

  const systemPrompt =
    'You are a professional e-commerce short-video scriptwriter. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildScriptPrompt(input);

  // Gemini has its own native adapter
  if (providerId === 'gemini') {
    return geminiGenerateScript(input);
  }

  const config = resolveConfig(providerId);
  const providerName = config.name;
  const model = process.env[config.modelEnv] || config.defaultModel;

  const rawText = await chatCompletion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: config.maxTokens,
    responseFormat: 'json_object',
  });

  const script = parseJsonResponse<ScriptOutput>(rawText, providerName);

  // Ensure fullScript exists
  if (!script.fullScript && script.shots?.length) {
    script.fullScript = script.shots.map((s) => s.voiceover).join('\n');
  }

  return { script, provider: providerId, model };
}
