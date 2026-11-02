import { randomUUID } from 'node:crypto';
import {
  ExecutionError,
  type AdmissionWaitReason,
  type AdmitResult,
  type ExecutionFacadeOptions,
  type InstanceFence,
  type OperationRecord,
} from './context.ts';
import { mapOperation, readAttempt } from './records.ts';
import {
  monthlyCostUsage,
  personalConcurrencyPoolKey,
  readActorPolicy,
  shanghaiAccountingPeriod,
  type ActorPolicy,
} from './pools.ts';

type AdmissionOptions = ExecutionFacadeOptions & { assertOpen(): void };

interface PoolState {
  poolKey: string;
  capacity: number;
  enabled: number;
  mappingSnapshotJson: string;
}

function heldPoolCount(options: AdmissionOptions, poolKey: string): number {
  return options.db.prepare(`
    SELECT COUNT(*) AS count FROM execution_reservations
    WHERE kind = 'concurrency' AND poolKey = ? AND state = 'held'
  `).pluck().get(poolKey) as number;
}

function candidateReason(
  options: AdmissionOptions,
  operation: OperationRecord,
  policy: ActorPolicy,
  accountingPeriod: string,
): AdmissionWaitReason | null {
  if (options.maintenance()) return 'maintenance';
  if (!options.actorAllowed(operation.actorId)) return 'actor_disabled';
  if (!options.scopeAllowed(operation.actorId, {
    resourceType: operation.scopeType, resourceId: operation.scopeId,
  })) return 'scope_forbidden';
  if (policy.paused) return 'actor_paused';
  for (const poolKey of operation.requiredPools) {
    const pool = options.db.prepare('SELECT * FROM execution_pools WHERE poolKey = ?').get(poolKey) as PoolState | undefined;
    if (!pool || !pool.mappingSnapshotJson || pool.mappingSnapshotJson === '{}') return 'pool_missing';
    if (!pool.enabled) return 'pool_disabled';
    if (heldPoolCount(options, poolKey) >= pool.capacity) return 'pool_capacity';
  }
  if (heldPoolCount(options, personalConcurrencyPoolKey(operation.actorId)) >= policy.personalConcurrency) {
    return 'personal_concurrency';
  }
  if (operation.quote.kind === 'unpriced' && policy.monthlyLimitMinor !== null) return 'pricing_required';
  if (policy.monthlyLimitMinor !== null) {
    const unknown = options.db.prepare(`
      SELECT 1 FROM execution_reservations
      WHERE kind = 'cost' AND actorId = ? AND state = 'held' AND costState = 'unknown' LIMIT 1
    `).get(operation.actorId);
    if (unknown) return 'cost_unknown';
    const reserve = operation.quote.kind === 'priced' ? operation.quote.reserve.minor : 0;
    if (monthlyCostUsage(options.db, operation.actorId, accountingPeriod) + reserve > policy.monthlyLimitMinor) {
      return 'monthly_budget';
    }
  }
  return null;
}

