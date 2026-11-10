import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SubmissionEvidence } from '../submission-evidence.ts';
import { UNIFIED_IMAGE_CHANNELS, UNIFIED_IMAGE_MODEL_KEY } from './catalog.ts';

/**
 * 通道健康状态只影响未来任务选路，不改写真实供应商 enabled，也不碰已受理/未知尝试。
 *
 * 状态机：
 *   healthy --连续服务故障达到阈值--> avoided
 *   avoided --冷却到期，原子领取一次恢复探针--> recovering
 *   recovering --正常成功--> healthy
 *   recovering --再次服务故障--> avoided（更长冷却）
 *
 * 恢复探针就是普通待执行任务；它照常经过授权、预算、池和 attempt 计数，不产生隐形付费请求。
 */
export type UnifiedChannelHealthState = 'healthy' | 'avoided' | 'recovering';

export type UnifiedChannelFailureReason =
  | 'provider_server_error'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_network'
  | 'provider_response_invalid'
  | 'provider_poll_failed';

export interface UnifiedChannelHealthRecord {
  healthKey: string;
  unifiedModel: string;
  channelKey: string;
  providerId: string;
  state: UnifiedChannelHealthState;
  consecutiveFailures: number;
  reasonCode: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  avoidUntil: string | null;
  version: number;
  updatedAt: string;
}

export interface UnifiedChannelHealthDefinition {
  unifiedModel: string;
  unifiedModelLabel: string;
  channelKey: string;
  channelLabel: string;
  providerTable: 'providers' | 'video_providers';
  providerId: string;
}

export const UNIFIED_CHANNEL_FAILURE_THRESHOLD = 3;
export const UNIFIED_CHANNEL_BASE_COOLDOWN_MS = 5 * 60_000;
export const UNIFIED_CHANNEL_MAX_COOLDOWN_MS = 60 * 60_000;
export const UNIFIED_CHANNEL_RECOVERY_LEASE_MS = 10 * 60_000;

const HEALTH_CHANNELS: readonly UnifiedChannelHealthDefinition[] = Object.freeze([
  Object.freeze({
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    unifiedModelLabel: 'Image 2',
    channelKey: 'qiniu',
    channelLabel: '七牛',
    providerTable: 'providers' as const,
    providerId: UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!.providerId,
  }),
  Object.freeze({
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    unifiedModelLabel: 'Image 2',
    channelKey: 'tencent',
    channelLabel: '腾讯',
    providerTable: 'providers' as const,
    providerId: UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'tencent')!.providerId,
  }),
] as const);

const FAILURE_REASON_LABELS: Record<string, string> = {
  provider_server_error: '上游连续返回服务错误',
  provider_rate_limited: '上游持续限流',
  provider_timeout: '上游请求连续超时',
  provider_network: '网络连接连续失败',
  provider_response_invalid: '上游响应无法解析',
  provider_poll_failed: '结果查询连续失败',
};

const DEFAULT_COPY = {
  healthy: '可用',
  avoided: '系统临时避让',
  recovering: '正在恢复验证',
} as const;

export function unifiedChannelHealthKey(unifiedModel: string, channelKey: string): string {
  return `${unifiedModel}:${channelKey}`;
}

function immediate<T>(db: Database.Database, operation: () => T): T {
  return db.inTransaction ? operation() : db.transaction(operation).immediate();
}

export function listUnifiedChannelHealthDefinitions(): UnifiedChannelHealthDefinition[] {
  return HEALTH_CHANNELS.map((channel) => ({ ...channel }));
}

export function unifiedChannelFailureReasonFromEvidence(
  evidence: SubmissionEvidence,
): UnifiedChannelFailureReason | null {
  if (!['unknown', 'terminal_failed'].includes(evidence.state)) return null;
  switch (evidence.error?.category) {
    case 'server_error': return 'provider_server_error';
    case 'rate_limited': return 'provider_rate_limited';
    case 'timeout': return 'provider_timeout';
    case 'network': return 'provider_network';
    case 'parse': return 'provider_response_invalid';
    default: return null;
  }
}

export function channelHealthReasonLabel(reasonCode: string | null): string | null {
  if (!reasonCode) return null;
  return FAILURE_REASON_LABELS[reasonCode] ?? '连续服务故障';
}

export function channelHealthStateLabel(record: Pick<UnifiedChannelHealthRecord, 'state'>): string {
  return DEFAULT_COPY[record.state];
}

export function readUnifiedChannelHealth(
  db: Database.Database,
  unifiedModel: string,
  channelKey: string,
): UnifiedChannelHealthRecord | null {
  const row = db.prepare('SELECT * FROM execution_media_channel_health WHERE healthKey = ?').get(
    unifiedChannelHealthKey(unifiedModel, channelKey),
  ) as UnifiedChannelHealthRecord | undefined;
  return row ?? null;
}

