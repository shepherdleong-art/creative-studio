import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-lifecycle-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'staging'), { recursive: true });
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, projectId TEXT, path TEXT, originalPath TEXT, processedPath TEXT);
  CREATE TABLE execution_operations (id TEXT PRIMARY KEY, scopeType TEXT NOT NULL, scopeId TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE batch_scripts (id TEXT PRIMARY KEY, projectId TEXT NOT NULL);
  CREATE TABLE batch_script_snapshots (id TEXT PRIMARY KEY, batchVersionId TEXT NOT NULL, sourceScriptId TEXT NOT NULL);
  INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES ('admin', '0000', '管理员', 'admin', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02');
  INSERT INTO projects VALUES ('project-a'), ('project-b'), ('project-c'), ('project-d'), ('project-e'), ('project-f'), ('project-g');
`);
const { registerRootScope, registerInheritedScope, requireResourceAccess } = await import('../lib/team-service/resource-scopes.ts');
const { registerReadyTeamFile } = await import('../lib/team-service/files/registry.ts');
const {
  softDeleteResource,
  restoreResource,
  createBackupPin,
  releaseBackupPin,
  acquireLifecycleBarrier,
  releaseLifecycleBarrier,
  requestPermanentCleanup,
  runPermanentCleanup,
  cleanupUnreferencedStaging,
} = await import('../lib/team-service/lifecycle/index.ts');

const admin = {
  kind: 'user' as const, userId: 'admin', employeeId: '0000', displayName: '管理员', role: 'admin' as const,
  sessionId: 'admin-session', sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
};
const employee = { ...admin, role: 'employee' as const };
const ref = (resourceId: string) => ({ resourceType: 'project', resourceId });

function addProject(id: string) {
  registerRootScope(db, { resourceType: 'project', resourceId: id, ownerUserId: 'admin' });
}
function addFile(name: string, references: Array<{ resourceType: string; resourceId: string }>) {
  const absolutePath = path.join(storageRoot, 'staging', name);
  fs.writeFileSync(absolutePath, name);
  return registerReadyTeamFile(db, {
    storageRoot, absolutePath, mimeType: 'text/plain', ownerUserId: 'admin', references,
    validateReference(reference) { requireResourceAccess(db, admin, reference.resourceType, reference.resourceId, 'write'); },
  });
}

try {
  for (const id of ['project-a', 'project-b', 'project-c', 'project-d', 'project-e', 'project-f', 'project-g']) addProject(id);
  const fileA = addFile('a.txt', [ref('project-a')]);
  const fileShared = addFile('shared.txt', [ref('project-a'), ref('project-b')]);
  softDeleteResource(db, admin, ref('project-a'));

  const pin = createBackupPin(db, admin, {
    releaseId: 'release-1', configVersion: 'config-1', fileIds: [fileA.id, fileShared.id],
  });
  const job = requestPermanentCleanup(db, admin, ref('project-a'));
  assert.throws(() => requestPermanentCleanup(db, employee, ref('project-a')), /管理员/);
  assert.equal(requestPermanentCleanup(db, admin, ref('project-a')).id, job.id, '重复请求复用清理任务');

  const barrier = acquireLifecycleBarrier(db, admin, 'backup', { releaseId: 'release-1' });
  let result = runPermanentCleanup(db, { jobId: job.id, storageRoot });
  assert.equal(result.status, 'deferred');
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'maintenance_barrier'));
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'a.txt')), true);
  releaseLifecycleBarrier(db, admin, barrier.id);

  result = runPermanentCleanup(db, { jobId: job.id, storageRoot });
  assert.equal(result.status, 'deferred');
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'backup'));
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'cross_module'));
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'a.txt')), true, '有引用时不得先 unlink');
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'shared.txt')), true);
  assert.ok(db.prepare("SELECT 1 FROM team_resource_scopes WHERE resourceType = 'project' AND resourceId = 'project-a'").get());

  releaseBackupPin(db, admin, pin.id);
  result = runPermanentCleanup(db, { jobId: job.id, storageRoot });
  assert.equal(result.status, 'deferred');
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'cross_module'));
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'a.txt')), true);

  db.prepare("UPDATE team_file_references SET releasedAt = '2026-11-02' WHERE fileId = ? AND resourceId = 'project-b'").run(fileShared.id);
  let unlinkCount = 0;
  result = runPermanentCleanup(db, {
    jobId: job.id, storageRoot,
    unlink(absolutePath) { unlinkCount += 1; fs.unlinkSync(absolutePath); },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(unlinkCount, 2);
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'shared.txt')), false);
  assert.equal(db.prepare("SELECT 1 FROM projects WHERE id = 'project-a'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = 'project-b'").get());
  assert.equal(runPermanentCleanup(db, { jobId: job.id, storageRoot }).status, 'completed');
  assert.equal(requestPermanentCleanup(db, admin, ref('project-a')).id, job.id, '完成后重复请求仍返回同一任务');
  assert.equal(unlinkCount, 2, '重复完成不得重复 unlink');

  const fileC = addFile('c.txt', [ref('project-c')]);
  softDeleteResource(db, admin, ref('project-c'));
  const resumed = requestPermanentCleanup(db, admin, ref('project-c'));
  let crashed = true;
  result = runPermanentCleanup(db, {
    jobId: resumed.id, storageRoot,
    unlink(absolutePath) {
      fs.unlinkSync(absolutePath);
      if (crashed) { crashed = false; throw new Error('simulated crash after unlink'); }
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'c.txt')), false);
  result = runPermanentCleanup(db, { jobId: resumed.id, storageRoot });
  assert.equal(result.status, 'completed', '崩溃后按持久文件清单对账并完成');
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'c.txt')), false);
  assert.ok(fileC.id);

  const fileD = addFile('d.txt', [ref('project-d')]);
  softDeleteResource(db, admin, ref('project-d'));
  const databaseInterrupted = requestPermanentCleanup(db, admin, ref('project-d'));
  db.exec(`CREATE TRIGGER fail_lifecycle_scope_delete BEFORE DELETE ON team_resource_scopes
    WHEN OLD.resourceId = 'project-d' BEGIN SELECT RAISE(ABORT, 'database interrupted'); END;`);
  result = runPermanentCleanup(db, { jobId: databaseInterrupted.id, storageRoot });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /database interrupted/);
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'd.txt')), true, '数据库中断不得提前 unlink');
  assert.deepEqual(db.prepare("SELECT state FROM team_files WHERE id = ?").get(fileD.id), { state: 'ready' });
  db.exec('DROP TRIGGER fail_lifecycle_scope_delete');
  assert.equal(runPermanentCleanup(db, { jobId: databaseInterrupted.id, storageRoot }).status, 'completed');

  const fileG = addFile('g.txt', [ref('project-g')]);
  softDeleteResource(db, admin, ref('project-g'));
  const restoredCleanup = requestPermanentCleanup(db, admin, ref('project-g'));
  restoreResource(db, admin, ref('project-g'));
  assert.throws(() => requestPermanentCleanup(db, admin, ref('project-g')), /只有回收站/);
  assert.throws(() => runPermanentCleanup(db, { jobId: restoredCleanup.id, storageRoot }), /资源已恢复/);
  assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = 'project-g'").get(), '恢复后的资源不得被旧清理任务删除');
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'g.txt')), true);
  assert.deepEqual(db.prepare('SELECT state FROM team_files WHERE id = ?').get(fileG.id), { state: 'ready' });
  softDeleteResource(db, admin, ref('project-g'));
  assert.throws(() => runPermanentCleanup(db, {
    jobId: restoredCleanup.id, storageRoot,
    now() { restoreResource(db, admin, ref('project-g')); return new Date(); },
  }), /资源已恢复/, '数据库阶段必须再次拒绝已恢复资源');
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'g.txt')), true);
  softDeleteResource(db, admin, ref('project-g'));
  assert.equal(runPermanentCleanup(db, { jobId: restoredCleanup.id, storageRoot }).status, 'completed');

  softDeleteResource(db, admin, ref('project-e'));
  db.prepare("INSERT INTO execution_operations VALUES ('operation-e', 'project', 'project-e', 'accepted')").run();
  const inflight = requestPermanentCleanup(db, admin, ref('project-e'));
  result = runPermanentCleanup(db, { jobId: inflight.id, storageRoot });
  assert.equal(result.status, 'deferred');
  assert.ok(result.blockers.some((blocker) => blocker.kind === 'inflight_operation'));
  db.prepare("UPDATE execution_operations SET status = 'succeeded' WHERE id = 'operation-e'").run();
  assert.equal(runPermanentCleanup(db, { jobId: inflight.id, storageRoot }).status, 'completed');

  db.prepare("INSERT INTO batch_scripts VALUES ('script-f', 'project-f')").run();
  db.prepare("INSERT INTO batch_script_snapshots VALUES ('snapshot-f', 'version-f', 'script-f')").run();
  registerInheritedScope(db, {
    resourceType: 'batch_script', resourceId: 'script-f', parent: ref('project-f'),
  });
  softDeleteResource(db, admin, { resourceType: 'batch_script', resourceId: 'script-f' });
  const historical = requestPermanentCleanup(db, admin, { resourceType: 'batch_script', resourceId: 'script-f' });
  result = runPermanentCleanup(db, { jobId: historical.id, storageRoot });
  assert.equal(result.status, 'deferred');
  assert.ok(result.blockers.some((blocker) => blocker.detail.includes('历史快照')));
  assert.ok(db.prepare("SELECT 1 FROM batch_scripts WHERE id = 'script-f'").get());

  fs.writeFileSync(path.join(storageRoot, 'staging', 'orphan.part'), 'orphan');
  fs.writeFileSync(path.join(storageRoot, 'staging', 'registered.part'), 'registered');
  db.prepare(`INSERT INTO team_files (
    id, seriesId, version, ownerUserId, relativePath, mimeType, byteSize, sha256, state, createdAt
  ) VALUES ('staged-file', 'staged-file', 1, 'admin', 'staging/registered.part', 'text/plain', 10, ?, 'staged', '2020-01-01')`)
    .run('0'.repeat(64));
  const staging = cleanupUnreferencedStaging(db, {
    storageRoot, candidates: ['staging/orphan.part', 'staging/registered.part'],
  });
  assert.deepEqual(staging.deleted, ['staging/orphan.part']);
  assert.deepEqual(staging.skipped, ['staging/registered.part']);
  assert.equal(fs.existsSync(path.join(storageRoot, 'staging', 'registered.part')), true, '登记中的 staging 不按时间自动删除');

  console.log('PASS: cross-module/backup pins, deferred cleanup, crash reconciliation, idempotency and safe staging cleanup');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
