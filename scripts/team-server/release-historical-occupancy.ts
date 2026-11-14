import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ExecutionJournal } from '../../lib/media-core/execution/context.ts';

// Explicit operator action only. This file is not imported by the server.
// Releasing scheduling occupancy is not a statement about the remote outcome or cost.
type Row = Record<string, unknown>;
export interface HistoricalOccupancyPlan {
  version: 1;
  auditId: string;
  operatorId: string;
  reason: string;
  createdAt: string;
  targets: ReturnType<typeof verifiedTargets>;
  sha256: string;
}
export interface HistoricalOccupancyOptions {
  db: Database.Database;
  journal: ExecutionJournal;
  now?: () => Date;
}
export function occupancyFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function assertAdmin(db: Database.Database, operatorId: string): void {
  const actor = db.prepare('SELECT role,status FROM team_users WHERE id=?').get(operatorId) as Row | undefined;
  assert.ok(actor?.role === 'admin' && actor.status === 'active', 'Active administrator required');
}
function readTarget(db: Database.Database, operationId: string) {
  const operation = db.prepare('SELECT * FROM execution_operations WHERE id=?').get(operationId) as Row | undefined;
  assert.ok(operation, 'Operation not found');
  const attempt = db.prepare('SELECT * FROM execution_attempts WHERE id=?').get(operation.currentAttemptId) as Row | undefined;
  assert.ok(attempt, 'Current attempt not found');
  const operationFacts = Object.fromEntries(['id','actorId','module','taskId','status','currentAttemptId','currentPermitId','requiredPoolsJson','mediaTaskId'].map(key => [key, operation[key] ?? null]));
  const attemptFacts = Object.fromEntries(['id','operationId','actorId','permitId','submissionState','terminalState','remoteId','leaseUntil','updatedAt'].map(key => [key, attempt[key] ?? null]));
  const concurrency = db.prepare("SELECT * FROM execution_reservations WHERE permitId=? AND kind='concurrency' ORDER BY id").all(operation.currentPermitId) as Row[];
  return {
    operationId, attemptId: String(attempt.id), permitId: String(attempt.permitId), actorId: String(operation.actorId),
    module: String(operation.module), taskId: String(operation.taskId),
    operation: operationFacts, attempt: attemptFacts, concurrency,
    operationSha256: occupancyFingerprint(operation),
    attemptsSha256: occupancyFingerprint(db.prepare('SELECT * FROM execution_attempts WHERE operationId=? ORDER BY id').all(operationId)),
    costsSha256: occupancyFingerprint(db.prepare("SELECT * FROM execution_reservations WHERE operationId=? AND kind='cost' ORDER BY id").all(operationId)),
  };
}
function verifiedTargets(options: HistoricalOccupancyOptions, operationIds: string[]) {
  assert.ok(operationIds.length > 0 && operationIds.length <= 100 && new Set(operationIds).size === operationIds.length,
    'An explicit unique list of at most 100 operations is required');
  const verification = options.journal.verify({ repairTail: false });
  assert.ok(verification.valid, 'Execution journal must verify without repair');
  const now = (options.now?.() ?? new Date()).getTime();
  return [...operationIds].sort().map(id => {
    const target = readTarget(options.db, id);
    const { operation, attempt, concurrency } = target;
    assert.equal(operation.status, 'unknown', 'Only historical unknown operations may be detached');
    assert.equal(attempt.submissionState, 'maybe_sent');
    assert.equal(attempt.terminalState, null);
    assert.equal(attempt.remoteId, null, 'Known remote tasks require their normal reconciliation path');
    assert.equal(operation.mediaTaskId ?? null, null, 'Unified media is outside this operator action');
    assert.equal(attempt.operationId, id);
    assert.equal(attempt.actorId, operation.actorId);
    assert.equal(attempt.permitId, operation.currentPermitId);
    assert.ok(Date.parse(String(attempt.leaseUntil)) < now, 'An active lease cannot be detached');
    assert.ok(Date.parse(String(attempt.updatedAt)) <= now - 15 * 60_000, 'Recent attempts cannot be detached');
    const evidence = verification.records.filter(r => r.attemptId === attempt.id);
    const intent = evidence.find(r => r.eventType === 'submit_intent');
    const receipt = evidence.at(-1);
    assert.ok(intent && receipt?.eventType === 'receipt' && receipt.terminalState === 'unknown', 'Unknown receipt evidence required');
    assert.equal(receipt.operationId, id); assert.equal(receipt.permitId, attempt.permitId);
    assert.equal(receipt.actorId, operation.actorId);
    const expectedPools = [...JSON.parse(String(operation.requiredPoolsJson)) as string[], `actor:${operation.actorId}:remote`].sort();
    assert.deepEqual(concurrency.map(r => String(r.poolKey)).sort(), expectedPools, 'Concurrency evidence is incomplete');
    for (const row of concurrency) {
      assert.equal(row.operationId, id); assert.equal(row.actorId, operation.actorId);
      assert.ok(row.attemptId === null || row.attemptId === attempt.id);
    }
    return { ...target, receiptSeq: receipt.seq, receiptHash: receipt.hash };
  });
}
export function planHistoricalOccupancyRelease(options: HistoricalOccupancyOptions, input: {
  operatorId: string; auditId: string; reason: string; operationIds: string[];
}): HistoricalOccupancyPlan {
  assertAdmin(options.db, input.operatorId);
  assert.match(input.auditId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,100}$/);
  assert.ok(input.reason.trim().length >= 10, 'An explicit operator reason is required');
  return options.db.transaction(() => {
    const targets = verifiedTargets(options, input.operationIds);
    for (const target of targets) assert.ok(target.concurrency.every(r => r.state === 'held'), 'Create the plan before releasing occupancy');
    const body = { version: 1 as const, auditId: input.auditId, operatorId: input.operatorId,
      reason: input.reason, createdAt: (options.now?.() ?? new Date()).toISOString(), targets };
    return { ...body, sha256: occupancyFingerprint(body) };
  })();
}
export function releaseHistoricalOccupancy(options: HistoricalOccupancyOptions, plan: HistoricalOccupancyPlan,
  persistAuditIntent: (plan: HistoricalOccupancyPlan) => void) {
  const { sha256, ...body } = plan;
  assert.equal(occupancyFingerprint(body), sha256, 'Plan integrity check failed');
  assertAdmin(options.db, plan.operatorId);
  assert.equal(typeof persistAuditIntent, 'function', 'Durable audit sink required');
  const reason = `operator_detached_unknown:${plan.auditId}`;
  return options.db.transaction(() => {
    assertAdmin(options.db, plan.operatorId);
    const current = verifiedTargets(options, plan.targets.map(t => t.operationId));
    let alreadyReleased = true;
    for (let index = 0; index < current.length; index += 1) {
      const actual = current[index]; const expected = plan.targets[index];
      const { concurrency: actualRows, ...actualFacts } = actual;
      const { concurrency: expectedRows, ...expectedFacts } = expected;
      assert.deepEqual(actualFacts, expectedFacts, 'Historical evidence changed; re-inspect before release');
      for (let rowIndex = 0; rowIndex < actualRows.length; rowIndex += 1) {
        const row = actualRows[rowIndex]; const before = expectedRows[rowIndex];
        if (row.state === 'released') {
          assert.equal(row.releaseReason, reason, 'Occupancy was changed by another action');
          assert.ok(row.releasedAt);
          assert.deepEqual(row, { ...before, state: 'released', releasedAt: row.releasedAt, releaseReason: reason });
        } else {
          alreadyReleased = false;
          assert.deepEqual(row, before, 'Occupancy changed since planning');
        }
      }
    }
    if (alreadyReleased) return { auditId: plan.auditId, alreadyReleased: true, releasedReservations: 0, operationCount: current.length };
    assert.ok(current.every(t => t.concurrency.every(r => r.state === 'held')), 'Partial external change must be investigated');
    // The operator writes and fsyncs this audit before the transaction changes any row.
    persistAuditIntent(plan);
    const at = (options.now?.() ?? new Date()).toISOString();
    let changed = 0;
    const update = options.db.prepare("UPDATE execution_reservations SET state='released',releasedAt=?,releaseReason=? WHERE id=? AND kind='concurrency' AND state='held'");
    for (const target of current) for (const row of target.concurrency) {
      const result = update.run(at, reason, row.id); assert.equal(result.changes, 1); changed += result.changes;
    }
    // Keep operation/attempt rows, all old attempts and cost reservations byte-for-byte intact.
    for (const target of current) {
      const after = readTarget(options.db, target.operationId);
      assert.deepEqual(after.operation, target.operation); assert.deepEqual(after.attempt, target.attempt);
      assert.equal(after.operationSha256, target.operationSha256);
      assert.equal(after.attemptsSha256, target.attemptsSha256); assert.equal(after.costsSha256, target.costsSha256);
    }
    return { auditId: plan.auditId, alreadyReleased: false, releasedReservations: changed, operationCount: current.length, releasedAt: at };
  }).immediate();
}