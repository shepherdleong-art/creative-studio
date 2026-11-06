import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createCoreUsageSnapshot,
  resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
} from './usage-pricing.ts';
import {
  beginUsageCall,
  drainBillableUsageCalls,
  markUsageCallBillable,
} from './usage-ledger.ts';
import { getDb } from './db.ts';
import { isUsageSchemaReady } from './usage-schema.ts';
import type { CostQuote, Money } from './media-core/execution/context.ts';

export interface TtsUsageContext {
  projectId?: string | null;
  refType?: string;
  refId?: string;
  detail?: Record<string, unknown>;
  executionAttemptId?: string | null;
}

export interface DoubaoTtsUsageProviderIdentity {
  model?: string;
  providerId?: string;
  providerName?: string;
  providerType?: string;
  configuredModel?: string;
  requestModel?: string;
}

function doubaoUsagePlan(provider: DoubaoTtsUsageProviderIdentity) {
  if (provider.model !== 'seed-tts-2.0') return null;
  return resolveCoreUsagePlan({
    providerTable: 'final_edit_tts_providers',
    providerId: provider.providerId ?? '',
    providerName: provider.providerName ?? '',
    providerType: provider.providerType ?? '',
    configuredModel: provider.configuredModel ?? '',
    requestModel: provider.requestModel ?? '',
  });
}

function doubaoTtsCost(provider: DoubaoTtsUsageProviderIdentity, text: string): { money: Money; pricingSnapshot: unknown } | null {
  const plan = doubaoUsagePlan(provider);
  if (!plan || plan.unit !== 'character') return null;
  return {
    money: {
      currency: 'CNY',
      minor: Math.ceil(Array.from(text).length * plan.unitPriceMicros / (plan.priceScale * 10_000)),
    },
    pricingSnapshot: {
      coreModelKey: plan.coreModelKey,
      pricingVersion: plan.pricingVersion,
      priceComponents: plan.priceComponents,
    },
  };
}

export function doubaoTtsExecutionQuote(provider: DoubaoTtsUsageProviderIdentity, text: string): CostQuote {
  const cost = doubaoTtsCost(provider, text);
  return cost
    ? { kind: 'priced', reserve: cost.money, pricingSnapshot: cost.pricingSnapshot }
    : { kind: 'unpriced', pricingSnapshot: null };
}

export function doubaoTtsActualCost(provider: DoubaoTtsUsageProviderIdentity, text: string): Money | null {
  return doubaoTtsCost(provider, text)?.money ?? null;
}

export interface DoubaoTtsUsageHandle {
  enabled: boolean;
  eventKey: string;
  db?: Database.Database;
}

function disabledHandle(): DoubaoTtsUsageHandle {
  return { enabled: false, eventKey: '' };
}

/**
 * Begin one durable TTS call event. The exact provider identity is checked
 * before opening the database, so non-core TTS remains a normal best-effort
 * call with no usage side effects.
 */
export function beginDoubaoTtsUsage(
  provider: DoubaoTtsUsageProviderIdentity,
  context: TtsUsageContext | undefined,
): DoubaoTtsUsageHandle {
  const eventKey = `tts-call:${randomUUID()}`;
  if (provider.model !== 'seed-tts-2.0') return disabledHandle();
  const providerSnapshot: CoreUsageProviderSnapshot = {
    providerTable: 'final_edit_tts_providers',
    providerId: provider.providerId ?? '',
    providerName: provider.providerName ?? '',
    providerType: provider.providerType ?? '',
    configuredModel: provider.configuredModel ?? '',
    requestModel: provider.requestModel ?? '',
  };
  const plan = resolveCoreUsagePlan(providerSnapshot);
  if (!plan) return disabledHandle();

  try {
    const db = getDb();
    if (!isUsageSchemaReady(db)) {
      // 核心 TTS 调用仍照常执行，但本次不进入消耗统计；必须留下脱敏告警。
      console.error('[usage-ledger] schema unavailable; usage accounting skipped for this TTS call');
      return disabledHandle();
    }
    const snapshot = createCoreUsageSnapshot(providerSnapshot, plan, {
      projectId: context?.projectId ?? undefined,
      refType: context?.refType ?? 'tts',
      refId: context?.refId ?? eventKey,
    });
    const started = beginUsageCall(db, {
      eventKey,
      snapshot,
      projectId: context?.projectId,
      refType: context?.refType ?? 'tts',
      refId: context?.refId ?? eventKey,
      executionAttemptId: context?.executionAttemptId,
    });
    return started.ok ? { enabled: true, eventKey, db } : disabledHandle();
  } catch {
    // Usage accounting must never block a real TTS request.
    return disabledHandle();
  }
}

/** Mark the upstream-success evidence; local audio processing happens later. */
export function markDoubaoTtsUsageBillable(
  handle: DoubaoTtsUsageHandle,
  text: string,
  context: TtsUsageContext | undefined,
): void {
  if (!handle.enabled || !handle.db || !handle.eventKey) return;
  try {
    const marked = markUsageCallBillable(handle.db, handle.eventKey, {
      quantity: { character: Array.from(text).length },
      callCount: 1,
      detail: {
        ...(context?.detail ?? {}),
        source: 'doubao-tts',
      },
    });
    if (marked.ok) drainBillableUsageCalls(handle.db);
  } catch {
    // The upstream audio is already valid; ledger errors are reconciled later.
  }
}
