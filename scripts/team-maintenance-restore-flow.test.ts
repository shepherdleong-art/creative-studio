import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeReleaseManifest } from './team-server/distribution.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-restore-flow-'));
const deploymentRoot = path.join(fixture, 'deployment');
const dataRoot = path.join(fixture, 'active');
const backupRoot = path.join(fixture, 'backups');
const releaseRoot = path.join(deploymentRoot, 'releases', 'release-1');
const deploymentId = 'deployment-restore-flow';
const configPath = path.join(deploymentRoot, 'config', 'maintenance-deployment.json');
const databases = new Set<Database.Database>();
const stores = new Set<{ close(): void }>();
function open(root = dataRoot) {
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('foreign_keys = ON');
  return db;
}
function write(relative: string, content: string) {
  const file = path.join(releaseRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
}
function worker(jobId: string, ...extra: string[]) {
  return spawnSync(process.execPath, ['scripts/team-server/maintenance.mjs', 'worker', '--config', configPath,
    '--job-id', jobId, '--once', '--allow-fixture-release', '--test-isolated-cutover', ...extra], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 120_000, windowsHide: true,
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot },
  });
}
function addProject(db: Database.Database, id: string) {
  db.prepare("INSERT INTO providers (id, name, baseUrl, model) VALUES (?, 'fixture', '', 'model')").run(`provider-${id}`);
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, ?, 'model', 'fixture')")
    .run(id, `项目 ${id}`, `provider-${id}`);
}

