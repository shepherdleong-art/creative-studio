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
  type ChatImagePart,
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
import { isCosMediaConfigured, tryUploadBufferToCosAndSign } from '../cos-media.ts';
import type { LlmUsageContext, LlmUsageContextInput } from '../usage-llm.ts';
import {
  ProviderExecutionGateError,
  assertProviderExecutionAvailable,
  evaluateProviderExecutionGate,
} from '../provider-execution-gate';
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

export async function assertStoredScriptProviderExecutionAvailable(
  providerId: string,
  options: {
    capability: 'model' | 'media';
    mediaTransportAvailable?: boolean;
  },
): Promise<void> {
  checkConfigured(providerId);
  const runtime = resolveStoredScriptProvider(providerId);
  await assertProviderExecutionAvailable(runtime, options);
}

function assertExternalProviderExecutionAvailable(
  runtime: ReturnType<typeof resolveStoredScriptProvider>,
  capability: 'model' | 'media',
): void {
  const result = evaluateProviderExecutionGate({ provider: runtime, capability });
  if (!result.allowed) {
    throw new ProviderExecutionGateError(result.code, result.message, result.executionScope);
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
  usageContext?: LlmUsageContextInput;
  onTextDelta?: (accumulated: string) => void;
  onReasoningDelta?: (accumulated: string) => void;
}): Promise<T> {
  checkConfigured(input.providerId);
  const runtime = resolveStoredScriptProvider(input.providerId);
  const capability = input.images?.length ? 'media' : 'model';
  let images: ChatImagePart[] | undefined = input.images;
  if (runtime.executionScope === 'company') {
    // 公司视觉调用的图片必须经受控媒体传输（COS 上传 + 预签名 URL），不内联 base64；
    // COS 未配置时门禁失败关闭。
    await assertProviderExecutionAvailable(runtime, {
      capability,
      mediaTransportAvailable: isCosMediaConfigured(),
    });
    if (input.images?.length) {
      images = await Promise.all(input.images.map(async (image) => {
        const imageUrl = await tryUploadBufferToCosAndSign(Buffer.from(image.imageBase64, 'base64'), image.mimeType);
        if (!imageUrl) {
          throw new Error('公司供应商的视觉媒体传输未配置：请在 .env.local 配置 CREATIVE_STUDIO_COS_SECRET_ID / CREATIVE_STUDIO_COS_SECRET_KEY / CREATIVE_STUDIO_COS_DOMAIN 后重启');
        }
        return { mimeType: image.mimeType, imageUrl };
      }));
    }
  } else {
    // 保持直连路径同步：创建请求后立即 abort 时，供应商 Adapter 必须已经接管 signal。
    assertExternalProviderExecutionAvailable(runtime, capability);
  }
  const defaultOptions = {
    usageContext: { enabled: true } satisfies LlmUsageContext,
  };
  const options = {
    ...defaultOptions,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    images,
    onTextDelta: input.onTextDelta,
    onReasoningDelta: input.onReasoningDelta,
    usageContext: {
      ...defaultOptions.usageContext,
      ...(input.usageContext ?? {}),
      enabled: true,
    } satisfies LlmUsageContext,
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
  providerId: string,
  usageContext?: LlmUsageContextInput,
): Promise<AnalysisResult> {
  checkConfigured(providerId);
  const runtime = resolveStoredScriptProvider(providerId);
  if (runtime.executionScope === 'company') {
    await assertProviderExecutionAvailable(runtime, { capability: 'model' });
  } else {
    assertExternalProviderExecutionAvailable(runtime, 'model');
  }

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
  const defaultCompletionOptions = {
    usageContext: { enabled: true } satisfies LlmUsageContext,
  };
  const completionOptions = {
    ...defaultCompletionOptions,
    systemPrompt,
    userPrompt,
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    responseFormat: 'json_object',
    usageContext: {
      ...defaultCompletionOptions.usageContext,
      ...(usageContext ?? {}),
      enabled: true,
    } satisfies LlmUsageContext,
  } as const;
  const rawText = runtime.apiStyle === 'openai-compatible'
    ? await chatCompletion(config, completionOptions, runtime)
    : await completion(config, completionOptions, runtime);

  return parseJsonResponse<AnalysisResult>(rawText, config.name);
}
