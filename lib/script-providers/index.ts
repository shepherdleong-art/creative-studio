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
  buildAnalysisPrompt,
  completeOpenAiCompatibleJson,
  parseJsonResponse,
  type ChatImagePart,
} from './openai-compatible';
import {
  completeOpenAiResponsesJson,
  usesOpenAiResponses,
} from './openai-responses';
import {
  completeAnthropicMessagesJson,
  usesAnthropicMessages,
} from './anthropic-messages';
import { geminiCompleteJson } from './gemini';
import { toScriptProviderMeta } from './config';
import { isCosMediaConfigured, tryUploadBufferToCosAndSign } from '../cos-media.ts';
import type { LlmUsageContext, LlmUsageContextInput } from '../usage-llm.ts';
import { llmExecutionQuote } from '../usage-llm.ts';
import { createHash } from 'node:crypto';
import { requireAccessContext } from '../media-core/access-context.ts';
import { getExecutionModuleRuntime } from '../media-core/execution/module-runtime.ts';
import { executeExecutionContinuation, registerExecutionContinuation } from '../media-core/execution/module-adapters.ts';
import type { ExecutionGrant } from '../media-core/execution/context.ts';
import type { LlmExecutionTransport } from './transport-execution.ts';
import { readLlmExecutionCheckpoint, writeLlmExecutionCheckpoint } from './execution-checkpoints.ts';
import { getDb } from '../db.ts';
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

export interface LlmExecutionRequestBudget {
  kind: 'script-studio-text' | 'script-studio-phase';
  taskId: string;
  requestedCount: number;
  planIndex: number;
  purpose: string;
}

export interface LlmExecutionContext {
  taskId: string;
  step: string;
  inputRevision?: string;
  scope: { resourceType: string; resourceId: string };
  requiredPools?: readonly string[];
  businessAttempt?: { id: string; number: number };
  requestBudget?: LlmExecutionRequestBudget;
}

type LlmRequestBudgetReserver = (db: ReturnType<typeof getDb>, budget: LlmExecutionRequestBudget) => void;
let llmRequestBudgetReserver: LlmRequestBudgetReserver | null = null;

/** 模块在运行时注册自己的持久预算；公共传输层只在真正获准后调用。 */
export function registerLlmExecutionRequestBudgetReserver(reserver: LlmRequestBudgetReserver): void {
  llmRequestBudgetReserver = reserver;
}

export interface CompleteJsonInput {
  providerId: string;
  /** 任务快照固定的模型；提供时覆盖当前供应商配置，避免排队期间配置漂移改变实际调用。 */
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: Array<{ mimeType: string; imageBase64: string }>;
  preserveImageBytes?: boolean;
  usageContext?: LlmUsageContextInput;
  executionContext?: LlmExecutionContext;
  onTextDelta?: (accumulated: string) => void;
  onReasoningDelta?: (accumulated: string) => void;
}

export class LlmExecutionUnknownError extends Error {
  readonly code = 'llm_execution_unknown';

  constructor() {
    super('LLM 调用结果尚未核清，未自动重提');
    this.name = 'LlmExecutionUnknownError';
  }
}

export class LlmExecutionDeferredError extends Error {
  readonly code = 'llm_execution_deferred';
  readonly operationId: string;
  readonly waitReason: string | null;

  constructor(operationId: string, waitReason: string | null) {
    super('LLM 调用正在等待统一执行名额');
    this.name = 'LlmExecutionDeferredError';
    this.operationId = operationId;
    this.waitReason = waitReason;
  }
}

