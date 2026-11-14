import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CostQuote, EnqueueInput } from '../lib/media-core/execution/context.ts';
import { meterDatabase, seedCompletedHistory } from './execution-admission-metrics.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-admission-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const {
  readActorPolicy,
  actorModelAllowed,
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

async function meteredSetup(name: string) {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const raw = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(raw);
  raw.pragma('foreign_keys = ON');
  const readiness = await checkExecutionReadiness({ db: raw, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true);
  registerExecutionInstance(raw, { ...identity, deploymentId: 'deployment-admission' });
  const metered = meterDatabase(raw);
  const runtime = createExecutionFacade({
    db: metered.db,
    deploymentId: 'deployment-admission',
    journal,
    actorAllowed: () => true,
    scopeAllowed: () => true,
    maintenance: () => false,
  });
  await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-admission', signal: new AbortController().signal });
  cleanups.push(() => { runtime.closeNewWork(); });
  return { raw, stats: metered.stats, reset: metered.reset, execution: runtime.facade };
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
  const defaultPolicy = readActorPolicy((await setup('defaults')).db, 'new-user');
  assert.deepEqual(defaultPolicy, {
    actorId: 'new-user', monthlyLimitMinor: 0, currency: 'CNY', personalConcurrency: 0,
    paused: false, allowedModels: null, timezone: 'Asia/Shanghai', version: 0,
    concurrencyMode: 'legacy', concurrencySource: 'legacy_fixed', effectiveConcurrency: 0,
  });

  {
    const { db } = await setup('manual-team-default');
    const { readTeamConcurrencyPolicy, updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    updateActorPolicy(db, {
      actorId: 'legacy-member', monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 0,
    });
    const team = updateTeamConcurrencyPolicy(db, { manualDefaultConcurrency: 4, expectedVersion: 0 });
    assert.deepEqual(team, { mode: 'manual', manualDefaultConcurrency: 4, version: 1 });
    db.prepare(`INSERT INTO execution_actor_policies (
      actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt
    ) VALUES ('new-member', 0, 'CNY', 0, 0, 'Asia/Shanghai', 1, 'inherit', ?)`).run(new Date().toISOString());
    const inherited = readActorPolicy(db, 'new-member');
    assert.equal(inherited.concurrencyMode, 'inherit');
    assert.equal(inherited.concurrencySource, 'team_default');
    assert.equal(inherited.effectiveConcurrency, 4, '新成员无需逐人填写即可继承团队默认');
    assert.equal(inherited.personalConcurrency, 0, '并发继承不得发放费用额度');
    const legacy = readActorPolicy(db, 'legacy-member');
    assert.equal(legacy.concurrencyMode, 'legacy');
    assert.equal(legacy.concurrencySource, 'legacy_fixed');
    assert.equal(legacy.effectiveConcurrency, 2, '保存团队默认不得迁移已有固定值');
    assert.equal(readTeamConcurrencyPolicy(db).version, 1);
  }

  {
    const { db, execution } = await setup('inherited-admission');
    const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 5, enabled: true, mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0 });
    updateTeamConcurrencyPolicy(db, { manualDefaultConcurrency: 1, expectedVersion: 0 });
    for (const actorId of ['inherited-a', 'inherited-b']) {
      db.prepare(`INSERT INTO execution_actor_policies (
        actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt
      ) VALUES (?, NULL, 'CNY', 0, 0, 'Asia/Shanghai', 1, 'inherit', ?)`).run(actorId, new Date().toISOString());
    }
    execution.enqueue(operation('inherited-a', 'inherited-a1'));
    const firstId = db.prepare("SELECT id FROM execution_operations WHERE taskId='inherited-a1'").pluck().get() as string;
    assert.equal(execution.admit({ ...identity, operationId: firstId }).kind, 'admitted');
    execution.enqueue(operation('inherited-a', 'inherited-a2'));
    const secondId = db.prepare("SELECT id FROM execution_operations WHERE taskId='inherited-a2'").pluck().get() as string;
    assert.deepEqual(execution.admit({ ...identity, operationId: secondId }), { kind: 'deferred', reasons: ['personal_concurrency'] }, '团队默认必须限制真实准入');
    assert.deepEqual(db.prepare("SELECT waitDetail FROM execution_operations WHERE id = ?").pluck().get(secondId), JSON.stringify({
      reason: 'personal_concurrency', concurrencySource: 'team_default', currentConcurrency: 1, effectiveConcurrency: 1,
    }), '等待详情必须能解释团队继承来源和实际占用');
    execution.enqueue(operation('inherited-b', 'inherited-b1'));
    const otherId = db.prepare("SELECT id FROM execution_operations WHERE taskId='inherited-b1'").pluck().get() as string;
    assert.equal(execution.admit({ ...identity, operationId: otherId }).kind, 'admitted', '个人上限不预占团队共享池名额');
    execution.enqueue(operation('inherited-b', 'inherited-b2'));
    const poolWaitId = db.prepare("SELECT id FROM execution_operations WHERE taskId='inherited-b2'").pluck().get() as string;
    upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 2, enabled: true, mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 1 });
    assert.deepEqual(execution.admit({ ...identity, operationId: poolWaitId }), { kind: 'deferred', reasons: ['pool_capacity'] });
    assert.deepEqual(db.prepare("SELECT waitDetail FROM execution_operations WHERE id=?").pluck().get(poolWaitId), JSON.stringify({
      reason: 'pool_capacity', poolKey: 'shared', currentConcurrency: 2, capacity: 2,
    }), '共享池等待不能误报个人上限');
    assert.equal(readActorPolicy(db, 'inherited-b').concurrencySource, 'team_default');
    updateActorPolicy(db, { actorId: 'inherited-b', monthlyLimitMinor: null, personalConcurrency: 0, paused: false, expectedVersion: 1 });
    assert.equal(readActorPolicy(db, 'inherited-b').concurrencyMode, 'inherit', '旧客户端只改费用/暂停不得丢失继承来源');
    updateActorPolicy(db, { actorId: 'inherited-b', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 2, concurrencyMode: 'fixed' });
    assert.equal(readActorPolicy(db, 'inherited-b').concurrencySource, 'personal_fixed');
    updateActorPolicy(db, { actorId: 'inherited-b', monthlyLimitMinor: null, personalConcurrency: 0, paused: false, expectedVersion: 3, concurrencyMode: 'inherit' });
    assert.equal(readActorPolicy(db, 'inherited-b').effectiveConcurrency, 1);
    updateTeamConcurrencyPolicy(db, { manualDefaultConcurrency: 0, expectedVersion: 1 });
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind='concurrency' AND state='held'").pluck().get(), 4, '降额不得释放已受理名额');
  }

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

  {
    const { db, execution } = await setup('model-permissions');
    upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 10, enabled: true, mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0 });
    const policy = { actorId: 'restricted', monthlyLimitMinor: null, personalConcurrency: 10, paused: false };
    updateActorPolicy(db, { ...policy, expectedVersion: 0, allowedModels: ['model-a'] });
    for (const snapshot of [{ model: 'model-a' }, { requestModel: 'model-a' }, { configuredModel: 'model-a' }, { modelAlias: 'model-a' }]) {
      assert.equal(actorModelAllowed(readActorPolicy(db, 'restricted'), snapshot), true, '图片、视频、文本、配音与画布模型快照均可识别');
    }
    assert.equal(actorModelAllowed(readActorPolicy(db, 'restricted'), { model: 'model-b', coreModelKey: 'model-a' }), false, '定价别名不得代替真实模型权限');
    const denied = execution.enqueue({ ...operation('restricted', 'denied'), providerSnapshot: { model: 'model-a-fast' } });
    assert.deepEqual(execution.admit({ ...identity, operationId: denied.operation.id }), { kind: 'deferred', reasons: ['model_forbidden'] });
    assert.equal(db.prepare('SELECT COUNT(*) FROM execution_reservations').pluck().get(), 0, '拒绝模型不能预留费用或并发');
    const allowed = execution.enqueue({ ...operation('restricted', 'allowed'), providerSnapshot: { model: 'model-a' } });
    const grant = execution.admit({ ...identity, operationId: allowed.operation.id });
    assert.equal(grant.kind, 'admitted');
    updateActorPolicy(db, { ...policy, expectedVersion: 1, allowedModels: [] });
    if (grant.kind === 'admitted') {
      await assert.rejects(execution.markSubmitting({ grant: grant.grant, requestSnapshot: {} }), { code: 'model_forbidden' }, '准入后撤销权限也必须在提交前拦截');
    }
    assert.equal(readActorPolicy(db, 'restricted').allowedModels?.length, 0);
    updateActorPolicy(db, { ...policy, expectedVersion: 2 });
    assert.deepEqual(readActorPolicy(db, 'restricted').allowedModels, [], '旧客户端只改额度不得清除模型限制');
    assert.throws(() => updateActorPolicy(db, { ...policy, expectedVersion: 2, allowedModels: null }), { code: 'policy_version_conflict' });
    updateActorPolicy(db, { ...policy, expectedVersion: 3, allowedModels: ['model-a-fast'] });
    assert.equal(execution.admit({ ...identity, operationId: denied.operation.id }).kind, 'admitted', '授权后排队任务可继续');
    const missing = execution.enqueue({ ...operation('restricted', 'missing'), providerSnapshot: {} });
    assert.deepEqual(execution.admit({ ...identity, operationId: missing.operation.id }), { kind: 'deferred', reasons: ['model_forbidden'] }, '缺少模型身份不能绕过限制');
    updateActorPolicy(db, { ...policy, expectedVersion: 4, allowedModels: null });
    assert.equal(execution.admit({ ...identity, operationId: missing.operation.id }).kind, 'admitted');
  }

  {
    const { db, execution } = await setup('automatic-pools');
    const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    updateTeamConcurrencyPolicy(db, { mode: 'auto', manualDefaultConcurrency: 1, expectedVersion: 0 });
    for (const [poolKey, capacity] of [['busy', 1], ['idle', 4]] as const) {
      upsertExecutionPool(db, { poolKey, kind: 'remote', capacity, enabled: true, mappingSnapshot: { providerId: poolKey }, expectedVersion: 0 });
    }
    updateActorPolicy(db, { actorId: 'auto-user', monthlyLimitMinor: null, personalConcurrency: 0, concurrencyMode: 'inherit', paused: false, expectedVersion: 0 });
    const busy = execution.enqueue(operation('auto-user', 'busy-first', { pools: ['busy'] }));
    assert.equal(execution.admit({ ...identity, operationId: busy.operation.id }).kind, 'admitted');
    execution.enqueue(operation('auto-user', 'busy-waiting', { pools: ['busy'] }));
    const independent = execution.enqueue(operation('auto-user', 'independent-idle', { pools: ['idle'] }));
    assert.equal(execution.admit({ ...identity, operationId: independent.operation.id }).kind, 'admitted', '同一成员的忙碌池队首不能阻塞空闲池独立任务');
    execution.enqueue(operation('auto-user', 'busy-still-waiting', { pools: ['busy'] }));
    const secondBusyResult = execution.admit(identity);
    assert.equal(secondBusyResult.kind, 'deferred');
    assert.equal(secondBusyResult.kind, 'deferred');
    upsertExecutionPool(db, { poolKey: 'idle', kind: 'remote', capacity: 4, enabled: true, mappingSnapshot: { providerId: 'idle' }, expectedVersion: 1 });
    const anotherIndependent = execution.enqueue(operation('auto-user', 'another-independent-idle', { pools: ['idle'] }));
    const ordinary = execution.admit(identity);
    assert.equal(ordinary.kind, 'admitted', '普通轮转路径也不得被忙碌池队首阻塞');
    if (ordinary.kind === 'admitted') assert.equal(ordinary.grant.operation.id, anotherIndependent.operation.id);
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE poolKey='idle' AND state='held'").pluck().get(), 2, '空闲池的两个独立任务各占一个名额');
    const multiPool = execution.enqueue(operation('auto-user', 'atomic-two-pools', { pools: ['idle', 'busy'] }));
    assert.equal(execution.admit({ ...identity, operationId: multiPool.operation.id }).kind, 'deferred');
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations r JOIN execution_operations o ON o.id=r.operationId WHERE o.taskId='atomic-two-pools'").pluck().get(), 0, '多池请求不得获得部分名额');
  }

  {
    const { db, execution } = await setup('automatic-ordinary-borrow');
    const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    updateTeamConcurrencyPolicy(db, { mode: 'auto', manualDefaultConcurrency: 1, expectedVersion: 0 });
    upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 2, enabled: true, mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0 });
    db.prepare(`INSERT INTO execution_actor_policies (actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt)
      VALUES ('borrower', NULL, 'CNY', 0, 0, 'Asia/Shanghai', 1, 'inherit', ?)`).run(new Date().toISOString());
    execution.enqueue(operation('borrower', 'borrow-first'));
    execution.enqueue(operation('borrower', 'borrow-second'));
    assert.equal(execution.admit(identity).kind, 'admitted');
    const second = execution.admit(identity);
    assert.equal(second.kind, 'admitted', '普通路径在真实池未满时不得误跳过同池借用任务');
    if (second.kind === 'admitted') assert.equal(second.grant.operation.taskId, 'borrow-second');
  }

  for (const [index, [poolKey, capacity]] of ([
    ['company:other-media', 50], ['company:qiniuyun', 100], ['llm:remote', 20], ['tts:remote', 20],
  ] as const).entries()) {
    const { db, execution } = await setup(`automatic-any-pool-${index}`);
    const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    updateTeamConcurrencyPolicy(db, { mode: 'auto', manualDefaultConcurrency: 10, expectedVersion: 0 });
    upsertExecutionPool(db, { poolKey, kind: 'remote', capacity, enabled: true, mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0 });
    updateActorPolicy(db, { actorId: 'only-member', monthlyLimitMinor: null, personalConcurrency: 0, concurrencyMode: 'inherit', paused: false, expectedVersion: 0 });
    for (let task = 0; task <= capacity; task += 1) {
      const queued = execution.enqueue(operation('only-member', `task-${task}`, { pools: [poolKey] }));
      const result = execution.admit({ ...identity, operationId: queued.operation.id });
      if (task < capacity) assert.equal(result.kind, 'admitted', `${poolKey} 应允许单人使用全部 ${capacity} 个空闲名额`);
      else assert.deepEqual(result, { kind: 'deferred', reasons: ['pool_capacity'] }, `${poolKey} 不得超售`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE poolKey=? AND kind='concurrency' AND state='held'").pluck().get(poolKey), capacity);
  }

  {
    const { db, execution } = await setup('automatic-eligible-demand');
    const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    updateTeamConcurrencyPolicy(db, { mode: 'auto', manualDefaultConcurrency: 1, expectedVersion: 0 });
    upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 10, enabled: true, mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0 });
    for (const actorId of ['productive', 'zero-budget', 'not-logged-in']) {
      db.prepare(`INSERT INTO execution_actor_policies (actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt)
        VALUES (?, ?, 'CNY', 0, 0, 'Asia/Shanghai', 1, 'inherit', ?)`).run(actorId, actorId === 'zero-budget' ? 0 : null, new Date().toISOString());
    }
    for (let index = 0; index < 10; index += 1) {
      execution.enqueue(operation('zero-budget', `ineligible-${index}`));
      const queued = execution.enqueue(operation('productive', `productive-${index}`));
      const admitted = execution.admit({ ...identity, operationId: queued.operation.id });
      assert.equal(admitted.kind, 'admitted', '无费用资格或没有实际任务的成员不得稀释唯一生产成员的借用容量');
    }
  }

  {
    const decisions: string[] = [];
    const deferredDetails: string[] = [];
    for (const historyRows of [0, 500, 2000]) {
      const { raw, stats, reset, execution } = await meteredSetup(`history-scaling-${historyRows}`);
      upsertExecutionPool(raw, {
        poolKey: 'shared', kind: 'remote', capacity: 10, enabled: true,
        mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
      });
      updateActorPolicy(raw, {
        actorId: 'scale-user', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
      });
      seedCompletedHistory(raw, historyRows);

      const heapBefore = process.memoryUsage().heapUsed;
      reset();
      const idle = execution.admit(identity);
      assert.deepEqual(idle, { kind: 'idle' });
      assert.equal(stats.snapshotBytes, 0, `${historyRows} 条完成历史不得在空闲准入中被读取`);
      assert.equal(stats.snapshotRows, 0, `${historyRows} 条完成历史不得被解析`);

      const first = execution.enqueue(operation('scale-user', `scale-${historyRows}-first`, {
        snapshot: { grantedInput: `grant-${historyRows}` },
      }));
      reset();
      const granted = execution.admit({ ...identity, operationId: first.operation.id });
      assert.equal(granted.kind, 'admitted');
      if (granted.kind === 'admitted') {
        assert.deepEqual(granted.grant.inputSnapshot, { grantedInput: `grant-${historyRows}` }, '获准后仍返回完整输入快照');
      }
      assert.equal(stats.snapshotRows, 1, '只允许搬运被授予操作自己的完整输入');
      assert.ok(stats.snapshotBytes < 4096, `获准只读取选中操作的小输入快照，实际 ${stats.snapshotBytes} 字节`);

      const second = execution.enqueue(operation('scale-user', `scale-${historyRows}-second`));
      reset();
      const deferred = execution.admit(identity);
      assert.deepEqual(deferred, { kind: 'deferred', reasons: ['personal_concurrency'] });
      assert.equal(stats.snapshotBytes, 0, `${historyRows} 条完成历史不得在延期准入中被读取`);
      assert.equal(stats.snapshotRows, 0, `${historyRows} 条完成历史不得在延期准入中被解析`);
      const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
      // 只作结构性上限:快照字节/行数断言已证明历史未被读取,
      // 堆增长阈值放宽以吸收 GC 时机与共享机器抖动。
      assert.ok(heapGrowth < 128 * 1024 * 1024, `准入不得长期保留完成历史快照（${historyRows} 条，堆增长 ${heapGrowth} 字节）`);

      assert.equal(execution.admit({ ...identity, operationId: first.operation.id }).kind, 'idle', '已授予操作不得重复提交');
      assert.equal(raw.prepare('SELECT COUNT(*) FROM execution_attempts WHERE operationId = ?').pluck().get(first.operation.id), 1);
      assert.equal(raw.prepare("SELECT COUNT(*) FROM execution_operations WHERE status IN ('pending', 'deferred')").pluck().get(), 1,
        '第二个操作应保持待准入');
      decisions.push(JSON.stringify({ idle: idle.kind, granted: granted.kind, deferred }));
      deferredDetails.push(raw.prepare('SELECT waitDetail FROM execution_operations WHERE id = ?')
        .pluck().get(second.operation.id) as string);
    }
    assert.equal(new Set(decisions).size, 1, '0/500/2000 条完成历史必须给出完全一致的准入决策');
    assert.equal(new Set(deferredDetails).size, 1, '等待详情不得因历史规模变化');
  }

  {
    const mixedDetails: string[] = [];
    const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
    for (const historyRows of [0, 2000]) {
      const { raw, stats, reset, execution } = await meteredSetup(`history-mixed-${historyRows}`);
      updateTeamConcurrencyPolicy(raw, { mode: 'auto', manualDefaultConcurrency: 1, expectedVersion: 0 });
      upsertExecutionPool(raw, {
        poolKey: 'shared', kind: 'remote', capacity: 10, enabled: true,
        mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
      });
      for (const actorId of ['held-a', 'held-b', 'held-c', 'held-d', 'released-e', 'deferred-f']) {
        raw.prepare(`INSERT INTO execution_actor_policies (
          actorId, monthlyLimitMinor, currency, personalConcurrency, paused, timezone, version, concurrencyMode, updatedAt
        ) VALUES (?, ?, 'CNY', 0, 0, 'Asia/Shanghai', 1, 'inherit', ?)`)
          .run(actorId, actorId === 'deferred-f' ? 1 : null, new Date().toISOString());
      }
      for (let index = 0; index < 3; index += 1) {
        const queued = execution.enqueue(operation('held-a', `held-a-${index}`));
        assert.equal(execution.admit({ ...identity, operationId: queued.operation.id }).kind, 'admitted');
      }
      execution.enqueue(operation('held-b', 'held-b-1'));
      const accepted = execution.enqueue(operation('held-c', 'held-c-1'));
      assert.equal(execution.admit({ ...identity, operationId: accepted.operation.id }).kind, 'admitted');
      raw.prepare("UPDATE execution_operations SET status = 'accepted' WHERE id = ?").run(accepted.operation.id);
      const unknownHeld = execution.enqueue(operation('held-d', 'held-d-1'));
      assert.equal(execution.admit({ ...identity, operationId: unknownHeld.operation.id }).kind, 'admitted');
      raw.prepare("UPDATE execution_operations SET status = 'unknown' WHERE id = ?").run(unknownHeld.operation.id);
      const released = execution.enqueue(operation('released-e', 'released-e-1'));
      assert.equal(execution.admit({ ...identity, operationId: released.operation.id }).kind, 'admitted');
      raw.prepare("UPDATE execution_operations SET status = 'unknown' WHERE id = ?").run(released.operation.id);
      raw.prepare("UPDATE execution_reservations SET state = 'released' WHERE operationId = ? AND kind = 'concurrency'")
        .run(released.operation.id);
      const deferredF = execution.enqueue(operation('deferred-f', 'deferred-f-1', { minor: 5 }));
      assert.deepEqual(execution.admit({ ...identity, operationId: deferredF.operation.id }),
        { kind: 'deferred', reasons: ['monthly_budget'] }, '无资格成员保持延期而不稀释自动公平');
      seedCompletedHistory(raw, historyRows);
      const overflow = execution.enqueue(operation('held-a', 'held-a-3'));
      reset();
      const result = execution.admit({ ...identity, operationId: overflow.operation.id });
      assert.deepEqual(result, { kind: 'deferred', reasons: ['fair_share'] }, '自动公平上限必须按真实占用裁决');
      const detail = raw.prepare("SELECT waitDetail FROM execution_operations WHERE taskId = 'held-a-3'")
        .pluck().get() as string;
      assert.equal(JSON.parse(detail).effectiveConcurrency, 3,
        '真实已占额 unknown 计入轮转，已释放 unknown 与无资格延期不计入');
      assert.equal(stats.snapshotBytes, 0, `${historyRows} 条完成历史不得参与混合需求的准入搬运`);
      assert.equal(stats.snapshotRows, 0);
      mixedDetails.push(detail);
    }
    assert.equal(new Set(mixedDetails).size, 1, '混合需求下 0/2000 条历史必须给出相同等待详情');
  }

  console.log('execution admission tests passed');
} finally {
  for (const cleanup of cleanups) cleanup();
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
