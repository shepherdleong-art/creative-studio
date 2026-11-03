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
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
        if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
        if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-usage-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-usage-routes',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-release-routes',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');

ensureServerDeploymentMarker({ mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300, deploymentId: 'deployment-usage-routes', trustedOrigin: 'https://studio.example.test' });
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const admin = await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-usage-routes-password');
async function account(employeeId: string) {
  const created = await service.createUser(admin, { employeeId, displayName: employeeId, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  const principal = await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-usage-routes-password`);
  return { principal, cookie: sessionCookie(login.token).split(';', 1)[0] };
}
const alice = await account('0001');
const bob = await account('0002');
const adminCookie = sessionCookie(adminLogin.token).split(';', 1)[0];

const usageRoute = await import('../app/api/team/usage/route.ts');
const exportRoute = await import('../app/api/team/usage/export/route.ts');
const membersRoute = await import('../app/api/team/members/route.ts');
const policyRoute = await import('../app/api/team/members/[id]/policy/route.ts');
const tasksRoute = await import('../app/api/team/tasks/route.ts');
const reportRoute = await import('../app/api/team/errors/report/route.ts');
const errorsRoute = await import('../app/api/team/errors/route.ts');
const diagnosticRoute = await import('../app/api/team/errors/[id]/diagnostics/route.ts');

function request(url: string, cookie: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `${cookie}; __Host-team_csrf=csrf-test`);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-csrf-token', 'csrf-test');
  if (!headers.has('x-creative-studio-client-version')) headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  return new Request(url, { ...init, headers });
}
const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }) satisfies RequestInit;

try {
  const ownPolicy = await policyRoute.GET(request(`https://studio.example.test/api/team/members/${alice.principal.userId}/policy`, alice.cookie), { params: Promise.resolve({ id: alice.principal.userId }) });
  assert.equal(ownPolicy.status, 200, await ownPolicy.clone().text());
  assert.equal((await ownPolicy.json()).version, 0);
  const crossPolicy = await policyRoute.GET(request(`https://studio.example.test/api/team/members/${bob.principal.userId}/policy`, alice.cookie), { params: Promise.resolve({ id: bob.principal.userId }) });
  assert.equal(crossPolicy.status, 403);
  const employeePatch = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${alice.principal.userId}/policy`, alice.cookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: null, personalConcurrency: 9, paused: false, expectedVersion: 0 }),
  }), { params: Promise.resolve({ id: alice.principal.userId }) });
  assert.equal(employeePatch.status, 403, '员工直接 PATCH 自己策略也必须被拒绝');

  const adminPatch = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${alice.principal.userId}/policy`, adminCookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: 12345, personalConcurrency: 3, paused: true, expectedVersion: 0 }),
  }), { params: Promise.resolve({ id: alice.principal.userId }) });
  assert.equal(adminPatch.status, 200, await adminPatch.clone().text());
  assert.equal((await adminPatch.json()).monthlyLimitMinor, 12345);
  const members = await membersRoute.GET(request('https://studio.example.test/api/team/members?search=0001', adminCookie));
  assert.equal(members.status, 200);
  const memberBody = await members.json();
  assert.equal(memberBody.items.length, 1);
  assert.equal(memberBody.items[0].monthlyLimitMinor, 12345);
  assert.equal(memberBody.items[0].paused, true);

  const ownUsage = await usageRoute.GET(request('https://studio.example.test/api/team/usage', alice.cookie));
  assert.equal(ownUsage.status, 200, await ownUsage.clone().text());
  assert.equal((await ownUsage.json()).localAgentIncluded, false);
  const crossUsage = await usageRoute.GET(request(`https://studio.example.test/api/team/usage?actorUserId=${bob.principal.userId}`, alice.cookie));
  assert.equal(crossUsage.status, 403);
  const employeeCsv = await exportRoute.GET(request('https://studio.example.test/api/team/usage/export', alice.cookie));
  assert.equal(employeeCsv.status, 403);
  const adminCsv = await exportRoute.GET(request('https://studio.example.test/api/team/usage/export', adminCookie));
  assert.equal(adminCsv.status, 200);
  assert.match(adminCsv.headers.get('content-type') ?? '', /text\/csv/);
  assert.equal(adminCsv.headers.get('cache-control'), 'no-store');

  const report = await reportRoute.POST(request('https://studio.example.test/api/team/errors/report', alice.cookie, {
    method: 'POST', ...json({ clientEventId: 'route-client-1', stage: 'client_update', code: 'bad_signature', actorUserId: bob.principal.userId, message: 'https://example.test/?q-signature=SECRET' }),
  }));
  assert.equal(report.status, 201, await report.clone().text());
  const reported = await report.json();
  assert.equal(reported.actorUserId, alice.principal.userId);
  assert.equal(reported.clientVersion, '0.7.1');
  assert.equal(reported.serverReleaseId, 'server-release-routes');
  assert.equal(reported.stage, 'client_update');
  const ownErrors = await errorsRoute.GET(request('https://studio.example.test/api/team/errors', alice.cookie));
  assert.equal((await ownErrors.json()).items.length, 1);
  const otherErrors = await errorsRoute.GET(request('https://studio.example.test/api/team/errors', bob.cookie));
  assert.equal((await otherErrors.json()).items.length, 0);
  const diagnostic = await diagnosticRoute.GET(request(`https://studio.example.test/api/team/errors/${reported.errorId}/diagnostics`, alice.cookie), { params: Promise.resolve({ id: reported.errorId }) });
  assert.equal(diagnostic.status, 200);
  assert.match(diagnostic.headers.get('content-disposition') ?? '', /diagnostic-/);
  assert.equal((await diagnostic.clone().text()).includes('SECRET'), false);
  const crossDiagnostic = await diagnosticRoute.GET(request(`https://studio.example.test/api/team/errors/${reported.errorId}/diagnostics`, bob.cookie), { params: Promise.resolve({ id: reported.errorId }) });
  assert.equal(crossDiagnostic.status, 404);
  const adminErrors = await errorsRoute.GET(request(`https://studio.example.test/api/team/errors?errorId=${reported.errorId}`, adminCookie));
  assert.equal((await adminErrors.json()).items[0].actorUserId, alice.principal.userId);

  const maliciousReport = await reportRoute.POST(request('https://studio.example.test/api/team/errors/report', alice.cookie, {
    method: 'POST',
    ...json({ clientEventId: 'route-client-malicious', stage: 'client_update', code: 'bad_signature' }),
    headers: { 'content-type': 'application/json', 'x-creative-studio-client-version': 'Bearer SECRET' },
  }));
  assert.equal(maliciousReport.status, 426, '异常客户端版本应在兼容门禁被拒绝');
  const maliciousReportText = await maliciousReport.text();
  assert.equal(maliciousReportText.includes('Bearer'), false);
  assert.equal(maliciousReportText.includes('SECRET'), false);
  const errorsAfterMaliciousReport = await errorsRoute.GET(request('https://studio.example.test/api/team/errors', alice.cookie));
  assert.equal((await errorsAfterMaliciousReport.json()).items.length, 1, '被拒绝的异常版本不得写入诊断记录');

  const tasks = await tasksRoute.GET(request('https://studio.example.test/api/team/tasks', alice.cookie));
  assert.equal(tasks.status, 200);
  assert.deepEqual((await tasks.json()).items, []);

  console.log('PASS: authenticated team usage, admin policy/CSV, task center and diagnostic routes');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
