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
  ScriptInput,
  ScriptOutput,
  ProviderScriptResult,
} from './types';
import {
  chatCompletion,
  parseJsonResponse,
  buildAnalysisPrompt,
  buildScriptPrompt,
} from './openai-compatible';

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
  return Boolean(process.env.GEMINI_API_KEY);
}

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL || geminiConfig.defaultModel;
}

export function getGeminiMeta(): ProviderMeta {
  return {
    id: geminiConfig.id,
    name: geminiConfig.name,
    model: getGeminiModel(),
    configured: isGeminiConfigured(),
    apiStyle: (process.env.GEMINI_API_STYLE as ProviderMeta['apiStyle']) || 'openai-compatible',
  };
}

function getApiStyle(): 'native' | 'openai-compatible' {
  return (process.env.GEMINI_API_STYLE || 'openai-compatible') as 'native' | 'openai-compatible';
}

// ── Native Gemini API call ──

async function geminiNativeCall(prompt: string): Promise<string> {
  const baseUrl = (process.env.GEMINI_BASE_URL || geminiConfig.defaultBaseUrl).replace(/\/$/, '');
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || geminiConfig.defaultModel;

  if (!apiKey) {
    throw new Error('Gemini API Key 未配置。请在 .env.local 中设置 GEMINI_API_KEY。');
  }

  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: geminiConfig.maxTokens },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini (native) error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!rawText.trim()) {
    throw new Error('Gemini 返回了空响应');
  }

  return rawText;
}

// ── Unified call (routes to native or openai-compatible) ──

async function geminiCall(
  systemPrompt: string,
  userPrompt: string,
  responseFormat: 'json_object' | 'text' = 'json_object'
): Promise<string> {
  const apiStyle = getApiStyle();

  if (apiStyle === 'openai-compatible') {
    return chatCompletion(geminiConfig, {
      systemPrompt,
      userPrompt,
      temperature: 0.7,
      maxTokens: geminiConfig.maxTokens,
      responseFormat,
    });
  }

  // Native path: combine system + user into a single prompt (Gemini native doesn't have system role)
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return geminiNativeCall(combined);
}

// ── Public API ──

export async function geminiAnalyzeSellingPoints(input: AnalysisInput): Promise<AnalysisResult> {
  const systemPrompt = 'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildAnalysisPrompt(input);

  const rawText = await geminiCall(systemPrompt, userPrompt, 'json_object');
  return parseJsonResponse<AnalysisResult>(rawText, 'Gemini');
}

export async function geminiGenerateScript(input: ScriptInput): Promise<ProviderScriptResult> {
  const systemPrompt = 'You are a professional e-commerce short-video scriptwriter. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildScriptPrompt(input);

  const rawText = await geminiCall(systemPrompt, userPrompt, 'json_object');
  const script = parseJsonResponse<ScriptOutput>(rawText, 'Gemini');

  // Ensure fullScript exists
  if (!script.fullScript && script.shots?.length) {
    script.fullScript = script.shots.map((s) => s.voiceover).join('\n');
  }

  return { script, provider: 'gemini', model: getGeminiModel() };
}
