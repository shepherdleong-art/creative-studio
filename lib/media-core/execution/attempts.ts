import { createHash, randomUUID } from 'node:crypto';
import {
  assertMoney,
  ExecutionError,
  type AttachReceiptInput,
  type AttemptRecord,
  type CostQuote,
  type ExecutionFacadeOptions,
  type ExecutionReceipt,
  type MarkSubmittingInput,
  type OperationRecord,
  type SettleInput,
  type SubmitIntent,
} from './context.ts';
import { readActorPolicy, monthlyCostUsage, shanghaiAccountingPeriod } from './pools.ts';
import { readAttempt, readOperation } from './records.ts';

type AttemptOptions = ExecutionFacadeOptions & { assertOpen(): void };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(',')}}`;
}

function requestHash(snapshot: unknown): string {
  return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

function safeReceipt(receipt: ExecutionReceipt): ExecutionReceipt {
  for (const value of [receipt.remoteId, receipt.resultRef]) {
    if (value !== undefined && (!value.trim() || value.length > 1_000)) {
      throw new ExecutionError('invalid_receipt', '远端回执身份无效。');
    }
  }
  if (receipt.errorCode !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/.test(receipt.errorCode)) {
    throw new ExecutionError('invalid_receipt', '回执只允许安全错误码。');
  }
  if (receipt.actualCost) assertMoney(receipt.actualCost);
  return {
    remoteId: receipt.remoteId,
    resultRef: receipt.resultRef,
    terminalState: receipt.terminalState,
    actualCost: receipt.actualCost,
    errorCode: receipt.errorCode,
  };
}

export function journalIdentity(operation: OperationRecord, attempt: AttemptRecord) {
  return {
    operationId: operation.id,
    attemptId: attempt.id,
    permitId: attempt.permitId,
    actorId: attempt.actorId,
    module: operation.module,
    step: operation.step,
    inputHash: operation.inputHash,
    requestHash: attempt.requestHash ?? undefined,
    transportSeq: attempt.transportSeq,
    requiredPools: operation.requiredPools,
    policyVersion: attempt.policyVersion,
    accountingPeriod: attempt.accountingPeriod,
    currency: attempt.currency,
    reservedMinor: attempt.reservedMinor,
  };
}

export function intentFromAttempt(attempt: AttemptRecord): SubmitIntent {
  if (!attempt.requestHash || attempt.intentJournalSeq === null) {
    throw new ExecutionError('submit_intent_missing', '提交意图证据不完整。');
  }
  return {
    operationId: attempt.operationId,
    attemptId: attempt.id,
    permitId: attempt.permitId,
    actorId: attempt.actorId,
    submitRound: attempt.submitRound,
    transportSeq: attempt.transportSeq,
    intentJournalSeq: attempt.intentJournalSeq,
    requestHash: attempt.requestHash,
    instanceId: attempt.instanceId,
    fence: attempt.fence,
  };
}

function assertCurrentIdentity(attempt: AttemptRecord, identity: { instanceId: string; fence: number }): void {
  if (attempt.instanceId !== identity.instanceId || attempt.fence !== identity.fence) {
    throw new ExecutionError('stale_fence', '执行 instance/fence 已变化，拒绝迟到写回。');
  }
}

function assertStageAllowed(options: AttemptOptions, operation: OperationRecord): void {
  if (options.maintenance()) throw new ExecutionError('maintenance', '维护状态停止新付费提交。');
  if (!options.actorAllowed(operation.actorId)) throw new ExecutionError('actor_disabled', '账号停用只阻止新付费提交。');
  if (!options.scopeAllowed(operation.actorId, {
    resourceType: operation.scopeType, resourceId: operation.scopeId,
  })) throw new ExecutionError('scope_forbidden', 'scope 已阻止新付费提交。');
  const policy = readActorPolicy(options.db, operation.actorId);
  if (policy.paused) throw new ExecutionError('actor_paused', '成员已暂停新的付费生成。');
  for (const poolKey of operation.requiredPools) {
    const pool = options.db.prepare('SELECT enabled FROM execution_pools WHERE poolKey = ?').get(poolKey) as { enabled: number } | undefined;
    if (!pool) throw new ExecutionError('pool_missing', `资源池 ${poolKey} 未配置。`);
    if (!pool.enabled) throw new ExecutionError('pool_disabled', `资源池 ${poolKey} 已停用。`);
  }
}

function quoteValues(quote: CostQuote, limited: boolean): { reserve: number; costState: 'reserved' | 'unknown'; snapshot: unknown } {
  if (quote.kind === 'priced') {
    assertMoney(quote.reserve);
    return { reserve: quote.reserve.minor, costState: 'reserved', snapshot: quote.pricingSnapshot };
  }
  if (limited) throw new ExecutionError('pricing_required', '受限成员缺少可信价格上界。');
  return { reserve: 0, costState: 'unknown', snapshot: quote.pricingSnapshot ?? null };
}

export async function markSubmitting(options: AttemptOptions, input: MarkSubmittingInput): Promise<SubmitIntent> {
  options.assertOpen();
  const verification = options.journal.verify();
  if (!verification.valid) throw new ExecutionError('execution_journal_unavailable', '执行 journal 不可写，禁止提交。');
  const hash = requestHash(input.requestSnapshot);
  const newId = options.newId ?? randomUUID;
  const now = options.now?.() ?? new Date();
  const prepared = options.db.transaction(() => {
    const operation = readOperation(options.db, input.grant.operation.id);
    assertStageAllowed(options, operation);
    let attempt: AttemptRecord;
    if ((input.retryKind ?? 'initial') === 'initial') {
      attempt = readAttempt(options.db, input.grant.attempt.id);
      if (attempt.operationId !== operation.id || attempt.permitId !== input.grant.permitId) {
        throw new ExecutionError('attempt_conflict', 'grant 与执行尝试不一致。');
      }
      assertCurrentIdentity(attempt, input.grant.instance);
      if (attempt.submissionState === 'maybe_sent') {
        if (attempt.requestHash !== hash) throw new ExecutionError('attempt_conflict', '同一传输的请求已变化。');
        return { operation, attempt, existing: true };
      }
      if (attempt.submissionState !== 'not_sent') throw new ExecutionError('attempt_conflict', '该传输已经收到回执。');
      const policy = readActorPolicy(options.db, operation.actorId);
      if (policy.monthlyLimitMinor !== null
        && monthlyCostUsage(options.db, operation.actorId, attempt.accountingPeriod) > policy.monthlyLimitMinor) {
        throw new ExecutionError('monthly_budget', '成员额度降低后阻止尚未发送的付费提交。');
      }
      for (const poolKey of operation.requiredPools) {
        const pool = options.db.prepare('SELECT capacity FROM execution_pools WHERE poolKey = ?').pluck().get(poolKey) as number;
        const held = options.db.prepare(`
          SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND poolKey = ? AND state = 'held'
        `).pluck().get(poolKey) as number;
        if (held > pool) throw new ExecutionError('pool_capacity', '共享池降容后阻止尚未发送的提交。');
      }
      const personalHeld = options.db.prepare(`
        SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND poolKey = ? AND state = 'held'
      `).pluck().get(`actor:${operation.actorId}:remote`) as number;
      if (personalHeld > policy.personalConcurrency) {
        throw new ExecutionError('personal_concurrency', '个人并发降额后阻止尚未发送的提交。');
      }
      options.faults?.beforeIntentDatabase?.();
      const changed = options.db.prepare(`
        UPDATE execution_attempts SET submissionState = 'maybe_sent', requestHash = ?, policyVersion = ?, updatedAt = ?
        WHERE id = ? AND submissionState = 'not_sent' AND instanceId = ? AND fence = ?
      `).run(hash, policy.version, now.toISOString(), attempt.id, attempt.instanceId, attempt.fence);
      options.db.prepare('UPDATE execution_reservations SET policyVersion = ? WHERE kind = ? AND attemptId = ?')
        .run(policy.version, 'cost', attempt.id);
      if (changed.changes !== 1) throw new ExecutionError('stale_fence', '提交前执行权已变化。');
    } else {
      const previous = readAttempt(options.db, operation.currentAttemptId ?? '');
      assertCurrentIdentity(previous, input.grant.instance);
      if (previous.permitId !== input.grant.permitId || previous.submissionState !== 'terminal'
        || previous.costState !== 'settled') {
        throw new ExecutionError('previous_attempt_uncertain', '前一传输未明确终态并结算，禁止内部回退。');
      }
      const held = options.db.prepare(`
        SELECT COUNT(*) FROM execution_reservations
        WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'
      `).pluck().get(previous.permitId) as number;
      if (held !== operation.requiredPools.length + 1) {
        throw new ExecutionError('permit_released', '原远端并发 permit 已释放，不能按内部回退复用。');
      }
      if (!input.quote) throw new ExecutionError('pricing_required', '内部回退必须重新提供价格快照。');
      const policy = readActorPolicy(options.db, operation.actorId);
      const values = quoteValues(input.quote, policy.monthlyLimitMinor !== null);
      const period = shanghaiAccountingPeriod(now);
      if (policy.monthlyLimitMinor !== null
        && monthlyCostUsage(options.db, operation.actorId, period) + values.reserve > policy.monthlyLimitMinor) {
        throw new ExecutionError('monthly_budget', '内部回退需要重新通过月度费用门禁。');
      }
      const attemptId = newId();
      const at = now.toISOString();
      options.db.prepare(`
        INSERT INTO execution_attempts (
          id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
          requestHash, providerSnapshotJson, pricingSnapshotJson, submissionState,
          instanceId, fence, leaseOwner, leaseUntil, policyVersion, accountingPeriod,
          currency, reservedMinor, actualMinor, costState, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'maybe_sent', ?, ?, ?, ?, ?, ?, 'CNY', ?, NULL, ?, ?, ?)
      `).run(
        attemptId, operation.id, previous.permitId, operation.actorId, operation.businessAttemptNo,
        previous.submitRound, previous.transportSeq + 1, hash, JSON.stringify(operation.providerSnapshot),
        values.snapshot === null ? null : JSON.stringify(values.snapshot), previous.instanceId, previous.fence,
        previous.leaseOwner, new Date(now.getTime() + 30_000).toISOString(), policy.version, period,
        values.reserve, values.costState, at, at,
      );
      options.db.prepare(`
        INSERT INTO execution_reservations (
          id, operationId, permitId, attemptId, actorId, kind, poolKey, state,
          accountingPeriod, currency, reservedMinor, costState, policyVersion, createdAt
        ) VALUES (?, ?, ?, ?, ?, 'cost', ?, 'held', ?, 'CNY', ?, ?, ?, ?)
      `).run(newId(), operation.id, previous.permitId, attemptId, operation.actorId,
        `actor:${operation.actorId}:cost`, period, values.reserve, values.costState, policy.version, at);
      attempt = readAttempt(options.db, attemptId);
    }
    options.db.prepare(`
      UPDATE execution_operations SET status = 'maybe_sent', currentAttemptId = ?, updatedAt = ? WHERE id = ?
    `).run(attempt.id, now.toISOString(), operation.id);
    return { operation, attempt: readAttempt(options.db, attempt.id), existing: false };
  }).immediate();

  if (prepared.existing) return intentFromAttempt(prepared.attempt);
  const record = options.journal.appendIntent({
    ...journalIdentity(prepared.operation, prepared.attempt),
    costState: prepared.attempt.costState,
    at: now.toISOString(),
  });
  options.db.prepare(`
    UPDATE execution_attempts SET intentJournalSeq = ? WHERE id = ? AND intentJournalSeq IS NULL
  `).run(record.seq, prepared.attempt.id);
  return intentFromAttempt(readAttempt(options.db, prepared.attempt.id));
}

export async function attachReceipt(options: ExecutionFacadeOptions, input: AttachReceiptInput): Promise<AttemptRecord> {
  const attempt = readAttempt(options.db, input.intent.attemptId);
  const operation = readOperation(options.db, attempt.operationId);
  assertCurrentIdentity(attempt, input.intent);
  if (attempt.id !== input.intent.attemptId || attempt.permitId !== input.intent.permitId
    || attempt.transportSeq !== input.intent.transportSeq || attempt.requestHash !== input.intent.requestHash
    || attempt.intentJournalSeq !== input.intent.intentJournalSeq) {
    throw new ExecutionError('attempt_conflict', '提交意图与回执目标不一致。');
  }
  const receipt = safeReceipt(input.receipt);
  if (attempt.receiptJournalSeq !== null) {
    if (canonical(attempt.receipt) !== canonical(receipt)) {
      throw new ExecutionError('receipt_conflict', '同一传输已有不同回执。');
    }
    return attempt;
  }
  if (attempt.submissionState !== 'maybe_sent') throw new ExecutionError('attempt_conflict', '回执对应传输不在 maybe_sent。');
  const now = options.now?.() ?? new Date();
  const record = options.journal.appendReceipt({
    ...journalIdentity(operation, attempt),
    at: now.toISOString(),
    remoteId: receipt.remoteId,
    resultRef: receipt.resultRef,
    terminalState: receipt.terminalState,
    actualCost: receipt.actualCost,
    errorCode: receipt.errorCode,
  });
  options.db.transaction(() => {
    options.faults?.beforeReceiptDatabase?.();
    const state = receipt.terminalState ? 'terminal' : 'accepted';
    options.db.prepare(`
      UPDATE execution_attempts SET
        submissionState = ?, terminalState = ?, remoteId = ?, receiptJson = ?, receiptJournalSeq = ?,
        actualMinor = ?, errorCode = ?, updatedAt = ?
      WHERE id = ? AND receiptJournalSeq IS NULL AND instanceId = ? AND fence = ?
    `).run(
      state, receipt.terminalState ?? null, receipt.remoteId ?? null, JSON.stringify(receipt), record.seq,
      receipt.actualCost?.minor ?? null, receipt.errorCode ?? null, now.toISOString(),
      attempt.id, attempt.instanceId, attempt.fence,
    );
    if (operation.currentAttemptId === attempt.id) {
      const operationStatus = receipt.terminalState === 'succeeded' ? 'succeeded'
        : receipt.terminalState === 'failed' ? 'failed'
          : receipt.terminalState === 'not_created' ? 'reconciling' : 'accepted';
      options.db.prepare('UPDATE execution_operations SET status = ?, updatedAt = ? WHERE id = ?')
        .run(operationStatus, now.toISOString(), operation.id);
    }
  }).immediate();
  return readAttempt(options.db, attempt.id);
}

export async function settleAttempt(options: ExecutionFacadeOptions, input: SettleInput): Promise<AttemptRecord> {
  const before = readAttempt(options.db, input.attemptId);
  const actualCost = input.actualCost ?? null;
  if (actualCost) assertMoney(actualCost);
  const reservation = options.db.prepare(`
    SELECT * FROM execution_reservations WHERE kind = 'cost' AND attemptId = ?
  `).get(input.attemptId) as { state: string; actualMinor: number | null; costState: string } | undefined;
  if (!reservation) throw new ExecutionError('cost_reservation_missing', '执行费用预留缺失，禁止结算。');
  const operation = readOperation(options.db, before.operationId);
  const releaseRemote = input.remoteTerminal && operation.currentAttemptId === before.id;
  const latePricing = actualCost !== null && reservation.costState === 'unknown'
    && before.terminalState === input.outcome;
  const alreadyFinal = !latePricing && (reservation.state !== 'held'
    || (before.costState === 'unknown' && before.submissionState === 'terminal' && before.actualMinor === null));
  if (alreadyFinal) {
    if (before.terminalState !== input.outcome
      || (before.actualMinor !== null && before.actualMinor !== actualCost?.minor)
      || (before.actualMinor === null && actualCost !== null)) {
      throw new ExecutionError('settle_conflict', '同一传输已有不同结算结果。');
    }
    if (releaseRemote) {
      const at = (options.now?.() ?? new Date()).toISOString();
      options.db.transaction(() => {
        options.db.prepare(`
          UPDATE execution_reservations SET state = 'released', releasedAt = COALESCE(releasedAt, ?),
            releaseReason = COALESCE(releaseReason, ?)
          WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'
        `).run(at, input.outcome === 'not_created' ? 'confirmed_not_created' : 'remote_terminal', before.permitId);
        options.db.prepare(`
          UPDATE execution_operations SET status = ?, resultJson = COALESCE(?, resultJson), updatedAt = ? WHERE id = ?
        `).run(
          input.outcome === 'not_created' ? 'pending' : input.outcome,
          input.result === undefined ? null : JSON.stringify(input.result), at, operation.id,
        );
      }).immediate();
    }
    return readAttempt(options.db, before.id);
  }
  if (before.actualMinor !== null && before.actualMinor !== actualCost?.minor) {
    throw new ExecutionError('settle_conflict', '结算金额与已持久回执不一致。');
  }
  const policy = readActorPolicy(options.db, before.actorId);
  const now = options.now?.() ?? new Date();
  const at = now.toISOString();
  const unknown = actualCost === null && input.outcome !== 'not_created';
  const keepUnknownHeld = unknown && policy.monthlyLimitMinor !== null;
  options.db.transaction(() => {
    const costState = input.outcome === 'not_created' ? 'released' : unknown ? 'unknown' : 'settled';
    options.db.prepare(`
      UPDATE execution_attempts SET submissionState = 'terminal', terminalState = ?, actualMinor = ?,
        costState = ?, errorCode = COALESCE(?, errorCode), updatedAt = ?
      WHERE id = ?
    `).run(input.outcome, actualCost?.minor ?? null, costState, input.errorCode ?? null, at, before.id);
    if (input.outcome === 'not_created') {
      options.db.prepare(`
        UPDATE execution_reservations SET state = 'released', actualMinor = NULL, costState = 'released',
          releasedAt = ?, releaseReason = 'confirmed_not_created' WHERE attemptId = ? AND kind = 'cost' AND state = 'held'
      `).run(at, before.id);
    } else if (keepUnknownHeld) {
      options.db.prepare(`
        UPDATE execution_reservations SET actualMinor = NULL, costState = 'unknown'
        WHERE attemptId = ? AND kind = 'cost' AND state = 'held'
      `).run(before.id);
    } else {
      options.db.prepare(`
        UPDATE execution_reservations SET state = 'settled', actualMinor = ?, costState = ?, settledAt = ?
        WHERE attemptId = ? AND kind = 'cost'
          AND (state = 'held' OR (state = 'settled' AND costState = 'unknown'))
      `).run(actualCost?.minor ?? null, unknown ? 'unknown' : 'settled', at, before.id);
    }
    if (releaseRemote) {
      options.db.prepare(`
        UPDATE execution_reservations SET state = 'released', releasedAt = ?, releaseReason = ?
        WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'
      `).run(at, input.outcome === 'not_created' ? 'confirmed_not_created' : 'remote_terminal', before.permitId);
    }
    if (input.outcome === 'not_created' && releaseRemote) {
      options.db.prepare(`
        UPDATE execution_operations SET status = 'pending', currentAttemptId = NULL, currentPermitId = NULL,
          waitReason = NULL, waitDetail = NULL, updatedAt = ? WHERE id = ?
      `).run(at, operation.id);
    } else if (releaseRemote) {
      options.db.prepare(`
        UPDATE execution_operations SET status = ?, resultJson = COALESCE(?, resultJson), updatedAt = ? WHERE id = ?
      `).run(input.outcome, input.result === undefined ? null : JSON.stringify(input.result), at, operation.id);
    }
  }).immediate();
  if (!unknown && input.outcome !== 'not_created') {
    try {
      await options.mirrorUsage?.({ attemptId: before.id, actualCost, outcome: input.outcome });
    } catch {
      // usage 只是镜像；执行台账已提交，失败不参与门禁也不回滚。
    }
  }
  return readAttempt(options.db, before.id);
}

export async function transmitAttempt(
  options: ExecutionFacadeOptions,
  intent: SubmitIntent,
  send: (intent: SubmitIntent) => Promise<ExecutionReceipt>,
): Promise<AttemptRecord> {
  const before = readAttempt(options.db, intent.attemptId);
  assertCurrentIdentity(before, intent);
  if (before.permitId !== intent.permitId || before.transportSeq !== intent.transportSeq
    || before.requestHash !== intent.requestHash || before.intentJournalSeq !== intent.intentJournalSeq) {
    throw new ExecutionError('attempt_conflict', '传输意图与执行尝试不一致。');
  }
  if (before.submissionState === 'accepted' || before.submissionState === 'terminal') return before;
  if (before.submissionState !== 'maybe_sent' || before.intentJournalSeq === null) {
    throw new ExecutionError('submit_intent_missing', '缺少已刷盘提交意图，禁止自动重提。');
  }
  let receipt: ExecutionReceipt;
  try {
    receipt = await send(intent);
  } catch (error) {
    const operation = readOperation(options.db, before.operationId);
    const now = options.now?.() ?? new Date();
    await Promise.resolve(options.journal.appendReceipt({
      ...journalIdentity(operation, before), at: now.toISOString(), terminalState: 'unknown',
      errorCode: 'transport_unknown',
    }));
    options.db.prepare("UPDATE execution_operations SET status = 'unknown', updatedAt = ? WHERE id = ?")
      .run(now.toISOString(), operation.id);
    throw error;
  }
  return attachReceipt(options, { intent, receipt });
}
