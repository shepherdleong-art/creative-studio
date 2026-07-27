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
  ScriptInput,
  ProviderScriptResult,
} from './types';
import {
  chatCompletion,
  buildAnalysisPrompt,
  buildScriptPrompt,
  completeOpenAiCompatibleJson,
  parseJsonResponse,
} from './openai-compatible';
import {
  chatCompletion as responsesChatCompletion,
  completeOpenAiResponsesJson,
  usesOpenAiResponses,
} from './openai-responses';
import { geminiAnalyzeSellingPoints, geminiCompleteJson, geminiGenerateScript } from './gemini';
import type { ScriptOutput } from './types';
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
  ScriptInput,
  ScriptOutput,
  ProviderScriptResult,
  ScriptSegment,
  DroppedShot,
  SellingPointMapEntry,
  SelectedSellingPoint,
  ShotContext,
  SellingPointRanking,
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
  images?: Array<{ mimeType: string; imageBase64: string }>;
}): Promise<T> {
  checkConfigured(input.providerId);
  const runtime = resolveStoredScriptProvider(input.providerId);
  const options = {
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    images: input.images,
  };

  if (runtime.apiStyle === 'native-gemini') {
    return geminiCompleteJson<T>(options, runtime);
  }

  if (usesOpenAiResponses(runtime.apiStyle)) {
    return completeOpenAiResponsesJson<T>(resolveConfig(input.providerId), options, runtime);
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
  const completion = usesOpenAiResponses(runtime.apiStyle) ? responsesChatCompletion : chatCompletion;
  const rawText = await completion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    responseFormat: 'json_object',
  }, runtime);

  return parseJsonResponse<AnalysisResult>(rawText, config.name);
}

export async function generateScript(
  input: ScriptInput,
  providerId: string
): Promise<ProviderScriptResult> {
  checkConfigured(providerId);
  const runtime = resolveStoredScriptProvider(providerId);

  const systemPrompt =
    'You are a professional e-commerce short-video scriptwriter. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildScriptPrompt(input);

  if (runtime.apiStyle === 'native-gemini') {
    return geminiGenerateScript(input, runtime);
  }

  const config = resolveConfig(providerId);

  const completion = usesOpenAiResponses(runtime.apiStyle) ? responsesChatCompletion : chatCompletion;
  const rawText = await completion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    responseFormat: 'json_object',
    images: input.shots.map((shot) => ({ mimeType: shot.mimeType, imageBase64: shot.imageBase64 })),
  }, runtime);

  const script = parseJsonResponse<ScriptOutput>(rawText, config.name);

  return { script, provider: providerId, model: runtime.model };
}
