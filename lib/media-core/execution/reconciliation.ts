import { randomUUID } from 'node:crypto';
import {
  assertMoney,
  ExecutionError,
  type AttemptRecord,
  type ExecutionFacadeOptions,
  type ExecutionJournalRecord,
  type OperationRecord,
  type ReconcileInput,
  type TerminalState,
} from './context.ts';
import { attachReceipt, intentFromAttempt, journalIdentity, settleAttempt } from './attempts.ts';
import { personalConcurrencyPoolKey, readActorPolicy } from './pools.ts';
import { readAttempt, readOperation } from './records.ts';

export interface ExecutionRecoveryResult {
  available: boolean;
  unknownAttemptIds: string[];
  orphanAttemptIds: string[];
  recoveredReceiptAttemptIds: string[];
}

function receiptFor(records: ExecutionJournalRecord[] | undefined): ExecutionJournalRecord | undefined {
  return records?.filter((record) => record.eventType === 'receipt').at(-1);
}

function applyReceipt(
  options: ExecutionFacadeOptions,
  operation: OperationRecord,
  attempt: AttemptRecord,
  record: ExecutionJournalRecord,
): AttemptRecord {
  const terminal = record.terminalState && record.terminalState !== 'unknown' ? record.terminalState : null;
  const at = record.at;
  options.db.prepare(`
    UPDATE execution_attempts SET submissionState = ?, terminalState = ?, remoteId = COALESCE(?, remoteId),
      receiptJson = ?, receiptJournalSeq = ?, actualMinor = ?, errorCode = COALESCE(?, errorCode), updatedAt = ?
    WHERE id = ?
  `).run(
    terminal ? 'terminal' : 'accepted', terminal, record.remoteId ?? null,
    JSON.stringify({
      remoteId: record.remoteId, resultRef: record.resultRef, terminalState: terminal ?? undefined,
      actualCost: record.actualCost, errorCode: record.errorCode,
    }), record.seq, record.actualCost?.minor ?? null, record.errorCode ?? null, at, attempt.id,
  );
  if (operation.currentAttemptId === attempt.id) {
    const status = terminal === 'succeeded' ? 'succeeded' : terminal === 'failed' ? 'failed'
      : terminal === 'not_created' ? 'reconciling' : 'accepted';
    options.db.prepare('UPDATE execution_operations SET status = ?, updatedAt = ? WHERE id = ?')
      .run(status, at, operation.id);
  }
  return readAttempt(options.db, attempt.id);
}

async function appendTerminal(
  options: ExecutionFacadeOptions,
  attempt: AttemptRecord,
  operation: OperationRecord,
  input: {
    terminalState: TerminalState;
    actualCost?: { currency: 'CNY'; minor: number } | null;
    resultRef?: string;
    errorCode?: string;
    source: string;
  },
): Promise<AttemptRecord> {
  if (input.actualCost) assertMoney(input.actualCost);
  const record = options.journal.appendReceipt({
    ...journalIdentity(operation, attempt),
    terminalState: input.terminalState,
    actualCost: input.actualCost ?? null,
    resultRef: input.resultRef,
    errorCode: input.errorCode,
    reconciliationSource: input.source,
  });
  return applyReceipt(options, operation, attempt, record);
}

