/**
 * 04 号票：管理员一键查看用户视角。
 *
 * 关键约束（规格「范围及角色」）：
 * - 切换只改展示，会话与权限不变，内容仍归管理员本人账号；
 * - 员工没有切换入口，直接调用接口被拒绝；
 * - 员工即使手工写视角 Cookie，也不会因此获得管理能力。
 */
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-view-as-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-view-as',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const {
  VIEW_AS_USER_COOKIE, resolveViewMode, effectiveWorkspaceRole, viewAsUserCookie,
} = await import('../lib/team-service/view-as-user.ts');

// ---- 纯函数 ----
assert.equal(resolveViewMode('admin', '1'), 'user');
assert.equal(resolveViewMode('admin', null), 'admin');
assert.equal(resolveViewMode('employee', '1'), 'admin', '员工写视角 Cookie 也不生效');
assert.equal(effectiveWorkspaceRole('admin', 'user'), 'employee');
assert.equal(effectiveWorkspaceRole('admin', 'admin'), 'admin');
assert.equal(effectiveWorkspaceRole('employee', 'admin'), 'employee');
assert.match(viewAsUserCookie(true), new RegExp(`${VIEW_AS_USER_COOKIE}=1`));
assert.match(viewAsUserCookie(false), /Max-Age=0/);

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-view-as', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-view-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-view-password' });
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];
const created = await service.createUser(adminSession.principal, { employeeId: '0001', displayName: '员工', role: 'employee' });
const employeeLogin = await service.login({ employeeId: '0001', password: created.credential });
await service.changeOwnPassword(employeeLogin.principal, created.credential, 'employee-view-password');
const employeeSession = await service.login({ employeeId: '0001', password: 'employee-view-password' });
const employeeCookie = sessionCookie(employeeSession.token).split(';', 1)[0];

const route = await import('../app/api/team/auth/view-as/route.ts');
const sessionRoute = await import('../app/api/team/auth/session/route.ts');

function post(cookie: string, body: unknown) {
  return route.POST(new Request('https://studio.example.test/api/team/auth/view-as', {
    method: 'POST',
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', 'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

// ---- 管理员进入用户视角：会话不变 ----
const enter = await post(adminCookie, { active: true });
assert.equal(enter.status, 200);
const setCookie = enter.headers.get('set-cookie') ?? '';
assert.match(setCookie, new RegExp(`${VIEW_AS_USER_COOKIE}=1`), '进入用户视角写 Cookie');
assert.equal((await enter.json() as { viewMode: string }).viewMode, 'user');
const sessionInUserView = await sessionRoute.GET(new Request('https://studio.example.test/api/team/auth/session', {
  headers: { Cookie: `${adminCookie}; ${VIEW_AS_USER_COOKIE}=1` },
}));
const sessionBody = await sessionInUserView.json() as { user: { role: string; employeeId: string }; viewMode: string };
assert.equal(sessionBody.user.role, 'admin', '用户视角里服务端身份仍是管理员');
assert.equal(sessionBody.user.employeeId, '0000');
assert.equal(sessionBody.viewMode, 'user', '会话接口如实报告当前视角');

// ---- 返回管理界面 ----
const leave = await post(adminCookie, { active: false });
assert.equal(leave.status, 200);
assert.match(leave.headers.get('set-cookie') ?? '', /Max-Age=0/);
assert.equal((await leave.json() as { viewMode: string }).viewMode, 'admin');

// ---- 员工：接口被拒绝，写 Cookie 也拿不到管理能力 ----
const employeeAttempt = await post(employeeCookie, { active: true });
assert.equal(employeeAttempt.status, 403, '员工不能切换用户视角');
const employeeSessionWithCookie = await sessionRoute.GET(new Request('https://studio.example.test/api/team/auth/session', {
  headers: { Cookie: `${employeeCookie}; ${VIEW_AS_USER_COOKIE}=1` },
}));
const employeeBody = await employeeSessionWithCookie.json() as { user: { role: string }; viewMode: string };
assert.equal(employeeBody.user.role, 'employee');
assert.equal(employeeBody.viewMode, 'admin', '员工写视角 Cookie 时视角仍按管理端（即无切换）解析');

// ---- 没有会话时不能切换 ----
const anonymous = await route.POST(new Request('https://studio.example.test/api/team/auth/view-as', {
  method: 'POST',
  headers: {
    Cookie: '__Host-team_csrf=csrf', Origin: 'https://studio.example.test',
    'x-csrf-token': 'csrf', 'content-type': 'application/json',
  },
  body: JSON.stringify({ active: true }),
}));
assert.equal(anonymous.status, 401);

// ---- 路由已在团队策略里分类，且不会被当成资源写 ----
const { teamRoutePolicy } = await import('../lib/team-service/route-policy.ts');
const policy = teamRoutePolicy('/api/team/auth/view-as', 'POST');
assert.equal(policy.category, 'authenticated');
assert.equal(policy.csrf, true);

await closeDb();
fs.rmSync(root, { recursive: true, force: true });
console.log('team view-as-user tests passed');
