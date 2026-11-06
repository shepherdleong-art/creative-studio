import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 首启验收：空数据根 → 正式本机初始化 CLI → 正式 HTTP 路由配置供应商/资源池/账号 → 可准入。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-first-run-'));
const origin = 'https://studio.example.test';
const deploymentId = 'deployment-first-run';
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
  CREATIVE_STUDIO_TRUSTED_ORIGIN: origin,
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'first-run-test',
  CREATIVE_STUDIO_MODULE_BATCH: '1',
  CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO: '1',
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { getTeamAuthService } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const { readPoolAdminState } = await import('../lib/team-service/pools.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const providersRoute = await import('../app/api/providers/route.ts');
const poolsRoute = await import('../app/api/team/pools/route.ts');
const usersRoute = await import('../app/api/team/users/route.ts');
const membersRoute = await import('../app/api/team/members/route.ts');
const memberPolicyRoute = await import('../app/api/team/members/[id]/policy/route.ts');
const projectsRoute = await import('../app/api/projects/route.ts');
const projectRoute = await import('../app/api/projects/[id]/route.ts');

function request(method: string, pathname: string, cookie: string, body?: unknown) {
  return new Request(`${origin}${pathname}`, {
    method,
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`,
      Origin: origin,
      'x-csrf-token': 'csrf',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookieOf(token: string) {
  return sessionCookie(token).split(';', 1)[0];
}
function parseCredential(stdout: string): string {
  const match = /一次性凭据（仅显示本次）：(\S+)/.exec(stdout);
  assert.ok(match, `首管理员初始化必须输出一次性凭据：${stdout}`);
  return match[1];
}

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId, trustedOrigin: origin,
});
const database = getDb();
try {
  // 空根：团队/执行结构就绪，但没有任何池与供应商配置。
  assert.equal((await checkExecutionReadiness({ db: database, ...schemaUpgradeRuntimePaths(root) })).available, true);
  const emptyState = readPoolAdminState(database, { userId: 'none', role: 'admin' });
  assert.equal(emptyState.pools.length, 0);
  assert.equal(emptyState.bindings.length, 0);

  const init = spawnSync(process.execPath, [
    'scripts/team-server/init-admin.mjs', '--employee-id', 'first-admin', '--name', '首启管理员',
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.equal(init.status, 0, init.stderr);
  const credential = parseCredential(init.stdout);

  const auth = getTeamAuthService();
  const adminLogin = await auth.login({ employeeId: 'first-admin', password: credential });
  await assert.rejects(
    () => auth.login({ employeeId: 'first-admin', password: credential }),
    (error: unknown) => (error as { code?: string }).code === 'credential_consumed',
    '一次性凭据重复使用必须被拒绝',
  );
  const admin = await auth.changeOwnPassword(adminLogin.principal, credential, 'first-run-admin-password');
  assert.equal(admin.mustChangePassword, false);
  const adminCookie = cookieOf((await auth.login({ employeeId: 'first-admin', password: 'first-run-admin-password' })).token);

  // 供应商通过正式 POST 入口创建，响应不回显密钥。
  const providerResponse = await providersRoute.POST(request('POST', '/api/providers', adminCookie, {
    name: '隔离图片供应商',
    baseUrl: 'https://media.invalid.test/v1',
    apiKey: 'fixture-key-not-real-0001',
    model: 'gpt-image-2',
    type: 'openai-compatible',
  }));
  assert.equal(providerResponse.status, 200, await providerResponse.clone().text());
  const providerText = await providerResponse.text();
  assert.equal(providerText.includes('fixture-key-not-real-0001'), false, '供应商响应不得回显密钥');
  const provider = JSON.parse(providerText) as { id: string; configured: boolean };
  assert.equal(provider.configured, true);

  // 新员工默认零额度；管理员通过正式成员策略入口授权。
  const createdEmployee = await usersRoute.POST(request('POST', '/api/team/users', adminCookie, {
    employeeId: 'first-employee', displayName: '首启员工', role: 'employee',
  }));
  assert.equal(createdEmployee.status, 201, await createdEmployee.clone().text());
  const employeeRecord = await createdEmployee.json() as { user: { id: string }; credential: string };
  const employeeLogin = await auth.login({ employeeId: 'first-employee', password: employeeRecord.credential });
  const employee = await auth.changeOwnPassword(employeeLogin.principal, employeeRecord.credential, 'first-run-employee-password');
  const employeeCookie = cookieOf((await auth.login({ employeeId: 'first-employee', password: 'first-run-employee-password' })).token);
  const policy = await memberPolicyRoute.GET(
    request('GET', `/api/team/members/${employee.userId}/policy`, adminCookie),
    { params: Promise.resolve({ id: employee.userId }) },
  );
  assert.equal(policy.status, 200);
  const policyBody = await policy.json() as { monthlyLimitMinor: number | null; personalConcurrency: number };
  assert.equal(policyBody.monthlyLimitMinor, 0, '新账号默认零额度');
  assert.equal(policyBody.personalConcurrency, 0, '新账号默认零并发');
  const granted = await memberPolicyRoute.PATCH(
    request('PATCH', `/api/team/members/${employee.userId}/policy`, adminCookie, {
      monthlyLimitMinor: 100000, personalConcurrency: 1, paused: false, expectedVersion: 0,
    }),
    { params: Promise.resolve({ id: employee.userId }) },
  );
  assert.equal(granted.status, 200, await granted.clone().text());

  // 管理员可创建项目；项目池未配置前业务池状态明确阻塞。
  const projectResponse = await projectsRoute.POST(request('POST', '/api/projects', adminCookie, {
    storeCode: 'B店',
    productCode: 'FR-001',
    productionType: '新品种草',
    editorName: '首启管理员',
    providerId: provider.id,
    aspectRatio: '1:1',
    resolution: '1k',
  }));
  assert.equal(projectResponse.status, 200, await projectResponse.clone().text());
  const project = await projectResponse.json() as { id: string };
  assert.ok(project.id);

  const beforePool = readPoolAdminState(database, { userId: admin.userId, role: 'admin' });
  assert.equal(beforePool.ready, false, '仅有供应商仍缺少资源池，不得放行生产');

  const employeePools = await poolsRoute.POST(request('POST', '/api/team/pools', employeeCookie, {
    changes: [{ action: 'bind-media-upstream', entityType: 'image', entityId: provider.id, poolKey: 'media:shared', capacity: 1, expectedVersion: 0 }],
  }));
  assert.equal(employeePools.status, 403, '员工不得配置资源池');
  const employeeProject = await projectRoute.GET(
    request('GET', `/api/projects/${project.id}`, employeeCookie),
    { params: Promise.resolve({ id: project.id }) },
  );
  assert.ok([403, 404].includes(employeeProject.status), '未授权员工不得读取他人项目');

  const unknownPool = await poolsRoute.POST(request('POST', '/api/team/pools', adminCookie, {
    changes: [{ action: 'bind-media-upstream', entityType: 'image', entityId: 'missing-provider', poolKey: 'media:shared', capacity: 1, expectedVersion: 0 }],
  }));
  assert.equal(unknownPool.status, 404, '误配池必须给出明确供应商不存在原因');

  const preview = await poolsRoute.POST(request('POST', '/api/team/pools', adminCookie, {
    preview: true,
    changes: [{ action: 'bind-media-upstream', entityType: 'image', entityId: provider.id, poolKey: 'media:shared', capacity: 2, expectedVersion: 0 }],
  }));
  assert.equal(preview.status, 200);
  assert.equal(readPoolAdminState(database, { userId: admin.userId, role: 'admin' }).pools.length, 0, '预览不得落库');

  const applied = await poolsRoute.POST(request('POST', '/api/team/pools', adminCookie, {
    changes: [{ action: 'bind-media-upstream', entityType: 'image', entityId: provider.id, poolKey: 'media:shared', capacity: 2, expectedVersion: 0 }],
  }));
  assert.equal(applied.status, 200, await applied.clone().text());
  const ready = readPoolAdminState(database, { userId: admin.userId, role: 'admin' });
  assert.equal(ready.bindings.some((binding) => binding.poolKey === 'media:shared'), true);
  const imageRequirement = ready.requirements.find((item) => item.key === `image:${provider.id}`);
  assert.equal(imageRequirement?.status, 'ready', '已配置的图片供应商必须可准入');
  // 种子内置的公司供应商仍未配置凭据/池；它们必须保持显式阻塞，不能被本轮绕过。
  assert.ok(
    ready.blockers.some((blocker) => blocker.includes('资源池') && blocker.includes('尚未配置')),
    '未配置池的供应商必须给出可操作原因',
  );

  // 成员列表入口可用于双人边界核对，不依赖直插业务表。
  const members = await membersRoute.GET(request('GET', '/api/team/members', adminCookie));
  assert.equal(members.status, 200);
  const memberList = await members.json() as { items: Array<{ employeeId: string }> };
  assert.deepEqual(memberList.items.map((item) => item.employeeId).sort(), ['first-admin', 'first-employee']);

  console.log('team first-run acceptance passed');
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
