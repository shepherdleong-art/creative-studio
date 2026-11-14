import type Database from 'better-sqlite3';
import { readUnifiedChannelHealth } from './health.ts';

/**
 * Tencent shared-pool priority is derived from the frozen work-task snapshot,
 * not from a mutable provider label or a UI hint:
 *
 * - single-channel: no alternative compatible channel can still run;
 * - overflow: this attempt is on Tencent, but another channel is still unused
 *   and currently available.
 *
 * Member rotation and every execution gate are applied before this preference.
 * The aging window only prevents a continuous stream of single-channel work
 * from starving an older overflow task.
 */
export const MEDIA_PRIORITY_AGING_MS = 30_000;

export type MediaAdmissionPriorityClass = 'normal' | 'single_channel' | 'overflow';

export interface MediaAdmissionPriority {
  priority: 0 | 1;
  candidateCount: number;
  priorityClass: MediaAdmissionPriorityClass;
  currentChannelKey: string | null;
  availableChannelKeys: string[];
  reason: string;
  evaluatedAt: string;
}

export interface EffectiveMediaAdmissionPriority extends MediaAdmissionPriority {
  effectivePriority: 0 | 1;
  aged: boolean;
  ageMs: number;
}

interface TaskRow {
  unifiedModel: string;
  status: string;
}

interface ChannelRow {
  channelKey: string;
  state: string;
  providerTable: string;
  providerId: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function hasSubmittedIntent(
  db: Database.Database,
  mediaTaskId: string,
  channelKey: string,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1
      FROM execution_attempts a
      JOIN execution_operations o ON o.id = a.operationId
     WHERE o.mediaTaskId = ? AND o.channelKey = ?
       AND a.intentJournalSeq IS NOT NULL
     LIMIT 1
  `).get(mediaTaskId, channelKey));
}

function providerAvailable(
  db: Database.Database,
  providerTable: string,
  providerId: string,
): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(providerTable)) {
    return false;
  }
  if (providerTable === 'providers') {
    // Execution readiness tests can build the shared execution ledger without
    // the legacy provider table. Keep that isolated schema non-throwing: a
    // missing provider table cannot prove a future channel is available.
    if (!tableExists(db, 'providers')) return false;
    const row = db.prepare(`SELECT enabled, baseUrl, apiKey FROM providers WHERE id = ?`)
      .get(providerId) as { enabled: number; baseUrl: string; apiKey: string } | undefined;
    return Boolean(row
      && row.enabled === 1
      && row.baseUrl.trim()
      && row.apiKey.trim());
  }
  if (providerTable === 'video_providers') {
    if (!tableExists(db, 'video_providers')) return false;
    const row = db.prepare(`
      SELECT enabled, baseUrl, apiKey, accessKey, secretKey, baseUrlEnv
        FROM video_providers WHERE id = ?
    `).get(providerId) as {
      enabled: number;
      baseUrl: string;
      apiKey: string;
      accessKey: string;
      secretKey: string;
      baseUrlEnv: string;
    } | undefined;
    if (!row || row.enabled !== 1) return false;
    const keyAvailable = Boolean(row.apiKey.trim())
      || Boolean(row.accessKey.trim() && row.secretKey.trim());
    const addressAvailable = Boolean(row.baseUrl.trim() || row.baseUrlEnv.trim());
    return keyAvailable && addressAvailable;
  }
  return false;
}

function channelIsFutureCandidate(
  db: Database.Database,
  task: TaskRow,
  channel: ChannelRow,
  mediaTaskId: string,
): boolean {
  if (!['candidate', 'skipped', 'overflowed', 'waiting_capacity', 'selected'].includes(channel.state)) return false;
  if (!providerAvailable(db, channel.providerTable, channel.providerId)) return false;
  if (hasSubmittedIntent(db, mediaTaskId, channel.channelKey)) return false;
  const health = readUnifiedChannelHealth(db, task.unifiedModel, channel.channelKey);
  return !health || health.state === 'healthy';
}

/** 决策只需要通道身份；准入可传入不含完整输入的轻量投影。 */
export interface MediaAdmissionPrioritySource {
  mediaTaskId?: string | null;
  channelKey?: string | null;
}

/**
 * Read-only decision used by admission. It only looks at frozen task/channel
 * rows and current provider/health state; it never reserves capacity.
 */
export function readMediaAdmissionPriority(
  db: Database.Database,
  operation: MediaAdmissionPrioritySource,
  now: Date = new Date(),
): MediaAdmissionPriority {
  const currentChannelKey = operation.channelKey?.trim() || null;
  if (!operation.mediaTaskId || !currentChannelKey) {
    return {
      priority: 0,
      candidateCount: 1,
      priorityClass: 'normal',
      currentChannelKey: null,
      availableChannelKeys: [],
      reason: 'non_unified_single_channel',
      evaluatedAt: now.toISOString(),
    };
  }
  const task = db.prepare(`
    SELECT unifiedModel, status FROM execution_media_tasks WHERE id = ?
  `).get(operation.mediaTaskId) as TaskRow | undefined;
  if (!task) {
    return {
      priority: 0,
      candidateCount: 1,
      priorityClass: 'normal',
      currentChannelKey,
      availableChannelKeys: [currentChannelKey],
      reason: 'task_snapshot_missing',
      evaluatedAt: now.toISOString(),
    };
  }
  const channels = db.prepare(`
    SELECT channelKey, state, providerTable, providerId
      FROM execution_media_channels
     WHERE mediaTaskId = ?
     ORDER BY priority, channelKey
  `).all(operation.mediaTaskId) as ChannelRow[];
  if (channels.length === 0) {
    return {
      priority: 0,
      candidateCount: 1,
      priorityClass: 'normal',
      currentChannelKey,
      availableChannelKeys: [currentChannelKey],
      reason: 'channel_snapshot_missing',
      evaluatedAt: now.toISOString(),
    };
  }
  const availableChannelKeys = channels
    .filter((channel) => channel.channelKey === currentChannelKey
      || channelIsFutureCandidate(db, task, channel, operation.mediaTaskId!))
    .map((channel) => channel.channelKey);
  const candidateCount = availableChannelKeys.length;
  const isTencent = currentChannelKey === 'tencent';
  if (isTencent && candidateCount > 1) {
    return {
      priority: 1,
      candidateCount,
      priorityClass: 'overflow',
      currentChannelKey,
      availableChannelKeys,
      reason: 'tencent_with_available_alternative',
      evaluatedAt: now.toISOString(),
    };
  }
  return {
    priority: 0,
    candidateCount,
    priorityClass: isTencent ? 'single_channel' : 'normal',
    currentChannelKey,
    availableChannelKeys,
    reason: isTencent ? 'tencent_single_channel' : 'non_tencent_attempt',
    evaluatedAt: now.toISOString(),
  };
}

export function effectiveMediaAdmissionPriority(
  priority: MediaAdmissionPriority,
  createdAt: string,
  now: Date,
): EffectiveMediaAdmissionPriority {
  const created = Date.parse(createdAt);
  const ageMs = Number.isFinite(created) ? Math.max(0, now.getTime() - created) : 0;
  const aged = priority.priority > 0 && ageMs >= MEDIA_PRIORITY_AGING_MS;
  return {
    ...priority,
    effectivePriority: aged ? 0 : priority.priority,
    aged,
    ageMs,
  };
}
