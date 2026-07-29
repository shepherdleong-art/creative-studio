/**
 * Script Provider Registry
 *
 * Unified entry point for script generation LLM providers.
 * Provider credentials are resolved from local SQLite settings.
 */

import type {
  ProviderConfig,
  ProviderMeta,
  AnalysisInput,
  AnalysisResult,
} from './types';
import {
  chatCompletion,
  buildAnalysisPrompt,
  completeOpenAiCompatibleJson,
  parseJsonResponse,
} from './openai-compatible';
import {
  chatCompletion as responsesChatCompletion,
  completeOpenAiResponsesJson,
  usesOpenAiResponses,
} from './openai-responses';
import {
  chatCompletion as anthropicChatCompletion,
  completeAnthropicMessagesJson,
  usesAnthropicMessages,
} from './anthropic-messages';
import { geminiAnalyzeSellingPoints, geminiCompleteJson } from './gemini';
import { toScriptProviderMeta } from './config';
import {
  listScriptProviderMeta,
  resolveStoredScriptProvider,
  getScriptProviderDefaults,
} from './store';

export type {
  ProviderConfig,
  ProviderMeta,
  AnalysisInput,
  AnalysisResult,
  ScriptOutput,
  ScriptSegment,
  DroppedShot,
  SellingPointMapEntry,
  SelectedSellingPoint,
  SellingPointRanking,
  ScriptStrategyAnalysisV3,
  ScriptOutputV3,
  ScriptSegmentV3,
  StoredScriptOutput,
} from './types';

export function getAvailableProviders(): ProviderMeta[] {
  return listScriptProviderMeta();
}

export function getProviderMeta(providerId: string): ProviderMeta | undefined {
  return getAvailableProviders().find((p) => p.id === providerId);
}

export function estimateVisionAnalysisCost(providerId: string, requestCount: number): number {
  const runtime = resolveStoredScriptProvider(providerId);
  return Number((Math.max(0, Math.trunc(requestCount)) * runtime.visionCostPerRequest).toFixed(6));
}

function resolveConfig(providerId: string): ProviderConfig {
  return getScriptProviderDefaults(providerId);
}

function checkConfigured(providerId: string): void {
  const runtime = resolveStoredScriptProvider(providerId);
  const meta = toScriptProviderMeta(runtime);
  if (!meta.configured) {
    throw new Error(`${runtime.name} 未配置完整：${runtime.missing.join(', ')}`);
  }
}

export async function completeJson<T>(input: {
  providerId: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: Array<{ mimeType: string; imageBase64: string }>;
}): Promise<T> {
  checkConfigured(input.providerId);
  const runtime = resolveStoredScriptProvider(input.providerId);
  const options = {
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    images: input.images,
  };

  if (runtime.apiStyle === 'native-gemini') {
    return geminiCompleteJson<T>(options, runtime);
  }

  if (usesOpenAiResponses(runtime.apiStyle)) {
    return completeOpenAiResponsesJson<T>(resolveConfig(input.providerId), options, runtime);
  }

  if (usesAnthropicMessages(runtime.apiStyle)) {
    return completeAnthropicMessagesJson<T>(resolveConfig(input.providerId), options, runtime);
  }

  return completeOpenAiCompatibleJson<T>(resolveConfig(input.providerId), options, runtime);
}

export async function analyzeSellingPoints(
  input: AnalysisInput,
  providerId: string
): Promise<AnalysisResult> {
  checkConfigured(providerId);
  const runtime = resolveStoredScriptProvider(providerId);

  const systemPrompt =
    'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildAnalysisPrompt(input);

  if (runtime.apiStyle === 'native-gemini') {
    return geminiAnalyzeSellingPoints(input, runtime);
  }

  const config = resolveConfig(providerId);
  const completion = usesOpenAiResponses(runtime.apiStyle)
    ? responsesChatCompletion
    : usesAnthropicMessages(runtime.apiStyle)
      ? anthropicChatCompletion
      : chatCompletion;
  const rawText = await completion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    responseFormat: 'json_object',
  }, runtime);

  return parseJsonResponse<AnalysisResult>(rawText, config.name);
}
