import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import module from 'node:module';
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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-auth-route-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
process.env.CREATIVE_STUDIO_PORT = '3300';
process.env.CREATIVE_STUDIO_DEPLOYMENT_ID = 'deployment-auth-route';
process.env.CREATIVE_STUDIO_TRUSTED_ORIGIN = 'https://studio.example.test';

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: fixtureRoot, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-auth-route', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
const readiness = await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) });
assert.equal(readiness.available, true);
const passwordParams = { N: 1024, r: 8, p: 1 };
const kdf = new BoundedKdfScheduler({ maxConcurrent: 2, maxQueue: 32 });
const initialized = await initializeFirstAdministrator({
  db, employeeId: '00001', displayName: '首管理员', kdf, passwordParams,
});
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);

const { sessionCookie: issueSessionCookie } = await import('../lib/team-service/auth/request.ts');
const fixedNow = Date.now;
try {
  Date.now = () => Date.parse('2026-11-06T08:00:00.000Z');
  assert.match(issueSessionCookie('opaque-token', true), /Expires=Sun, 06 Dec 2026 08:00:00 GMT/i, '持久 Cookie 必须从本次认证起固定 30 天到期');
  assert.doesNotMatch(issueSessionCookie('opaque-token', false), /Max-Age|Expires/i);
} finally { Date.now = fixedNow; }
const { GET: csrfGET } = await import('../app/api/team/auth/csrf/route.ts');
const { POST: loginPOST } = await import('../app/api/team/auth/login/route.ts');
const { GET: sessionGET } = await import('../app/api/team/auth/session/route.ts');
const { POST: changePasswordPOST } = await import('../app/api/team/auth/change-password/route.ts');
const { POST: logoutPOST } = await import('../app/api/team/auth/logout/route.ts');
const { GET: usersGET, POST: usersPOST } = await import('../app/api/team/users/route.ts');
const { PATCH: userPATCH } = await import('../app/api/team/users/[id]/route.ts');
const { POST: resetPOST } = await import('../app/api/team/users/[id]/reset-credential/route.ts');

const endpoint = (pathname: string) => `https://studio.example.test${pathname}`;
const cookiePair = (setCookie: string | null) => {
  assert.ok(setCookie);
  return setCookie.split(';', 1)[0];
};

async function bootstrapCsrf() {
  const response = await csrfGET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie ?? '', /__Host-team_csrf=/);
  assert.match(setCookie ?? '', /HttpOnly/i);
  assert.match(setCookie ?? '', /Secure/i);
  assert.match(setCookie ?? '', /SameSite=Strict/i);
  assert.match(setCookie ?? '', /Path=\//i);
  const body = await response.json();
  assert.match(body.csrfToken, /^[A-Za-z0-9_-]{40,}$/);
  return { token: body.csrfToken as string, cookie: cookiePair(setCookie) };
}

function writeRequest(pathname: string, body: unknown, options: {
  cookie?: string;
  csrf?: string;
  origin?: string | null;
} = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('x-csrf-token', options.csrf);
  if (options.origin !== null) headers.set('Origin', options.origin ?? 'https://studio.example.test');
  return new Request(endpoint(pathname), { method: 'POST', headers, body: JSON.stringify(body) });
}

