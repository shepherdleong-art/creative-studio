import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput, ExecutionJournal } from '../lib/media-core/execution/context.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-attempts-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { monthlyCostUsage, updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');

const root = path.join(fixtureRoot, 'db');
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
assert.equal(readiness.available, true);
const identity = { instanceId: 'instance-attempts', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-attempts' });
upsertExecutionPool(db, {
  poolKey: 'shared', kind: 'remote', capacity: 4, enabled: true,
  mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
});
let now = new Date('2026-01-31T15:59:59.000Z');
let actorAllowed = true;
let maintenance = false;
const journalRecords: Array<Record<string, unknown>> = [];
const journal = {
  verify: () => ({ valid: true, records: journalRecords }),
  scan: () => journalRecords,
  appendIntent: (input: Record<string, unknown>) => {
    const record = {
      ...input, schemaVersion: 1, deploymentId: 'deployment-attempts', eventType: 'submit_intent',
      seq: journalRecords.length + 1, prevHash: null, hash: `hash-${journalRecords.length + 1}`,
      at: now.toISOString(),
    };
    journalRecords.push(record);
    return record;
  },
  appendReceipt: (input: Record<string, unknown>) => {
    if (input.attemptId) {
      const state = db.prepare('SELECT submissionState FROM execution_attempts WHERE id = ?').pluck().get(input.attemptId);
      assert.ok(state === 'maybe_sent' || (state === 'terminal' && input.reconciliationSource),
        'receipt journal 必须先于 DB 回执更新；晚到核查费用可在既有终态上追加');
    }
    const record = {
      ...input, schemaVersion: 1, deploymentId: 'deployment-attempts', eventType: 'receipt',
      seq: journalRecords.length + 1, prevHash: null, hash: `hash-${journalRecords.length + 1}`,
      at: now.toISOString(),
    };
    journalRecords.push(record);
    return record;
  },
} as unknown as ExecutionJournal;
const usageMirrors: Array<Record<string, unknown>> = [];
let failUsageMirror = false;
const runtime = createExecutionFacade({
  db,
  deploymentId: 'deployment-attempts',
  journal,
  now: () => now,
  actorAllowed: () => actorAllowed,
  scopeAllowed: () => true,
  maintenance: () => maintenance,
  mirrorUsage: (record) => {
    if (failUsageMirror) throw new Error('usage unavailable');
    usageMirrors.push(record);
  },
});
await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-attempts', signal: new AbortController().signal });
const execution = runtime.facade;

function operation(taskId: string, actorId = 'user-a', minor = 100): EnqueueInput {
  return {
    operationKey: `images/${taskId}/submit/r1`, actor: { userId: actorId },
    scope: { resourceType: 'project', resourceId: `${actorId}-project` },
    module: 'images', taskId, step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: `${taskId}-business`, number: 1 },
    inputSnapshot: { taskId }, inputHash: `hash-${taskId}`,
    continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
    requiredPools: ['shared'],
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor }, pricingSnapshot: { version: 1 } },
  };
}

async function grant(taskId: string, actorId = 'user-a', minor = 100) {
  execution.enqueue(operation(taskId, actorId, minor));
  const result = execution.admit({ ...identity, leaseMs: 0 });
  assert.equal(result.kind, 'admitted');
  if (result.kind !== 'admitted') throw new Error('grant expected');
  return result.grant;
}

