import { randomUUID } from 'node:crypto';
import {
  ExecutionError,
  type AdmissionWaitReason,
  type AdmitResult,
  type ExecutionFacadeOptions,
  type InstanceFence,
} from './context.ts';
import {
  mapOperationDecision,
  readAttempt,
  readOperation,
  OPERATION_DECISION_COLUMNS,
  type OperationDecision,
  type OperationDecisionRow,
} from './records.ts';
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
  operation: OperationDecision;
  blocked: WaitDecision | null;
  priority: EffectiveMediaAdmissionPriority;
}

type WaitDecision = { reason: AdmissionWaitReason; detail?: Omit<AdmissionWaitDetail, 'reason'> };

/** 单次准入内一次查询得到的 held 并发预约聚合。 */
interface HeldReservations {
  byPool: Map<string, number>;
  byPoolActor: Map<string, number>;
  operationIds: Set<string>;
}

/**
 * 单次准入内的有界缓存。只在当前事务/调用内有效，函数返回后即可回收；
 * 不得把这里的任何数据挂到数据库实例或模块级容器上长期保留。
 */
interface AdmissionRun {
  options: AdmissionOptions;
  now: Date;
  accountingPeriod: string;
  demand?: OperationDecision[];
  waitingByActor?: Map<string, OperationDecision[]>;
  policies: Map<string, ActorPolicy>;
  pools: Map<string, PoolState | null>;
  held?: HeldReservations;
  monthlyUsage: Map<string, number>;
  costUnknown: Map<string, boolean>;
  autoLimits: Map<string, number>;
  eligibility: Map<string, WaitDecision | null>;
}

function createRun(options: AdmissionOptions, now: Date): AdmissionRun {
  return {
    options,
    now,
    accountingPeriod: shanghaiAccountingPeriod(now),
    policies: new Map(),
    pools: new Map(),
    monthlyUsage: new Map(),
    costUnknown: new Map(),
    autoLimits: new Map(),
    eligibility: new Map(),
  };
}

function readPolicy(run: AdmissionRun, actorId: string): ActorPolicy {
  const cached = run.policies.get(actorId);
  if (cached) return cached;
  const policy = readActorPolicy(run.options.db, actorId);
  run.policies.set(actorId, policy);
  return policy;
}

function readPoolState(run: AdmissionRun, poolKey: string): PoolState | undefined {
  if (run.pools.has(poolKey)) return run.pools.get(poolKey) ?? undefined;
  const pool = run.options.db.prepare('SELECT * FROM execution_pools WHERE poolKey = ?').get(poolKey) as
    | PoolState | undefined;
  run.pools.set(poolKey, pool ?? null);
  return pool;
}

/**
 * held 并发预约:按池计数、按池+成员计数与 held operationId 集合共用一次查询。
 * 原实现分别用 GROUP BY 与 DISTINCT 扫两遍同一谓词,这里一次取出后在内存聚合。
 */
function heldReservations(run: AdmissionRun): HeldReservations {
  if (!run.held) {
    const byPool = new Map<string, number>();
    const byPoolActor = new Map<string, number>();
    const operationIds = new Set<string>();
    const rows = run.options.db.prepare(`
      SELECT operationId, poolKey, actorId FROM execution_reservations
      WHERE kind = 'concurrency' AND state = 'held'
    `).all() as Array<{ operationId: string; poolKey: string; actorId: string }>;
    for (const row of rows) {
      byPool.set(row.poolKey, (byPool.get(row.poolKey) ?? 0) + 1);
      const actorKey = `${row.actorId}\u0000${row.poolKey}`;
      byPoolActor.set(actorKey, (byPoolActor.get(actorKey) ?? 0) + 1);
      operationIds.add(row.operationId);
    }
    run.held = { byPool, byPoolActor, operationIds };
  }
  return run.held;
}

function heldCounts(run: AdmissionRun): { byPool: Map<string, number>; byPoolActor: Map<string, number> } {
  const held = heldReservations(run);
  return { byPool: held.byPool, byPoolActor: held.byPoolActor };
}

function heldPoolCount(run: AdmissionRun, poolKey: string, actorId?: string): number {
  const counts = heldCounts(run);
  return actorId === undefined
    ? counts.byPool.get(poolKey) ?? 0
    : counts.byPoolActor.get(`${actorId}\u0000${poolKey}`) ?? 0;
}

