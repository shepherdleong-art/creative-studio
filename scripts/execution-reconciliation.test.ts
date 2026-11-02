import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-reconciliation-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { recoverExecution } = await import('../lib/media-core/execution/reconciliation.ts');

const databases = new Set<Database.Database>();
const identity = { instanceId: 'instance-recovery', fence: 1 };

async function setup(name: string, mutate?: (options: Record<string, unknown>) => void) {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('foreign_keys = ON');
  const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true);
  registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-recovery' });
  upsertExecutionPool(db, {
    poolKey: 'shared', kind: 'remote', capacity: 2, enabled: true,
    mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
  });
  updateActorPolicy(db, {
    actorId: 'user-a', monthlyLimitMinor: 500, personalConcurrency: 2, paused: false, expectedVersion: 0,
  });
  const journal = createExecutionJournal({
    deploymentId: 'deployment-recovery',
    directory: path.join(root, 'storage', 'execution-journal', 'deployment-recovery'),
  });
  const options: Record<string, unknown> = {
    db, deploymentId: 'deployment-recovery', journal,
    actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  };
  mutate?.(options);
  const runtime = createExecutionFacade(options as never);
  await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-recovery', signal: new AbortController().signal });
  async function grant(taskId = 'task-1') {
    runtime.facade.enqueue({
      operationKey: `images/${taskId}/submit/r1`, actor: { userId: 'user-a' },
      scope: { resourceType: 'project', resourceId: 'project-a' },
      module: 'images', taskId, step: 'submit', inputRevision: 'r1',
      businessAttempt: { id: `${taskId}-business`, number: 1 },
      inputSnapshot: { taskId }, inputHash: `hash-${taskId}`,
      continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
      requiredPools: ['shared'],
      quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 100 }, pricingSnapshot: { version: 1 } },
    });
    const result = runtime.facade.admit({ ...identity, leaseMs: 0 });
    assert.equal(result.kind, 'admitted');
    if (result.kind !== 'admitted') throw new Error('grant expected');
    return result.grant;
  }
  return { db, journal, options, runtime, execution: runtime.facade, grant };
}

