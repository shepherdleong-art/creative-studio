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
} from './types.ts';
import {
  buildAnalysisPrompt,
  completeOpenAiCompatibleJson,
  parseJsonResponse,
  chatCompletion,
} from './openai-compatible.ts';
import {
  chatCompletion as responsesChatCompletion,
  completeOpenAiResponsesJson,
  usesOpenAiResponses,
} from './openai-responses.ts';
import {
  chatCompletion as anthropicChatCompletion,
  completeAnthropicMessagesJson,
  usesAnthropicMessages,
} from './anthropic-messages.ts';
import { geminiAnalyzeSellingPoints, geminiCompleteJson } from './gemini.ts';
import { resolveScriptProviderRuntimeConfig, toScriptProviderMeta } from './config.ts';
import { isManagedDeployment } from '../managed-deployment.ts';
import { getDb } from '../db.ts';
import {
  ProviderExecutionGateError,
  assertProviderExecutionAvailable,
  evaluateProviderExecutionGate,
  assertProviderExecutionIdentityStable,
  readManagedExecutionGeneration,
  type AssertProviderExecutionAvailableOptions,
} from '../provider-execution-gate.ts';
import {
  listScriptProviderMeta,
  resolveStoredScriptProvider,
  getScriptProviderDefaults,
} from './store.ts';

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
} from './types.ts';

export function getAvailableProviders(): ProviderMeta[] {
  return listScriptProviderMeta();
}

export function getProviderMeta(providerId: string): ProviderMeta | undefined {
  return getAvailableProviders().find((p) => p.id === providerId);
}

export function estimateVisionAnalysisCost(providerId: string, requestCount: number): number {
  const runtime = resolveExecutionScriptProvider(providerId);
  return Number((Math.max(0, Math.trunc(requestCount)) * runtime.visionCostPerRequest).toFixed(6));
}

function resolveConfig(providerId: string): ProviderConfig {
  return getScriptProviderDefaults(providerId);
}

function checkConfigured(providerId: string): void {
  const runtime = resolveExecutionScriptProvider(providerId);
  const meta = toScriptProviderMeta(runtime);
  if (!meta.configured) {
    throw new Error(`${runtime.name} 未配置完整：${runtime.missing.join(', ')}`);
  }
}

/** Build the adapter config from the same immutable row used by the gate. */
function resolveExecutionConfig(providerId: string): ProviderConfig {
  try {
    return resolveConfig(providerId);
  } catch (error) {
    if (!isManagedDeployment()) throw error;
    const row = readRawScriptProvider(providerId);
    if (!row) throw error;
    return {
      id: row.id,
      name: row.name,
      apiStyle: row.apiStyle as ProviderConfig['apiStyle'],
      keyEnv: row.keyEnv,
      baseUrlEnv: row.baseUrlEnv,
      modelEnv: row.modelEnv,
      defaultModel: row.defaultModel,
      defaultBaseUrl: row.defaultBaseUrl,
      maxTokens: row.maxTokens,
    };
  }
}
type ScriptExecutionOptions = Pick<
  AssertProviderExecutionAvailableOptions,
  'root' | 'inspectRuntime' | 'companyRuntime' | 'allowlist' | 'env'
>;

interface RawScriptProviderIdentity {
  id: string;
  name: string;
  type: string;
  apiStyle: string;
  baseUrl: string;
  keyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  maxTokens: number;
  apiKey: string;
  model: string;
  enabled: number;
  supportsVision: number;
  visionCostPerRequest: number;
  executionScope: string;
}

function readRawScriptProvider(providerId: string): RawScriptProviderIdentity | undefined {
  return getDb().prepare(`SELECT * FROM script_providers WHERE id = ?`).get(providerId) as RawScriptProviderIdentity | undefined;
}

/**
 * Managed provider listing deliberately hides disallowed rows. Execution must
 * still retain the queued row identity long enough for the shared gate to
 * return a stable policy code instead of falling through to a generic lookup
 * error. The fallback is only used in managed mode and never replaces the id.
 */
function resolveExecutionScriptProvider(providerId: string): ReturnType<typeof resolveStoredScriptProvider> {
  try {
    return resolveStoredScriptProvider(providerId);
  } catch (error) {
    if (!isManagedDeployment()) throw error;
    const row = readRawScriptProvider(providerId);
    if (!row) throw error;
    return resolveScriptProviderRuntimeConfig({
      id: row.id,
      name: row.name,
      apiStyle: row.apiStyle as ProviderConfig['apiStyle'],
      keyEnv: row.keyEnv,
      baseUrlEnv: row.baseUrlEnv,
      modelEnv: row.modelEnv,
      defaultModel: row.defaultModel,
      defaultBaseUrl: row.defaultBaseUrl,
      maxTokens: row.maxTokens,
    }, row as Parameters<typeof resolveScriptProviderRuntimeConfig>[1]);
  }
}