function heldOperationIds(run: AdmissionRun): Set<string> {
  return heldReservations(run).operationIds;
}

/** 仍然活跃的需求；终态历史不进入每次准入的搬运与解析。 */
function demandRows(run: AdmissionRun): OperationDecision[] {
  if (!run.demand) {
    run.demand = (run.options.db.prepare(`
      SELECT ${OPERATION_DECISION_COLUMNS} FROM execution_operations
      WHERE status IN ('pending', 'deferred', 'admitted', 'maybe_sent', 'accepted', 'reconciling', 'unknown')
    `).all() as OperationDecisionRow[]).map(mapOperationDecision);
  }
  return run.demand;
}

/**
 * 待准入需求按成员分组。直接派生自已查的活跃需求投影(demandRows),
 * 不再为 pending/deferred 单独扫一遍 execution_operations;组内顺序按
 * readySeq 升序,保持原 `ORDER BY actorId, readySeq` 的成员内 FIFO 语义。
 */
function waitingRowsByActor(run: AdmissionRun): Map<string, OperationDecision[]> {
  if (!run.waitingByActor) {
    const grouped = new Map<string, OperationDecision[]>();
    const rows = demandRows(run)
      .filter((operation) => operation.status === 'pending' || operation.status === 'deferred')
      .sort((left, right) => (
        left.actorId === right.actorId
          ? left.readySeq - right.readySeq
          : left.actorId < right.actorId ? -1 : 1
      ));
    for (const operation of rows) {
      const list = grouped.get(operation.actorId) ?? [];
      list.push(operation);
      grouped.set(operation.actorId, list);
    }
    run.waitingByActor = grouped;
  }
  return run.waitingByActor;
}

function monthlyUsage(run: AdmissionRun, actorId: string): number {
  const cached = run.monthlyUsage.get(actorId);
  if (cached !== undefined) return cached;
  const usage = monthlyCostUsage(run.options.db, actorId, run.accountingPeriod);
  run.monthlyUsage.set(actorId, usage);
  return usage;
}

function hasUnknownCost(run: AdmissionRun, actorId: string): boolean {
  const cached = run.costUnknown.get(actorId);
  if (cached !== undefined) return cached;
  const unknown = Boolean(run.options.db.prepare(`
    SELECT 1 FROM execution_reservations
    WHERE kind = 'cost' AND actorId = ? AND state IN ('held', 'settled') AND costState = 'unknown' LIMIT 1
  `).get(actorId));
  run.costUnknown.set(actorId, unknown);
  return unknown;
}

function automaticConcurrencyLimit(run: AdmissionRun, poolKey: string): number {
  const cached = run.autoLimits.get(poolKey);
  if (cached !== undefined) return cached;
  const capacity = readPoolState(run, poolKey)?.capacity ?? Number.NaN;
  const activeActors = new Set<string>();
  for (const candidate of demandRows(run)) {
    if (!candidate.requiredPools.includes(poolKey)) continue;
    if (candidate.status === 'pending' || candidate.status === 'deferred') {
      if (eligibilityReason(run, candidate)) continue;
    } else if (['admitted', 'maybe_sent', 'accepted', 'reconciling', 'unknown'].includes(candidate.status)) {
      if (!heldOperationIds(run).has(candidate.id)) continue;
      // Existing accepted/unknown occupancy is real demand even if a later
      // pause or permission change prevents that actor from starting new work.
    } else continue;
    activeActors.add(candidate.actorId);
  }
  const limit = Math.max(1, Math.ceil(capacity / Math.max(1, activeActors.size)));
  run.autoLimits.set(poolKey, limit);
  return limit;
}

