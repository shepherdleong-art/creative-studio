import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ExecutionJournal } from '../lib/media-core/execution/context.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-pool-config-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { listExecutionPools, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { applyPoolChanges, previewPoolChanges, readPoolAdminState, TeamPoolError } = await import('../lib/team-service/pools.ts');

const EMPTY_JOURNAL: ExecutionJournal = {
  appendIntent: () => { throw new Error('测试不发送真实提交'); },
  appendReceipt: () => { throw new Error('测试不发送真实提交'); },
  verify: () => ({ valid: true, records: [] }),
  scan: () => [],
};
const admin = { userId: 'admin-1', role: 'admin' as const };

function createDatabase(): Database.Database {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL DEFAULT '',
      apiKeyEnv TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, defaultCostPerImage REAL
    );
    CREATE TABLE IF NOT EXISTS script_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      baseUrl TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

const db = createDatabase();
try {
  const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true, readiness.message);
  // 真实画布表保存 providerSnapshot，没有独立 providerIdentity 列。
  db.exec(`CREATE TABLE creative_canvas_tasks (id TEXT PRIMARY KEY, providerSnapshot TEXT NOT NULL);
    INSERT INTO creative_canvas_tasks VALUES ('old-canvas-task', '{"providerIdentity":"historical-image"}');`);
  assert.ok(readPoolAdminState(db, admin).requirements.some((item) => item.poolKey === 'historical-image:remote'));
  db.prepare('DELETE FROM creative_canvas_tasks').run();

  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
    VALUES ('img-1', '图片供应商 A', 'https://media.example.test/v1', 'secret-key-a', 'gpt-image-2', 'openai-compatible', 1)`).run();
  db.prepare(`INSERT INTO script_providers (id, name, model, baseUrl, apiKey, enabled)
    VALUES ('llm-1', '脚本供应商', 'gpt-5', 'https://llm.example.test/v1', 'secret-llm', 1)`).run();

  const before = readPoolAdminState(db, admin);
  const imageRequirement = before.requirements.find((item) => item.key === 'image:img-1');
  assert.ok(imageRequirement);
  assert.equal(imageRequirement!.status, 'missing');
  assert.equal(before.ready, false);
  assert.equal(JSON.stringify(before).includes('secret-key-a'), false);
  assert.equal(JSON.stringify(before).includes('secret-llm'), false);

  // 非管理员不能读写池配置。
  assert.throws(() => readPoolAdminState(db, { userId: 'employee-1', role: 'employee' }), (error: unknown) =>
    error instanceof TeamPoolError && error.status === 403);

  // 预览不落库。
  const preview = previewPoolChanges(db, admin, [{
    action: 'bind-media-upstream', entityType: 'image', entityId: 'img-1',
    poolKey: 'media:shared', capacity: 1, expectedVersion: 0,
  }]);
  assert.equal(preview[0].action, 'create');
  assert.equal(listExecutionPools(db).length, 0);

  applyPoolChanges(db, admin, [{
    action: 'bind-media-upstream', entityType: 'image', entityId: 'img-1',
    poolKey: 'media:shared', capacity: 1, expectedVersion: 0,
  }]);
  applyPoolChanges(db, admin, [{
    action: 'upsert', poolKey: 'llm:remote', kind: 'remote', capacity: 2, enabled: true,
    mappingSnapshot: { protocol: 'llm-remote/1', modules: ['script'] }, expectedVersion: 0,
  }]);

  const configured = readPoolAdminState(db, admin);
  assert.equal(configured.ready, true, JSON.stringify(configured.blockers));
  assert.deepEqual(configured.pools.map((pool) => pool.poolKey).sort(), ['llm:remote', 'media:shared']);
  assert.equal(configured.bindings.length, 1);
  assert.equal(configured.requirements.find((item) => item.key === 'image:img-1')!.poolKey, 'media:shared');
  const sharedOccupancy = configured.occupancy.find((pool) => pool.poolKey === 'media:shared');
  assert.deepEqual(sharedOccupancy, { poolKey: 'media:shared', capacity: 1, held: 0, accepted: 0, maybeSent: 0, notSent: 0, activeMembers: [] });

  // 同一真实上游的第二个 Key 只有在管理员显式绑定时才共享容量。
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
    VALUES ('img-2', '图片供应商 B', 'https://media.example.test/v1', 'secret-key-b', 'gpt-image-2', 'openai-compatible', 1)`).run();
  const isolated = readPoolAdminState(db, admin).requirements.find((item) => item.key === 'image:img-2')!;
  assert.notEqual(isolated.poolKey, 'media:shared');
  assert.equal(isolated.status, 'missing');

  applyPoolChanges(db, admin, [{
    action: 'bind-media-upstream', entityType: 'image', entityId: 'img-2',
    poolKey: 'media:shared', capacity: 1, expectedVersion: 1,
  }]);
  const sharedMapping = listExecutionPools(db).find((pool) => pool.poolKey === 'media:shared')!;
  assert.equal((sharedMapping.mappingSnapshot as { protocol: string }).protocol, 'media-upstream-pool/1');
  assert.equal((sharedMapping.mappingSnapshot as { credentialFingerprints: string[] }).credentialFingerprints.length, 2);
  assert.equal(readPoolAdminState(db, admin).requirements.find((item) => item.key === 'image:img-2')!.poolKey, 'media:shared');
  assert.equal(readPoolAdminState(db, admin).occupancy.every((pool) => !JSON.stringify(pool).includes('secret')), true, '占用投影不得泄露供应商凭据或映射快照');

  // 不同上游地址不能合并计容。
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
    VALUES ('img-other', '图片供应商 C', 'https://other.example.test/v1', 'secret-key-c', 'gpt-image-2', 'openai-compatible', 1)`).run();
  assert.throws(() => applyPoolChanges(db, admin, [{
    action: 'bind-media-upstream', entityType: 'image', entityId: 'img-other',
    poolKey: 'media:shared', capacity: 1, expectedVersion: 2,
  }]), (error: unknown) => error instanceof TeamPoolError && error.code === 'pool_mapping_conflict');

  // 版本冲突有确定结果，且不写入。
  assert.throws(() => applyPoolChanges(db, admin, [{
    action: 'upsert', poolKey: 'llm:remote', kind: 'remote', capacity: 4, enabled: true,
    mappingSnapshot: { protocol: 'llm-remote/1' }, expectedVersion: 0,
  }]), (error: unknown) => error instanceof TeamPoolError && error.code === 'pool_version_conflict');

  // 不允许把明文凭据写进映射快照。
  assert.throws(() => applyPoolChanges(db, admin, [{
    action: 'upsert', poolKey: 'media:leak', kind: 'remote', capacity: 1, enabled: true,
    mappingSnapshot: { protocol: 'x/1', apiKey: 'secret' }, expectedVersion: 0,
  }]), (error: unknown) => error instanceof TeamPoolError && error.code === 'pool_mapping_secret');

  // 业务入口准入：真实池配置后可以领取；移除配置后明确阻止新付费。
  updateActorPolicy(db, { actorId: 'employee-1', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0 });
  registerExecutionInstance(db, { instanceId: 'instance-pool', fence: 1, deploymentId: 'deployment-pool' });
  const runtime = createExecutionFacade({
    db,
    deploymentId: 'deployment-pool',
    journal: EMPTY_JOURNAL,
    actorAllowed: () => true,
    scopeAllowed: () => true,
    maintenance: () => false,
    now: () => new Date('2026-11-04T00:00:00.000Z'),
  });
  await runtime.lifecycle.start({
    instanceId: 'instance-pool', fence: 1, deploymentId: 'deployment-pool', signal: new AbortController().signal,
  });
  const enqueue = (taskId: string, pool: string) => runtime.facade.enqueue({
    operationKey: `image/${taskId}/submit/r0`,
    actor: { userId: 'employee-1' },
    scope: { resourceType: 'project', resourceId: 'project-1' },
    module: 'image',
    taskId,
    step: 'submit',
    inputRevision: 'r0',
    businessAttempt: { id: `${taskId}:r0`, number: 1 },
    inputSnapshot: { taskId },
    inputHash: `hash-${taskId}`,
    continuationKey: 'legacy-image.submit',
    providerSnapshot: { providerId: 'img-1' },
    requiredPools: [pool],
    quote: { kind: 'unpriced' },
  });
  enqueue('task-allowed', 'media:shared');
  const admitted = runtime.facade.admit({ instanceId: 'instance-pool', fence: 1 });
  assert.equal(admitted.kind, 'admitted');

  db.prepare("DELETE FROM execution_pools WHERE poolKey = 'llm:remote'").run();
  enqueue('task-blocked', 'llm:remote');
  const blocked = runtime.facade.admit({ instanceId: 'instance-pool', fence: 1 });
  assert.equal(blocked.kind, 'deferred');
  assert.ok(blocked.kind === 'deferred' && blocked.reasons.includes('pool_missing'));

  // 配置重启后保留。
  db.close();
  const reopened = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    const pools = listExecutionPools(reopened);
    assert.ok(pools.some((pool) => pool.poolKey === 'media:shared' && pool.capacity === 1));
    assert.equal(listExecutionPools(reopened).some((pool) => pool.poolKey === 'llm:remote'), false);
  } finally {
    reopened.close();
  }
  console.log('team pool configuration tests passed');
} finally {
  try { db.close(); } catch { /* 已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true });
}
