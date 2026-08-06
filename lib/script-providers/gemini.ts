/**
 * Gemini script generation provider.
 *
 * Supports two API styles:
 * - "openai-compatible": /v1/chat/completions proxy (default, uses shared adapter)
 * - "native": Gemini generateContent REST API
 *
 * Configure via env:
 *   GEMINI_BASE_URL   — API base (default: https://geekai.co/api)
 *   GEMINI_API_KEY    — API key
 *   GEMINI_MODEL      — Model name (default: gemini-3.5-flash)
 *   GEMINI_API_STYLE  — "native" or "openai-compatible" (default: openai-compatible)
 */

import type {
  ProviderConfig,
  ProviderMeta,
  AnalysisInput,
  AnalysisResult,
} from './types';
import type { ScriptProviderRuntimeConfig } from './config';
import { resolveStoredScriptProvider } from './store';
import {
  chatCompletion,
  parseJsonResponse,
  buildAnalysisPrompt,
  type ChatImagePart,
} from './openai-compatible';
import { createScriptProviderRequestControl } from './request-control.ts';

const DEFAULT_GEMINI_TIMEOUT_MS = 120_000;

interface GeminiCallOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: ChatImagePart[];
}

// ── Provider Config ──

export const geminiConfig: ProviderConfig = {
  id: 'gemini',
  name: 'Gemini',
  apiStyle: 'openai-compatible',
  keyEnv: 'GEMINI_API_KEY',
  baseUrlEnv: 'GEMINI_BASE_URL',
  modelEnv: 'GEMINI_MODEL',
  defaultModel: 'gemini-3.5-flash',
  defaultBaseUrl: 'https://geekai.co/api',
  maxTokens: 8192,
};

// ── Helpers ──

export function isGeminiConfigured(): boolean {
  try {
    return resolveStoredScriptProvider('gemini').configured;
  } catch {
    return false;
  }
}

export function getGeminiModel(): string {
  return geminiConfig.defaultModel;
}

export function getGeminiMeta(): ProviderMeta {
  let supportsVision = false;
  try {
    supportsVision = resolveStoredScriptProvider('gemini').supportsVision;
  } catch {
    supportsVision = false;
  }
  return {
    id: geminiConfig.id,
    name: geminiConfig.name,
    model: getGeminiModel(),
    configured: isGeminiConfigured(),
    apiStyle: 'openai-compatible',
    supportsVision,
    executionScope: 'external',
  };
}

function getApiStyle(runtime?: ScriptProviderRuntimeConfig): 'native' | 'openai-compatible' {
  return runtime?.apiStyle === 'native-gemini' ? 'native' : 'openai-compatible';
}

// ── Native Gemini API call ──

async function geminiNativeCall(
  prompt: string,
  runtime?: ScriptProviderRuntimeConfig,
  options?: GeminiCallOptions,
): Promise<string> {
  const baseUrl = (runtime?.baseUrl || geminiConfig.defaultBaseUrl).replace(/\/$/, '');
  const apiKey = runtime?.apiKey;
  const model = runtime?.model || geminiConfig.defaultModel;

  if (!apiKey) {
    throw new Error('Gemini API Key 未配置。请在供应商配置页填写。');
  }

  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of options?.images ?? []) {
    // Gemini 原生 generateContent 只接受 inlineData；公司供应商的 COS URL 传输不适用于此适配器。
    if (!image.imageBase64) throw new Error('Gemini 原生接口只支持 base64 图片输入');
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.imageBase64 } });
  }

  const requestControl = createScriptProviderRequestControl({
    externalSignal: options?.signal,
    timeoutMs: options?.timeoutMs,
    defaultTimeoutMs: DEFAULT_GEMINI_TIMEOUT_MS,
    timeoutMessage: (timeoutMs) => `Gemini (native) 请求超时（${timeoutMs}ms）`,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: options?.temperature ?? 0.7,
          maxOutputTokens: options?.maxTokens ?? runtime?.maxTokens ?? geminiConfig.maxTokens,
        },
      }),
      signal: requestControl.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini (native) error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText.trim()) throw new Error('Gemini 返回了空响应');
    return rawText;
  } catch (error) {
    return requestControl.rethrow(error);
  } finally {
    requestControl.dispose();
  }
}

// ── Unified call (routes to native or openai-compatible) ──

async function geminiCall(
  systemPrompt: string,
  userPrompt: string,
  responseFormat: 'json_object' | 'text' = 'json_object',
  runtime?: ScriptProviderRuntimeConfig,
  options?: GeminiCallOptions,
): Promise<string> {
  const apiStyle = getApiStyle(runtime);

  if (apiStyle === 'openai-compatible') {
    return chatCompletion(geminiConfig, {
      systemPrompt,
      userPrompt,
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? runtime?.maxTokens ?? geminiConfig.maxTokens,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      responseFormat,
      images: options?.images,
    }, runtime);
  }

  // Native path: combine system + user into a single prompt (Gemini native doesn't have system role)
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return geminiNativeCall(combined, runtime, options);
}

// ── Public API ──

export async function geminiAnalyzeSellingPoints(input: AnalysisInput, runtime?: ScriptProviderRuntimeConfig): Promise<AnalysisResult> {
  const systemPrompt = 'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildAnalysisPrompt(input);

  const rawText = await geminiCall(systemPrompt, userPrompt, 'json_object', runtime);
  return parseJsonResponse<AnalysisResult>(rawText, 'Gemini');
}

export async function geminiCompleteJson<T>(input: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: ChatImagePart[];
}, runtime?: ScriptProviderRuntimeConfig): Promise<T> {
  const rawText = await geminiCall(
    input.systemPrompt,
    input.userPrompt,
    'json_object',
    runtime,
    {
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      images: input.images,
    },
  );
  return parseJsonResponse<T>(rawText, 'Gemini');
}
