import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as { registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = path.join(repoRoot, specifier.slice(2));
    const candidate = fs.existsSync(base) && fs.statSync(base).isFile() ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
    if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
  }
  try { return nextResolve(specifier, context); }
  catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
} });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-routes-'));
const dataRoot = path.join(fixture, 'data-root');
const backupRoot = path.join(fixture, 'backups');
const deploymentRoot = path.join(fixture, 'deployment');
const serviceRoot = path.join(deploymentRoot, 'service');
fs.mkdirSync(serviceRoot, { recursive: true });
fs.writeFileSync(path.join(serviceRoot, 'current-release.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'release-route-13', packageSha256: 'e'.repeat(64), switchedAt: new Date().toISOString() }));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: dataRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-maintenance-routes', CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_MAINTENANCE_DEPLOYMENT_ROOT: deploymentRoot, CREATIVE_STUDIO_MAINTENANCE_BACKUP_ROOT: backupRoot,
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const { requirePrincipal } = await import('../lib/team-service/auth/request.ts');
ensureServerDeploymentMarker({ mode: 'server', dataRoot, hostname: '127.0.0.1', port: 3300, deploymentId: 'deployment-maintenance-routes', trustedOrigin: 'https://studio.example.test' });
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const initialized = await initializeFirstAdministrator({ db, employeeId: '00042', displayName: '网页管理员', kdf, passwordParams: { N: 1024, r: 8, p: 1 } });
const auth = createTeamAuthService({ db, kdf, passwordParams: { N: 1024, r: 8, p: 1 } });
setTeamAuthServiceForTests(auth);
const adminLogin = await auth.login({ employeeId: '00042', password: initialized.credential });
await auth.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-password');
const adminSession = await auth.login({ employeeId: '00042', password: 'admin-password' });
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];
const adminRequest = new Request('https://studio.example.test/api/team/maintenance/jobs', { headers: { Cookie: adminCookie } });
const principal = requirePrincipal(adminRequest, { admin: true });
const created = await auth.createUser(principal, { employeeId: '00001', displayName: '普通员工', role: 'employee' });
const employeeLogin = await auth.login({ employeeId: '00001', password: created.credential });
await auth.changeOwnPassword(employeeLogin.principal, created.credential, 'employee-password');
const employeeSession = await auth.login({ employeeId: '00001', password: 'employee-password' });
const employeeCookie = sessionCookie(employeeSession.token).split(';', 1)[0];

const jobsRoute = await import('../app/api/team/maintenance/jobs/route.ts');
const jobRoute = await import('../app/api/team/maintenance/jobs/[id]/route.ts');
const backupsRoute = await import('../app/api/team/maintenance/backups/route.ts');
const auditRoute = await import('../app/api/team/maintenance/jobs/[id]/audit/route.ts');
function request(pathname: string, cookie: string, body?: unknown, origin = 'https://studio.example.test'): Request {
  return new Request(`https://studio.example.test${pathname}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=maintenance-csrf`, Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': 'maintenance-csrf' }),
    },
  });
}