export function admitOperation(
  options: AdmissionOptions,
  instance: InstanceFence & { leaseMs?: number },
): AdmitResult {
  options.assertOpen();
  if (!Number.isSafeInteger(instance.fence) || instance.fence <= 0 || !instance.instanceId.trim()) {
    throw new ExecutionError('stale_fence', '执行 instance/fence 无效。');
  }
  const verification = options.journal.verify();
  if (!verification.valid) throw new ExecutionError('execution_journal_unavailable', '执行 journal 不可信，拒绝准入。');
  const now = options.now?.() ?? new Date();
  const run = options.db.transaction((): AdmitResult => {
    const owner = options.db.prepare(`
      SELECT 1 FROM execution_instances
      WHERE instanceId = ? AND fence = ? AND deploymentId = ? AND stoppedAt IS NULL
    `).get(instance.instanceId, instance.fence, options.deploymentId);
    if (!owner) throw new ExecutionError('stale_fence', '执行 instance/fence 已失效。');
    const state = options.db.prepare('SELECT cursorActorId FROM execution_admission_state WHERE id = 1').get() as
      | { cursorActorId: string | null } | undefined;
    if (!state) throw new ExecutionError('execution_not_ready', '执行轮转状态未就绪。');
    const actors = (options.db.prepare(`
      SELECT actorId FROM execution_operations
      WHERE status IN ('pending', 'deferred')
      GROUP BY actorId ORDER BY actorId
    `).all() as Array<{ actorId: string }>).map(({ actorId }) => actorId);
    if (actors.length === 0) return { kind: 'idle' };
    const ordered = state.cursorActorId
      ? [...actors.filter((actor) => actor > state.cursorActorId!), ...actors.filter((actor) => actor <= state.cursorActorId!)]
      : actors;
    const reasons: AdmissionWaitReason[] = [];
    for (const actorId of ordered) {
      const row = options.db.prepare(`
        SELECT * FROM execution_operations
        WHERE actorId = ? AND status IN ('pending', 'deferred')
        ORDER BY readySeq LIMIT 1
      `).get(actorId) as Parameters<typeof mapOperation>[0] | undefined;
      if (!row) continue;
      const operation = mapOperation(row);
      const policy = readActorPolicy(options.db, actorId);
      const accountingPeriod = shanghaiAccountingPeriod(now);
      const reason = candidateReason(options, operation, policy, accountingPeriod);
      if (reason) {
        if (!reasons.includes(reason)) reasons.push(reason);
        options.db.prepare(`
          UPDATE execution_operations SET status = 'deferred', waitReason = ?, waitDetail = ?, updatedAt = ?
          WHERE id = ?
        `).run(reason, JSON.stringify([reason]), now.toISOString(), operation.id);
        continue;
      }

      const newId = options.newId ?? randomUUID;
      const permitId = newId();
      const attemptId = newId();
      const previous = options.db.prepare(`
        SELECT COALESCE(MAX(submitRound), 0) AS round, COALESCE(MAX(transportSeq), 0) AS transportSeq
        FROM execution_attempts WHERE operationId = ?
      `).get(operation.id) as { round: number; transportSeq: number };
      const leaseMs = instance.leaseMs ?? 30_000;
      if (!Number.isFinite(leaseMs) || leaseMs < 0) throw new ExecutionError('invalid_input', 'leaseMs 无效。');
      const at = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const reservedMinor = operation.quote.kind === 'priced' ? operation.quote.reserve.minor : 0;
      const pricingSnapshot = operation.quote.kind === 'priced'
        ? operation.quote.pricingSnapshot
        : operation.quote.pricingSnapshot ?? null;
      options.db.prepare(`
        INSERT INTO execution_attempts (
          id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
          providerSnapshotJson, pricingSnapshotJson, submissionState,
          instanceId, fence, leaseOwner, leaseUntil, policyVersion, accountingPeriod,
          currency, reservedMinor, actualMinor, costState, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_sent', ?, ?, ?, ?, ?, ?, 'CNY', ?, NULL, ?, ?, ?)
      `).run(
        attemptId, operation.id, permitId, actorId, operation.businessAttemptNo, previous.round + 1, previous.transportSeq + 1,
        JSON.stringify(operation.providerSnapshot), pricingSnapshot === null ? null : JSON.stringify(pricingSnapshot),
        instance.instanceId, instance.fence, instance.instanceId, leaseUntil,
        policy.version, accountingPeriod, reservedMinor,
        operation.quote.kind === 'priced' ? 'reserved' : 'unknown', at, at,
      );
      const addConcurrency = options.db.prepare(`
        INSERT INTO execution_reservations (id, operationId, permitId, actorId, kind, poolKey, state, createdAt)
        VALUES (?, ?, ?, ?, 'concurrency', ?, 'held', ?)
      `);
      for (const poolKey of [...operation.requiredPools, personalConcurrencyPoolKey(actorId)]) {
        addConcurrency.run(newId(), operation.id, permitId, actorId, poolKey, at);
      }
      options.db.prepare(`
        INSERT INTO execution_reservations (
          id, operationId, permitId, attemptId, actorId, kind, poolKey, state,
          accountingPeriod, currency, reservedMinor, costState, policyVersion, createdAt
        ) VALUES (?, ?, ?, ?, ?, 'cost', ?, 'held', ?, 'CNY', ?, ?, ?, ?)
      `).run(
        newId(), operation.id, permitId, attemptId, actorId, `actor:${actorId}:cost`,
        accountingPeriod, reservedMinor, operation.quote.kind === 'priced' ? 'reserved' : 'unknown',
        policy.version, at,
      );
      options.db.prepare(`
        UPDATE execution_operations
        SET status = 'admitted', waitReason = NULL, waitDetail = NULL,
            currentPermitId = ?, currentAttemptId = ?, updatedAt = ?
        WHERE id = ?
      `).run(permitId, attemptId, at, operation.id);
      options.db.prepare('UPDATE execution_admission_state SET cursorActorId = ? WHERE id = 1').run(actorId);
      return {
        kind: 'admitted',
        grant: {
          operation: { ...operation, status: 'admitted', currentPermitId: permitId, currentAttemptId: attemptId },
          permitId,
          attempt: readAttempt(options.db, attemptId),
          inputSnapshot: operation.inputSnapshot,
          continuationKey: operation.continuationKey,
          instance: { instanceId: instance.instanceId, fence: instance.fence },
        },
      };
    }
    return reasons.length > 0 ? { kind: 'deferred', reasons } : { kind: 'idle' };
  });
  return run.immediate();
}
