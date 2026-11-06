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
const adminCookie = sessionCookie(adminLogin.token).split(';', 1)[0];
const adminRequest = new Request('https://studio.example.test/api/team/maintenance/jobs', { headers: { Cookie: adminCookie } });
const principal = requirePrincipal(adminRequest, { admin: true });
const created = await auth.createUser(principal, { employeeId: '00001', displayName: '普通员工', role: 'employee' });
const employeeLogin = await auth.login({ employeeId: '00001', password: created.credential });
await auth.changeOwnPassword(employeeLogin.principal, created.credential, 'employee-password');
const employeeCookie = sessionCookie(employeeLogin.token).split(';', 1)[0];

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
  const listed = await backupsRoute.GET(request('/api/team/maintenance/backups', adminCookie));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).backups, []);
  console.log('team maintenance administrator route tests passed');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  fs.rmSync(fixture, { recursive: true, force: true });
  process.env = previousEnv;
}
