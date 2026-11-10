import type Database from 'better-sqlite3';
import { ExecutionError } from './context.ts';
import { readTeamConcurrencyPolicy } from './team-policy.ts';
import {
  trustedChannelModelsForUnifiedModel,
  trustedUnifiedModelForChannelModel,
} from '../unified-media/catalog.ts';

export type ActorConcurrencyMode = 'legacy' | 'inherit' | 'fixed';
export type ActorConcurrencySource = 'legacy_fixed' | 'team_default' | 'personal_fixed';

export interface ActorPolicy {
  actorId: string;
  monthlyLimitMinor: number | null;
  currency: 'CNY';
  personalConcurrency: number;
  concurrencyMode: ActorConcurrencyMode;
  concurrencySource: ActorConcurrencySource;
  /** null means demand-driven automatic fairness, never unlimited shared-pool capacity. */
  effectiveConcurrency: number | null;
  paused: boolean;
  allowedModels: string[] | null;
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
  allowedModelsJson: string | null;
  concurrencyMode: 'inherit' | 'fixed' | null;
  timezone: 'Asia/Shanghai';
  version: number;
}

export const DEFAULT_ACTOR_POLICY = Object.freeze({
  monthlyLimitMinor: 0,
  currency: 'CNY' as const,
  personalConcurrency: 0,
  paused: false,
  allowedModels: null,
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
  const mode: ActorConcurrencyMode = row?.concurrencyMode ?? 'legacy';
  const personalConcurrency = row?.personalConcurrency ?? DEFAULT_ACTOR_POLICY.personalConcurrency;
  const teamDefault = readTeamConcurrencyPolicy(db);
  return {
    actorId,
    ...(row ? {
      monthlyLimitMinor: row.monthlyLimitMinor,
      currency: row.currency,
      paused: Boolean(row.paused),
      allowedModels: row.allowedModelsJson == null ? null : JSON.parse(row.allowedModelsJson) as string[],
      timezone: row.timezone,
      version: row.version,
    } : { ...DEFAULT_ACTOR_POLICY, version: 0 }),
    personalConcurrency,
    concurrencyMode: mode,
    concurrencySource: mode === 'inherit' ? 'team_default' : mode === 'fixed' ? 'personal_fixed' : 'legacy_fixed',
    effectiveConcurrency: mode === 'inherit'
    ? teamDefault.mode === 'auto' ? null : teamDefault.manualDefaultConcurrency
    : personalConcurrency,
  };
}

export function createInheritedActorPolicy(db: Database.Database, actorId: string): void {
  if (!actorId.trim()) throw new ExecutionError('invalid_input', 'actorId 不能为空。');
  // First-admin initialization runs before execution readiness; its absent row
  // stays legacy zero. Later account creation always has execution schema ready.
  if (!(db.prepare('PRAGMA table_info(execution_actor_policies)').all() as Array<{ name: string }>).some(column => column.name === 'concurrencyMode')) return;
  db.prepare(`
    INSERT INTO execution_actor_policies (
      actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt
    ) VALUES (?, 0, 'CNY', 0, 0, 'Asia/Shanghai', 1, 'inherit', ?)
  `).run(actorId, new Date().toISOString());
}

export function updateActorPolicy(db: Database.Database, input: {
  actorId: string;
  monthlyLimitMinor: number | null;
  personalConcurrency: number;
  concurrencyMode?: 'inherit' | 'fixed';
  paused: boolean;
  expectedVersion: number;
  allowedModels?: string[] | null;
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
    const allowedModels = input.allowedModels === undefined ? current.allowedModels : input.allowedModels;
    if (allowedModels !== null && (!Array.isArray(allowedModels) || allowedModels.length > 500
      || allowedModels.some(model => typeof model !== 'string' || !model.trim() || model.length > 200))) {
      throw new ExecutionError('invalid_input', '模型权限必须为不限模型或有效的模型列表。');
    }
    db.prepare(`
      INSERT INTO execution_actor_policies (
        actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt
      ) VALUES (?, ?, 'CNY', ?, ?, 'Asia/Shanghai', ?, ?, ?)
      ON CONFLICT(actorId) DO UPDATE SET
        monthlyLimitMinor = excluded.monthlyLimitMinor,
        personalConcurrency = excluded.personalConcurrency,
        paused = excluded.paused,
        concurrencyMode = excluded.concurrencyMode,
        version = excluded.version,
        updatedAt = excluded.updatedAt
    `).run(input.actorId, input.monthlyLimitMinor, input.personalConcurrency, input.paused ? 1 : 0,
      version, input.concurrencyMode ?? (current.concurrencyMode === 'legacy' ? null : current.concurrencyMode), new Date().toISOString());
    db.prepare('UPDATE execution_actor_policies SET allowedModelsJson = ? WHERE actorId = ?')
      .run(allowedModels === null ? null : JSON.stringify([...new Set(allowedModels.map(model => model.trim()))]), input.actorId);
    return readActorPolicy(db, input.actorId);
  });
  return run.immediate();
}

