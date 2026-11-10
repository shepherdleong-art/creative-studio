import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
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
  actorModelAllowed,
  personalConcurrencyPoolKey,
  readActorPolicy,
  shanghaiAccountingPeriod,
  type ActorPolicy,
} from './pools.ts';
import {
  effectiveMediaAdmissionPriority,
  MEDIA_PRIORITY_AGING_MS,
  readMediaAdmissionPriority,
  type EffectiveMediaAdmissionPriority,
} from '../unified-media/admission-priority.ts';

type AdmissionOptions = ExecutionFacadeOptions & { assertOpen(): void };

interface PoolState {
  poolKey: string;
  capacity: number;
  enabled: number;
  mappingSnapshotJson: string;
}

interface AdmissionEvaluation {
  row: Parameters<typeof mapOperation>[0];
  operation: OperationRecord;
  blocked: ReturnType<typeof candidateReason>;
  priority: EffectiveMediaAdmissionPriority;
}

function heldPoolCount(options: AdmissionOptions, poolKey: string, actorId?: string): number {
  return options.db.prepare(`
    SELECT COUNT(*) AS count FROM execution_reservations
    WHERE kind = 'concurrency' AND poolKey = ? AND state = 'held'
      ${actorId === undefined ? '' : 'AND actorId = ?'}
  `).pluck().get(...(actorId === undefined ? [poolKey] : [poolKey, actorId])) as number;
}

const demandSnapshots = new WeakMap<Database.Database, OperationRecord[]>();

function automaticConcurrencyLimit(options: AdmissionOptions, operation: OperationRecord, poolKey: string, period: string): number {
  const capacity = options.db.prepare('SELECT capacity FROM execution_pools WHERE poolKey = ?')
    .pluck().get(poolKey) as number;
  const rows = demandSnapshots.get(options.db) ?? options.db.prepare('SELECT * FROM execution_operations').all()
    .map(row => mapOperation(row as Parameters<typeof mapOperation>[0]));
  const activeActors = new Set<string>();
  for (const candidate of rows) {
    if (!candidate.requiredPools.includes(poolKey)) continue;
    if (candidate.status === 'pending' || candidate.status === 'deferred') {
      const reason = candidateReason(options, candidate, readActorPolicy(options.db, candidate.actorId), period, true);
      if (reason) continue;
    } else if (['admitted', 'maybe_sent', 'accepted', 'reconciling', 'unknown'].includes(candidate.status)) {
      const held = options.db.prepare("SELECT 1 FROM execution_reservations WHERE operationId=? AND kind='concurrency' AND state='held' LIMIT 1").get(candidate.id);
      if (!held) continue;
      // Existing accepted/unknown occupancy is real demand even if a later
      // pause or permission change prevents that actor from starting new work.
    } else continue;
    activeActors.add(candidate.actorId);
  }
  return Math.max(1, Math.ceil(capacity / Math.max(1, activeActors.size)));
}

export interface AdmissionWaitDetail {
  reason: AdmissionWaitReason;
  concurrencySource?: ActorPolicy['concurrencySource'];
  currentConcurrency?: number;
  effectiveConcurrency?: number;
  poolKey?: string;
  capacity?: number;
}

function candidateReason(
  options: AdmissionOptions,
  operation: OperationRecord,
  policy: ActorPolicy,
  accountingPeriod: string,
  eligibilityOnly = false,
): { reason: AdmissionWaitReason; detail?: Omit<AdmissionWaitDetail, 'reason'> } | null {
  if (options.maintenance()) return { reason: 'maintenance' };
  if (!options.actorAllowed(operation.actorId)) return { reason: 'actor_disabled' };
  if (!options.scopeAllowed(operation.actorId, {
    resourceType: operation.scopeType, resourceId: operation.scopeId,
  })) return { reason: 'scope_forbidden' };
  if (policy.paused) return { reason: 'actor_paused' };
  if (!actorModelAllowed(policy, operation.providerSnapshot)) return { reason: 'model_forbidden' };
  const currentConcurrency = heldPoolCount(options, personalConcurrencyPoolKey(operation.actorId));
  if (!eligibilityOnly) for (const poolKey of operation.requiredPools) {
    const pool = options.db.prepare('SELECT * FROM execution_pools WHERE poolKey = ?').get(poolKey) as PoolState | undefined;
    if (!pool || !pool.mappingSnapshotJson || pool.mappingSnapshotJson === '{}') return { reason: 'pool_missing', detail: { poolKey } };
    if (!pool.enabled) return { reason: 'pool_disabled', detail: { poolKey } };
    const currentConcurrency = heldPoolCount(options, poolKey);
    if (currentConcurrency < pool.capacity && policy.effectiveConcurrency === null) {
      const actorHeld = heldPoolCount(options, poolKey, operation.actorId);
      const limit = automaticConcurrencyLimit(options, operation, poolKey, accountingPeriod);
      if (actorHeld >= limit) return {
        reason: 'fair_share',
        detail: { concurrencySource: policy.concurrencySource, currentConcurrency: actorHeld, effectiveConcurrency: limit, poolKey, capacity: pool.capacity },
      };
    }
    if (currentConcurrency >= pool.capacity) return { reason: 'pool_capacity', detail: { poolKey, currentConcurrency, capacity: pool.capacity } };
  }
  const effectiveConcurrency = eligibilityOnly ? Number.MAX_SAFE_INTEGER : policy.effectiveConcurrency ?? Number.MAX_SAFE_INTEGER;
  if (currentConcurrency >= effectiveConcurrency) {
    return {
      reason: policy.effectiveConcurrency === null ? 'fair_share' : 'personal_concurrency',
      detail: { concurrencySource: policy.concurrencySource, currentConcurrency, effectiveConcurrency },
    };
  }
  if (operation.quote.kind === 'unpriced' && policy.monthlyLimitMinor !== null) return { reason: 'pricing_required' };
  if (policy.monthlyLimitMinor !== null) {
    const unknown = options.db.prepare(`
      SELECT 1 FROM execution_reservations
      WHERE kind = 'cost' AND actorId = ? AND state IN ('held', 'settled') AND costState = 'unknown' LIMIT 1
    `).get(operation.actorId);
    if (unknown) return { reason: 'cost_unknown' };
    const reserve = operation.quote.kind === 'priced' ? operation.quote.reserve.minor : 0;
    if (monthlyCostUsage(options.db, operation.actorId, accountingPeriod) + reserve > policy.monthlyLimitMinor) {
      return { reason: 'monthly_budget' };
    }
  }
  return null;
}

