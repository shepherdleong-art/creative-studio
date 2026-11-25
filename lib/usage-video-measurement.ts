import type Database from 'better-sqlite3';
import type { CoreUsageQuantities, CoreUsageSnapshotV1 } from './usage-pricing.ts';
import { QINIU_KLING_4_DEFAULT_RESOLUTION } from './company-qiniu-kling-4.ts';
import { QINIU_KLING_4_PRICING_VERSION, qiniuKling4BillingSeconds } from './qiniu-kling-4-pricing.ts';
import {
  minimaxH3Resolution, minimaxH3Quantities, minimaxH3UsageDetail,
  parseMiniMaxH3VideoUsage, referenceVideoDurationSec, type MiniMaxH3VideoUsage,
} from './minimax-h3-pricing.ts';

/** Read the job's frozen output settings and ordered original reference assets. */
function readVideoJobUsageSettings(db: Database.Database, jobId: string) {
  try {
    const job = db.prepare('SELECT projectId, resolution, generationMode, durationSec FROM video_jobs WHERE id = ?')
      .get(jobId) as { projectId: string; resolution: string | null; generationMode: string; durationSec: number } | undefined;
    if (!job) return null;
    const references = job.generationMode === 'reference-to-video'
      ? db.prepare(`SELECT a.kind, a.durationSec FROM video_job_references i
          LEFT JOIN video_reference_assets a ON a.id = i.assetId AND a.projectId = ?
          WHERE i.jobId = ? ORDER BY i.orderIndex`).all(job.projectId, jobId) as { kind: string | null; durationSec: number | null }[]
      : [];
    // No explicit references means the implicit source image, never an input video.
    const inputVideoDurationSec = referenceVideoDurationSec(references);
    if (inputVideoDurationSec === null) return null;
    return { ...job, inputVideoDurationSec };
  } catch {
    return null;
  }
}

export function readMiniMaxH3JobUsage(db: Database.Database, jobId: string): MiniMaxH3VideoUsage | null {
  const job = readVideoJobUsageSettings(db, jobId);
  if (!job) return null;
  const resolution = minimaxH3Resolution(job.generationMode === 'reference-to-video' ? job.resolution : undefined);
  return parseMiniMaxH3VideoUsage({ resolution, inputVideoDurationSec: job.inputVideoDurationSec, outputVideoDurationSec: job.durationSec });
}

export function readQiniuKling4JobUsage(db: Database.Database, jobId: string) {
  const job = readVideoJobUsageSettings(db, jobId);
  if (!job) return null;
  const estimatedBillingSeconds = qiniuKling4BillingSeconds(job.durationSec, job.inputVideoDurationSec);
  if (estimatedBillingSeconds === null) return null;
  return {
    resolution: job.resolution ?? QINIU_KLING_4_DEFAULT_RESOLUTION,
    hasInputVideo: job.inputVideoDurationSec > 0,
    estimatedBillingSeconds,
  };
}

/** Shared by reservation, settlement, live ledger and reconciliation. */
export function videoJobUsageMeasurement(snapshot: CoreUsageSnapshotV1, durationSec: number | null | undefined): {
  quantity: CoreUsageQuantities;
  detail: Record<string, unknown>;
} | null {
  if (snapshot.priceComponents.some((component) => component.key === 'input_second')) {
    const usage = parseMiniMaxH3VideoUsage(snapshot.videoUsage);
    return usage ? { quantity: minimaxH3Quantities(usage), detail: minimaxH3UsageDetail(usage) } : null;
  }
  if (snapshot.pricingVersion === QINIU_KLING_4_PRICING_VERSION) {
    const seconds = snapshot.estimatedBillingSeconds;
    return seconds === undefined ? null : {
      quantity: seconds,
      detail: { estimated: true, measurementSource: 'task_snapshot' },
    };
  }
  return {
    quantity: typeof durationSec === 'number' && Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0,
    detail: {},
  };
}