export async function reconcileAttempt(options: ExecutionFacadeOptions, input: ReconcileInput): Promise<AttemptRecord> {
  const attempt = readAttempt(options.db, input.attemptId);
  const operation = readOperation(options.db, attempt.operationId);
  if (input.evidence.kind === 'still_unknown') {
    options.journal.appendReceipt({
      ...journalIdentity(operation, attempt), terminalState: 'unknown',
      errorCode: input.evidence.errorCode, reconciliationSource: input.source,
    });
    if (attempt.submissionState === 'maybe_sent') {
      options.db.prepare("UPDATE execution_operations SET status = 'unknown', updatedAt = ? WHERE id = ?")
        .run(new Date().toISOString(), operation.id);
    }
    return attempt;
  }
  if (input.evidence.kind === 'remote_id') {
    if (attempt.submissionState === 'accepted' || attempt.submissionState === 'terminal') {
      if (attempt.remoteId !== input.evidence.remoteId) {
        throw new ExecutionError('receipt_conflict', '远端身份与既有回执不一致。');
      }
      return attempt;
    }
    return attachReceipt(options, {
      intent: intentFromAttempt(attempt),
      receipt: { remoteId: input.evidence.remoteId, resultRef: input.evidence.resultRef },
    });
  }
  if (input.evidence.kind === 'confirmed_not_created') {
    if (attempt.submissionState === 'accepted'
      || (attempt.terminalState !== null && attempt.terminalState !== 'not_created')) {
      throw new ExecutionError('receipt_conflict', '已受理或已有终态的调用不能被改写为未创建。');
    }
    if (attempt.terminalState !== 'not_created') {
      await appendTerminal(options, attempt, operation, {
        terminalState: 'not_created', errorCode: input.evidence.errorCode, source: input.source,
      });
    }
    return settleAttempt(options, {
      attemptId: attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
      errorCode: input.evidence.errorCode,
    });
  }
  if (attempt.terminalState !== null && attempt.terminalState !== input.evidence.outcome) {
    throw new ExecutionError('receipt_conflict', '同一传输已有不同的远端终态。');
  }
  if (attempt.actualMinor !== null && input.evidence.actualCost
    && attempt.actualMinor !== input.evidence.actualCost.minor) {
    throw new ExecutionError('settle_conflict', '同一传输已有不同的实际费用。');
  }
  const lateActualCost = attempt.actualMinor === null && input.evidence.actualCost != null;
  if (attempt.terminalState !== input.evidence.outcome || lateActualCost) {
    await appendTerminal(options, attempt, operation, {
      terminalState: input.evidence.outcome,
      actualCost: input.evidence.actualCost,
      resultRef: input.evidence.resultRef,
      errorCode: input.evidence.errorCode,
      source: input.source,
    });
  }
  return settleAttempt(options, {
    attemptId: attempt.id,
    outcome: input.evidence.outcome,
    actualCost: input.evidence.actualCost,
    remoteTerminal: true,
    errorCode: input.evidence.errorCode,
    errorStage: 'remote_poll',
  });
}

function ensureReservations(
  options: ExecutionFacadeOptions,
  intent: ExecutionJournalRecord,
  operationId: string | null,
): void {
  const newId = options.newId ?? randomUUID;
  const addConcurrency = options.db.prepare(`
    INSERT INTO execution_reservations (id, operationId, permitId, attemptId, actorId, kind, poolKey, state, createdAt)
    VALUES (?, ?, ?, ?, ?, 'concurrency', ?, 'held', ?)
  `);
  for (const poolKey of [...intent.requiredPools, personalConcurrencyPoolKey(intent.actorId)]) {
    const existing = options.db.prepare(`
      SELECT 1 FROM execution_reservations WHERE permitId = ? AND kind = 'concurrency' AND poolKey = ?
    `).get(intent.permitId, poolKey);
    if (!existing) addConcurrency.run(newId(), operationId, intent.permitId, intent.attemptId, intent.actorId, poolKey, intent.at);
  }
  const cost = options.db.prepare('SELECT 1 FROM execution_reservations WHERE kind = ? AND attemptId = ?')
    .get('cost', intent.attemptId);
  if (!cost) {
    options.db.prepare(`
      INSERT INTO execution_reservations (
        id, operationId, permitId, attemptId, actorId, kind, poolKey, state,
        accountingPeriod, currency, reservedMinor, costState, policyVersion, createdAt
      ) VALUES (?, ?, ?, ?, ?, 'cost', ?, 'held', ?, 'CNY', ?, ?, ?, ?)
    `).run(newId(), operationId, intent.permitId, intent.attemptId, intent.actorId,
      `actor:${intent.actorId}:cost`, intent.accountingPeriod, intent.reservedMinor,
      intent.costState ?? 'reserved', intent.policyVersion, intent.at);
  }
}

