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
import { chatCompletion, buildAnalysisPrompt, buildScriptPrompt, parseJsonResponse } from './openai-compatible';
import { geminiAnalyzeSellingPoints, geminiGenerateScript } from './gemini';
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
  ScriptShot,
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

export async function analyzeSellingPoints(
  input: AnalysisInput,
  providerId: string
): Promise<AnalysisResult> {
  checkConfigured(providerId);
  const runtime = resolveStoredScriptProvider(providerId);

  const systemPrompt =
    'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildAnalysisPrompt(input);

  if (providerId === 'gemini') {
    return geminiAnalyzeSellingPoints(input, runtime);
  }

  const config = resolveConfig(providerId);
  const rawText = await chatCompletion(config, {
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

  if (providerId === 'gemini') {
    return geminiGenerateScript(input, runtime);
  }

  const config = resolveConfig(providerId);
  const providerName = config.name;

  const rawText = await chatCompletion(config, {
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    responseFormat: 'json_object',
  }, runtime);

  const script = parseJsonResponse<ScriptOutput>(rawText, providerName);

  if (!script.fullScript && script.shots?.length) {
    script.fullScript = script.shots.map((s) => s.voiceover).join('\n');
  }

  return { script, provider: providerId, model: runtime.model };
}