function executionIdentity(
  providerId: string,
  runtime: ReturnType<typeof resolveStoredScriptProvider>,
  options: { env?: NodeJS.ProcessEnv; root?: string } = {},
) {
  const row = readRawScriptProvider(providerId);
  const config = row ? undefined : resolveConfig(providerId);
  const managed = isManagedDeployment(options.env ?? process.env);
  const configSignature = row
    ? [
      row.apiStyle,
      row.keyEnv,
      row.baseUrlEnv,
      row.modelEnv,
      row.defaultBaseUrl,
      row.defaultModel,
      row.maxTokens,
      row.enabled,
      row.supportsVision,
      row.visionCostPerRequest,
      row.executionScope,
    ].map((value) => String(value ?? '')).join('\u0000')
    : undefined;
  return {
    ...runtime,
    type: row?.type || runtime.apiStyle,
    apiStyle: row?.apiStyle || runtime.apiStyle,
    apiKeyEnv: row?.keyEnv || config?.keyEnv,
    keyEnv: row?.keyEnv || config?.keyEnv,
    configSignature,
    managedGeneration: managed ? readManagedExecutionGeneration(options.root) : undefined,
  };
}

function assertScriptExecutionIdentityStable(
  providerId: string,
  previous: ReturnType<typeof executionIdentity>,
  env?: NodeJS.ProcessEnv,
  root?: string,
): void {
  if (!isManagedDeployment(env ?? process.env)) return;
  const currentRuntime = resolveExecutionScriptProvider(providerId);
  assertProviderExecutionIdentityStable(previous, executionIdentity(providerId, currentRuntime, { env, root }));
}
export async function assertStoredScriptProviderExecutionAvailable(
  providerId: string,
  options: {
    capability: 'model' | 'media';
    mediaTransportAvailable?: boolean;
  } & ScriptExecutionOptions,
): Promise<void> {
  const runtime = resolveExecutionScriptProvider(providerId);
  if (!isManagedDeployment(options.env ?? process.env)) checkConfigured(providerId);
  await assertProviderExecutionAvailable(executionIdentity(providerId, runtime, options), {
    ...options,
    kind: 'script',
  });
}

function assertExternalProviderExecutionAvailable(
  providerId: string,
  runtime: ReturnType<typeof resolveStoredScriptProvider>,
  capability: 'model' | 'media',
): void {
  const result = evaluateProviderExecutionGate({
    provider: executionIdentity(providerId, runtime),
    capability,
    kind: 'script',
    managed: false,
  });
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
  /** Test seam for managed runtime inspection; production callers omit it. */
  executionGate?: ScriptExecutionOptions;
}): Promise<T> {
  const runtime = resolveExecutionScriptProvider(input.providerId);
  if (!isManagedDeployment(input.executionGate?.env ?? process.env)) checkConfigured(input.providerId);
  const capability = input.images?.length ? 'media' : 'model';
  const gateOptions = input.executionGate ?? {};
  // Capture both provider identity and adapter routing before the gate. A
  // same-id row/config mutation after this point must not mix old runtime data
  // with a freshly resolved adapter configuration.
  const executionIdentitySnapshot = executionIdentity(input.providerId, runtime, gateOptions);
  const executionConfigSnapshot = runtime.apiStyle === 'native-gemini'
    ? undefined
    : resolveExecutionConfig(input.providerId);
  if (isManagedDeployment(gateOptions.env ?? process.env) || runtime.executionScope === 'company') {
    await assertStoredScriptProviderExecutionAvailable(input.providerId, {
      ...gateOptions,
      capability,
      // Script visual calls have no task-level MediaTransport seam yet.
      mediaTransportAvailable: false,
    });
    assertScriptExecutionIdentityStable(input.providerId, executionIdentitySnapshot, gateOptions.env, gateOptions.root);
  } else {
    // Keep direct providers synchronous with their existing route while still
    // checking immediately before the adapter dispatch.
    assertExternalProviderExecutionAvailable(input.providerId, runtime, capability);
  }
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
    return completeOpenAiResponsesJson<T>(executionConfigSnapshot!, options, runtime);
  }

  if (usesAnthropicMessages(runtime.apiStyle)) {
    return completeAnthropicMessagesJson<T>(executionConfigSnapshot!, options, runtime);
  }

  return completeOpenAiCompatibleJson<T>(executionConfigSnapshot!, options, runtime);
}

export async function analyzeSellingPoints(
  input: AnalysisInput,
  providerId: string,
  executionGate?: ScriptExecutionOptions,
): Promise<AnalysisResult> {
  const runtime = resolveExecutionScriptProvider(providerId);
  if (!isManagedDeployment(executionGate?.env ?? process.env)) checkConfigured(providerId);
  const executionIdentitySnapshot = executionIdentity(providerId, runtime, executionGate);
  const executionConfigSnapshot = runtime.apiStyle === 'native-gemini'
    ? undefined
    : resolveExecutionConfig(providerId);
  if (isManagedDeployment(executionGate?.env ?? process.env) || runtime.executionScope === 'company') {
    await assertStoredScriptProviderExecutionAvailable(providerId, {
      ...executionGate,
      capability: 'model',
    });
    assertScriptExecutionIdentityStable(providerId, executionIdentitySnapshot, executionGate?.env, executionGate?.root);
  } else {
    assertExternalProviderExecutionAvailable(providerId, runtime, 'model');
  }

  const systemPrompt =
    'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.';
  const userPrompt = buildAnalysisPrompt(input);

  if (runtime.apiStyle === 'native-gemini') {
    return geminiAnalyzeSellingPoints(input, runtime);
  }

  const config = executionConfigSnapshot!;
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
