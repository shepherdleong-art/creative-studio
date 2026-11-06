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
const concurrencyRoute = await import('../app/api/team/concurrency-policy/route.ts');
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
  assert.equal((await ownPolicy.json()).version, 1);
  const crossPolicy = await policyRoute.GET(request(`https://studio.example.test/api/team/members/${bob.principal.userId}/policy`, alice.cookie), { params: Promise.resolve({ id: bob.principal.userId }) });
  assert.equal(crossPolicy.status, 403);
  const employeePatch = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${alice.principal.userId}/policy`, alice.cookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: null, personalConcurrency: 9, paused: false, expectedVersion: 1 }),
  }), { params: Promise.resolve({ id: alice.principal.userId }) });
  assert.equal(employeePatch.status, 403, '员工直接 PATCH 自己策略也必须被拒绝');

  const adminPatch = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${alice.principal.userId}/policy`, adminCookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: 12345, personalConcurrency: 3, paused: true, expectedVersion: 1 }),
  }), { params: Promise.resolve({ id: alice.principal.userId }) });
  assert.equal(adminPatch.status, 200, await adminPatch.clone().text());
  assert.equal((await adminPatch.json()).monthlyLimitMinor, 12345);
  const teamConcurrencyUrl = 'https://studio.example.test/api/team/concurrency-policy';
  const members = await membersRoute.GET(request('https://studio.example.test/api/team/members?search=0001', adminCookie));
  assert.equal(members.status, 200);
  const memberBody = await members.json();
  assert.equal(memberBody.items.length, 1);
  assert.equal(memberBody.items[0].monthlyLimitMinor, 12345);
  assert.equal(memberBody.items[0].paused, true);

  const employeeTeamPolicy = await concurrencyRoute.PATCH(request(teamConcurrencyUrl, alice.cookie, {
    method: 'PATCH', ...json({ mode: 'manual', manualDefaultConcurrency: 3, expectedVersion: 1 }),
  }));
  assert.equal(employeeTeamPolicy.status, 403, '员工不得保存团队默认并发');
  const employeeTeamPolicyRead = await concurrencyRoute.GET(request(teamConcurrencyUrl, alice.cookie));
  assert.equal(employeeTeamPolicyRead.status, 403);
  const invalidTeamPolicy = await concurrencyRoute.PATCH(request(teamConcurrencyUrl, adminCookie, {
    method: 'PATCH', ...json({ manualDefaultConcurrency: -1, expectedVersion: 0 }),
  }));
  assert.equal(invalidTeamPolicy.status, 400);
  const unavailableAutoPolicy = await concurrencyRoute.PATCH(request(teamConcurrencyUrl, adminCookie, {
    method: 'PATCH', ...json({ mode: 'auto', manualDefaultConcurrency: 3, expectedVersion: 0 }),
  }));
  assert.equal(unavailableAutoPolicy.status, 200, await unavailableAutoPolicy.clone().text());
  assert.deepEqual(await unavailableAutoPolicy.json(), { mode: 'auto', manualDefaultConcurrency: 3, version: 1 });
  const autoInherited = await policyRoute.GET(request(`https://studio.example.test/api/team/members/${alice.principal.userId}/policy`, adminCookie), { params: Promise.resolve({ id: alice.principal.userId }) });
  assert.equal((await autoInherited.json()).effectiveConcurrency, null, '自动继承没有永久承诺的个人固定配额');
  const teamPolicy = await concurrencyRoute.PATCH(request(teamConcurrencyUrl, adminCookie, {
    method: 'PATCH', ...json({ mode: 'manual', manualDefaultConcurrency: 3, expectedVersion: 1 }),
  }));
  assert.equal(teamPolicy.status, 200, await teamPolicy.clone().text());
  assert.deepEqual(await teamPolicy.json(), { mode: 'manual', manualDefaultConcurrency: 3, version: 2 });
  const staleTeamPolicy = await concurrencyRoute.PATCH(request(teamConcurrencyUrl, adminCookie, {
    method: 'PATCH', ...json({ manualDefaultConcurrency: 9, expectedVersion: 0 }),
  }));
  assert.equal(staleTeamPolicy.status, 409, '另一管理员先保存后必须拒绝旧版本覆盖');
  const usersRoute = await import('../app/api/team/users/route.ts');
  const created = await usersRoute.POST(request('https://studio.example.test/api/team/users', adminCookie, {
    method: 'POST', ...json({ employeeId: '0003', displayName: '新继承成员', role: 'employee' }),
  }));
  assert.equal(created.status, 201, await created.clone().text());
  const createdUser = (await created.json()).user;
  const inherited = await policyRoute.GET(request(`https://studio.example.test/api/team/members/${createdUser.id}/policy`, adminCookie), { params: Promise.resolve({ id: createdUser.id }) });
  const inheritedBody = await inherited.json();
  assert.equal(inheritedBody.concurrencyMode, 'inherit', '建号事务必须明确标记继承');
  assert.equal(inheritedBody.concurrencySource, 'team_default');
  assert.equal(inheritedBody.effectiveConcurrency, 3);
  assert.equal(inheritedBody.personalConcurrency, 0);
  assert.equal(inheritedBody.monthlyLimitMinor, 0, '团队并发默认不得放宽费用');
  const inheritedPatch = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${createdUser.id}/policy`, adminCookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: 5000, personalConcurrency: 0, concurrencyMode: 'fixed', paused: false, expectedVersion: 1 }),
  }), { params: Promise.resolve({ id: createdUser.id }) });
  assert.equal(inheritedPatch.status, 200);
  const inheritedPatchBody = await inheritedPatch.json();
  assert.equal(inheritedPatchBody.effectiveConcurrency, 0, '显式零上限不等于暂停');
  const restoreInheritance = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${createdUser.id}/policy`, adminCookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: 5000, personalConcurrency: 0, concurrencyMode: 'inherit', paused: false, expectedVersion: 2 }),
  }), { params: Promise.resolve({ id: createdUser.id }) });
  assert.equal(restoreInheritance.status, 200);
  const restoreInheritanceBody = await restoreInheritance.json();
  assert.equal(restoreInheritanceBody.effectiveConcurrency, 3);
  assert.equal(restoreInheritanceBody.monthlyLimitMinor, 5000, '恢复继承不能改动费用');
  assert.equal(restoreInheritanceBody.paused, false);
  const inheritedFixed = await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${createdUser.id}/policy`, adminCookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: 5000, personalConcurrency: 1, concurrencyMode: 'fixed', paused: true, expectedVersion: 3, allowedModels: ['model-only'] }),
  }), { params: Promise.resolve({ id: createdUser.id }) });
  const inheritedFixedBody = await inheritedFixed.json();
  assert.equal(inheritedFixedBody.concurrencySource, 'personal_fixed');
  assert.equal(inheritedFixedBody.paused, true, '个人并发 1 与显式暂停分别保存');
  assert.deepEqual(inheritedFixedBody.allowedModels, ['model-only'], '覆盖保存不得改动模型权限');
  await policyRoute.PATCH(request(`https://studio.example.test/api/team/members/${createdUser.id}/policy`, adminCookie, {
    method: 'PATCH', ...json({ monthlyLimitMinor: 5000, personalConcurrency: 0, concurrencyMode: 'inherit', paused: false, expectedVersion: 4, allowedModels: ['model-only'] }),
  }), { params: Promise.resolve({ id: createdUser.id }) });
  const inheritedMembers = await membersRoute.GET(request('https://studio.example.test/api/team/members?search=0003', adminCookie));
  const inheritedMember = (await inheritedMembers.json()).items[0];
  assert.equal(inheritedMember.concurrencyLimit, 3, '成员列表必须展示生效团队默认而不是内部存储的 0');
  assert.equal(inheritedMember.concurrencySource, 'team_default');
  assert.equal(inheritedMember.concurrencyMode, 'inherit');
  assert.equal(inheritedMember.paused, false, '恢复继承不得静默解除暂停');
  assert.deepEqual(inheritedMember.allowedModels, ['model-only']);
  assert.deepEqual((await concurrencyRoute.GET(request(teamConcurrencyUrl, adminCookie)).then(response => response.json())), { mode: 'manual', manualDefaultConcurrency: 3, version: 2 });

  const policyUrl = `https://studio.example.test/api/team/members/${alice.principal.userId}/policy`;
  const policyContext = { params: Promise.resolve({ id: alice.principal.userId }) };
  const modelPolicy = { monthlyLimitMinor: 12345, personalConcurrency: 2, paused: false, expectedVersion: 2, allowedModels: ['image2-medium'] };
  const forbiddenModels = await policyRoute.PATCH(request(policyUrl, alice.cookie, { method: 'PATCH', ...json(modelPolicy) }), policyContext);
  assert.equal(forbiddenModels.status, 403);
  const invalidModels = await policyRoute.PATCH(request(policyUrl, adminCookie, { method: 'PATCH', ...json({ ...modelPolicy, allowedModels: [1] }) }), policyContext);
  assert.equal(invalidModels.status, 400);
  const modelPatch = await policyRoute.PATCH(request(policyUrl, adminCookie, { method: 'PATCH', ...json(modelPolicy) }), policyContext);
  assert.equal(modelPatch.status, 200, await modelPatch.clone().text());
  assert.deepEqual((await modelPatch.json()).allowedModels, ['image2-medium']);
  const modelRead = await policyRoute.GET(request(policyUrl, adminCookie), policyContext);
  assert.deepEqual((await modelRead.json()).allowedModels, ['image2-medium']);
  const stalePatch = await policyRoute.PATCH(request(policyUrl, adminCookie, { method: 'PATCH', ...json({ ...modelPolicy, allowedModels: null }) }), policyContext);
  assert.equal(stalePatch.status, 409);
  assert.ok(memberBody.modelOptions.every((option: Record<string, unknown>) => Object.keys(option).every(key => ['model', 'label', 'category'].includes(key))));

  // One actual admission by another member reproduces the old admin zero-vs-team mismatch.
  const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
  const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
  const { upsertExecutionPool, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
  const identity = { instanceId: 'usage-scope-test', fence: 1 };
  registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-usage-routes' });
  upsertExecutionPool(db, { poolKey: 'scope-test', kind: 'remote', capacity: 2, enabled: true, mappingSnapshot: { test: true }, expectedVersion: 0 });
  updateActorPolicy(db, { actorId: bob.principal.userId, monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 1 });
  const runtime = createExecutionFacade({ db, deploymentId: 'deployment-usage-routes', actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
    journal: { verify: () => ({ valid: true, records: [] }), scan: () => [], appendIntent: () => { throw new Error('no transport'); }, appendReceipt: () => { throw new Error('no transport'); } } });
  await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-usage-routes', signal: new AbortController().signal });
  const operation = runtime.facade.enqueue({ operationKey: 'image/scope-task/submit/1', actor: { userId: bob.principal.userId }, scope: { resourceType: 'project', resourceId: 'scope-fixture' }, module: 'image', taskId: 'scope-task', step: 'submit', inputRevision: '1', businessAttempt: { id: 'scope-business', number: 1 }, inputSnapshot: {}, inputHash: 'scope-hash', continuationKey: 'test', providerSnapshot: { model: 'image-test' }, requiredPools: ['scope-test'], quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 25 }, pricingSnapshot: {} } });
  assert.equal(runtime.facade.admit({ ...identity, operationId: operation.operation.id }).kind, 'admitted');
  runtime.closeNewWork();

  const adminOwn = await usageRoute.GET(request('https://studio.example.test/api/team/usage', adminCookie));
  const adminOwnBody = await adminOwn.json();
  assert.equal(adminOwnBody.scope, 'self');
  assert.equal(adminOwnBody.items.length, 0);
  assert.equal(adminOwnBody.totals.estimatedMinor, 0);
  assert.equal(adminOwnBody.canViewTeam, true);
  assert.equal(adminOwnBody.member.userId, admin.userId);
  const adminTeam = await usageRoute.GET(request('https://studio.example.test/api/team/usage?scope=team', adminCookie));
  const teamBody = await adminTeam.json();
  assert.equal(teamBody.scope, 'team');
  assert.equal(teamBody.items.length, 1);
  assert.equal(teamBody.items[0].actorUserId, bob.principal.userId);
  assert.equal(teamBody.totals.estimatedMinor, 25);
  assert.equal(teamBody.teamQuota.chargedMinor, 25);
  assert.equal(teamBody.teamQuota.heldMinor, 25);
  assert.equal(teamBody.teamQuota.accountingPeriod, '2026-11');
  assert.equal(teamBody.models[0].model, 'image-test');
  assert.equal(teamBody.models[0].chargedMinor, 25);
  assert.equal(teamBody.trend.reduce((sum: number, point: { chargedMinor: number }) => sum + point.chargedMinor, 0), 25);
  assert.equal(teamBody.members.find((member: { userId: string }) => member.userId === bob.principal.userId).rangeChargedMinor, 25);
  const drilldown = await usageRoute.GET(request(`https://studio.example.test/api/team/usage?period=month&scope=team&actorUserId=${bob.principal.userId}`, adminCookie));
  const drilldownBody = await drilldown.json();
  assert.equal(drilldownBody.items.length, 1);
  assert.equal(drilldownBody.member.userId, bob.principal.userId);
  assert.equal(drilldownBody.models[0].callCount, 1);
  const teamToday = await usageRoute.GET(request('https://studio.example.test/api/team/usage?period=today&scope=team', adminCookie));
  assert.equal((await teamToday.json()).teamQuota.chargedMinor, 25, '团队额度不随分析日期筛选变化');
  const employeeTeam = await usageRoute.GET(request('https://studio.example.test/api/team/usage?scope=team', alice.cookie));
  const employeeTeamBody = await employeeTeam.json();
  assert.equal(employeeTeamBody.scope, 'self');
  assert.equal(employeeTeamBody.items.length, 0);
  assert.equal(employeeTeamBody.teamQuota, null);
  assert.deepEqual(employeeTeamBody.members, []);

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
