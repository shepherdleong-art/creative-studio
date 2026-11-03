import type Database from 'better-sqlite3';
import { ExecutionError } from './context.ts';

export interface ActorPolicy {
  actorId: string;
  monthlyLimitMinor: number | null;
  currency: 'CNY';
  personalConcurrency: number;
  paused: boolean;
  timezone: 'Asia/Shanghai';
  version: number;
}

export interface ExecutionPool {
  poolKey: string;
  kind: 'upload' | 'remote' | 'download' | 'media';
  capacity: number;
  enabled: boolean;
  mappingSnapshot: unknown;
  version: number;
}

interface PolicyRow {
  actorId: string;
  monthlyLimitMinor: number | null;
  currency: 'CNY';
  personalConcurrency: number;
  paused: number;
  timezone: 'Asia/Shanghai';
  version: number;
}

export const DEFAULT_ACTOR_POLICY = Object.freeze({
  monthlyLimitMinor: 0,
  currency: 'CNY' as const,
  personalConcurrency: 0,
  paused: false,
  timezone: 'Asia/Shanghai' as const,
});

export function personalConcurrencyPoolKey(actorId: string): string {
  return `actor:${actorId}:remote`;
}

export function shanghaiAccountingPeriod(date: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('无法确定 Asia/Shanghai 账期。');
  return `${year}-${month}`;
}

export function readActorPolicy(db: Database.Database, actorId: string): ActorPolicy {
  const row = db.prepare('SELECT * FROM execution_actor_policies WHERE actorId = ?').get(actorId) as PolicyRow | undefined;
  if (!row) return { actorId, ...DEFAULT_ACTOR_POLICY, version: 0 };
  return {
    actorId: row.actorId,
    monthlyLimitMinor: row.monthlyLimitMinor,
    currency: row.currency,
    personalConcurrency: row.personalConcurrency,
    paused: Boolean(row.paused),
    timezone: row.timezone,
    version: row.version,
  };
}

export function updateActorPolicy(db: Database.Database, input: {
  actorId: string;
  monthlyLimitMinor: number | null;
  personalConcurrency: number;
  paused: boolean;
  expectedVersion: number;
}): ActorPolicy {
  if (!input.actorId.trim()) throw new ExecutionError('invalid_input', 'actorId 不能为空。');
  if (input.monthlyLimitMinor !== null
    && (!Number.isSafeInteger(input.monthlyLimitMinor) || input.monthlyLimitMinor < 0)) {
    throw new ExecutionError('invalid_money', '月额度必须是 NULL 或非负安全整数 minor。');
  }
  if (!Number.isSafeInteger(input.personalConcurrency) || input.personalConcurrency < 0) {
    throw new ExecutionError('invalid_input', '个人并发必须是非负安全整数。');
  }
  const run = db.transaction(() => {
    const current = readActorPolicy(db, input.actorId);
    if (current.version !== input.expectedVersion) {
      throw new ExecutionError('policy_version_conflict', `成员策略 version 已变化，期望 ${input.expectedVersion}，实际 ${current.version}。`);
    }
    const version = current.version + 1;
    db.prepare(`
      INSERT INTO execution_actor_policies (
        actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, updatedAt
      ) VALUES (?, ?, 'CNY', ?, ?, 'Asia/Shanghai', ?, ?)
      ON CONFLICT(actorId) DO UPDATE SET
        monthlyLimitMinor = excluded.monthlyLimitMinor,
        personalConcurrency = excluded.personalConcurrency,
        paused = excluded.paused,
        version = excluded.version,
        updatedAt = excluded.updatedAt
    `).run(input.actorId, input.monthlyLimitMinor, input.personalConcurrency, input.paused ? 1 : 0,
      version, new Date().toISOString());
    return readActorPolicy(db, input.actorId);
  });
  return run.immediate();
}

export function upsertExecutionPool(db: Database.Database, input: {
  poolKey: string;
  kind: ExecutionPool['kind'];
  capacity: number;
  enabled: boolean;
  mappingSnapshot: unknown;
  expectedVersion: number;
}): ExecutionPool {
  if (!input.poolKey.trim()) throw new ExecutionError('pool_missing', 'poolKey 不能为空。');
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 0) {
    throw new ExecutionError('invalid_input', '池容量必须是非负安全整数。');
  }
  const mappingSnapshotJson = JSON.stringify(input.mappingSnapshot);
  if (!mappingSnapshotJson || mappingSnapshotJson === 'null' || mappingSnapshotJson === '{}') {
    throw new ExecutionError('pool_mapping_required', '资源池必须保存受控映射快照。');
  }
  const run = db.transaction(() => {
    const existing = db.prepare('SELECT version FROM execution_pools WHERE poolKey = ?').get(input.poolKey) as
      | { version: number } | undefined;
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new ExecutionError('pool_version_conflict', `资源池 version 已变化，期望 ${input.expectedVersion}，实际 ${currentVersion}。`);
    }
    const version = currentVersion + 1;
    db.prepare(`
      INSERT INTO execution_pools (poolKey, kind, capacity, enabled, mappingSnapshotJson, version, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(poolKey) DO UPDATE SET
        kind = excluded.kind, capacity = excluded.capacity, enabled = excluded.enabled,
        mappingSnapshotJson = excluded.mappingSnapshotJson, version = excluded.version, updatedAt = excluded.updatedAt
    `).run(input.poolKey, input.kind, input.capacity, input.enabled ? 1 : 0, mappingSnapshotJson, version,
      new Date().toISOString());
    return readExecutionPool(db, input.poolKey);
  });
  return run.immediate();
}

export function readExecutionPool(db: Database.Database, poolKey: string): ExecutionPool {
  const row = db.prepare('SELECT * FROM execution_pools WHERE poolKey = ?').get(poolKey) as
    | (Omit<ExecutionPool, 'enabled' | 'mappingSnapshot'> & { enabled: number; mappingSnapshotJson: string })
    | undefined;
  if (!row) throw new ExecutionError('pool_missing', `受控资源池 ${poolKey} 未配置。`);
  return {
    poolKey: row.poolKey,
    kind: row.kind,
    capacity: row.capacity,
    enabled: Boolean(row.enabled),
    mappingSnapshot: JSON.parse(row.mappingSnapshotJson) as unknown,
    version: row.version,
  };
}

export function chargedCostExpression(alias = 'r'): string {
  return `CASE
    WHEN ${alias}.state = 'held' THEN COALESCE(${alias}.reservedMinor, 0)
    WHEN ${alias}.state = 'settled' THEN COALESCE(${alias}.actualMinor,
      CASE WHEN ${alias}.costState = 'unknown' THEN ${alias}.reservedMinor ELSE 0 END, 0)
    ELSE 0 END`;
}

export function monthlyCostUsage(db: Database.Database, actorId: string, accountingPeriod: string): number {
  return db.prepare(`
    SELECT COALESCE(SUM(${chargedCostExpression()}), 0) AS amount
    FROM execution_reservations r
    WHERE r.kind = 'cost' AND r.actorId = ? AND r.accountingPeriod = ? AND r.state IN ('held', 'settled')
  `).pluck().get(actorId, accountingPeriod) as number;
}
