import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ScriptProviderRuntimeConfig } from './script-providers/config.ts';
import {
  createCoreUsageSnapshot,
  normalizeGptTokenUsage,
  resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
  type NormalizedGptTokenUsage,
} from './usage-pricing.ts';
import {
  beginUsageCall,
  drainBillableUsageCalls,
  markUsageCallBillable,
} from './usage-ledger.ts';
import { getDb } from './db.ts';

export interface LlmUsageContext {
  enabled: true;
  projectId?: string;
  refType?: string;
  refId?: string;
}

/** Public call-site shape; the registry always merges enabled: true. */
export type LlmUsageContextInput = Omit<LlmUsageContext, 'enabled'> & { enabled?: boolean };

export interface LlmUsageAttempt {
  callId: string;
  eventKey: string;
  db: Database.Database;
}

interface ParsedGptUsage {
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  normalized: NormalizedGptTokenUsage;
  rawUsage: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readCachedTokens(usage: Record<string, unknown>): number | null {
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const cachedValue = promptDetails?.cached_tokens ?? inputDetails?.cached_tokens;
  return cachedValue === undefined ? 0 : tokenNumber(cachedValue);
}

function parseGptUsage(value: unknown): ParsedGptUsage | null {
  if (!isRecord(value)) return null;
  const promptTokens = tokenNumber(value.prompt_tokens ?? value.input_tokens);
  const completionTokens = tokenNumber(value.completion_tokens ?? value.output_tokens);
  const cachedReadTokens = readCachedTokens(value);
  if (promptTokens === null || completionTokens === null || cachedReadTokens === null) return null;
  return {
    promptTokens,
    completionTokens,
    cachedReadTokens,
    normalized: normalizeGptTokenUsage({ promptTokens, completionTokens, cachedReadTokens }),
    rawUsage: value,
  };
}

function createProviderSnapshot(
  runtime: Pick<ScriptProviderRuntimeConfig, 'id' | 'name' | 'type' | 'apiStyle' | 'model' | 'executionScope'>,
  requestModel: string,
): CoreUsageProviderSnapshot {
  return {
    providerTable: 'script_providers',
    providerId: runtime.id,
    providerName: runtime.name,
    providerType: runtime.type?.trim() || '',
    executionScope: runtime.executionScope,
    apiStyle: runtime.apiStyle,
    configuredModel: runtime.model,
    requestModel,
  };
}

/** Create durable started evidence only for the exact company GPT core identity. */
export function beginLlmUsageCall(
  runtime: Pick<ScriptProviderRuntimeConfig, 'id' | 'name' | 'type' | 'apiStyle' | 'model' | 'executionScope'>,
  requestModel: string,
  context?: LlmUsageContext,
): LlmUsageAttempt | null {
  if (!context?.enabled) return null;

  // Keep direct adapter/test callers compatible while still taking the persisted
  // type as the source of truth. Never substitute apiStyle for this identity.
  let db: Database.Database | undefined;
  let persistedType = runtime.type?.trim();
  if (!persistedType) {
    try {
      db = getDb();
      persistedType = (
        db.prepare('SELECT type FROM script_providers WHERE id = ?').get(runtime.id) as { type?: unknown } | undefined
      )?.type as string | undefined;
    } catch {
      return null;
    }
  }
  const provider = createProviderSnapshot({ ...runtime, type: typeof persistedType === 'string' ? persistedType : '' }, requestModel);
  const plan = resolveCoreUsagePlan(provider);
  if (!plan) return null;

  const callId = randomUUID();
  const eventKey = `llm-call:${callId}`;
  const projectId = context.projectId?.trim() || '';
  const refType = context.refType?.trim() || 'llm_call';
  const refId = context.refId?.trim() || callId;
  const snapshot = createCoreUsageSnapshot(provider, plan, {
    projectId,
    refType,
    refId,
  });

  try {
    db ??= getDb();
    const started = beginUsageCall(db, {
      eventKey,
      snapshot,
      projectId,
      refType,
      refId,
    });
    if (!started.ok) return null;
    return { callId, eventKey, db };
  } catch {
    // Usage accounting is explicitly best-effort and must never block the model request.
    return null;
  }
}

function estimateTokenUsage(serializedPrompt: string, rawOutput: string): ParsedGptUsage {
  const promptTokens = Array.from(serializedPrompt).length;
  const completionTokens = Array.from(rawOutput).length;
  return {
    promptTokens,
    completionTokens,
    cachedReadTokens: 0,
    normalized: normalizeGptTokenUsage({ promptTokens, completionTokens, cachedReadTokens: 0 }),
    rawUsage: {},
  };
}

/** Mark a successful HTTP response before business JSON parsing, then drain best-effort. */
export function finishLlmUsageCall(
  attempt: LlmUsageAttempt | null,
  input: {
    usage: unknown;
    serializedPrompt: string;
    rawOutput: string;
    hasImages: boolean;
  },
): void {
  if (!attempt) return;

  try {
    const parsed = parseGptUsage(input.usage);
    const measured = parsed ?? estimateTokenUsage(input.serializedPrompt, input.rawOutput);
    const mark = markUsageCallBillable(attempt.db, attempt.eventKey, {
      quantity: measured.normalized,
      callCount: 1,
      category: input.hasImages ? 'llm_vision' : 'llm_text',
      detail: {
        source: 'openai-compatible',
        estimated: parsed === null,
        promptTokens: measured.promptTokens,
        completionTokens: measured.completionTokens,
        uncachedInputTokens: measured.normalized.uncachedInputTokens,
        cachedReadTokens: measured.normalized.cachedReadTokens,
        outputTokens: measured.normalized.outputTokens,
        rawUsage: parsed?.rawUsage ?? null,
      },
    });
    if (!mark.ok) return;
    try {
      drainBillableUsageCalls(attempt.db);
    } catch {
      // A later reconciliation can drain the durable billable evidence.
    }
  } catch {
    // Accounting errors must not replace a successful model response.
  }
}
