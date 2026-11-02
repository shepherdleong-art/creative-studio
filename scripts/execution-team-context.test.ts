import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput } from '../lib/media-core/execution/context.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-team-context-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createTeamExecutionRuntime } = await import('../lib/team-service/bootstrap.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');

const db = new Database(path.join(fixtureRoot, 'workbench.db'));
db.pragma('foreign_keys = ON');
const teamReady = await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) });
const executionReady = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) });
assert.equal(teamReady.available, true);
assert.equal(executionReady.available, true);
const now = new Date().toISOString();
function user(id: string, status = 'active', role = 'employee') {
  db.prepare(`
    INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, 'hash', ?, ?)
  `).run(id, id, id, role, status, now, now);
}
function scope(id: string, ownerUserId: string) {
  db.prepare(`
    INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt
    ) VALUES ('project', ?, ?, 'project', ?, ?, ?)
  `).run(id, ownerUserId, id, now, now);
}
user('user-a');
user('user-b');
user('user-disabled', 'disabled');
scope('project-a', 'user-a');
scope('project-b', 'user-b');
scope('project-disabled', 'user-disabled');
registerExecutionInstance(db, { instanceId: 'instance-team-execution', fence: 1, deploymentId: 'deployment-team-execution' });
upsertExecutionPool(db, {
  poolKey: 'shared', kind: 'remote', capacity: 2, enabled: true,
  mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
});
for (const actorId of ['user-a', 'user-b', 'user-disabled']) {
  updateActorPolicy(db, {
    actorId, monthlyLimitMinor: 100, personalConcurrency: 1, paused: false, expectedVersion: 0,
  });
}
const identity = { instanceId: 'instance-team-execution', fence: 1 };
const config = {
  mode: 'server' as const, dataRoot: fixtureRoot, hostname: '127.0.0.1' as const, port: 3300,
  deploymentId: 'deployment-team-execution', trustedOrigin: 'https://studio.example.test',
};
const runtime = createTeamExecutionRuntime({ config, db });

function operation(taskId: string, actorId: string, scopeId: string, pools = ['shared']): EnqueueInput {
  return {
    operationKey: `images/${taskId}/submit/r1`, actor: { userId: actorId },
    scope: { resourceType: 'project', resourceId: scopeId },
    module: 'images', taskId, step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: `${taskId}-business`, number: 1 },
    inputSnapshot: { taskId }, inputHash: `hash-${taskId}`,
    continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
    requiredPools: pools,
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 50 }, pricingSnapshot: { version: 1 } },
  };
}

try {
  assert.throws(() => runtime.facade.enqueue(operation('before-ready', 'user-a', 'project-a')), /readiness/);
  await runtime.lifecycle.start({ ...identity, deploymentId: config.deploymentId, signal: new AbortController().signal });
  assert.throws(() => runtime.facade.enqueue(operation('wrong-scope', 'user-a', 'project-b')), /scope/);
  assert.throws(() => runtime.facade.enqueue(operation('disabled', 'user-disabled', 'project-disabled')), /停用/);

  runtime.facade.enqueue(operation('missing-pool', 'user-b', 'project-b', ['not-configured']));
  const missing = runtime.facade.admit(identity);
  assert.equal(missing.kind, 'deferred');
  if (missing.kind === 'deferred') assert.ok(missing.reasons.includes('pool_missing'));

  runtime.facade.enqueue(operation('accepted', 'user-a', 'project-a'));
  const admitted = runtime.facade.admit(identity);
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') throw new Error('grant expected');
  const intent = await runtime.facade.markSubmitting({ grant: admitted.grant, requestSnapshot: {} });
  await runtime.facade.transmit(intent, async () => ({ remoteId: 'remote-team' }));
  db.prepare("UPDATE team_users SET status = 'disabled' WHERE id = 'user-a'").run();
  db.prepare('UPDATE team_service_state SET maintenance = 1 WHERE id = 1').run();
  const settled = await runtime.facade.settle({
    attemptId: admitted.grant.attempt.id, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 50 }, remoteTerminal: true,
  });
  assert.equal(settled.submissionState, 'terminal', '停用和维护只挡新阶段，不杀已受理结果');
  assert.throws(() => runtime.facade.enqueue(operation('maintenance', 'user-b', 'project-b')), /维护/);
  runtime.closeNewWork();
  db.close();

  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
  const { startTeamServiceRuntime, getTeamExecutionFacade } = await import('../lib/team-service/runtime/index.ts');
  await assert.rejects(() => startTeamServiceRuntime(), /server/);
  assert.throws(() => getTeamExecutionFacade(), /execution|执行/);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'storage', 'execution-journal')), true,
    'server 组合根已经使用独立 journal；local 不再创建额外 worker 或目录');
  const before = fs.readdirSync(path.join(fixtureRoot, 'storage', 'execution-journal', config.deploymentId)).length;
  await Promise.resolve();
  assert.equal(fs.readdirSync(path.join(fixtureRoot, 'storage', 'execution-journal', config.deploymentId)).length, before,
    'local 入口不得启动执行 worker 或追加 journal');

  console.log('execution team context tests passed');
} finally {
  if (db.open) db.close();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