try {
  updateActorPolicy(db, {
    actorId: 'user-a', monthlyLimitMinor: 100, personalConcurrency: 3, paused: false, expectedVersion: 0,
  });

  {
    const first = await grant('sync');
    assert.equal(first.attempt.accountingPeriod, '2026-01');
    const intent = await execution.markSubmitting({ grant: first, requestSnapshot: { prompt: 'secret request body' } });
    assert.equal(intent.transportSeq, 1);
    assert.equal(intent.intentJournalSeq, 1);
    assert.equal(db.prepare('SELECT submissionState FROM execution_attempts WHERE id = ?').pluck().get(first.attempt.id), 'maybe_sent');
    assert.equal(JSON.stringify(journalRecords).includes('secret request body'), false);

    let posts = 0;
    const accepted = await execution.transmit(intent, async () => {
      posts += 1;
      assert.equal(journalRecords.at(-1)?.eventType, 'submit_intent');
      return { remoteId: 'remote-sync' };
    });
    assert.equal(posts, 1);
    assert.equal(accepted.submissionState, 'accepted');
    assert.equal(accepted.remoteId, 'remote-sync');
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), 3,
      'accepted 后仍保留共享、个人和费用占额');
    const replayedReceipt = await execution.attachReceipt({ intent, receipt: { remoteId: 'remote-sync' } });
    assert.equal(replayedReceipt.remoteId, 'remote-sync', '相同回执重放必须幂等');

    now = new Date('2026-02-01T00:00:00.000Z');
    failUsageMirror = true;
    const settled = await execution.settle({
      attemptId: first.attempt.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 120 },
      remoteTerminal: true, result: { assetId: 'asset-1' },
    });
    assert.equal(settled.submissionState, 'terminal');
    assert.equal(settled.actualMinor, 120, '超预估必须照实入账');
    assert.equal(settled.accountingPeriod, '2026-01', '跨月结算保留原账期');
    assert.equal(monthlyCostUsage(db, 'user-a', '2026-01'), 120);
    assert.equal(monthlyCostUsage(db, 'user-a', '2026-02'), 0);
    assert.equal(usageMirrors.length, 0, 'usage 镜像失败不得回滚执行结算');
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND state = 'held'").pluck().get(), 0);

    const repeated = await execution.settle({
      attemptId: first.attempt.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 120 }, remoteTerminal: true,
    });
    assert.equal(repeated.actualMinor, 120);
    await assert.rejects(() => execution.settle({
      attemptId: first.attempt.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 121 }, remoteTerminal: true,
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'settle_conflict'));
  }

  updateActorPolicy(db, {
    actorId: 'user-a', monthlyLimitMinor: 500, personalConcurrency: 3, paused: false, expectedVersion: 1,
  });
  {
    const fallback = await grant('fallback', 'user-a', 80);
    const firstIntent = await execution.markSubmitting({ grant: fallback, requestSnapshot: { model: 'model-a', temperature: 0.7 } });
    let posts = 0;
    await execution.transmit(firstIntent, async () => {
      posts += 1;
      return { terminalState: 'failed', actualCost: { currency: 'CNY', minor: 20 }, errorCode: 'temperature_rejected' };
    });
    await execution.settle({
      attemptId: fallback.attempt.id, outcome: 'failed', actualCost: { currency: 'CNY', minor: 20 }, remoteTerminal: false,
    });
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND state = 'held'").pluck().get(), 2,
      '协议回退前必须复用原远端并发 permit');

    await assert.rejects(() => execution.markSubmitting({
      grant: { ...fallback, instance: { instanceId: 'stale-instance', fence: 99 } },
      requestSnapshot: { model: 'model-a', temperature: 1 }, retryKind: 'protocol_fallback',
      quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 80 }, pricingSnapshot: { version: 1 } },
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'stale_fence'));

    const secondIntent = await execution.markSubmitting({
      grant: fallback, requestSnapshot: { model: 'model-a', temperature: 1 }, retryKind: 'protocol_fallback',
      quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 80 }, pricingSnapshot: { version: 1 } },
    });
    assert.equal(secondIntent.submitRound, firstIntent.submitRound);
    assert.equal(secondIntent.transportSeq, 2);
    assert.equal(secondIntent.permitId, firstIntent.permitId);
    const secondAccepted = await execution.transmit(secondIntent, async () => {
      posts += 1;
      return { remoteId: 'remote-fallback' };
    });
    assert.equal(posts, 2);
    assert.equal(secondAccepted.transportSeq, 2);
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'cost'").pluck().get(), 3,
      '每次实际 HTTP 传输独立计价');
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND permitId = ?").pluck().get(fallback.permitId), 2);
    await execution.settle({
      attemptId: fallback.attempt.id, outcome: 'failed', actualCost: { currency: 'CNY', minor: 20 }, remoteTerminal: true,
    });
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND permitId = ? AND state = 'held'")
      .pluck().get(fallback.permitId), 2, '旧 transport 的迟到终态不得释放新 fallback 正在复用的 permit');
    assert.equal(db.prepare('SELECT currentAttemptId FROM execution_operations WHERE id = ?').pluck().get(fallback.operation.id),
      secondAccepted.id, '旧 transport 不得覆盖新 fallback 的操作状态');
    await execution.settle({
      attemptId: secondAccepted.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 80 }, remoteTerminal: true,
    });
  }

  {
    const lateRelease = await grant('late-release', 'user-a', 0);
    const intent = await execution.markSubmitting({ grant: lateRelease, requestSnapshot: {} });
    await execution.transmit(intent, async () => ({
      remoteId: 'remote-late-release', terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 0 },
    }));
    await execution.settle({
      attemptId: lateRelease.attempt.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: false,
    });
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'")
      .pluck().get(lateRelease.permitId), 2);
    await execution.settle({
      attemptId: lateRelease.attempt.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true,
    });
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'")
      .pluck().get(lateRelease.permitId), 0, '费用已结算后，远端终态仍可幂等释放原 permit');
    let stalePosts = 0;
    await assert.rejects(() => execution.transmit({ ...intent, fence: intent.fence + 1 }, async () => {
      stalePosts += 1;
      return { remoteId: 'must-not-send' };
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'stale_fence'));
    assert.equal(stalePosts, 0);
  }

  {
    const retry = await grant('explicit-retry', 'user-a', 0);
    const intent = await execution.markSubmitting({ grant: retry, requestSnapshot: {} });
    await execution.transmit(intent, async () => ({ terminalState: 'not_created', actualCost: null, errorCode: 'before_accept' }));
    await execution.settle({ attemptId: retry.attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true });
    assert.equal(db.prepare('SELECT status FROM execution_operations WHERE id = ?').pluck().get(retry.operation.id), 'pending');
    const admitted = execution.admit(identity);
    assert.equal(admitted.kind, 'admitted');
    if (admitted.kind === 'admitted') assert.equal(admitted.grant.attempt.submitRound, 2);
  }

  {
    const unknown = await grant('unknown-cost', 'user-a', 10);
    const intent = await execution.markSubmitting({ grant: unknown, requestSnapshot: {} });
    await execution.transmit(intent, async () => ({ remoteId: 'remote-unknown-cost' }));
    const settled = await execution.settle({ attemptId: unknown.attempt.id, outcome: 'succeeded', actualCost: null, remoteTerminal: true });
    assert.equal(settled.actualMinor, null);
    assert.equal(settled.costState, 'unknown');
    assert.equal(db.prepare("SELECT state FROM execution_reservations WHERE kind = 'cost' AND attemptId = ?").pluck().get(unknown.attempt.id), 'held',
      '受限用户未知实际费用保留待核查预留');
    execution.enqueue(operation('after-unknown', 'user-a', 0));
    const blocked = execution.admit(identity);
    assert.equal(blocked.kind, 'deferred');
    if (blocked.kind === 'deferred') assert.ok(blocked.reasons.includes('cost_unknown'));
    const latePriced = await execution.reconcile({
      attemptId: unknown.attempt.id,
      evidence: { kind: 'terminal', outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 40 } },
      source: 'provider',
    });
    assert.equal(latePriced.actualMinor, 40, '未知费用必须允许晚到实际账单结算');
    assert.equal(latePriced.costState, 'settled');
    assert.equal(monthlyCostUsage(db, 'user-a', '2026-02'), 140, '晚到费用仍计入原账期且只结算一次');
  }

  {
    updateActorPolicy(db, {
      actorId: 'user-b', monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 0,
    });
    const unknown = await grant('unknown-before-limit', 'user-b', 10);
    const intent = await execution.markSubmitting({ grant: unknown, requestSnapshot: {} });
    await execution.transmit(intent, async () => ({ remoteId: 'remote-unknown-before-limit' }));
    await execution.settle({ attemptId: unknown.attempt.id, outcome: 'succeeded', actualCost: null, remoteTerminal: true });
    assert.equal(db.prepare("SELECT state FROM execution_reservations WHERE kind = 'cost' AND attemptId = ?")
      .pluck().get(unknown.attempt.id), 'settled');
    updateActorPolicy(db, {
      actorId: 'user-b', monthlyLimitMinor: 100, personalConcurrency: 2, paused: false, expectedVersion: 1,
    });
    assert.equal(monthlyCostUsage(db, 'user-b', '2026-02'), 10,
      '不限额转受限后，历史未知费用仍按原预留占额而不是归零');
    execution.enqueue(operation('after-limit-with-unknown', 'user-b', 0));
    assert.equal(execution.admit(identity).kind, 'admitted', '先让 RR 中另一用户的已就绪操作继续');
    const blocked = execution.admit(identity);
    assert.equal(blocked.kind, 'deferred');
    if (blocked.kind === 'deferred') assert.ok(blocked.reasons.includes('cost_unknown'));
  }

  actorAllowed = false;
  maintenance = true;
  const existing = db.prepare("SELECT id FROM execution_attempts WHERE submissionState = 'accepted' LIMIT 1").pluck().get() as string | undefined;
  if (existing) {
    await assert.doesNotReject(() => execution.settle({ attemptId: existing, outcome: 'failed', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true }),
      '停用和维护不得阻断已受理结果结算');
  }
  assert.throws(() => execution.enqueue(operation('blocked-new')), /维护|停用/);

  console.log('execution attempts tests passed');
} finally {
  runtime.closeNewWork();
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