function admissionTrace(priority: EffectiveMediaAdmissionPriority) {
  return {
    ...priority,
    agingWindowMs: MEDIA_PRIORITY_AGING_MS,
  };
}

function writeAdmissionPriority(
  options: AdmissionOptions,
  operationId: string,
  priority: EffectiveMediaAdmissionPriority,
): void {
  options.db.prepare(`
    UPDATE execution_operations
       SET admissionPriority = ?, admissionCandidateCount = ?, admissionTraceJson = ?
     WHERE id = ?
  `).run(
    priority.effectivePriority,
    priority.candidateCount,
    JSON.stringify(admissionTrace(priority)),
    operationId,
  );
}

function priorityWaitDetail(
  priority: EffectiveMediaAdmissionPriority,
  reason: AdmissionWaitReason,
  detail?: Omit<AdmissionWaitDetail, 'reason'>,
): string {
  return JSON.stringify({
    reason,
    ...detail,
    ...(priority.priority > 0 ? {
      admissionPriority: priority.priorityClass,
      admissionPriorityValue: priority.effectivePriority,
      admissionCandidateCount: priority.candidateCount,
      admissionPriorityAged: priority.aged,
      admissionChannelKeys: priority.availableChannelKeys,
    } : {}),
  });
}

export function admitOperation(
  options: AdmissionOptions,
  instance: InstanceFence & { leaseMs?: number; operationId?: string },
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
    demandSnapshots.set(options.db, options.db.prepare('SELECT * FROM execution_operations').all()
      .map(row => mapOperation(row as Parameters<typeof mapOperation>[0])));
    const requestedRow = instance.operationId ? options.db.prepare(`
      SELECT * FROM execution_operations WHERE id = ? AND status IN ('pending', 'deferred')
    `).get(instance.operationId) as Parameters<typeof mapOperation>[0] | undefined : undefined;
    if (instance.operationId && !requestedRow) return { kind: 'idle' };
    const actors = requestedRow
      ? [mapOperation(requestedRow).actorId]
      : (options.db.prepare(`
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
      const rows = requestedRow ? [requestedRow] : options.db.prepare(`
        SELECT * FROM execution_operations
        WHERE actorId = ? AND status IN ('pending', 'deferred')
        ORDER BY readySeq
      `).all(actorId) as Array<Parameters<typeof mapOperation>[0]>;
      if (rows.length === 0) continue;
      const policy = readActorPolicy(options.db, actorId);
      const accountingPeriod = shanghaiAccountingPeriod(now);
      const evaluations: AdmissionEvaluation[] = rows.map((row) => {
        const operation = mapOperation(row);
        return {
          row,
          operation,
          blocked: candidateReason(options, operation, policy, accountingPeriod),
          priority: effectiveMediaAdmissionPriority(
            readMediaAdmissionPriority(options.db, operation, now),
            operation.createdAt,
            now,
          ),
        };
      });
      const head = evaluations[0];
      let chosen: AdmissionEvaluation | undefined;
      if (requestedRow) {
        if (!head.blocked) chosen = head;
      } else {
        // Member rotation stays the outer fairness layer. Within one member,
        // only an eligible pool head may be reordered:
        // - a single-channel task beats an overflow task;
        // - an older overflow task is promoted after the aging window;
        // - permission/budget/pause/cost gates keep the historical FIFO block.
        const mayReorder = !head.blocked
          || head.blocked.reason === 'pool_capacity'
          || head.blocked.reason === 'fair_share';
        if (mayReorder) {
          chosen = evaluations
            .filter((evaluation) => !evaluation.blocked)
            .sort((left, right) =>
              left.priority.effectivePriority - right.priority.effectivePriority
              || left.operation.readySeq - right.operation.readySeq)[0];
        }
      }
      if (!chosen) {
        const { reason, detail } = head.blocked ?? {
          reason: 'pool_capacity' as const,
          detail: undefined,
        };
        if (!reasons.includes(reason)) reasons.push(reason);
        writeAdmissionPriority(options, head.operation.id, head.priority);
        options.db.prepare(`
          UPDATE execution_operations SET status = 'deferred', waitReason = ?, waitDetail = ?, updatedAt = ?
          WHERE id = ?
        `).run(
          reason,
          priorityWaitDetail(head.priority, reason, detail),
          now.toISOString(),
          head.operation.id,
        );
        continue;
      }
      const operation = chosen.operation;
      writeAdmissionPriority(options, operation.id, chosen.priority);

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
