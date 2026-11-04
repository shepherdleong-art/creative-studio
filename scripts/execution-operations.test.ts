import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput } from '../lib/media-core/execution/context.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-operations-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance, EXECUTION_MIGRATIONS } = await import('../lib/media-core/execution/schema.ts');
const { ensureVersionedSchemaReady } = await import('../lib/schema-upgrade/versioned.ts');
const { readActorPolicy } = await import('../lib/media-core/execution/pools.ts');

const root = path.join(fixtureRoot, 'db');
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
assert.equal(readiness.available, true);
assert.deepEqual(readiness.appliedVersions, [1, 2, 3, 4, 5]);

registerExecutionInstance(db, { instanceId: 'instance-a', fence: 1, deploymentId: 'deployment-a' });
const journal = {
  verify: () => ({ valid: true, records: [] }),
  appendIntent: () => { throw new Error('not used by enqueue'); },
  appendReceipt: () => { throw new Error('not used by enqueue'); },
  scan: () => [],
};
const runtime = createExecutionFacade({
  db,
  deploymentId: 'deployment-a',
  journal,
  actorAllowed: () => true,
  scopeAllowed: () => true,
  maintenance: () => false,
});
await runtime.lifecycle.start({
  deploymentId: 'deployment-a', instanceId: 'instance-a', fence: 1, signal: new AbortController().signal,
});
const execution = runtime.facade;

function input(overrides: Record<string, unknown> = {}): EnqueueInput {
  const operation = {
    module: 'images', taskId: 'task-1', step: 'submit', inputRevision: 'r1',
  };
  return {
    ...operation,
    operationKey: 'images/task-1/submit/r1',
    actor: { userId: 'user-a' },
    scope: { resourceType: 'project', resourceId: 'project-a' },
    businessAttempt: { id: 'business-attempt-1', number: 1 },
    inputSnapshot: { imageId: 'image-1', prompt: 'not written to journal' },
    inputHash: 'hash-a',
    continuationKey: 'images.submit',
    providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
    requiredPools: ['provider-a:remote'],
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 125 }, pricingSnapshot: { version: 1 } },
    ...overrides,
  };
}

try {
  const legacyRoot = path.join(fixtureRoot, 'legacy-v4');
  fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
  const legacyDb = new Database(path.join(legacyRoot, 'data', 'workbench.db'));
  try {
    const paths = schemaUpgradeRuntimePaths(legacyRoot);
    const previous = await ensureVersionedSchemaReady({ db: legacyDb, scope: 'execution', migrations: EXECUTION_MIGRATIONS.slice(0, 4), migrationTable: 'execution_schema_migrations', backupRoot: paths.backupRoot, validate: () => {} });
    assert.equal(previous.state, 'ready');
    legacyDb.prepare("INSERT INTO execution_actor_policies VALUES ('existing', 2000, 'CNY', 3, 1, 'Asia/Shanghai', 7, ?)").run(new Date().toISOString());
    const upgraded = await checkExecutionReadiness({ db: legacyDb, ...paths });
    assert.equal(upgraded.available, true);
    assert.deepEqual(readActorPolicy(legacyDb, 'existing'), { actorId: 'existing', monthlyLimitMinor: 2000, currency: 'CNY', personalConcurrency: 3, paused: true, timezone: 'Asia/Shanghai', version: 7, allowedModels: null });
    assert.equal((await checkExecutionReadiness({ db: legacyDb, ...paths })).available, true, '重复启动不重复执行迁移');
  } finally { legacyDb.close(); }

  let checkpoints = 0;
  const first = execution.enqueue({
    ...input(),
    persistCheckpoint: () => { checkpoints += 1; },
  });
  assert.equal(first.kind, 'deferred');
  assert.equal(first.replayed, false);
  assert.equal(first.operation.status, 'pending');
  assert.equal(first.operation.readySeq, 1);
  assert.equal(first.operation.actorId, 'user-a');
  assert.equal(first.operation.scopeType, 'project');
  assert.equal(first.operation.scopeId, 'project-a');
  assert.equal(first.operation.step, 'submit');
  assert.equal(first.operation.inputRevision, 'r1');
  assert.equal(first.operation.businessAttemptNo, 1);
  assert.equal(checkpoints, 1);

  const replay = execution.enqueue({
    ...input(),
    persistCheckpoint: () => { checkpoints += 1; },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(replay.operation.readySeq, 1);
  assert.equal(checkpoints, 1, '同内容重放不能重复业务检查点副作用');

  assert.throws(
    () => execution.enqueue(input({ inputSnapshot: { imageId: 'image-2' }, inputHash: 'hash-b' })),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'idempotency_conflict'),
  );
  assert.throws(
    () => execution.enqueue(input({ operationKey: 'some-other-key' })),
    /operationKey/,
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM execution_operations').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM execution_reservations').pluck().get(), 0,
    '排队不得预留并发或费用');
  assert.deepEqual(
    db.prepare('SELECT nextReadySeq, cursorActorId FROM execution_admission_state WHERE id = 1').get(),
    { nextReadySeq: 2, cursorActorId: null },
  );

  const beforeRuntime = createExecutionFacade({
    db,
    deploymentId: 'deployment-a',
    journal,
    actorAllowed: () => true,
    scopeAllowed: () => true,
    maintenance: () => false,
  });
  assert.throws(
    () => beforeRuntime.facade.enqueue(input({ taskId: 'task-before-ready', operationKey: 'images/task-before-ready/submit/r1' })),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'execution_not_ready'),
  );

  assert.throws(
    () => createExecutionFacade({
      db,
      deploymentId: 'deployment-a',
      actorAllowed: () => true,
      scopeAllowed: () => true,
      maintenance: () => false,
    } as never),
    /journal/,
  );

  console.log('execution operations tests passed');
} finally {
  await runtime.lifecycle.drain?.({
    deploymentId: 'deployment-a', instanceId: 'instance-a', fence: 1, signal: new AbortController().signal,
  });
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
