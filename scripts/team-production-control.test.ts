import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TEAM_SERVICE_MIGRATIONS } from '../lib/team-service/schema.ts';
import { EXECUTION_MIGRATIONS, registerExecutionInstance } from '../lib/media-core/execution/schema.ts';
import { readProductionControl, setProductionPaused } from '../lib/team-service/production-control.ts';
import { updateActorPolicy, upsertExecutionPool } from '../lib/media-core/execution/pools.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-production-control-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { createTeamExecutionRuntime } = await import('../lib/team-service/bootstrap.ts');
const db = new Database(path.join(root, 'test.db'));
const admin = { userId: 'admin', role: 'admin' as const };
const identity = { instanceId: 'test-instance', fence: 1, deploymentId: 'test' };
try {
  for (const migration of [...TEAM_SERVICE_MIGRATIONS, ...EXECUTION_MIGRATIONS]) db.exec(migration.sql);
  db.exec(`INSERT INTO team_users (id,employeeId,displayName,role,status,passwordHash,createdAt,updatedAt)
    VALUES ('admin','90001','Test','admin','active','unused',datetime('now'),datetime('now'));
    INSERT INTO team_resource_scopes (resourceType,resourceId,ownerUserId,rootType,rootId,createdAt,updatedAt)
    VALUES ('project','test','admin','project','test',datetime('now'),datetime('now'));`);
  updateActorPolicy(db, { actorId: 'admin', monthlyLimitMinor: null, personalConcurrency: 5, paused: false, expectedVersion: 0 });
  upsertExecutionPool(db, { poolKey: 'llm:remote', kind: 'remote', capacity: 20, enabled: true, mappingSnapshot: { protocol: 'llm-remote/1' }, expectedVersion: 0 });
  registerExecutionInstance(db, identity);
  const config = { mode: 'server' as const, hostname: '127.0.0.1' as const, port: 3300, deploymentId: 'test', dataRoot: root, trustedOrigin: 'http://127.0.0.1:3300' };
  const runtime = createTeamExecutionRuntime({ db, config });
  await runtime.lifecycle.start({ ...identity, signal: new AbortController().signal });
  const enqueue = (id: string) => runtime.facade.enqueue({
    operationKey: `script/${id}/submit/r0`, actor: { userId: 'admin' },
    scope: { resourceType: 'project', resourceId: 'test' }, module: 'script', taskId: id,
    step: 'submit', inputRevision: 'r0', businessAttempt: { id, number: 1 }, inputSnapshot: { id },
    inputHash: id, continuationKey: 'test', providerSnapshot: {}, requiredPools: ['llm:remote'], quote: { kind: 'unpriced' },
  });
  enqueue('queued-before-pause');
  assert.throws(() => setProductionPaused(db, { userId: 'employee', role: 'employee' }, { paused: true, expectedVersion: 0 }), /管理员/);
  const paused = setProductionPaused(db, admin, { paused: true, expectedVersion: 0 });
  assert.equal(paused.paused, true);
  assert.equal(paused.maintenance, false);
  assert.throws(() => enqueue('new-while-paused'), /维护/);
  const deferred = runtime.facade.admit(identity);
  assert.equal(deferred.kind, 'deferred');
  assert.throws(() => setProductionPaused(db, admin, { paused: false, expectedVersion: 0 }), /状态已变化/);
  const resumed = setProductionPaused(db, admin, { paused: false, expectedVersion: paused.version });
  assert.equal(runtime.facade.admit(identity).kind, 'admitted');
  db.prepare("UPDATE team_service_state SET maintenance=1, reason='deployment' WHERE id=1").run();
  setProductionPaused(db, admin, { paused: true, expectedVersion: resumed.version });
  const restored = setProductionPaused(db, admin, { paused: false, expectedVersion: resumed.version + 1 });
  assert.equal(restored.maintenance, true, 'UI resume must never clear deployment maintenance');
  assert.throws(() => enqueue('during-deployment'), /维护/);
  const reopened = new Database(path.join(root, 'test.db'));
  assert.equal(readProductionControl(reopened, admin).version, restored.version);
  reopened.close();
  console.log('production pause: admission, resume, authorization, conflict, persistence and maintenance isolation passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