/** Use the configured model identity, not the pricing alias shared by multiple models. */
export function executionModelIdentity(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Record<string, unknown>;
  for (const key of ['unifiedModel', 'configuredModel', 'model', 'requestModel', 'modelAlias']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return null;
}

export function actorModelAllowed(policy: ActorPolicy, snapshot: unknown): boolean {
  if (policy.allowedModels === null) return true;
  const model = executionModelIdentity(snapshot);
  if (model === null) return false;
  const object = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const explicitUnified = typeof object.unifiedModel === 'string' && object.unifiedModel.trim()
    ? object.unifiedModel.trim()
    : null;
  const unified = explicitUnified ?? trustedUnifiedModelForChannelModel(model);
  const candidates = new Set<string>([model]);
  if (unified) {
    candidates.add(unified);
    for (const trustedModel of trustedChannelModelsForUnifiedModel(unified)) candidates.add(trustedModel);
  }
  return [...candidates].some((candidate) => policy.allowedModels!.includes(candidate));
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

export interface ExecutionPoolSummary extends ExecutionPool {
  updatedAt: string;
}

export function listExecutionPools(db: Database.Database): ExecutionPoolSummary[] {
  const rows = db.prepare('SELECT * FROM execution_pools ORDER BY poolKey').all() as Array<
    Omit<ExecutionPoolSummary, 'enabled' | 'mappingSnapshot'> & { enabled: number; mappingSnapshotJson: string }
  >;
  return rows.map((row) => ({
    poolKey: row.poolKey,
    kind: row.kind,
    capacity: row.capacity,
    enabled: Boolean(row.enabled),
    mappingSnapshot: JSON.parse(row.mappingSnapshotJson) as unknown,
    version: row.version,
    updatedAt: row.updatedAt,
  }));
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

export interface ExecutionPoolBinding {
  bindingKey: string;
  poolKey: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

/** 媒体上游共享池绑定键：同一凭证指纹的供应商行显式归入同一真实共享池。 */
export function mediaUpstreamBindingKey(credentialFingerprint: string): string {
  return `media-upstream:${credentialFingerprint}`;
}

export function listExecutionPoolBindings(db: Database.Database): ExecutionPoolBinding[] {
  return db.prepare('SELECT * FROM execution_pool_bindings ORDER BY bindingKey').all() as ExecutionPoolBinding[];
}

export function readExecutionPoolBinding(db: Database.Database, bindingKey: string): ExecutionPoolBinding | undefined {
  return db.prepare('SELECT * FROM execution_pool_bindings WHERE bindingKey = ?').get(bindingKey) as
    | ExecutionPoolBinding | undefined;
}

export function upsertExecutionPoolBinding(
  db: Database.Database,
  input: { bindingKey: string; poolKey: string; label?: string },
): ExecutionPoolBinding {
  if (!input.bindingKey.trim() || !input.poolKey.trim()) {
    throw new ExecutionError('invalid_input', '资源池绑定必须同时提供 bindingKey 与 poolKey。');
  }
  const at = new Date().toISOString();
  db.prepare(`
    INSERT INTO execution_pool_bindings (bindingKey, poolKey, label, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bindingKey) DO UPDATE SET
      poolKey = excluded.poolKey, label = excluded.label, updatedAt = excluded.updatedAt
  `).run(input.bindingKey, input.poolKey, input.label ?? '', at, at);
  return readExecutionPoolBinding(db, input.bindingKey)!;
}

export function removeExecutionPoolBinding(db: Database.Database, bindingKey: string): boolean {
  return db.prepare('DELETE FROM execution_pool_bindings WHERE bindingKey = ?').run(bindingKey).changes === 1;
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