function healthyRecord(input: {
  unifiedModel: string;
  channelKey: string;
  providerId: string;
  now: Date;
}): UnifiedChannelHealthRecord {
  return {
    healthKey: unifiedChannelHealthKey(input.unifiedModel, input.channelKey),
    unifiedModel: input.unifiedModel,
    channelKey: input.channelKey,
    providerId: input.providerId,
    state: 'healthy',
    consecutiveFailures: 0,
    reasonCode: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    avoidUntil: null,
    version: 1,
    updatedAt: input.now.toISOString(),
  };
}

function insertAudit(
  db: Database.Database,
  input: {
    healthKey: string;
    action: string;
    actorId?: string | null;
    reasonCode?: string | null;
    before: UnifiedChannelHealthRecord | null;
    after: UnifiedChannelHealthRecord | null;
    at: string;
  },
): void {
  db.prepare(`
    INSERT INTO execution_media_channel_health_events
      (id, healthKey, action, actorId, reasonCode, beforeJson, afterJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), input.healthKey, input.action, input.actorId ?? null, input.reasonCode ?? null,
    input.before === null ? null : JSON.stringify(input.before),
    input.after === null ? null : JSON.stringify(input.after),
    input.at,
  );
}

function upsertHealth(db: Database.Database, record: UnifiedChannelHealthRecord): void {
  db.prepare(`
    INSERT INTO execution_media_channel_health (
      healthKey, unifiedModel, channelKey, providerId, state, consecutiveFailures,
      reasonCode, lastFailureAt, lastSuccessAt, avoidUntil, version, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(healthKey) DO UPDATE SET
      providerId = excluded.providerId,
      state = excluded.state,
      consecutiveFailures = excluded.consecutiveFailures,
      reasonCode = excluded.reasonCode,
      lastFailureAt = excluded.lastFailureAt,
      lastSuccessAt = excluded.lastSuccessAt,
      avoidUntil = excluded.avoidUntil,
      version = excluded.version,
      updatedAt = excluded.updatedAt
  `).run(
    record.healthKey, record.unifiedModel, record.channelKey, record.providerId,
    record.state, record.consecutiveFailures, record.reasonCode, record.lastFailureAt,
    record.lastSuccessAt, record.avoidUntil, record.version, record.updatedAt,
  );
}

function cooldownForFailures(consecutiveFailures: number): number {
  const overThreshold = Math.max(0, consecutiveFailures - UNIFIED_CHANNEL_FAILURE_THRESHOLD);
  return Math.min(
    UNIFIED_CHANNEL_MAX_COOLDOWN_MS,
    UNIFIED_CHANNEL_BASE_COOLDOWN_MS * 2 ** overThreshold,
  );
}

export function recordUnifiedChannelFailure(
  db: Database.Database,
  input: {
    unifiedModel: string;
    channelKey: string;
    providerId: string;
    reasonCode: UnifiedChannelFailureReason;
    now?: Date;
  },
): UnifiedChannelHealthRecord {
  const now = input.now ?? new Date();
  return immediate(db, (): UnifiedChannelHealthRecord => {
    const key = unifiedChannelHealthKey(input.unifiedModel, input.channelKey);
    const before = readUnifiedChannelHealth(db, input.unifiedModel, input.channelKey);
    const consecutiveFailures = (before?.consecutiveFailures ?? 0) + 1;
    const avoided = consecutiveFailures >= UNIFIED_CHANNEL_FAILURE_THRESHOLD;
    const after: UnifiedChannelHealthRecord = {
      ...(before ?? healthyRecord({ ...input, now })),
      healthKey: key,
      state: avoided ? 'avoided' : 'healthy',
      consecutiveFailures,
      reasonCode: input.reasonCode,
      lastFailureAt: now.toISOString(),
      avoidUntil: avoided
        ? new Date(now.getTime() + cooldownForFailures(consecutiveFailures)).toISOString()
        : null,
      version: (before?.version ?? 0) + 1,
      updatedAt: now.toISOString(),
    };
    upsertHealth(db, after);
    insertAudit(db, {
      healthKey: key,
      action: avoided && before?.state !== 'avoided' ? 'system_avoid' : 'failure',
      reasonCode: input.reasonCode,
      before,
      after,
      at: after.updatedAt,
    });
    return after;
  });
}

export function recordUnifiedChannelSuccess(
  db: Database.Database,
  input: {
    unifiedModel: string;
    channelKey: string;
    providerId: string;
    now?: Date;
  },
): UnifiedChannelHealthRecord {
  const now = input.now ?? new Date();
  return immediate(db, (): UnifiedChannelHealthRecord => {
    const key = unifiedChannelHealthKey(input.unifiedModel, input.channelKey);
    const before = readUnifiedChannelHealth(db, input.unifiedModel, input.channelKey);
    const after: UnifiedChannelHealthRecord = {
      ...(before ?? healthyRecord({ ...input, now })),
      healthKey: key,
      providerId: input.providerId,
      state: 'healthy',
      consecutiveFailures: 0,
      reasonCode: null,
      lastSuccessAt: now.toISOString(),
      avoidUntil: null,
      version: (before?.version ?? 0) + 1,
      updatedAt: now.toISOString(),
    };
    upsertHealth(db, after);
    if (before?.state === 'avoided' || before?.state === 'recovering') {
      insertAudit(db, {
        healthKey: key,
        action: 'recovered_by_success',
        before,
        after,
        at: after.updatedAt,
      });
    }
    return after;
  });
}

/**
 * 新任务选择前调用。只有冷却已到期的 avoided 通道会被原子切到 recovering；
 * 一个恢复租约内只放一条普通任务作为验证探针。
 */
export function claimUnifiedChannelHealthForSelection(
  db: Database.Database,
  input: {
    unifiedModel: string;
    channelKey: string;
    providerId: string;
    now?: Date;
  },
): boolean {
  const now = input.now ?? new Date();
  return immediate(db, () => {
    const before = readUnifiedChannelHealth(db, input.unifiedModel, input.channelKey);
    if (!before || before.state === 'healthy') return true;
    if (before.avoidUntil && Date.parse(before.avoidUntil) > now.getTime()) return false;
    const nextVersion = before.version + 1;
    const recovering: UnifiedChannelHealthRecord = {
      ...before,
      state: 'recovering',
      providerId: input.providerId,
      avoidUntil: new Date(now.getTime() + UNIFIED_CHANNEL_RECOVERY_LEASE_MS).toISOString(),
      version: nextVersion,
      updatedAt: now.toISOString(),
    };
    const changed = db.prepare(`
      UPDATE execution_media_channel_health
      SET state = 'recovering', providerId = ?, avoidUntil = ?, version = ?, updatedAt = ?
      WHERE healthKey = ? AND version = ? AND state = ?
        AND (avoidUntil IS NULL OR avoidUntil <= ?)
    `).run(
      input.providerId, recovering.avoidUntil, nextVersion, recovering.updatedAt,
      before.healthKey, before.version, before.state, now.toISOString(),
    );
    if (changed.changes !== 1) return false;
    insertAudit(db, {
      healthKey: before.healthKey,
      action: 'recovery_probe_claimed',
      before,
      after: recovering,
      at: recovering.updatedAt,
    });
    return true;
  });
}

/**
 * A recovery probe is only claimed after selection. If admission defers,
 * submission is canceled, or another channel wins before the paid POST, the
 * probe must not occupy the recovery lease for an unrelated waiting task.
 */
export function releaseUnifiedChannelRecoveryProbe(
  db: Database.Database,
  input: {
    unifiedModel: string;
    channelKey: string;
    providerId: string;
    now?: Date;
  },
): void {
  const now = input.now ?? new Date();
  immediate(db, () => {
    const before = readUnifiedChannelHealth(db, input.unifiedModel, input.channelKey);
    if (!before || before.state !== 'recovering') return;
    const after: UnifiedChannelHealthRecord = {
      ...before,
      providerId: input.providerId,
      state: 'avoided',
      avoidUntil: now.toISOString(),
      version: before.version + 1,
      updatedAt: now.toISOString(),
    };
    upsertHealth(db, after);
    insertAudit(db, {
      healthKey: before.healthKey,
      action: 'recovery_probe_released',
      reasonCode: before.reasonCode,
      before,
      after,
      at: after.updatedAt,
    });
  });
}

export function clearUnifiedChannelHealthAvoidance(
  db: Database.Database,
  input: {
    unifiedModel: string;
    channelKey: string;
    providerId: string;
    actorId: string;
    expectedVersion: number;
    now?: Date;
  },
): UnifiedChannelHealthRecord {
  const now = input.now ?? new Date();
  return immediate(db, (): UnifiedChannelHealthRecord => {
    const before = readUnifiedChannelHealth(db, input.unifiedModel, input.channelKey);
    if (!before) {
      if (input.expectedVersion !== 0) {
        throw new Error(`通道健康状态版本已变化：期望 ${input.expectedVersion}，实际 0。`);
      }
      const after = healthyRecord({ ...input, now });
      after.version = 1;
      upsertHealth(db, after);
      insertAudit(db, {
        healthKey: after.healthKey, action: 'operator_clear', actorId: input.actorId,
        before: null, after, at: after.updatedAt,
      });
      return after;
    }
    if (before.version !== input.expectedVersion) {
      throw new Error(`通道健康状态版本已变化：期望 ${input.expectedVersion}，实际 ${before.version}。`);
    }
    const after: UnifiedChannelHealthRecord = {
      ...before,
      providerId: input.providerId,
      state: 'healthy',
      consecutiveFailures: 0,
      reasonCode: null,
      avoidUntil: null,
      version: before.version + 1,
      updatedAt: now.toISOString(),
    };
    upsertHealth(db, after);
    insertAudit(db, {
      healthKey: before.healthKey, action: 'operator_clear', actorId: input.actorId,
      before, after, at: after.updatedAt,
    });
    return after;
  });
}
