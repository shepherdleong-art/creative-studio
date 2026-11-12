import { readCanvasTaskPricingSnapshot } from './frozen-usage-pricing.ts';
import type Database from 'better-sqlite3';
import {
  CORE_USAGE_PRICING_VERSION, createCoreUsageSnapshot, resolveCoreUsagePlan,
  type CoreUsagePlan, type CoreUsageProviderSnapshot, type CoreUsageQuantities,
} from '../usage-pricing.ts';
import { parseUsageSnapshot } from '../usage-snapshot.ts';
import { videoJobUsageMeasurement } from '../usage-video-measurement.ts';
import {
  minimaxH3Resolution, minimaxH3Quantities, minimaxH3UsageDetail,
  parseMiniMaxH3VideoUsage, referenceVideoDurationSec, type MiniMaxH3VideoUsage,
} from '../minimax-h3-pricing.ts';
import type { CanvasTaskRecord } from './tasks.ts';

export interface MiniMaxH3UsageBasis {
  plan: CoreUsagePlan;
  quantity: CoreUsageQuantities | null;
  videoUsage?: MiniMaxH3VideoUsage;
  detail: Record<string, unknown>;
}

/** An admitted operation's prices and measurement win across restarts/upgrades. */
function frozenBasis(db: Database.Database, task: CanvasTaskRecord, identity: CoreUsageProviderSnapshot): MiniMaxH3UsageBasis | null | undefined {
  const quote = readCanvasTaskPricingSnapshot(db, task.id);
  if (quote === undefined || quote === null) return quote;
  const legacy = resolveCoreUsagePlan(identity);
  if (!legacy || quote.coreModelKey !== legacy.coreModelKey) return null;
  if (quote.pricingVersion === CORE_USAGE_PRICING_VERSION && !quote.priceComponents
    && typeof quote.quantity === 'number' && Number.isFinite(quote.quantity) && quote.quantity > 0) {
    return { plan: legacy, quantity: quote.quantity, detail: { estimated: true, measurementSource: 'frozen_quote' } };
  }
  const parsed = parseUsageSnapshot({
    ...createCoreUsageSnapshot(identity, legacy, { refType: 'canvas-task', refId: task.id }),
    pricingVersion: quote.pricingVersion, priceComponents: quote.priceComponents, videoUsage: quote.videoUsage,
  });
  if (!parsed.ok) return null;
  const snapshot = parsed.parsed.snapshot;
  const measurement = videoJobUsageMeasurement(snapshot, Number(quote.quantity));
  if (!measurement || !snapshot.videoUsage) return null;
  return {
    plan: { ...legacy, pricingVersion: snapshot.pricingVersion, priceComponents: snapshot.priceComponents,
      unitPriceMicros: 0, priceScale: 1 },
    quantity: measurement.quantity, videoUsage: snapshot.videoUsage, detail: measurement.detail,
  };
}

export function minimaxH3CanvasUsageBasis(
  db: Database.Database, task: CanvasTaskRecord, identity: CoreUsageProviderSnapshot,
  parameters: Record<string, unknown>, generationMode: unknown, purpose: 'quote' | 'actual',
): MiniMaxH3UsageBasis | null {
  if (purpose === 'actual') {
    const frozen = frozenBasis(db, task, identity);
    if (frozen !== undefined) return frozen;
  }
  const resolution = minimaxH3Resolution(parameters.resolution);
  if (!resolution) return null;
  const plan = resolveCoreUsagePlan(identity, { resolution });
  if (!plan) return null;
  // Read task inputs, never the editable graph. Resolve upstream output on this canvas only.
  const references = generationMode === 'reference-to-video'
    ? db.prepare(`SELECT a.mediaKind AS kind, a.durationSec
        FROM creative_canvas_task_inputs i
        LEFT JOIN creative_canvas_tasks upstream ON upstream.id = i.upstreamTaskId AND upstream.canvasId = ?
        LEFT JOIN creative_canvas_assets a ON a.id = COALESCE(i.resolvedAssetId, i.assetId, upstream.outputAssetId)
          AND a.canvasId = ? AND a.ready = 1
        WHERE i.taskId = ? AND i.textContent IS NULL ORDER BY i.orderIndex`)
      .all(task.canvasId, task.canvasId, task.id) as { kind: string | null; durationSec: number | null }[]
    : [];
  const inputVideoDurationSec = referenceVideoDurationSec(references);
  const videoUsage = parseMiniMaxH3VideoUsage({ resolution, inputVideoDurationSec, outputVideoDurationSec: parameters.durationSec });
  if (!videoUsage) return { plan, quantity: null, detail: { resolution, inputVideoDurationSec } };
  return { plan, quantity: minimaxH3Quantities(videoUsage), videoUsage, detail: minimaxH3UsageDetail(videoUsage) };
}
