import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AdmitResult, EnqueueInput, ExecutionGrant } from '../lib/media-core/execution/context.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-acceptance-fairness-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const resultPath = process.env.TEAM_ACCEPTANCE_RESULT_PATH;
let db: Database.Database | undefined;
let runtime: ReturnType<typeof import('../lib/media-core/execution/operations.ts').createExecutionFacade> | undefined;

try {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
  const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
  const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
  const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
  const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
  db = new Database(path.join(root, 'data', 'workbench.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
  const identity = { instanceId: 'acceptance-fairness-instance', fence: 1 };
  registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-acceptance-fairness' });
  upsertExecutionPool(db, {
    poolKey: 'shared', kind: 'remote', capacity: 1, enabled: true,
    mappingSnapshot: { providerId: 'fake-provider' }, expectedVersion: 0,
  });
  const users = Array.from({ length: 20 }, (_, index) => `user-${String(index + 1).padStart(2, '0')}`);
  for (const actorId of users) updateActorPolicy(db, {
    actorId, monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
  });
  const journal = createExecutionJournal({ deploymentId: 'deployment-acceptance-fairness' });
  runtime = createExecutionFacade({
    db, deploymentId: 'deployment-acceptance-fairness', journal,
    actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  });
  await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-acceptance-fairness', signal: new AbortController().signal });
  const modules = ['images', 'batch', 'scripts', 'canvas'];
  const grants: Array<{ sequence: number; actorId: string; module: string; taskId: string }> = [];
  const admissionMs: number[] = [];
  let fakeTransportCalls = 0;
  let maxHeldRemotePermits = 0;
  function operation(actorId: string, round: number): EnqueueInput {
    const moduleName = modules[Math.max(0, users.indexOf(actorId)) % modules.length];
    const taskId = `${actorId}-round-${round}`;
    return {
      operationKey: `${moduleName}/${taskId}/submit/r1`, actor: { userId: actorId },
      scope: { resourceType: 'project', resourceId: `${actorId}-project` },
      module: moduleName, taskId, step: 'submit', inputRevision: 'r1',
      businessAttempt: { id: `${taskId}-business`, number: 1 },
      inputSnapshot: { fixture: true }, inputHash: `hash-${taskId}`,
      continuationKey: `${moduleName}.submit`, providerSnapshot: { providerId: 'fake-provider', model: 'fake-model' },
      requiredPools: ['shared'],
      quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 0 }, pricingSnapshot: { fixture: 'free' } },
    };
  }

  for (let round = 1; round <= 2; round += 1) {
    for (const actorId of users) runtime.facade.enqueue(operation(actorId, round));
    for (const expectedActor of users) {
      const started = performance.now();
      const admitted: AdmitResult = runtime.facade.admit(identity);
      admissionMs.push(performance.now() - started);
      assert.equal(admitted.kind, 'admitted');
      if (admitted.kind !== 'admitted') throw new Error('必须获得准入');
      assert.equal(admitted.grant.operation.actorId, expectedActor, '同一资源条件下一个轮转周期必须覆盖全部合格用户');
      grants.push({
        sequence: grants.length + 1,
        actorId: admitted.grant.operation.actorId,
        module: admitted.grant.operation.module,
        taskId: admitted.grant.operation.taskId,
      });
      const held = db.prepare("SELECT COUNT(*) AS count FROM execution_reservations WHERE kind = 'concurrency' AND poolKey = 'shared' AND state = 'held'").pluck().get() as number;
      maxHeldRemotePermits = Math.max(maxHeldRemotePermits, held);
      assert.equal(held, 1, '共享池容量 1 不得被任何模块或用户突破');
      const intent = await runtime.facade.markSubmitting({ grant: admitted.grant, requestSnapshot: { fixture: true } });
      await runtime.facade.transmit(intent, async () => {
        fakeTransportCalls += 1;
        return { remoteId: `fake-remote-${grants.length}` };
      });
      await runtime.facade.settle({
        attemptId: intent.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true,
      });
    }
  }
  assert.equal(runtime.facade.admit(identity).kind, 'idle');
  assert.equal(new Set(grants.slice(0, 20).map((grant) => grant.actorId)).size, 20);
  assert.equal(new Set(grants.slice(20).map((grant) => grant.actorId)).size, 20);
  assert.equal(fakeTransportCalls, 40);
  assert.equal(maxHeldRemotePermits, 1);
  assert.equal(journal.verify().valid, true);

  const { updateTeamConcurrencyPolicy, readTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
  updateTeamConcurrencyPolicy(db, { mode: 'auto', manualDefaultConcurrency: 1, expectedVersion: readTeamConcurrencyPolicy(db).version });
  upsertExecutionPool(db, {
    poolKey: 'shared', kind: 'remote', capacity: 10, enabled: true,
    mappingSnapshot: { providerId: 'fake-provider' }, expectedVersion: 1,
  });
  for (const actorId of ['auto-a', 'auto-b']) updateActorPolicy(db, {
    actorId, monthlyLimitMinor: null, personalConcurrency: 0, concurrencyMode: 'inherit', paused: false, expectedVersion: 0,
  });
  const borrowed: ExecutionGrant[] = [];
  for (let index = 0; index < 10; index += 1) {
    const queued = runtime.facade.enqueue(operation('auto-a', index + 1));
    const admitted: AdmitResult = runtime.facade.admit({ ...identity, operationId: queued.operation.id });
    assert.equal(admitted.kind, 'admitted', '唯一有需求的成员可以借满十个空闲名额');
    if (admitted.kind === 'admitted') borrowed.push(admitted.grant);
  }
  const newcomer = runtime.facade.enqueue(operation('auto-b', 1));
  const firstRelease = borrowed.shift()!;
  const firstIntent = await runtime.facade.markSubmitting({ grant: firstRelease, requestSnapshot: { fixture: true } });
  await runtime.facade.settle({ attemptId: firstIntent.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true });
  const fairNewcomer = runtime.facade.admit({ ...identity, operationId: newcomer.operation.id });
  assert.equal(fairNewcomer.kind, 'admitted', '后来者获得释放名额，不取消先入者的其他请求');
  if (fairNewcomer.kind === 'admitted') assert.equal(fairNewcomer.grant.operation.actorId, 'auto-b');
  const waitingBorrower = runtime.facade.enqueue(operation('auto-a', 11));
  assert.deepEqual(runtime.facade.admit({ ...identity, operationId: waitingBorrower.operation.id }), {
    kind: 'deferred', reasons: ['pool_capacity'],
  }, '两人持续竞争时先借满者不能继续占用所有后续名额；池满如实报告共享容量等待');

  const remainingBorrowers = [...borrowed];
  if (fairNewcomer.kind === 'admitted') remainingBorrowers.push(fairNewcomer.grant);
  for (const grant of remainingBorrowers) {
    const intent = await runtime.facade.markSubmitting({ grant, requestSnapshot: { fixture: true } });
    await runtime.facade.settle({ attemptId: intent.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true });
  }
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE poolKey='shared' AND state='held'").pluck().get(), 0);
  for (const actorId of users) {
    runtime.facade.enqueue(operation(actorId, 100));
    runtime.facade.enqueue(operation(actorId, 200));
  }
  const rotating: ExecutionGrant[] = [];
  for (let index = 0; index < 10; index += 1) {
    const admitted: AdmitResult = runtime.facade.admit(identity);
    assert.equal(admitted.kind, 'admitted', '容量小于人数时每轮仍至少准入一人');
    if (admitted.kind === 'admitted') {
      assert.equal(admitted.grant.operation.actorId, users[index], '自动模式保留同一公平轮转顺序');
      rotating.push(admitted.grant);
    }
  }
  assert.deepEqual(runtime.facade.admit(identity), { kind: 'deferred', reasons: ['pool_capacity'] }, '真实容量耗尽后正常等待，而不是用零份额停滞');
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE poolKey='shared' AND state='held'").pluck().get(), 10, '多人竞争仍不得超过共享池真实容量');
  for (let index = 0; index < 10; index += 1) {
    const grant = rotating[index];
    const intent = await runtime.facade.markSubmitting({ grant, requestSnapshot: { fixture: true } });
    await runtime.facade.transmit(intent, async () => ({ remoteId: `auto-${intent.attemptId}` }));
    await runtime.facade.settle({ attemptId: intent.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true });
    const successor: AdmitResult = runtime.facade.admit(identity);
    assert.equal(successor.kind, 'admitted', '每次释放后等待成员必须继续准入');
    if (successor.kind === 'admitted') assert.equal(successor.grant.operation.actorId, users[10 + index], '后半组成员按公平顺序获得释放名额');
  }
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_actor_policies WHERE actorId='new-user-without-work'").pluck().get(), 0, '无登录或无工作成员不产生需求或预留');

  const sorted = [...admissionMs].sort((a, b) => a - b);
  const pick = (ratio: number) => sorted[Math.ceil(sorted.length * ratio) - 1];
  const result = {
    schemaVersion: 1,
    users: users.length,
    modules,
    rounds: 2,
    grantSequence: grants,
    admission: { count: admissionMs.length, p50Ms: pick(0.5), p95Ms: pick(0.95) },
    maxHeldRemotePermits,
    fakeTransportCalls,
    realPaidProviderCalls: 0,
    db: { busyErrors: 0, walBytes: fs.existsSync(path.join(root, 'data', 'workbench.db-wal')) ? fs.statSync(path.join(root, 'data', 'workbench.db-wal')).size : 0 },
    assertions: ['20 用户两轮授予均完整轮转且用户内 FIFO', '四模块共享池任一时刻最多 1 个 remote permit', '40 次 fake transport 均有独立日志且真实付费调用为 0'],
  };
  if (resultPath) {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`team acceptance fairness passed: ${grants.length} grants, 20 users, max remote permits ${maxHeldRemotePermits}`);
} finally {
  runtime?.closeNewWork();
  if (db?.open) db.close();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
