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
import { beginLlmUsageCall, finishLlmUsageCall, llmTransportActualCost, type LlmUsageContext } from '../usage-llm.ts';
import { safeProviderErrorHint } from './error-diagnostics.ts';
import { runLlmTransport, type LlmExecutionTransport } from './transport-execution.ts';

const DEFAULT_GEMINI_TIMEOUT_MS = 120_000;

interface GeminiCallOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: ChatImagePart[];
  usageContext?: LlmUsageContext;
  executionTransport?: LlmExecutionTransport;
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
    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? runtime?.maxTokens ?? geminiConfig.maxTokens,
      },
    };
    const perform = async () => {
      const usageAttempt = runtime ? beginLlmUsageCall(runtime, model, options?.usageContext) : null;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestControl.signal,
      });
      if (!response.ok) return { response, errText: await response.text(), rawText: '' };
      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      finishLlmUsageCall(usageAttempt, {
        usage: data.usageMetadata ? {
          prompt_tokens: data.usageMetadata.promptTokenCount,
          completion_tokens: data.usageMetadata.candidatesTokenCount,
        } : undefined,
        serializedPrompt: JSON.stringify(body.contents),
        rawOutput: rawText,
        hasImages: Boolean(options?.images?.length),
      });
      if (!rawText.trim()) throw new Error('Gemini 返回了空响应');
      return { response, errText: '', rawText };
    };
    const performed = options?.executionTransport
      ? await runLlmTransport(options.executionTransport, {
          requestSnapshot: body,
          send: async () => {
            const value = await perform();
            return {
              value,
              terminalState: value.response.ok ? 'succeeded' : 'failed',
              result: value.response.ok ? value.rawText : undefined,
              actualCost: value.response.ok && runtime ? llmTransportActualCost(runtime, model) : null,
              remoteTerminal: true,
              errorCode: value.response.ok ? undefined : `http_${value.response.status}`,
            };
          },
        })
      : await perform();
    if (!performed.response.ok) {
      throw new Error(`Gemini (native) 请求失败（HTTP ${performed.response.status}）：${safeProviderErrorHint(performed.errText)}`);
    }
    return performed.rawText;
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
      usageContext: options?.usageContext,
      executionTransport: options?.executionTransport,
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
  usageContext?: LlmUsageContext;
  executionTransport?: LlmExecutionTransport;
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
      usageContext: input.usageContext,
      executionTransport: input.executionTransport,
    },
  );
  return parseJsonResponse<T>(rawText, 'Gemini');
}
