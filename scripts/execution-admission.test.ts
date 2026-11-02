import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CostQuote, EnqueueInput } from '../lib/media-core/execution/context.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-admission-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const {
  readActorPolicy,
  shanghaiAccountingPeriod,
  updateActorPolicy,
  upsertExecutionPool,
} = await import('../lib/media-core/execution/pools.ts');

const databases = new Set<Database.Database>();
const cleanups: Array<() => void> = [];
const identity = { instanceId: 'instance-admission', fence: 1 };
const journal = {
  verify: () => ({ valid: true, records: [] }),
  appendIntent: () => { throw new Error('not used by admission'); },
  appendReceipt: () => { throw new Error('not used by admission'); },
  scan: () => [],
};

async function setup(name: string) {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('foreign_keys = ON');
  const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true);
  registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-admission' });
  const runtime = createExecutionFacade({
    db,
    deploymentId: 'deployment-admission',
    journal,
    actorAllowed: () => true,
    scopeAllowed: () => true,
    maintenance: () => false,
  });
  await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-admission', signal: new AbortController().signal });
  cleanups.push(() => { runtime.closeNewWork(); });
  return { db, execution: runtime.facade };
}

function operation(actorId: string, key: string, options: {
  pools?: string[]; minor?: number; quote?: CostQuote; snapshot?: unknown;
} = {}): EnqueueInput {
  return {
    operationKey: `images/${key}/submit/r1`,
    actor: { userId: actorId },
    scope: { resourceType: 'project', resourceId: `${actorId}-project` },
    module: 'images', taskId: key, step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: `${key}-business`, number: 1 },
    inputSnapshot: options.snapshot ?? { key }, inputHash: `hash-${key}`,
    continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
    requiredPools: options.pools ?? ['shared'], quote: options.quote ?? {
      kind: 'priced', reserve: { currency: 'CNY', minor: options.minor ?? 100 }, pricingSnapshot: { version: 1 },
    },
  };
}