function recoverOrphan(
  options: ExecutionFacadeOptions,
  intent: ExecutionJournalRecord,
  receipt: ExecutionJournalRecord | undefined,
): void {
  const existing = options.db.prepare('SELECT 1 FROM execution_reconciliation_orphans WHERE attemptId = ?').get(intent.attemptId);
  const terminal = receipt?.terminalState && receipt.terminalState !== 'unknown' ? receipt.terminalState : null;
  const state = terminal ? 'terminal' : receipt?.remoteId ? 'accepted' : 'unknown';
  if (!existing) {
    options.db.prepare(`
      INSERT INTO execution_reconciliation_orphans (
        attemptId, operationId, permitId, actorId, evidenceJson, state, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(intent.attemptId, intent.operationId, intent.permitId, intent.actorId,
      JSON.stringify([intent, ...(receipt ? [receipt] : [])]), state, intent.at, receipt?.at ?? intent.at);
  }
  if (terminal) {
    const policy = readActorPolicy(options.db, intent.actorId);
    const notCreated = terminal === 'not_created';
    const unknown = !notCreated && !receipt?.actualCost;
    const held = unknown && policy.monthlyLimitMinor !== null;
    const reservationState = notCreated ? 'released' : held ? 'held' : 'settled';
    const costState = notCreated ? 'released' : unknown ? 'unknown' : 'settled';
    const actualMinor = notCreated ? null : receipt?.actualCost?.minor ?? null;
    const hasCost = options.db.prepare('SELECT 1 FROM execution_reservations WHERE kind = ? AND attemptId = ?')
      .get('cost', intent.attemptId);
    if (!hasCost) {
      options.db.prepare(`
        INSERT INTO execution_reservations (
          id, operationId, permitId, attemptId, actorId, kind, poolKey, state,
          accountingPeriod, currency, reservedMinor, actualMinor, costState, policyVersion,
          createdAt, settledAt, releasedAt, releaseReason
        ) VALUES (?, NULL, ?, ?, ?, 'cost', ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        (options.newId ?? randomUUID)(), intent.permitId, intent.attemptId, intent.actorId,
        `actor:${intent.actorId}:cost`, reservationState,
        intent.accountingPeriod, intent.reservedMinor, actualMinor,
        costState, intent.policyVersion,
        intent.at, !notCreated && !held ? receipt?.at : null, notCreated ? receipt?.at : null,
        notCreated ? 'confirmed_not_created' : null,
      );
    } else {
      options.db.prepare(`
        UPDATE execution_reservations SET state = ?, actualMinor = ?, costState = ?,
          settledAt = CASE WHEN ? = 'settled' THEN COALESCE(settledAt, ?) ELSE settledAt END,
          releasedAt = CASE WHEN ? = 'released' THEN COALESCE(releasedAt, ?) ELSE releasedAt END,
          releaseReason = CASE WHEN ? = 'released' THEN 'confirmed_not_created' ELSE releaseReason END
        WHERE kind = 'cost' AND attemptId = ?
          AND (state = 'held' OR (state = 'settled' AND costState = 'unknown'))
      `).run(reservationState, actualMinor, costState,
        reservationState, receipt?.at ?? intent.at, reservationState, receipt?.at ?? intent.at,
        reservationState, intent.attemptId);
    }
    options.db.prepare(`
      UPDATE execution_reservations SET state = 'released', releasedAt = COALESCE(releasedAt, ?),
        releaseReason = COALESCE(releaseReason, 'remote_terminal')
      WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'
    `).run(receipt?.at ?? intent.at, intent.permitId);
    options.db.prepare(`
      UPDATE execution_reconciliation_orphans SET state = 'terminal', evidenceJson = ?, updatedAt = ? WHERE attemptId = ?
    `).run(JSON.stringify([intent, ...(receipt ? [receipt] : [])]), receipt?.at ?? intent.at, intent.attemptId);
    return;
  }
  ensureReservations(options, intent, null);
}

