import { setMaxListeners } from 'node:events';
import type Database from 'better-sqlite3';
import { isServerMediaExecution } from './legacy-media-execution.ts';
import { ExecutionError } from './media-core/execution/context.ts';
import { configuredProviderPool } from './media-core/execution/configured-provider-pool.ts';
import { readExecutionPool } from './media-core/execution/pools.ts';
import { resolveQueueWorkerCount, type QueuePoolDemand } from './team-service/production-defaults.ts';
import {
  normalizeUnifiedImageTier,
  unifiedImageCompatibleChannels,
} from './media-core/unified-media/catalog.ts';
import { unifiedImageProviderAvailability } from './media-core/unified-media/execution.ts';

interface MediaQueueWorkers {
  db: Database.Database;
  module: 'image' | 'video';
  projectId: string;
  jobId?: string;
  concurrency: number;
  signal: AbortSignal;
  worker(): Promise<void>;
}

function poolDemands(input: MediaQueueWorkers): QueuePoolDemand[] {
  const table = input.module === 'image' ? 'jobs' : 'video_jobs';
  const reworkKind = input.module === 'image' ? 'generate_image' : 'generate_video';
  const runnable = input.module === 'image'
    ? "status IN ('pending', 'retrying', 'running', 'deferred') OR ((status = 'needs_check' OR providerStatus = 'download_failed') AND (providerTaskId IS NOT NULL OR (providerStatus = 'download_failed' AND remoteImageUrl IS NOT NULL)))"
    : "status IN ('pending', 'running', 'deferred') OR ((status = 'needs_check' OR providerStatus = 'download_failed') AND providerTaskId IS NOT NULL)";
  const rows = input.db.prepare(`
    SELECT providerId, ${input.module === 'image' ? 'unifiedModel, unifiedRequestJson' : 'NULL AS unifiedModel, NULL AS unifiedRequestJson'},
      COUNT(*) AS taskCount FROM ${table}
    WHERE projectId = ? AND (? IS NULL OR id = ?)
      AND (${runnable})
      AND NOT EXISTS (SELECT 1 FROM final_edit_film_reworks r WHERE r.jobId = ${table}.id AND r.kind = ?)
    GROUP BY providerId ${input.module === 'image' ? ', unifiedModel, unifiedRequestJson' : ''}
  `).all(input.projectId, input.jobId ?? null, input.jobId ?? null, reworkKind) as Array<{
    providerId: string; unifiedModel: string | null; unifiedRequestJson: string | null; taskCount: number;
  }>;
  const pools = new Map<string, QueuePoolDemand>();
  for (const row of rows) {
    let poolKey = `unconfigured:${row.providerId}`;
    let capacity = 1;
    try {
      let providerId = row.providerId;
      if (row.unifiedModel && row.unifiedRequestJson) {
        const frozen = JSON.parse(row.unifiedRequestJson) as { tier?: unknown; ratio?: unknown };
        const tier = normalizeUnifiedImageTier(frozen.tier);
        const ratio = typeof frozen.ratio === 'string' ? frozen.ratio : '';
        const availability = new Map(unifiedImageProviderAvailability(input.db)
          .filter((channel) => channel.identityValid && channel.configured)
          .map((channel) => [channel.channelKey, channel]));
        const selected = tier ? unifiedImageCompatibleChannels(tier, ratio)
          .find((channel) => availability.has(channel.channelKey)) : undefined;
        if (selected) providerId = selected.providerId;
      }
      const configured = configuredProviderPool(input.db, input.module, providerId);
      if (configured) {
        poolKey = configured;
        const pool = readExecutionPool(input.db, poolKey);
        capacity = pool.enabled ? pool.capacity : 0;
      }
    } catch (error) {
      if (!(error instanceof ExecutionError) || !['pool_missing', 'pool_mapping_mismatch'].includes(error.code)) throw error;
      // One worker surfaces the existing configuration error. It grants no permit.
    }
    const demand = pools.get(poolKey);
    if (demand) demand.taskCount += row.taskCount;
    else pools.set(poolKey, { capacity, taskCount: row.taskCount });
  }
  return [...pools.values()];
}

/** Workers only arrange work; execution admission remains the authority for paid calls. */
export async function runMediaQueueWorkers(input: MediaQueueWorkers): Promise<void> {
  if (!isServerMediaExecution()) {
    const count = resolveQueueWorkerCount({ mode: 'local', concurrency: input.concurrency });
    await Promise.allSettled(Array.from({ length: count }, () => input.worker()));
    return;
  }
  // Each active job links its request to the queue signal and removes it on completion.
  setMaxListeners(0, input.signal);
  const active = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  do {
    const count = resolveQueueWorkerCount({ mode: 'server', poolDemands: poolDemands(input) });
    while (active.size < count && !input.signal.aborted && !failure) {
      const task = Promise.resolve().then(() => input.worker())
        .catch(error => { failure ??= { error }; })
        .finally(() => { active.delete(task); });
      active.add(task);
    }
    if (active.size === 0) break;
    // Re-read capacity and demand so new jobs, providers and pool increases take effect.
    await Promise.race([
      Promise.all(active),
      new Promise<void>(resolve => setTimeout(resolve, 250)),
    ]);
  } while (!input.signal.aborted && !failure);
  await Promise.all(active);
  if (failure) throw failure.error;
}