async function completeJsonDirect<T>(
  input: CompleteJsonInput,
  executionTransport?: LlmExecutionTransport,
  frozenRuntime?: Partial<ReturnType<typeof resolveStoredScriptProvider>>,
): Promise<T> {
  checkConfigured(input.providerId);
  const storedRuntime = resolveStoredScriptProvider(input.providerId);
  const configuredRuntime = { ...storedRuntime, ...(frozenRuntime ?? {}), apiKey: storedRuntime.apiKey };
  const runtime = input.model?.trim() ? { ...configuredRuntime, model: input.model.trim() } : configuredRuntime;
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
        const imageUrl = await tryUploadBufferToCosAndSign(Buffer.from(image.imageBase64, 'base64'), image.mimeType, input.preserveImageBytes ? { compress: false } : undefined);
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
    executionTransport,
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

type LlmOperationSnapshot = {
  request: CompleteJsonInput;
  provider: ReturnType<typeof providerExecutionSnapshot>;
};

function providerExecutionSnapshot(runtime: ReturnType<typeof resolveStoredScriptProvider>) {
  return {
    id: runtime.id,
    name: runtime.name,
    type: runtime.type,
    apiStyle: runtime.apiStyle,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    maxTokens: runtime.maxTokens,
    executionScope: runtime.executionScope,
    supportsVision: runtime.supportsVision,
  };
}

function persistentRequest(input: CompleteJsonInput): CompleteJsonInput {
  return {
    providerId: input.providerId,
    model: input.model,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    images: input.images,
    preserveImageBytes: input.preserveImageBytes,
    usageContext: input.usageContext,
    executionContext: input.executionContext,
  };
}

async function executeLlmGrant(
  grant: ExecutionGrant,
  facade: LlmExecutionTransport['facade'],
  liveInput?: CompleteJsonInput,
): Promise<void> {
  const snapshot = grant.inputSnapshot as LlmOperationSnapshot;
  const transport: LlmExecutionTransport = {
    facade,
    grant,
    quote: grant.operation.quote,
    persistCheckpoint: (attemptId, rawText) => writeLlmExecutionCheckpoint(grant.operation.id, attemptId, rawText),
  };
  const input = liveInput ?? snapshot.request;
  try {
    const requestBudget = input.executionContext?.requestBudget;
    if (requestBudget && grant.attempt.submitRound === 1) {
      if (!llmRequestBudgetReserver) throw new Error('server LLM 请求预算尚未注册，拒绝继续执行');
      llmRequestBudgetReserver(getDb(), requestBudget);
    }
    await completeJsonDirect(input, transport, snapshot.provider);
  } catch (error) {
    if (!transport.submittingStarted) {
      await facade.settle({
        attemptId: grant.attempt.id,
        outcome: 'not_created',
        actualCost: null,
        remoteTerminal: true,
        errorCode: 'preflight_failed',
      });
    }
    throw error;
  }
}

const LLM_CONTINUATION_KEY = 'script-providers.completeJson.v1';

registerExecutionContinuation(LLM_CONTINUATION_KEY, async (grant, facade) => {
  await executeLlmGrant(grant, facade);
});

export async function completeJson<T>(input: CompleteJsonInput): Promise<T> {
  const moduleRuntime = getExecutionModuleRuntime();
  if (!moduleRuntime) return completeJsonDirect<T>(input);
  const context = input.executionContext;
  if (!context?.taskId.trim() || !context.step.trim() || !context.scope.resourceId.trim()) {
    throw new Error('server LLM 调用缺少稳定执行上下文');
  }
  if (input.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
  const access = requireAccessContext();
  if (access.kind !== 'team') throw new Error('server LLM 调用缺少团队发起人上下文');
  checkConfigured(input.providerId);
  const stored = resolveStoredScriptProvider(input.providerId);
  const runtime = input.model?.trim() ? { ...stored, model: input.model.trim() } : stored;
  const capability = input.images?.length ? 'media' : 'model';
  if (runtime.executionScope === 'company') {
    await assertProviderExecutionAvailable(runtime, {
      capability,
      mediaTransportAvailable: isCosMediaConfigured(),
    });
  } else {
    assertExternalProviderExecutionAvailable(runtime, capability);
  }
  const provider = providerExecutionSnapshot(runtime);
  let snapshot: LlmOperationSnapshot = { request: persistentRequest(input), provider };
  const inputRevision = context.inputRevision ?? 'r1';
  const operationKey = `llm/${context.taskId}/${context.step}/${inputRevision}`;
  const requiredPools = context.requiredPools ?? ['llm:remote'];
  const quote = llmExecutionQuote(runtime, runtime.model);
  let inputHash = createHash('sha256').update(JSON.stringify({ snapshot, context })).digest('hex');
  const existing = getDb().prepare(`
    SELECT inputSnapshotJson, inputHash FROM execution_operations WHERE actorId = ? AND operationKey = ?
  `).get(access.actor.userId, operationKey) as { inputSnapshotJson: string; inputHash: string } | undefined;
  if (existing) {
    const persisted = JSON.parse(existing.inputSnapshotJson) as LlmOperationSnapshot;
    const comparable = (request: CompleteJsonInput) => JSON.stringify({ ...persistentRequest(request), model: undefined });
    if (comparable(input) === comparable(persisted.request)) {
      snapshot = persisted;
      inputHash = existing.inputHash;
    }
  }
  const enqueue = () => moduleRuntime.facade.enqueue({
    operationKey,
    actor: { userId: access.actor.userId },
    scope: context.scope,
    module: 'llm',
    taskId: context.taskId,
    step: context.step,
    inputRevision,
    businessAttempt: context.businessAttempt ?? { id: `${context.taskId}:${context.step}`, number: 1 },
    inputSnapshot: snapshot,
    inputHash,
    continuationKey: LLM_CONTINUATION_KEY,
    providerSnapshot: provider,
    configVersion: `${runtime.apiStyle}:${runtime.model}:${runtime.baseUrl}`,
    requiredPools,
    quote,
  });
  let operation = enqueue().operation;
  for (;;) {
    if (operation.status === 'succeeded') {
      const rawText = typeof operation.result === 'string'
        ? operation.result
        : readLlmExecutionCheckpoint(operation.id);
      if (rawText === null) throw new Error('LLM 执行检查点缺少原始正文');
      return parseJsonResponse<T>(rawText, runtime.name);
    }
    if (operation.status === 'failed') throw new Error('LLM 调用失败，请查看执行台账');
    if (operation.status === 'unknown' || operation.status === 'reconciling') {
      throw new LlmExecutionUnknownError();
    }
    const admitted = moduleRuntime.facade.admit({
      instanceId: moduleRuntime.instanceId,
      fence: moduleRuntime.fence,
    });
    if (admitted.kind !== 'admitted') {
      throw new LlmExecutionDeferredError(operation.id, operation.waitReason);
    }
    const own = admitted.grant.operation.id === operation.id;
    try {
      if (admitted.grant.continuationKey === LLM_CONTINUATION_KEY) {
        await executeLlmGrant(admitted.grant, moduleRuntime.facade, own ? input : undefined);
      } else {
        await executeExecutionContinuation(admitted.grant, moduleRuntime.facade);
      }
    } catch (error) {
      if (own) {
        operation = enqueue().operation;
        if (operation.status === 'unknown' || operation.status === 'reconciling') {
          throw new LlmExecutionUnknownError();
        }
        throw error;
      }
    }
    operation = enqueue().operation;
  }
}

export async function analyzeSellingPoints(
  input: AnalysisInput,
  providerId: string,
  usageContext?: LlmUsageContextInput,
  executionContext?: LlmExecutionContext,
): Promise<AnalysisResult> {
  const runtime = resolveStoredScriptProvider(providerId);
  const defaultCompletionOptions = {
    usageContext: { enabled: true } satisfies LlmUsageContext,
  };
  return completeJson<AnalysisResult>({
    providerId,
    systemPrompt: 'You are a professional e-commerce content strategist. Always respond with valid JSON only, no markdown fences.',
    userPrompt: buildAnalysisPrompt(input),
    temperature: 0.7,
    maxTokens: runtime.maxTokens,
    usageContext: { ...defaultCompletionOptions.usageContext, ...(usageContext ?? {}) },
    executionContext,
  });
}