try {
  write('app/server.js', '// fixture'); write('runtime/process-tree.mjs', '// fixture');
  write('app/runtime/team-server-entry.cjs', '// fixture'); write('app/scripts/team-server/maintenance.mjs', '// fixture');
  const node = write('runtimes/node/node.exe', 'node'); const caddy = write('tools/caddy/caddy.exe', 'caddy');
  const winsw = write('tools/winsw/WinSW.exe', 'winsw');
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const lock = JSON.parse(fs.readFileSync(path.resolve('scripts/team-server/distribution-lock.json'), 'utf8')) as {
    fixture: boolean; media: unknown[]; node: { binarySha256: string }; caddy: { binarySha256: string }; winsw: { sha256: string };
  };
  lock.fixture = true; lock.media = []; lock.node.binarySha256 = hash(node); lock.caddy.binarySha256 = hash(caddy); lock.winsw.sha256 = hash(winsw);
  write('service/distribution-lock.json', JSON.stringify(lock));
  write('service/packaging/forbidden-paths.json', fs.readFileSync(path.resolve('scripts/packaging/forbidden-paths.json'), 'utf8'));
  write('START-HERE.md', 'fixture'); write('deployment.example.json', '{}');
  writeReleaseManifest(releaseRoot, {
    releaseId: 'release-1', appVersion: '0.7.1', sourceCommit: 'fixture', fixture: true,
    compatibility: { minAppVersion: '0.7.1', maxAppVersion: '0.7.1', dataSchemaMin: 1, dataSchemaMax: 99 },
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1, deploymentId, releaseId: 'release-1', deploymentRoot, dataRoot, backupRoot,
    oldRoots: [], origin: 'https://studio.example.test', appPort: 3399, liteLLMPort: 4399,
    servicePrefix: 'CreativeStudioRestoreFlow', serviceAccount: 'NT AUTHORITY\\NetworkService',
    certificate: { certPath: 'C:\\protected\\certificate.crt', keyPath: 'C:\\protected\\certificate.key' },
    allowedNetworks: ['192.0.2.0/24'], enableLiteLLM: false, stopTimeoutSeconds: 240,
  }));
  fs.mkdirSync(path.join(deploymentRoot, 'service'), { recursive: true });
  fs.writeFileSync(path.join(deploymentRoot, 'service', 'current-release.json'), JSON.stringify({
    schemaVersion: 1, releaseId: 'release-1', packageSha256: hash(path.join(releaseRoot, 'release-manifest.json')), switchedAt: new Date().toISOString(),
  }));
  fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
  process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
  const { getDb } = await import('../lib/db.ts');
  const initializedDb = getDb();
  assert.equal(initializedDb.name, path.join(dataRoot, 'data', 'workbench.db'));
  const db = open();
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
  const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
  assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  addProject(db, 'project-a');
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES ('admin', 'admin', '管理员', 'admin', 'active', 'fixture', 0, 1, ?, ?)`).run(at, at);
  db.prepare(`INSERT INTO team_sessions (id, tokenHash, userId, sessionVersion, createdAt, absoluteExpiresAt, revokedAt)
    VALUES ('revoked-old', ?, 'admin', 1, ?, ?, ?)`).run('old-revoked-hash', at, '2099-01-01T00:00:00.000Z', at);
  db.prepare(`INSERT INTO team_sessions (id, tokenHash, userId, sessionVersion, createdAt, absoluteExpiresAt, revokedAt)
    VALUES ('valid-old', ?, 'admin', 1, ?, ?, NULL)`).run('old-valid-hash', at, '2099-01-01T00:00:00.000Z');
  fs.mkdirSync(path.join(dataRoot, 'storage', 'execution-journal', deploymentId), { recursive: true });
  const { MaintenanceJobStore } = await import('../lib/team-service/maintenance/jobs.ts');
  const jobs = new MaintenanceJobStore({ backupRoot, deploymentId }); stores.add(jobs);
  const backupJob = jobs.submit({ action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' }, idempotencyKey: 'backup-point-a-13' });
  const initialBackup = worker(backupJob.job.id);
  assert.equal(initialBackup.status, 0, `${initialBackup.stdout}${initialBackup.stderr}`);
  const backupId = String(jobs.get(backupJob.job.id).job.result?.backupId);
  const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
  const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
  const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
  const { upsertExecutionPool, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
  registerExecutionInstance(db, { instanceId: 'restore-flow', fence: 1, deploymentId });
  upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 1, enabled: true,
    mappingSnapshot: { providerId: 'provider-project-a' }, expectedVersion: 0 });
  updateActorPolicy(db, { actorId: 'admin', monthlyLimitMinor: 1000, personalConcurrency: 1, concurrencyMode: 'fixed', paused: false, expectedVersion: 0 });
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', 'project-a', 'admin', 'project', 'project-a', ?, ?)`).run(at, at);
  const execution = createExecutionFacade({ db, deploymentId,
    journal: createExecutionJournal({ deploymentId, directory: path.join(dataRoot, 'storage', 'execution-journal', deploymentId) }),
    actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false });
  await execution.lifecycle.start({ instanceId: 'restore-flow', fence: 1, deploymentId, signal: new AbortController().signal });
  execution.facade.enqueue({ operationKey: 'images/unknown-13/submit/r1', actor: { userId: 'admin' },
    scope: { resourceType: 'project', resourceId: 'project-a' }, module: 'images', taskId: 'unknown-13', step: 'submit',
    inputRevision: 'r1', businessAttempt: { id: 'unknown-business-13', number: 1 }, inputSnapshot: {}, inputHash: 'unknown-hash',
    continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-project-a', model: 'model' }, requiredPools: ['shared'],
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 1 }, pricingSnapshot: { version: 1 } } });
  const admission = execution.facade.admit({ instanceId: 'restore-flow', fence: 1, leaseMs: 0 });
  assert.equal(admission.kind, 'admitted');
  if (admission.kind !== 'admitted') throw new Error('unknown admission required');
  const unknownIntent = await execution.facade.markSubmitting({ grant: admission.grant, requestSnapshot: {} });
  addProject(db, 'project-b');
  const corrupt = jobs.submit({ action: 'restore.execute', target: { kind: 'restore', backupType: 'manual', backupId },
    principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' }, idempotencyKey: 'restore-bad-backup-13' });
  const databasePath = path.join(backupRoot, 'manual', backupId, 'data', 'workbench.db');
  const original = fs.readFileSync(databasePath);
  fs.writeFileSync(databasePath, Buffer.from('not-a-sqlite-backup'));
  const rejectedCorrupt = worker(corrupt.job.id);
  assert.notEqual(rejectedCorrupt.status, 0);
  assert.equal(jobs.get(corrupt.job.id).job.status, 'failed');
  assert.equal(fs.existsSync(path.join(fixture, '.restore-data', corrupt.job.id)), false, '坏备份不得先生成可切换根');
  fs.writeFileSync(databasePath, original);
  const noSpace = jobs.submit({ action: 'restore.execute', target: { kind: 'restore', backupType: 'manual', backupId },
    principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' }, idempotencyKey: 'restore-no-space-13' });
  assert.notEqual(worker(noSpace.job.id, '--test-disk-space-zero').status, 0);
  assert.match(jobs.get(noSpace.job.id).job.error?.message ?? '', /空间不足/);
  assert.equal(jobs.get(noSpace.job.id).job.result, null);
  assert.equal(fs.existsSync(path.join(fixture, '.restore-data', noSpace.job.id, 'restored')), false);
  const restore = jobs.submit({ action: 'restore.execute', target: { kind: 'restore', backupType: 'manual', backupId },
    principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' }, idempotencyKey: 'restore-point-a-13' });
  const prepare = worker(restore.job.id);
  assert.equal(prepare.status, 0, `${prepare.stdout}${prepare.stderr}`);
  assert.equal(jobs.get(restore.job.id).job.status, 'awaiting_confirmation');
  const waitingReport = jobs.get(restore.job.id).job.result?.reconciliation as { unknownAttemptIds: string[]; scheduling: boolean; automaticRetries: number; status: string };
  assert.ok(waitingReport.unknownAttemptIds.includes(admission.grant.attempt.id));
  assert.equal(waitingReport.status, 'hold'); assert.equal(waitingReport.scheduling, false); assert.equal(waitingReport.automaticRetries, 0);
  assert.equal(unknownIntent.attemptId, admission.grant.attempt.id);
  assert.equal(db.prepare('SELECT submissionState FROM execution_attempts WHERE id = ?').pluck().get(unknownIntent.attemptId), 'maybe_sent');
  assert.equal(worker(restore.job.id).status, 0);
  assert.equal(jobs.get(restore.job.id).job.status, 'awaiting_confirmation');
  jobs.confirm({ jobId: restore.job.id, principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' } });
  assert.notEqual(worker(restore.job.id).status, 0, '重连不可跳过重新认证');
  assert.equal(fs.existsSync(path.join(dataRoot, 'data', 'workbench.db')), true);
  assert.ok(jobs.audit(restore.job.id).some((record) => record.event === 'cutover_confirmed'));

  const failedRestore = jobs.submit({ action: 'restore.execute', target: { kind: 'restore', backupType: 'manual', backupId },
    principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' }, idempotencyKey: 'restore-point-a-failure-13' });
  assert.equal(worker(failedRestore.job.id).status, 0);
  fs.mkdirSync(path.join(deploymentRoot, 'restore-operations', failedRestore.job.id), { recursive: true });
  fs.writeFileSync(path.join(deploymentRoot, 'restore-operations', failedRestore.job.id, 'reauthenticated-session.json'), JSON.stringify({
    schemaVersion: 1, tokenHash: 'new-admin-session-hash',
    principal: { userId: 'admin', sessionId: 'new-admin-session', sessionVersion: 1, absoluteExpiresAt: '2099-01-01T00:00:00.000Z' },
  }));
  jobs.confirm({ jobId: failedRestore.job.id, principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' } });
  db.close();
  const { closeDb } = await import('../lib/db.ts');
  closeDb();
  for (const openDb of databases) if (openDb.open) openDb.close();
  const injectedFailure = worker(failedRestore.job.id, '--test-cutover-failure');
  assert.notEqual(injectedFailure.status, 0);
  assert.equal(fs.existsSync(path.join(dataRoot, 'data', 'workbench.db')), true, '失败切换必须保留原根');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).dataRoot, dataRoot);
  const failedActivity = JSON.parse(fs.readFileSync(path.join(deploymentRoot, 'service', 'active-data-root.json'), 'utf8'));
  assert.equal(failedActivity.state, 'failed'); assert.equal(failedActivity.activeDataRoot, dataRoot);
  assert.equal(failedActivity.recovery.preRestoreBackupId, `${failedRestore.job.id}-pre-restore`);

  const successful = jobs.submit({ action: 'restore.execute', target: { kind: 'restore', backupType: 'manual', backupId },
    principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' }, idempotencyKey: 'restore-point-a-success-13' });
  assert.equal(worker(successful.job.id).status, 0);
  const operationRoot = path.join(fixture, '.restore-data', successful.job.id);
  fs.mkdirSync(path.join(deploymentRoot, 'restore-operations', successful.job.id), { recursive: true });
  fs.writeFileSync(path.join(deploymentRoot, 'restore-operations', successful.job.id, 'reauthenticated-session.json'), JSON.stringify({
    schemaVersion: 1, tokenHash: 'new-admin-session-hash',
    principal: { userId: 'admin', sessionId: 'new-admin-session', sessionVersion: 1, absoluteExpiresAt: '2099-01-01T00:00:00.000Z' },
  }));
  jobs.confirm({ jobId: successful.job.id, principal: { userId: 'admin', employeeId: 'admin', displayName: '管理员', role: 'admin' } });
  const cutover = worker(successful.job.id);
  assert.equal(cutover.status, 0, `${cutover.stdout}${cutover.stderr}`);
  assert.equal(jobs.get(successful.job.id).job.status, 'succeeded');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).dataRoot, path.join(operationRoot, 'restored'));
  const activeDb = new Database(path.join(operationRoot, 'restored', 'data', 'workbench.db'), { readonly: true }); databases.add(activeDb);
  assert.equal(activeDb.prepare("SELECT COUNT(*) FROM projects WHERE id = 'project-a'").pluck().get(), 1);
  assert.equal(activeDb.prepare("SELECT COUNT(*) FROM projects WHERE id = 'project-b'").pluck().get(), 0);
  assert.equal(activeDb.prepare("SELECT revokedAt FROM team_sessions WHERE id = 'revoked-old'").pluck().get(), at);
  assert.ok(activeDb.prepare("SELECT revokedAt FROM team_sessions WHERE id = 'valid-old'").pluck().get());
  assert.equal(activeDb.prepare("SELECT COUNT(*) FROM team_sessions WHERE id = 'new-admin-session' AND revokedAt IS NULL").pluck().get(), 1);
  const retainedDb = new Database(path.join(operationRoot, 'protected-old-root', 'data', 'workbench.db'), { readonly: true }); databases.add(retainedDb);
  assert.equal(retainedDb.prepare("SELECT COUNT(*) FROM projects WHERE id = 'project-b'").pluck().get(), 1);
  const preRestoreDb = new Database(path.join(backupRoot, 'pre-restore', `${successful.job.id}-pre-restore`, 'data', 'workbench.db'), { readonly: true }); databases.add(preRestoreDb);
  assert.equal(preRestoreDb.prepare("SELECT COUNT(*) FROM projects WHERE id = 'project-b'").pluck().get(), 1);
  assert.ok(fs.existsSync(path.join(operationRoot, 'restored', 'storage', 'maintenance', 'restore-hold.json')));
  assert.equal(fs.existsSync(path.join(operationRoot, 'authorization-overlay.json')), false, '密码hash覆盖不得留在可继续备份的还原数据根');
  assert.ok(fs.existsSync(path.join(deploymentRoot, 'restore-operations', successful.job.id, 'authorization-overlay.json')));
  assert.equal(JSON.stringify(jobs.get(successful.job.id)).includes('new-admin-session-hash'), false, '网页作业不得包含会话hash');
  assert.equal(jobs.audit(successful.job.id).at(-1)?.actor.displayName, '管理员');
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('certificate.key'), true);
  assert.equal(fs.existsSync('C:\\protected\\certificate.key'), false, '测试不写证书或系统配置');
  console.log('team maintenance restore flow cutover, newer data, old session and audit tests passed');
} finally {
  for (const store of stores) store.close();
  const { closeDb } = await import('../lib/db.ts');
  closeDb();
  for (const db of databases) if (db.open) db.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