try {
  assert.equal(shanghaiAccountingPeriod(new Date('2026-02-28T15:59:59.000Z')), '2026-02');
  assert.equal(shanghaiAccountingPeriod(new Date('2026-02-28T16:00:00.000Z')), '2026-03');
  assert.deepEqual(readActorPolicy((await setup('defaults')).db, 'new-user'), {
    actorId: 'new-user', monthlyLimitMinor: 0, currency: 'CNY', personalConcurrency: 0,
    paused: false, timezone: 'Asia/Shanghai', version: 0,
  });

  {
    const { db, execution } = await setup('fairness');
    upsertExecutionPool(db, {
      poolKey: 'shared', kind: 'remote', capacity: 3, enabled: true,
      mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
    });
    assert.equal(execution.admit(identity).kind, 'idle', '缺操作时应返回 idle，而不是抛错');
    execution.enqueue(operation('user-a', 'a1'));
    assert.deepEqual(execution.admit(identity), {
      kind: 'deferred', reasons: ['personal_concurrency'],
    }, '新账号默认并发 0 必须安全拒绝');
    assert.equal(db.prepare('SELECT COUNT(*) FROM execution_reservations').pluck().get(), 0);

    for (const actorId of ['user-a', 'user-b']) {
      updateActorPolicy(db, {
        actorId, monthlyLimitMinor: 1_000, personalConcurrency: 2, paused: false, expectedVersion: 0,
      });
    }
    execution.enqueue(operation('user-a', 'a2'));
    execution.enqueue(operation('user-b', 'b1'));
    const grants: string[] = [];
    for (const key of ['a1', 'b1', 'a2']) {
      const result = execution.admit(identity);
      assert.equal(result.kind, 'admitted');
      if (result.kind === 'admitted') {
        assert.equal(result.grant.operation.taskId, key);
        grants.push(result.grant.operation.taskId);
        assert.equal(result.grant.attempt.submissionState, 'not_sent');
        assert.equal(result.grant.attempt.transportSeq, 1);
        assert.equal(result.grant.attempt.submitRound, 1);
        assert.equal(result.grant.attempt.fence, identity.fence);
        assert.equal(result.grant.attempt.businessAttemptNo, 1);
        assert.equal(result.grant.attempt.reservedMinor, 100);
      }
    }
    assert.deepEqual(grants, ['a1', 'b1', 'a2'], '用户间持久 RR、用户内 FIFO');
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'cost' AND state = 'held'").pluck().get(), 3);
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND poolKey = 'shared' AND state = 'held'").pluck().get(), 3);
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND poolKey LIKE 'actor:%' AND state = 'held'").pluck().get(), 3);

    upsertExecutionPool(db, {
      poolKey: 'shared', kind: 'remote', capacity: 1, enabled: true,
      mappingSnapshot: { providerId: 'provider-a', version: 2 }, expectedVersion: 1,
    });
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND state = 'held'").pluck().get(), 6,
      '降低容量不得杀掉既有占额');
    assert.throws(() => updateActorPolicy(db, {
      actorId: 'user-a', monthlyLimitMinor: 1, personalConcurrency: 1, paused: false, expectedVersion: 0,
    }), /version/);
  }

  {
    const { db, execution } = await setup('atomic-limits');
    for (const [poolKey, capacity] of [['shared', 10], ['second', 0]] as const) {
      upsertExecutionPool(db, {
        poolKey, kind: 'remote', capacity, enabled: true,
        mappingSnapshot: { providerId: poolKey }, expectedVersion: 0,
      });
    }
    updateActorPolicy(db, {
      actorId: 'user-atomic', monthlyLimitMinor: 100, personalConcurrency: 2, paused: false, expectedVersion: 0,
    });
    updateActorPolicy(db, {
      actorId: 'user-c', monthlyLimitMinor: 100, personalConcurrency: 2, paused: false, expectedVersion: 0,
    });
    execution.enqueue(operation('user-atomic', 'c1', { pools: ['shared', 'second'] }));
    assert.deepEqual(execution.admit(identity), { kind: 'deferred', reasons: ['pool_capacity'] });
    assert.equal(db.prepare('SELECT COUNT(*) FROM execution_reservations').pluck().get(), 0,
      '任一池不足时不得留下其他池的部分预留');

    execution.enqueue(operation('user-c', 'c2', { minor: 80 }));
    assert.equal(execution.admit(identity).kind, 'admitted');
    execution.enqueue(operation('user-c', 'c3', { minor: 80 }));
    const limited = execution.admit(identity);
    assert.equal(limited.kind, 'deferred');
    if (limited.kind === 'deferred') assert.ok(limited.reasons.includes('monthly_budget'));
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'cost'").pluck().get(), 1);

    updateActorPolicy(db, {
      actorId: 'user-free', monthlyLimitMinor: 0, personalConcurrency: 2, paused: false, expectedVersion: 0,
    });
    execution.enqueue(operation('user-free', 'free', { minor: 0 }));
    assert.equal(execution.admit(identity).kind, 'admitted', '可信免费价格不等于未知价格');
    execution.enqueue(operation('user-free', 'unknown-priced', { quote: { kind: 'unpriced' } }));
    const unpriced = execution.admit(identity);
    assert.equal(unpriced.kind, 'deferred');
    if (unpriced.kind === 'deferred') assert.ok(unpriced.reasons.includes('pricing_required'));

    updateActorPolicy(db, {
      actorId: 'user-unlimited', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
    });
    execution.enqueue(operation('user-unlimited', 'unlimited-unknown', { quote: { kind: 'unpriced' } }));
    const unlimited = execution.admit(identity);
    assert.equal(unlimited.kind, 'admitted', '不限额不豁免并发，但允许未知费用继续');
    if (unlimited.kind === 'admitted') {
      assert.equal(unlimited.grant.attempt.costState, 'unknown');
      assert.equal(unlimited.grant.attempt.actualMinor, null, '未知费用不得记成 0');
    }
    execution.enqueue(operation('user-unlimited', 'unlimited-second', { minor: 0 }));
    const unlimitedBlocked = execution.admit(identity);
    assert.equal(unlimitedBlocked.kind, 'deferred');
    if (unlimitedBlocked.kind === 'deferred') assert.ok(unlimitedBlocked.reasons.includes('personal_concurrency'));
  }

  {
    const { db, execution } = await setup('deferred');
    upsertExecutionPool(db, {
      poolKey: 'shared', kind: 'remote', capacity: 3, enabled: true,
      mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
    });
    for (const actorId of ['user-a', 'user-b']) {
      updateActorPolicy(db, {
        actorId, monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 0,
      });
    }
    execution.enqueue(operation('user-a', 'a1'));
    assert.equal(execution.admit(identity).kind, 'admitted');

    let orchestrationSlots = 1;
    const businessSubmitBudget = 0;
    const a2 = execution.enqueue({
      ...operation('user-a', 'a2', { snapshot: { previousResult: 'remote-a1', assetId: 'asset-a1' } }),
      persistCheckpoint: () => {
        orchestrationSlots -= 1;
      },
    });
    assert.equal(a2.kind, 'deferred');
    assert.equal(orchestrationSlots, 0, 'deferred continuation 必须立即释放假编排槽');
    assert.equal(businessSubmitBudget, 0, 'deferred 不消耗业务提交预算');
    execution.enqueue(operation('user-b', 'b1'));
    const next = execution.admit(identity);
    assert.equal(next.kind, 'admitted');
    if (next.kind === 'admitted') assert.equal(next.grant.operation.taskId, 'b1');
    const resumed = execution.admit(identity);
    assert.equal(resumed.kind, 'admitted');
    if (resumed.kind === 'admitted') {
      assert.equal(resumed.grant.operation.taskId, 'a2');
      assert.equal(resumed.grant.continuationKey, 'images.submit');
      assert.deepEqual(resumed.grant.inputSnapshot, { previousResult: 'remote-a1', assetId: 'asset-a1' });
      assert.equal(resumed.grant.attempt.submitRound, 1);
    }
  }

  console.log('execution admission tests passed');
} finally {
  for (const cleanup of cleanups) cleanup();
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