function eligibilityReason(run: AdmissionRun, operation: OperationDecision): WaitDecision | null {
  if (!run.eligibility.has(operation.id)) {
    run.eligibility.set(operation.id, candidateReason(run, operation, readPolicy(run, operation.actorId), true));
  }
  return run.eligibility.get(operation.id) ?? null;
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
  run: AdmissionRun,
  operation: OperationDecision,
  policy: ActorPolicy,
  eligibilityOnly = false,
): WaitDecision | null {
  const options = run.options;
  if (options.maintenance()) return { reason: 'maintenance' };
  if (!options.actorAllowed(operation.actorId)) return { reason: 'actor_disabled' };
  if (!options.scopeAllowed(operation.actorId, {
    resourceType: operation.scopeType, resourceId: operation.scopeId,
  })) return { reason: 'scope_forbidden' };
  if (policy.paused) return { reason: 'actor_paused' };
  if (!actorModelAllowed(policy, operation.providerSnapshot)) return { reason: 'model_forbidden' };
  const currentConcurrency = heldPoolCount(run, personalConcurrencyPoolKey(operation.actorId));
  if (!eligibilityOnly) for (const poolKey of operation.requiredPools) {
    const pool = readPoolState(run, poolKey);
    if (!pool || !pool.mappingSnapshotJson || pool.mappingSnapshotJson === '{}') return { reason: 'pool_missing', detail: { poolKey } };
    if (!pool.enabled) return { reason: 'pool_disabled', detail: { poolKey } };
    const poolConcurrency = heldPoolCount(run, poolKey);
    if (poolConcurrency < pool.capacity && policy.effectiveConcurrency === null) {
      const actorHeld = heldPoolCount(run, poolKey, operation.actorId);
      const limit = automaticConcurrencyLimit(run, poolKey);
      if (actorHeld >= limit) return {
        reason: 'fair_share',
        detail: { concurrencySource: policy.concurrencySource, currentConcurrency: actorHeld, effectiveConcurrency: limit, poolKey, capacity: pool.capacity },
      };
    }
    if (poolConcurrency >= pool.capacity) return { reason: 'pool_capacity', detail: { poolKey, currentConcurrency: poolConcurrency, capacity: pool.capacity } };
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
    if (hasUnknownCost(run, operation.actorId)) return { reason: 'cost_unknown' };
    const reserve = operation.quote.kind === 'priced' ? operation.quote.reserve.minor : 0;
    if (monthlyUsage(run, operation.actorId) + reserve > policy.monthlyLimitMinor) {
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

function readRequestedOperation(
  options: AdmissionOptions,
  operationId: string,
): OperationDecision | undefined {
  const row = options.db.prepare(`
    SELECT ${OPERATION_DECISION_COLUMNS} FROM execution_operations
    WHERE id = ? AND status IN ('pending', 'deferred')
  `).get(operationId) as OperationDecisionRow | undefined;
  return row ? mapOperationDecision(row) : undefined;
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
  const run = createRun(options, now);
  const transaction = options.db.transaction((): AdmitResult => {
    const owner = options.db.prepare(`
      SELECT 1 FROM execution_instances
      WHERE instanceId = ? AND fence = ? AND deploymentId = ? AND stoppedAt IS NULL
    `).get(instance.instanceId, instance.fence, options.deploymentId);
    if (!owner) throw new ExecutionError('stale_fence', '执行 instance/fence 已失效。');
    const state = options.db.prepare('SELECT cursorActorId FROM execution_admission_state WHERE id = 1').get() as
      | { cursorActorId: string | null } | undefined;
    if (!state) throw new ExecutionError('execution_not_ready', '执行轮转状态未就绪。');
    const requested = instance.operationId ? readRequestedOperation(options, instance.operationId) : undefined;
    if (instance.operationId && !requested) return { kind: 'idle' };
    const actors = requested
      ? [requested.actorId]
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
      const rows = requested ? [requested] : waitingRowsByActor(run).get(actorId) ?? [];
      if (rows.length === 0) continue;
      const policy = readPolicy(run, actorId);
      const evaluations: AdmissionEvaluation[] = rows.map((operation) => ({
        operation,
        blocked: candidateReason(run, operation, policy),
        priority: effectiveMediaAdmissionPriority(
          readMediaAdmissionPriority(options.db, operation, now),
          operation.createdAt,
          now,
        ),
      }));
      const head = evaluations[0];
      let chosen: AdmissionEvaluation | undefined;
      if (requested) {
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
      // 决策阶段只搬运轻量字段；完整输入只在真正授予时按 ID 读取一次。
      const operation = readOperation(options.db, chosen.operation.id);
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
        policy.version, run.accountingPeriod, reservedMinor,
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
        run.accountingPeriod, reservedMinor, operation.quote.kind === 'priced' ? 'reserved' : 'unknown',
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
  return transaction.immediate();
}
