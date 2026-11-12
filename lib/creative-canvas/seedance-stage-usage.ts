import { readCanvasTaskPricingSnapshot } from './frozen-usage-pricing.ts';
import { parseUsageSnapshot } from '../usage-snapshot.ts';
import type Database from 'better-sqlite3';
import { createCoreUsageSnapshot, resolveCoreUsagePlan, type CoreUsagePlan, type CoreUsageProviderSnapshot } from '../usage-pricing.ts';
import {
  estimateSeedance25ReferenceVideoTokens,
  estimateSeedance25VideoTokens,
  seedance25StageOutputSize,
  SEEDANCE_25_MINIMUM_TOKEN_RULE_VERSION,
} from '../seedance-2-5-pricing.ts';
import type { CanvasTaskRecord } from './tasks.ts';

export interface SeedanceStageUsageBasis {
  plan: CoreUsagePlan;
  quantity: number | null;
  detail: Record<string, unknown>;
}

interface MediaFacts {
  mediaKind: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadata(db: Database.Database, taskId: string): Record<string, unknown> {
  const row = db.prepare('SELECT metadataJson FROM creative_canvas_video_metadata WHERE taskId = ?')
    .get(taskId) as { metadataJson: string } | undefined;
  return object(row?.metadataJson);
}

/** Read immutable task inputs; a Final task's Draft asset is never an input video. */
function inputs(db: Database.Database, taskId: string, canvasId: string): MediaFacts[] | null {
  const rows = db.prepare(`SELECT a.mediaKind, a.width, a.height, a.durationSec
    FROM creative_canvas_task_inputs i
    LEFT JOIN creative_canvas_tasks upstream ON upstream.id = i.upstreamTaskId AND upstream.canvasId = ?
    LEFT JOIN creative_canvas_assets a ON a.id = COALESCE(i.resolvedAssetId, i.assetId, upstream.outputAssetId)
      AND a.canvasId = ? AND a.ready = 1
    WHERE i.taskId = ? AND i.textContent IS NULL ORDER BY i.orderIndex`)
    .all(canvasId, canvasId, taskId) as MediaFacts[];
  return rows.some((row) => !row.mediaKind) ? null : rows;
}

/** 官方 token 计价只用于 Seedance 2.5 的样片/转高清；普通任务保留原均价。 */
export function seedanceStageUsageBasis(
  db: Database.Database,
  task: CanvasTaskRecord,
  identity: CoreUsageProviderSnapshot,
  purpose: 'quote' | 'actual',
): SeedanceStageUsageBasis | null {
  if (identity.requestModel !== 'doubao-seedance-2-5-260628') return null;
  const snapshot = object(task.parameterSnapshot);
  const parameters = object(snapshot.parameters);
  const stage = parameters.generationStage;
  if (stage !== 'draft' && stage !== 'final-from-draft') return null;
  let sourceTaskId = task.id;
  let sourceParameters = parameters;
  let sourceMode = snapshot.generationMode;
  if (stage === 'final-from-draft') {
    // Billing can replay an expired Draft; only generation admission checks its expiry.
    const source = db.prepare(`SELECT t.id, t.providerSnapshot, t.parameterSnapshot, m.metadataJson
      FROM creative_canvas_assets a JOIN creative_canvas_tasks t ON t.outputAssetId = a.id
      JOIN creative_canvas_video_metadata m ON m.taskId = t.id
      WHERE a.id = ? AND a.canvasId = ? AND a.ready = 1 AND t.phase = 'succeeded'`)
      .get(String(parameters.draftAssetId ?? ''), task.canvasId) as
      { id: string; providerSnapshot: string; parameterSnapshot: string; metadataJson: string } | undefined;
    if (!source) return null;
    const provider = object(source.providerSnapshot);
    const taskProvider = object(task.providerSnapshot);
    const sourceSnapshot = object(source.parameterSnapshot);
    const sourceMetadata = object(source.metadataJson);
    sourceParameters = object(sourceSnapshot.parameters);
    if (provider.modelAlias !== identity.requestModel || provider.providerIdentity !== taskProvider.providerIdentity
      || sourceParameters.generationStage !== 'draft' || sourceMetadata.stage !== 'draft'
      || sourceMetadata.draftConfirmed !== true) return null;
    sourceTaskId = source.id;
    sourceMode = sourceSnapshot.generationMode;
  }
  const sourceInputs = inputs(db, sourceTaskId, task.canvasId);
  if (!sourceInputs) return null;
  const sourceMetadata = metadata(db, sourceTaskId);
  const videos = sourceInputs.filter((input) => input.mediaKind === 'video');
  const referenceDuration = sourceMetadata.referenceVideoDurationSec;
  const hasFrozenReferenceDuration = typeof referenceDuration === 'number' && Number.isFinite(referenceDuration) && referenceDuration > 0;
  const hasInputVideo = videos.length > 0 || hasFrozenReferenceDuration;
  const inputVideoDurationSec = hasFrozenReferenceDuration ? referenceDuration
    : videos.some((video) => video.durationSec === null || !Number.isFinite(video.durationSec) || video.durationSec <= 0)
      ? null : videos.reduce((sum, video) => sum + video.durationSec!, 0);
  let plan = resolveCoreUsagePlan(identity, { generationStage: stage, hasInputVideo });
  if (!plan) return null;
  if (purpose === 'actual') {
    const quote = readCanvasTaskPricingSnapshot(db, task.id);
    if (quote !== undefined) {
      // Preserve old unpriced attempts; never synthesize a price after submission.
      if (!quote || quote.coreModelKey !== plan.coreModelKey) return null;
      const frozen = parseUsageSnapshot({
        ...createCoreUsageSnapshot(identity, plan, { refType: 'canvas-task', refId: task.id }),
        pricingVersion: quote.pricingVersion, priceComponents: quote.priceComponents,
      });
      if (!frozen.ok || frozen.parsed.snapshot.priceComponents.length !== 1
        || frozen.parsed.snapshot.priceComponents[0].key !== 'output_token') return null;
      const component = frozen.parsed.snapshot.priceComponents[0];
      plan = { ...plan, pricingVersion: frozen.parsed.snapshot.pricingVersion,
        priceComponents: frozen.parsed.snapshot.priceComponents, unit: component.unit,
        unitPriceMicros: component.unitPriceMicros, priceScale: component.priceScale };
    }
  }
  // Query by task ID: callers may still hold the pre-download task object.
  const output = db.prepare(`SELECT a.mediaKind, a.width, a.height, a.durationSec
    FROM creative_canvas_tasks t JOIN creative_canvas_assets a ON a.id = t.outputAssetId
    WHERE t.id = ? AND a.canvasId = ? AND a.ready = 1`).get(task.id, task.canvasId) as MediaFacts | undefined;
  const sourceOutput = stage === 'final-from-draft'
    ? db.prepare(`SELECT a.durationSec FROM creative_canvas_tasks t
        JOIN creative_canvas_assets a ON a.id = t.outputAssetId WHERE t.id = ? AND a.canvasId = ?`)
      .get(sourceTaskId, task.canvasId) as { durationSec: number | null } | undefined : undefined;
  const durationSec = Number(output?.durationSec ?? sourceOutput?.durationSec ?? sourceParameters.durationSec ?? 0);
  const detail: Record<string, unknown> = {
    generationStage: stage, resolution: stage === 'draft' ? '480p' : '1080p',
    hasInputVideo, inputVideoDurationSec, durationSec, estimated: true,
    ...(stage === 'final-from-draft' ? { draftAssetId: parameters.draftAssetId } : {}),
  };
  if (purpose === 'actual') {
    if (!output) return { plan, quantity: null, detail };
    const usage = object(metadata(db, task.id).usage);
    const tokens = usage.completion_tokens;
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0) {
      return { plan, quantity: tokens, detail: { ...detail, estimated: false } };
    }
  }
  // A quote is a reservation. Actual video-reference charges still require the
  // provider's usage, including its authoritative minimum billable token count.
  if (hasInputVideo && purpose === 'actual') return { plan, quantity: null, detail };
  let size: readonly [number, number] | null = null;
  if (purpose === 'actual' && output?.width && output.height) size = [output.width, output.height];
  if (!size) {
    const adaptive = sourceMode === 'image-to-video' || sourceMode === 'video-edit' || sourceMode === 'video-extend'
      || sourceParameters.aspectRatio === 'adaptive';
    if (adaptive) {
      const first = sourceInputs.find((input) => input.mediaKind === 'video' || input.mediaKind === 'image');
      if (first?.width && first.height) {
        const ratio = first.width / first.height;
        const standard = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].find((candidate) => {
          const [w, h] = candidate.split(':').map(Number);
          return Math.abs(ratio / (w / h) - 1) < 0.01;
        });
        if (standard) size = seedance25StageOutputSize(stage, standard);
      }
    } else {
      size = seedance25StageOutputSize(stage, String(sourceParameters.aspectRatio ?? '16:9'));
    }
  }
  if (hasInputVideo) {
    const estimate = size && inputVideoDurationSec !== null
      ? estimateSeedance25ReferenceVideoTokens(durationSec, inputVideoDurationSec, size[0], size[1]) : null;
    return {
      plan,
      quantity: estimate?.billableTokens ?? null,
      detail: {
        ...detail,
        minimumTokenRuleVersion: SEEDANCE_25_MINIMUM_TOKEN_RULE_VERSION,
        ...(estimate ?? {}),
      },
    };
  }
  const quantity = size ? estimateSeedance25VideoTokens(durationSec, size[0], size[1]) : null;
  return { plan, quantity, detail };
}