async function loginWithCsrf(employeeId: string, password: string, remember = true) {
  const csrf = await bootstrapCsrf();
  const response = await loginPOST(writeRequest('/api/team/auth/login', { employeeId, password, remember }, {
    cookie: csrf.cookie, csrf: csrf.token,
  }));
  const sessionCookie = response.headers.get('set-cookie')
    ? cookiePair(response.headers.get('set-cookie'))
    : '';
  return {
    response,
    body: await response.json(),
    csrf,
    sessionCookie,
    cookie: sessionCookie ? `${csrf.cookie}; ${sessionCookie}` : csrf.cookie,
  };
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

try {
  const csrf = await bootstrapCsrf();
  for (const request of [
    writeRequest('/api/team/auth/login', { employeeId: '00001', password: initialized.credential }, { cookie: csrf.cookie, csrf: csrf.token, origin: null }),
    writeRequest('/api/team/auth/login', { employeeId: '00001', password: initialized.credential }, { cookie: csrf.cookie, csrf: csrf.token, origin: 'https://attacker.example' }),
    writeRequest('/api/team/auth/login', { employeeId: '00001', password: initialized.credential }, { cookie: csrf.cookie }),
    writeRequest('/api/team/auth/login', { employeeId: '00001', password: initialized.credential }, { cookie: csrf.cookie, csrf: 'wrong-token' }),
  ]) {
    const response = await loginPOST(request);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }

  const publicClaim = await usersPOST(writeRequest('/api/team/users', {
    employeeId: '00009', displayName: '公共认领', role: 'admin',
  }, { cookie: csrf.cookie, csrf: csrf.token }));
  assert.equal(publicClaim.status, 401, '首管理员只能由本机 CLI 初始化');

  const admin = await loginWithCsrf('00001', initialized.credential);
  assert.equal(admin.response.status, 200);
  assert.equal(admin.body.user.employeeId, '00001');
  assert.equal(admin.body.mustChangePassword, true);
  assert.equal(JSON.stringify(admin.body).includes(initialized.credential), false);
  assert.equal(JSON.stringify(admin.body).includes(admin.sessionCookie), false);
  const sessionSetCookie = admin.response.headers.get('set-cookie') ?? '';
  assert.match(sessionSetCookie, /__Host-team_session=/);
  assert.match(sessionSetCookie, /Max-Age=2592000/i);
  assert.match(sessionSetCookie, /HttpOnly/i);
  assert.match(sessionSetCookie, /Secure/i);
  assert.match(sessionSetCookie, /SameSite=Strict/i);
  assert.match(sessionSetCookie, /Path=\//i);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM team_sessions').all()).includes(admin.sessionCookie.split('=', 2)[1]), false);
  let response = await usersGET(new Request(endpoint('/api/team/users'), { headers: { Cookie: admin.cookie } }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'password_change_required');

  // Electron's background transfer/diagnostic session shares the renderer Cookie jar.
  // Its CSRF bootstrap must not invalidate the login page's already-cached token.
  const backgroundCsrf = await csrfGET(new Request(endpoint('/api/team/auth/csrf'), {
    headers: { Cookie: admin.cookie },
  }));
  assert.equal(backgroundCsrf.status, 200);
  const backgroundCookie = cookiePair(backgroundCsrf.headers.get('set-cookie'));
  assert.equal((await backgroundCsrf.json()).csrfToken, admin.csrf.token);
  for (const invalidToken of ['short', 'x'.repeat(44), '!'.repeat(43)]) {
    const replaced = await csrfGET(new Request(endpoint('/api/team/auth/csrf'), {
      headers: { Cookie: `__Host-team_csrf=${invalidToken}` },
    }));
    const replacement = (await replaced.json()).csrfToken;
    assert.match(replacement, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(replacement, invalidToken, '畸形 Cookie 必须重新签发');
  }
  response = await changePasswordPOST(writeRequest('/api/team/auth/change-password', {
    newPassword: 'admin-route-password',
  }, { cookie: `${backgroundCookie}; ${admin.sessionCookie}`, csrf: admin.csrf.token }));
  assert.equal(response.status, 200, '后台获取 CSRF 后，首次登录页面缓存的令牌仍须能完成改密');
  assert.equal((await response.json()).requiresReauthentication, true);
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  response = await sessionGET(new Request(endpoint('/api/team/auth/session'), { headers: { Cookie: admin.cookie } }));
  assert.equal((await response.json()).authenticated, false);
  const adminAfterPasswordChange = await loginWithCsrf('00001', 'admin-route-password');
  admin.cookie = adminAfterPasswordChange.cookie;
  admin.csrf = adminAfterPasswordChange.csrf;
  response = await sessionGET(new Request(endpoint('/api/team/auth/session'), { headers: { Cookie: admin.cookie } }));
  assert.equal((await response.json()).authenticated, true);

  response = await changePasswordPOST(writeRequest('/api/team/auth/change-password', {
    newPassword: 'must-not-change-without-current', mustChangePassword: true,
  }, { cookie: admin.cookie, csrf: admin.csrf.token }));
  assert.equal(response.status, 401, '普通改密不能靠请求体绕过当前密码');
  response = await changePasswordPOST(writeRequest('/api/team/auth/change-password', {
    newPassword: 'must-not-change-without-session',
  }, { cookie: csrf.cookie, csrf: csrf.token }));
  assert.equal(response.status, 401, '无会话不能设置新密码');

  const createdCredentials = new Map<string, string>();
  for (const [employeeId, displayName] of [['00123', '员工甲'], ['00124', '员工乙']] as const) {
    response = await usersPOST(writeRequest('/api/team/users', { employeeId, displayName, role: 'employee' }, {
      cookie: admin.cookie, csrf: admin.csrf.token,
    }));
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.user.employeeId, employeeId);
    assert.ok(created.credential);
    assert.equal('passwordHash' in created.user, false);
    createdCredentials.set(employeeId, created.credential);
  }

  response = await usersGET(new Request(endpoint('/api/team/users'), { headers: { Cookie: admin.cookie } }));
  const users = (await response.json()).users;
  assert.equal(users.length, 3);
  response = await usersPOST(writeRequest('/api/team/users', { employeeId: '00125', displayName: '仅会话', role: 'employee' }, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }));
  assert.equal(response.status, 201);
  const sessionOnlyCredential = (await response.json()).credential;
  const sessionOnlyLogin = await loginWithCsrf('00125', sessionOnlyCredential, false);
  assert.equal(sessionOnlyLogin.response.status, 200);
  assert.doesNotMatch(sessionOnlyLogin.response.headers.get('set-cookie') ?? '', /Max-Age|Expires/i, '未勾选记住时只能建立当前浏览器会话 Cookie');
  assert.equal(JSON.stringify(users).includes('passwordHash'), false);
  assert.equal(JSON.stringify(users).includes(initialized.credential), false);

  const employee = await loginWithCsrf('00123', createdCredentials.get('00123')!);
  response = await changePasswordPOST(writeRequest('/api/team/auth/change-password', {
    currentPassword: createdCredentials.get('00123')!, newPassword: 'employee-route-password',
  }, { cookie: employee.cookie, csrf: employee.csrf.token }));
  assert.equal(response.status, 200);
  const employeeAfterPasswordChange = await loginWithCsrf('00123', 'employee-route-password');
  employee.cookie = employeeAfterPasswordChange.cookie;
  employee.csrf = employeeAfterPasswordChange.csrf;

  for (const denied of [
    () => usersGET(new Request(endpoint('/api/team/users'), { headers: { Cookie: employee.cookie } })),
    () => usersPOST(writeRequest('/api/team/users', { employeeId: '00999', displayName: '越权', role: 'employee' }, { cookie: employee.cookie, csrf: employee.csrf.token })),
    () => userPATCH(writeRequest('/api/team/users/ignored', { role: 'admin' }, { cookie: employee.cookie, csrf: employee.csrf.token }), params('ignored')),
    () => resetPOST(writeRequest('/api/team/users/ignored/reset-credential', {}, { cookie: employee.cookie, csrf: employee.csrf.token }), params('ignored')),
  ]) {
    const deniedResponse = await denied();
    assert.equal(deniedResponse.status, 403);
    assert.equal((await deniedResponse.json()).error, 'admin_required');
  }

  response = await userPATCH(writeRequest('/api/team/users/ignored', { role: 'admin' }, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }), params(employee.body.user.id));
  assert.equal(response.status, 200);
  response = await sessionGET(new Request(endpoint('/api/team/auth/session'), { headers: { Cookie: employee.cookie } }));
  assert.equal((await response.json()).user.role, 'admin');
  await userPATCH(writeRequest('/api/team/users/ignored', { role: 'employee' }, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }), params(employee.body.user.id));

  response = await resetPOST(writeRequest('/api/team/users/ignored/reset-credential', {}, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }), params(employee.body.user.id));
  assert.equal(response.status, 200);
  const reset = await response.json();
  assert.ok(reset.credential);
  response = await sessionGET(new Request(endpoint('/api/team/auth/session'), { headers: { Cookie: employee.cookie } }));
  assert.equal((await response.json()).authenticated, false);
  const oldCredentialLogin = await loginWithCsrf('00123', createdCredentials.get('00123')!);
  assert.equal(oldCredentialLogin.response.status, 401);
  const resetLogin = await loginWithCsrf('00123', reset.credential);
  assert.equal(resetLogin.response.status, 200);
  assert.equal(resetLogin.body.mustChangePassword, true);

  const secondEmployee = await loginWithCsrf('00124', createdCredentials.get('00124')!);
  response = await userPATCH(writeRequest('/api/team/users/ignored', { status: 'disabled' }, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }), params(secondEmployee.body.user.id));
  assert.equal(response.status, 200);
  response = await sessionGET(new Request(endpoint('/api/team/auth/session'), { headers: { Cookie: secondEmployee.cookie } }));
  assert.equal((await response.json()).authenticated, false);

  response = await userPATCH(writeRequest('/api/team/users/ignored', { role: 'employee' }, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }), params(admin.body.user.id));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'last_admin_required');

  response = await logoutPOST(writeRequest('/api/team/auth/logout', {}, {
    cookie: admin.cookie, csrf: admin.csrf.token,
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  response = await sessionGET(new Request(endpoint('/api/team/auth/session'), { headers: { Cookie: admin.cookie } }));
  assert.equal((await response.json()).authenticated, false);
  const logoutSource = readFileSync(new URL('../app/api/team/auth/logout/route.ts', import.meta.url), 'utf8');
  assert.equal(logoutSource.includes('/api/shutdown'), false);
  assert.equal(logoutSource.includes('gracefulShutdown'), false);
  const shutdownSource = readFileSync(new URL('../app/api/shutdown/route.ts', import.meta.url), 'utf8');
  assert.equal(shutdownSource.includes('readRuntimeConfig'), true, 'server 必须拒绝公共 shutdown');
  assert.equal(shutdownSource.includes("mode !== 'server'"), false);
  const { POST: shutdownPOST } = await import('../app/api/shutdown/route.ts');
  assert.equal((await shutdownPOST()).status, 404);

  console.log('team auth route tests passed');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