try {
  {
    let failReceiptDatabase = true;
    const fixture = await setup('receipt-before-db', (options) => {
      options.faults = { beforeReceiptDatabase: () => { if (failReceiptDatabase) throw new Error('injected DB failure'); } };
    });
    const grant = await fixture.grant();
    const intent = await fixture.execution.markSubmitting({ grant, requestSnapshot: { task: 1 } });
    let posts = 0;
    await assert.rejects(() => fixture.execution.transmit(intent, async () => {
      posts += 1;
      return { remoteId: 'remote-crash', terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 130 } };
    }), /injected DB failure/);
    assert.equal(posts, 1);
    assert.equal(fixture.db.prepare('SELECT submissionState FROM execution_attempts WHERE id = ?').pluck().get(grant.attempt.id), 'maybe_sent');
    assert.equal(fixture.db.prepare('SELECT remoteId FROM execution_attempts WHERE id = ?').pluck().get(grant.attempt.id), null);

    failReceiptDatabase = false;
    const recovered = await recoverExecution(fixture.options as never);
    assert.equal(recovered.available, true);
    assert.ok(recovered.recoveredReceiptAttemptIds.includes(grant.attempt.id));
    const attempt = fixture.db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(grant.attempt.id) as Record<string, unknown>;
    assert.equal(attempt.submissionState, 'terminal');
    assert.equal(attempt.remoteId, 'remote-crash');
    assert.equal(attempt.actualMinor, 130);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 0);
    assert.equal(posts, 1, '恢复只补回执，不得重新 POST');
    fixture.runtime.closeNewWork();
  }

  {
    const fixture = await setup('unknown-send');
    const grant = await fixture.grant();
    const intent = await fixture.execution.markSubmitting({ grant, requestSnapshot: {} });
    let posts = 0;
    await assert.rejects(() => fixture.execution.transmit(intent, async () => {
      posts += 1;
      throw new Error('socket disappeared');
    }), /socket disappeared/);
    const recovered = await recoverExecution(fixture.options as never);
    assert.ok(recovered.unknownAttemptIds.includes(grant.attempt.id));
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 3);
    const unknown = await fixture.execution.reconcile({
      attemptId: grant.attempt.id, evidence: { kind: 'still_unknown' }, source: 'provider',
    });
    assert.equal(unknown.submissionState, 'maybe_sent');
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 3);
    await fixture.execution.reconcile({
      attemptId: grant.attempt.id, evidence: { kind: 'confirmed_not_created', errorCode: 'provider_not_found' }, source: 'provider',
    });
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 0);
    assert.equal(posts, 1, 'unknown 核查不能自动重提');
    fixture.runtime.closeNewWork();
  }

  {
    const fixture = await setup('orphan-after-rollback');
    const grant = await fixture.grant();
    const intent = await fixture.execution.markSubmitting({ grant, requestSnapshot: {} });
    let posts = 0;
    await fixture.execution.transmit(intent, async () => {
      posts += 1;
      return { remoteId: 'remote-orphan' };
    });
    fixture.db.prepare('DELETE FROM execution_reservations').run();
    fixture.db.prepare('DELETE FROM execution_attempts').run();
    fixture.db.prepare('DELETE FROM execution_operations').run();
    const recovered = await recoverExecution(fixture.options as never);
    assert.equal(recovered.available, true);
    assert.deepEqual(recovered.orphanAttemptIds, [grant.attempt.id]);
    assert.equal(fixture.db.prepare('SELECT state FROM execution_reconciliation_orphans WHERE attemptId = ?').pluck().get(grant.attempt.id), 'accepted');
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND state = 'held'").pluck().get(), 2,
      'DB 回退后按 journal 保守恢复共享和个人占额');
    assert.equal(fixture.db.prepare("SELECT reservedMinor FROM execution_reservations WHERE kind = 'cost' AND attemptId = ?").pluck().get(grant.attempt.id), 100);
    const orphanIntent = fixture.journal.scan().find((record) => record.attemptId === grant.attempt.id && record.eventType === 'submit_intent');
    assert.ok(orphanIntent);
    fixture.journal.appendReceipt({
      ...orphanIntent, terminalState: 'failed', actualCost: { currency: 'CNY', minor: 70 }, reconciliationSource: 'provider',
    });
    await recoverExecution(fixture.options as never);
    assert.equal(fixture.db.prepare("SELECT state FROM execution_reconciliation_orphans WHERE attemptId = ?").pluck().get(grant.attempt.id), 'terminal');
    assert.equal(fixture.db.prepare("SELECT actualMinor FROM execution_reservations WHERE kind = 'cost' AND attemptId = ?").pluck().get(grant.attempt.id), 70);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 0,
      '孤儿后续终态必须释放此前保守恢复的占额');
    assert.equal(posts, 1);
    fixture.runtime.closeNewWork();
  }

  {
    const fixture = await setup('intent-failure', (options) => {
      const journal = options.journal as { appendIntent: unknown };
      journal.appendIntent = () => { throw new Error('injected intent fsync failure'); };
    });
    const grant = await fixture.grant();
    await assert.rejects(() => fixture.execution.markSubmitting({ grant, requestSnapshot: {} }), /fsync failure/);
    assert.equal(fixture.db.prepare('SELECT submissionState FROM execution_attempts WHERE id = ?').pluck().get(grant.attempt.id), 'maybe_sent');
    assert.equal(fixture.journal.scan().length, 0);
    const recovered = await recoverExecution(fixture.options as never);
    assert.ok(recovered.unknownAttemptIds.includes(grant.attempt.id));
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 3,
      'DB maybe_sent 后 intent 前崩溃按未知保留');
    fixture.runtime.closeNewWork();
  }

  {
    const fixture = await setup('reconcile-terminal');
    const grant = await fixture.grant();
    const intent = await fixture.execution.markSubmitting({ grant, requestSnapshot: {} });
    await fixture.execution.transmit(intent, async () => ({ remoteId: 'remote-poll' }));
    const terminal = await fixture.execution.reconcile({
      attemptId: grant.attempt.id,
      evidence: { kind: 'terminal', outcome: 'failed', actualCost: { currency: 'CNY', minor: 90 }, errorCode: 'provider_failed' },
      source: 'provider',
    });
    assert.equal(terminal.submissionState, 'terminal');
    assert.equal(terminal.actualMinor, 90);
    assert.equal(fixture.db.prepare("SELECT state FROM execution_reservations WHERE kind = 'cost' AND attemptId = ?").pluck().get(grant.attempt.id), 'settled');
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND state = 'held'").pluck().get(), 0);
    fixture.runtime.closeNewWork();
  }

  console.log('execution reconciliation tests passed');
} finally {
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
