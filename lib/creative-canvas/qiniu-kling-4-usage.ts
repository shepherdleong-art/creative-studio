import type Database from 'better-sqlite3';
import { QINIU_KLING_4_DEFAULT_RESOLUTION } from '../company-qiniu-kling-4.ts';
import { QINIU_KLING_4_LEGACY_FIVE_SECOND_PRICE, QINIU_KLING_4_PRICING_VERSION, qiniuKling4BillingSeconds } from '../qiniu-kling-4-pricing.ts';
import {
  CORE_USAGE_PRICING_VERSION, createCoreUsageSnapshot, resolveCoreUsagePlan,
  type CoreUsagePlan, type CoreUsageProviderSnapshot,
} from '../usage-pricing.ts';
import { parseUsageSnapshot } from '../usage-snapshot.ts';
import { readCanvasTaskPricingSnapshot } from './frozen-usage-pricing.ts';
import { readCanvasReferenceVideoDuration } from './reference-video-duration.ts';
import type { CanvasTaskRecord } from './tasks.ts';

export function qiniuKling4CanvasUsageBasis(
  db: Database.Database, task: CanvasTaskRecord, identity: CoreUsageProviderSnapshot, defaultPlan: CoreUsagePlan,
  parameters: Record<string, unknown>, generationMode: unknown, purpose: 'quote' | 'actual',
): { plan: CoreUsagePlan; quantity: number | null; detail: Record<string, unknown> } | null {
  const frozen = purpose === 'actual' ? readCanvasTaskPricingSnapshot(db, task.id) : undefined;
  if (frozen !== undefined) {
    if (!frozen || frozen.coreModelKey !== defaultPlan.coreModelKey) return null;
    const quantity = frozen.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
    const legacy = frozen.pricingVersion === CORE_USAGE_PRICING_VERSION && frozen.priceComponents === undefined;
    const base = createCoreUsageSnapshot(identity, defaultPlan, { refType: 'canvas-task', refId: task.id });
    const parsed = parseUsageSnapshot({
      ...base,
      pricingVersion: frozen.pricingVersion,
      priceComponents: legacy
        ? [{ key: 'second', unit: 'second', unitPriceMicros: QINIU_KLING_4_LEGACY_FIVE_SECOND_PRICE, priceScale: 5 }]
        : frozen.priceComponents,
      estimatedBillingSeconds: frozen.pricingVersion === QINIU_KLING_4_PRICING_VERSION ? quantity : undefined,
    });
    if (!parsed.ok) return null;
    const { pricingVersion, priceComponents } = parsed.parsed.snapshot;
    const [{ unitPriceMicros, priceScale }] = priceComponents;
    return {
      plan: { ...defaultPlan, pricingVersion, priceComponents, unitPriceMicros, priceScale },
      quantity,
      detail: { estimated: true, measurementSource: 'frozen_quote' },
    };
  }
  const resolution = parameters.resolution ?? QINIU_KLING_4_DEFAULT_RESOLUTION;
  const inputSeconds = readCanvasReferenceVideoDuration(db, task, generationMode);
  if (inputSeconds === null) return null;
  const outputSeconds = Number(parameters.durationSec ?? 5);
  const plan = resolveCoreUsagePlan(identity, { resolution, hasInputVideo: inputSeconds > 0 });
  if (!plan) return null;
  return {
    plan,
    quantity: qiniuKling4BillingSeconds(outputSeconds, inputSeconds),
    detail: { estimated: true, measurementSource: 'task_snapshot', resolution, inputVideoDurationSec: inputSeconds, outputVideoDurationSec: outputSeconds },
  };
}