try {
  const employee = await jobsRoute.POST(request('/api/team/maintenance/jobs', employeeCookie, { idempotencyKey: 'employee-request-10', target: { kind: 'backup', backupType: 'manual' } }));
  assert.equal(employee.status, 403);
  assert.equal((await employee.json()).error, 'admin_required');
  const wrongOrigin = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, { idempotencyKey: 'wrong-origin-10', target: { kind: 'backup', backupType: 'manual' } }, 'https://attacker.example'));
  assert.equal(wrongOrigin.status, 403);
  for (const target of [
    { kind: 'backup', backupType: 'manual', path: 'C:\\outside' },
    { kind: 'backup', backupType: 'daily' },
    { kind: 'shell', command: 'whoami' },
  ]) {
    const rejected = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, { idempotencyKey: `invalid-${JSON.stringify(target).length}-10`, target }));
    assert.equal(rejected.status, 400, JSON.stringify(target));
  }
  const submitted = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, { idempotencyKey: 'frontend-click-00010', target: { kind: 'backup', backupType: 'manual' } }));
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const accepted = await submitted.json();
  assert.equal(accepted.job.requestedBy.displayName, '网页管理员');
  assert.equal(accepted.job.status, 'queued');
  const duplicate = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, { idempotencyKey: 'frontend-click-00010', target: { kind: 'backup', backupType: 'manual' } }));
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).job.id, accepted.job.id);
  const conflicting = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, { idempotencyKey: 'another-click-00010', target: { kind: 'backup', backupType: 'manual' } }));
  assert.equal(conflicting.status, 409);
  const reconnected = await jobRoute.GET(request(`/api/team/maintenance/jobs/${accepted.job.id}`, adminCookie), { params: Promise.resolve({ id: accepted.job.id }) });
  assert.equal(reconnected.status, 200);
  const reconnectedBody = await reconnected.json();
  assert.equal(reconnectedBody.job.id, accepted.job.id);
  assert.equal(JSON.stringify(reconnectedBody).includes(deploymentRoot), false);
  assert.equal(JSON.stringify(reconnectedBody).includes('control-credential'), false);
  const audit = await auditRoute.GET(request(`/api/team/maintenance/jobs/${accepted.job.id}/audit`, adminCookie), { params: Promise.resolve({ id: accepted.job.id }) });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json();
  assert.equal(auditBody.audit[0].actor.displayName, '网页管理员');
  assert.deepEqual(auditBody.audit[0].target, { kind: 'backup', backupType: 'manual' });
  assert.equal(auditBody.audit[0].event, 'submitted');
  const deniedAudit = await auditRoute.GET(request(`/api/team/maintenance/jobs/${accepted.job.id}/audit`, employeeCookie), { params: Promise.resolve({ id: accepted.job.id }) });
  assert.equal(deniedAudit.status, 403);
  const { createTeamBackup } = await import('../lib/team-service/maintenance/backup.ts');
  const configFile = path.join(deploymentRoot, 'config', 'maintenance-deployment.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ deploymentRoot, dataRoot }));
  await createTeamBackup({ db, principal, dataRoot, storageRoot: path.join(dataRoot, 'storage'), backupRoot,
    deploymentId: 'deployment-maintenance-routes', type: 'manual', backupId: 'verified-point-a',
    release: { releaseId: 'release-route-13', packageSha256: 'e'.repeat(64) }, config: { filePath: configFile } });
  const listed = await backupsRoute.GET(request('/api/team/maintenance/backups', adminCookie));
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.equal((await listed.json()).backups[0].restorable, true);
  const restoresRoute = await import('../app/api/team/maintenance/restores/route.ts');
  const badRestore = await restoresRoute.POST(request('/api/team/maintenance/restores', adminCookie, {
    idempotencyKey: 'restore-bad-backup-13', target: { kind: 'restore', backupType: 'manual', backupId: 'not-a-valid-backup' },
  }));
  assert.equal(badRestore.status, 409);
  const arbitraryRestore = await restoresRoute.POST(request('/api/team/maintenance/restores', adminCookie, {
    idempotencyKey: 'restore-arbitrary-path-13', target: { kind: 'restore', backupType: 'manual', backupId: 'x', path: 'C:\\outside' },
  }));
  assert.equal(arbitraryRestore.status, 400);
  const employeeRestore = await restoresRoute.POST(request('/api/team/maintenance/restores', employeeCookie, {
    idempotencyKey: 'restore-employee-13', target: { kind: 'restore', backupType: 'manual', backupId: 'x' },
  }));
  assert.equal(employeeRestore.status, 403);
  const confirmRoute = await import('../app/api/team/maintenance/restores/[id]/confirm/route.ts');
  const missingConfirm = await confirmRoute.POST(request(`/api/team/maintenance/restores/${accepted.job.id}/confirm`, adminCookie, { password: 'admin-password' }), { params: Promise.resolve({ id: accepted.job.id }) });
  assert.equal(missingConfirm.status, 409, '备份作业未完成隔离还原，不能伪装成待确认还原');
  const { MaintenanceJobStore } = await import('../lib/team-service/maintenance/jobs.ts');
  const store = new MaintenanceJobStore({ backupRoot, deploymentId: 'deployment-maintenance-routes' });
  store.claimNext({ workerId: 'route-fixture-worker' });
  store.complete({ jobId: accepted.job.id, workerId: 'route-fixture-worker', result: { backupId: 'verified-point-a' } });
  const submittedRestore = await restoresRoute.POST(request('/api/team/maintenance/restores', adminCookie, {
    idempotencyKey: 'restore-valid-point-13', target: { kind: 'restore', backupType: 'manual', backupId: 'verified-point-a' },
  }));
  assert.equal(submittedRestore.status, 202, await submittedRestore.clone().text());
  const restoreJob = (await submittedRestore.json()).job;
  store.claimNext({ workerId: 'route-fixture-worker' });
  store.awaitConfirmation({ jobId: restoreJob.id, workerId: 'route-fixture-worker', result: { awaitingConfirmation: true, preRestoreBackupId: 'verified-pre-restore' } });
  const wrongPassword = await confirmRoute.POST(request(`/api/team/maintenance/restores/${restoreJob.id}/confirm`, adminCookie, { password: 'incorrect-password' }), { params: Promise.resolve({ id: restoreJob.id }) });
  assert.equal(wrongPassword.status, 401);
  assert.equal(store.get(restoreJob.id).job.status, 'awaiting_confirmation');
  assert.equal(store.get(restoreJob.id).job.integrity, 'ok');
  const confirmed = await confirmRoute.POST(request(`/api/team/maintenance/restores/${restoreJob.id}/confirm`, adminCookie, { password: 'admin-password' }), { params: Promise.resolve({ id: restoreJob.id }) });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.equal((await confirmed.json()).accessVerified, true);
  assert.ok(confirmed.headers.get('set-cookie')?.includes('__Host-team_session='));
  assert.equal(store.get(restoreJob.id).job.status, 'queued');
  assert.equal(store.audit(restoreJob.id).at(-1)?.actor.displayName, '网页管理员');
  const duplicateConfirmation = await confirmRoute.POST(request(`/api/team/maintenance/restores/${restoreJob.id}/confirm`, adminCookie, { password: 'admin-password' }), { params: Promise.resolve({ id: restoreJob.id }) });
  assert.equal(duplicateConfirmation.status, 409, '重复确认不能重新排队已确认切换');
  store.close();

  const releasesRoute = await import('../app/api/team/maintenance/releases/route.ts');
  const releaseBody = {
    candidateId: 'a'.repeat(64), idempotencyKey: 'confirm-release-001',
    confirmation: { expectedReleaseId: 'old-release', targetAppVersion: '0.8.0', impactAcknowledged: true },
  };
  assert.equal((await releasesRoute.POST(request('/api/team/maintenance/releases', employeeCookie, releaseBody))).status, 403);
  assert.equal((await releasesRoute.POST(request('/api/team/maintenance/releases', adminCookie, {
    ...releaseBody, command: 'whoami',
  }))).status, 400);
  const unavailable = await releasesRoute.POST(request('/api/team/maintenance/releases', adminCookie, releaseBody));
  assert.notEqual(unavailable.status, 202, '没有通过候选和当前版本复核时不得启动升级');
  console.log('team maintenance administrator route tests passed');

  const cleanupRoute = await import('../app/api/team/maintenance/cleanup/route.ts');
  const backupStore = new MaintenanceJobStore({ backupRoot, deploymentId: 'deployment-maintenance-routes' });
  const claimed = backupStore.claimNext({ workerId: 'backup-worker' });
  assert.equal(claimed?.job.id, accepted.job.id);
  backupStore.complete({ jobId: accepted.job.id, workerId: 'backup-worker', result: { backupId: 'test-only', verifiedAt: '2026-11-06', totalBytes: 0, type: 'manual' } });
  backupStore.close();
  fs.mkdirSync(path.join(deploymentRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(deploymentRoot, 'config', 'maintenance-deployment.json'), JSON.stringify({ dataRoot, oldRoots: [path.join(fixture, 'retained-root')] }));
  const uploadId = 'failed-upload-route';
  const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
  db.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('test', '隔离供应商', 'http://127.0.0.1')").run();
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('route-project', '路由隔离项目', 'test', 'test', 'test')").run();
  registerRootScope(db, { resourceType: 'project', resourceId: 'route-project', ownerUserId: principal.userId });
  db.prepare(`INSERT INTO team_uploads (
    id, userId, targetResourceType, targetResourceId, usage, relativeName, mimeType,
    expectedSize, expectedSha256, sourceFingerprint, partSize, idempotencyKey, state, fileId, createdAt, updatedAt
  ) VALUES (?, ?, 'project', 'route-project', 'input', 'failed.part', 'application/octet-stream',
    4, ?, 'fingerprint', 1024, 'route-upload', 'failed', 'route-file', '2026-01-01', '2026-01-01')`)
    .run(uploadId, principal.userId, '0'.repeat(64));
  const temporary = path.join(dataRoot, 'storage', 'team-staging', uploadId, 'parts');
  fs.mkdirSync(temporary, { recursive: true });
  fs.writeFileSync(path.join(temporary, '1.part'), '1234');
  const employeeScan = await cleanupRoute.POST(request('/api/team/maintenance/cleanup', employeeCookie, {}));
  assert.equal(employeeScan.status, 403);
  const wrongOriginScan = await cleanupRoute.POST(request('/api/team/maintenance/cleanup', adminCookie, {}, 'https://attacker.example'));
  assert.equal(wrongOriginScan.status, 403);
  const scanned = await cleanupRoute.POST(request('/api/team/maintenance/cleanup', adminCookie, {}));
  assert.equal(scanned.status, 201, await scanned.clone().text());
  const preview = (await scanned.json()).preview;
  assert.equal(preview.totals.cleanableCount, 1);
  assert.equal(preview.totals.estimatedBytes, 4);
  assert.equal(JSON.stringify(preview).includes(dataRoot), false);
  const notConfirmed = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, {
    idempotencyKey: 'cleanup-not-confirmed', target: { kind: 'cleanup', previewId: preview.id },
  }));
  assert.equal(notConfirmed.status, 400);
  assert.equal(fs.existsSync(path.join(temporary, '1.part')), true);
  for (const target of [
    { kind: 'cleanup', previewId: preview.id, path: 'C:\\outside' },
    { kind: 'cleanup', previewId: '../../other' },
    { kind: 'shell', command: 'remove-item' },
  ]) {
    const denied = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, {
      idempotencyKey: `cleanup-denied-${JSON.stringify(target).length}`, confirm: true, target,
    }));
    assert.equal(denied.status, 400, await denied.clone().text());
  }
  const cleanupConfirmed = await jobsRoute.POST(request('/api/team/maintenance/jobs', adminCookie, {
    idempotencyKey: 'cleanup-confirmed-route', confirm: true, target: { kind: 'cleanup', previewId: preview.id },
  }));
  assert.equal(cleanupConfirmed.status, 202, await cleanupConfirmed.clone().text());
  const cleanupJob = (await cleanupConfirmed.json()).job;
  assert.equal(cleanupJob.requestedBy.userId, principal.userId);
  const cleanupAudit = await auditRoute.GET(request(`/api/team/maintenance/jobs/${cleanupJob.id}/audit`, adminCookie), { params: Promise.resolve({ id: cleanupJob.id }) });
  assert.equal((await cleanupAudit.json()).audit[0].actor.displayName, '网页管理员');
  assert.equal(fs.existsSync(path.join(temporary, '1.part')), true, 'HTTP确认只排队，不在网页进程直接删除');
  const cleanupStore = new MaintenanceJobStore({ backupRoot, deploymentId: 'deployment-maintenance-routes' });
  const cleanupClaim = cleanupStore.claimNext({ workerId: 'cleanup-worker' });
  assert.equal(cleanupClaim?.job.id, cleanupJob.id);
  const { executeCleanupPreview } = await import('../lib/team-service/maintenance/cleanup.ts');
  const cleanupResult = executeCleanupPreview({ db, previewId: preview.id, storageRoot: path.join(dataRoot, 'storage'), backupRoot, protectedDataRoots: [dataRoot, path.join(fixture, 'retained-root')] });
  cleanupStore.complete({ jobId: cleanupJob.id, workerId: 'cleanup-worker', result: { ...cleanupResult } });
  cleanupStore.close();
  const reconnectedCleanup = await jobRoute.GET(request(`/api/team/maintenance/jobs/${cleanupJob.id}`, adminCookie), { params: Promise.resolve({ id: cleanupJob.id }) });
  const cleanupBody = (await reconnectedCleanup.json()).job;
  assert.equal(cleanupBody.id, cleanupJob.id);
  assert.equal(cleanupBody.result.deletedCount, 1);
  assert.equal(cleanupBody.result.freedBytes, 4);
  assert.equal(fs.existsSync(path.join(temporary, '1.part')), false);
  console.log('team cleanup administrator routes, binding, confirmation and reconnected result passed');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  // Windows 上 SQLite WAL 文件可能在连接关闭后仍被短暂锁定，等待并重试清理。
  await new Promise(resolve => setTimeout(resolve, 100));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); break; }
    catch (error) {
      if (attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  process.env = previousEnv;
}