export async function recoverExecution(options: ExecutionFacadeOptions): Promise<ExecutionRecoveryResult> {
  const result: ExecutionRecoveryResult = {
    available: true, unknownAttemptIds: [], orphanAttemptIds: [], recoveredReceiptAttemptIds: [],
  };
  const verification = options.journal.verify({ repairTail: true });
  if (!verification.valid) {
    return { ...result, available: false };
  }
  const records = verification.records;
  const byAttempt = new Map<string, ExecutionJournalRecord[]>();
  for (const record of records) {
    const group = byAttempt.get(record.attemptId) ?? [];
    group.push(record);
    byAttempt.set(record.attemptId, group);
  }
  const inFlight = options.db.prepare(`
    SELECT id FROM execution_attempts
    WHERE submissionState IN ('not_sent', 'maybe_sent', 'accepted')
      OR (submissionState = 'terminal' AND (
        costState = 'unknown'
        OR EXISTS (
          SELECT 1 FROM execution_reservations
          WHERE attemptId = execution_attempts.id AND kind = 'cost' AND state = 'held'
        )
      ))
    ORDER BY createdAt
  `).all() as Array<{ id: string }>;
  for (const { id } of inFlight) {
    let attempt = readAttempt(options.db, id);
    const operation = readOperation(options.db, attempt.operationId);
    const evidence = byAttempt.get(id);
    const intent = evidence?.find((record) => record.eventType === 'submit_intent');
    const receipt = receiptFor(evidence);
    if (intent) {
      ensureReservations(options, intent, operation.id);
      if (attempt.submissionState === 'not_sent' || attempt.requestHash === null || attempt.intentJournalSeq === null) {
        options.db.prepare(`
          UPDATE execution_attempts SET submissionState = ?,
            requestHash = COALESCE(requestHash, ?), intentJournalSeq = COALESCE(intentJournalSeq, ?), updatedAt = ?
          WHERE id = ?
        `).run(attempt.submissionState === 'not_sent' ? 'maybe_sent' : attempt.submissionState,
          intent.requestHash ?? null, intent.seq, intent.at, id);
        attempt = readAttempt(options.db, id);
      }
    }
    if (attempt.submissionState === 'not_sent') {
      await settleAttempt(options, { attemptId: id, outcome: 'not_created', actualCost: null, remoteTerminal: true });
      continue;
    }
    if (receipt && receipt.terminalState !== 'unknown') {
      const terminal = receipt.terminalState ?? null;
      if (terminal) {
        if (attempt.terminalState && attempt.terminalState !== terminal) {
          throw new ExecutionError('receipt_conflict', '数据库与 journal 的远端终态不一致。');
        }
        if (attempt.actualMinor !== null && receipt.actualCost && attempt.actualMinor !== receipt.actualCost.minor) {
          throw new ExecutionError('settle_conflict', '数据库与 journal 的实际费用不一致。');
        }
        const shouldApply = attempt.submissionState !== 'terminal' || attempt.receiptJournalSeq === null
          || (attempt.actualMinor === null && receipt.actualCost != null);
        if (shouldApply) {
          if (attempt.receiptJournalSeq === null) result.recoveredReceiptAttemptIds.push(id);
          attempt = applyReceipt(options, operation, attempt, receipt);
        }
        const actualCost = receipt.actualCost ?? (attempt.actualMinor === null ? null : {
          currency: attempt.currency, minor: attempt.actualMinor,
        });
        await settleAttempt(options, {
          attemptId: id,
          outcome: terminal,
          actualCost,
          remoteTerminal: true,
          errorCode: receipt.errorCode,
        });
        continue;
      }
      if (attempt.submissionState !== 'terminal') {
        if (attempt.receiptJournalSeq === null) result.recoveredReceiptAttemptIds.push(id);
        applyReceipt(options, operation, attempt, receipt);
      }
      continue;
    }
    if (attempt.submissionState === 'maybe_sent') {
      result.unknownAttemptIds.push(id);
      // Restarting adds no provider evidence. Also repair timestamps previously refreshed on boot.
      // An older attempt must never replace the current operation's state or activity time.
      const evidenceAt = receipt?.at ?? attempt.updatedAt;
      options.db.prepare(`UPDATE execution_operations SET status = 'unknown', updatedAt = ?
        WHERE id = ? AND currentAttemptId = ? AND (status <> 'unknown' OR updatedAt <> ?)`)
        .run(evidenceAt, operation.id, id, evidenceAt);
    }
  }
  for (const [attemptId, evidence] of byAttempt) {
    const exists = options.db.prepare('SELECT 1 FROM execution_attempts WHERE id = ?').get(attemptId);
    if (exists) continue;
    const intent = evidence.find((record) => record.eventType === 'submit_intent');
    if (!intent) continue;
    result.orphanAttemptIds.push(attemptId);
    options.db.transaction(() => recoverOrphan(options, intent, receiptFor(evidence))).immediate();
  }
  return result;
}
