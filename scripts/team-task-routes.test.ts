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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-task-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3288',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-task-routes',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-release-task-routes',
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

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3288,
  deploymentId: 'deployment-task-routes', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
const paths = schemaUpgradeRuntimePaths(root);
assert.equal((await checkTeamServiceReadiness({ db, ...paths })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...paths })).available, true);

const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const admin = await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-task-routes-password');
const adminCookie = sessionCookie(adminLogin.token).split(';', 1)[0];

async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(admin, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  const principal = await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-task-routes-password`);
  return { principal, cookie: sessionCookie(login.token).split(';', 1)[0] };
}
const sameA = await account('0001', '李四');
const sameB = await account('0002', '李四');
const low = await account('0003', '低频成员');
const disabled = await account('0004', '已停用成员');
const other = await account('0005', '旁观成员');

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled) VALUES ('p', 'p', 'http://127.0.0.1:9', 'k', 'm', 'openai-compatible', 1)").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-routes', '路由测试项目', 'p', 'm', 'prompt')").run();

let sequence = 0;
function operation(actorId: string, at: string, status = 'succeeded', waitReason: string | null = null): string {
  sequence += 1;
  const id = `op-${String(sequence).padStart(5, '0')}`;
  db.prepare(`
    INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, waitReason, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', 'project-routes', 'image', ?, 'submit', 'r1', ?, 1, 'h', '{}', 'image.submit', '{}', '[]', '{}', ?, ?, ?, ?, ?)
  `).run(id, `key-${id}`, actorId, `task-${id}`, `business-${id}`, status, sequence, waitReason, at, at);
  return id;
}

const route = await import('../app/api/team/tasks/route.ts');

function request(url: string, cookie: string): Request {
  const headers = new Headers();
  headers.set('Cookie', `${cookie}; __Host-team_csrf=csrf-test`);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  return new Request(url, { headers });
}

try {
  // 低频成员的历史任务远早于后来制造的 500+ 条较新任务。
  const lowId = operation(low.principal.userId, '2026-01-01T00:00:00.000Z');
  for (let index = 0; index < 520; index += 1) {
    operation(sameA.principal.userId, new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString());
  }
  operation(sameB.principal.userId, '2026-10-02T00:00:00.000Z', 'failed');
  const disabledWaiting = operation(disabled.principal.userId, '2026-10-03T00:00:00.000Z', 'deferred', 'actor_disabled');
  const canceled = operation(sameB.principal.userId, '2026-10-04T00:00:00.000Z', 'pending', 'stage_canceled');

  // — 默认查询：上限与截断口径显式可见 —
  const defaultResponse = await route.GET(request('https://studio.example.test/api/team/tasks', adminCookie));
  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultResponse.headers.get('cache-control'), 'no-store');
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultBody.items.length, 500);
  assert.equal(defaultBody.limit, 500, '响应必须显式给出最近记录上限');
  assert.equal(defaultBody.truncated, true, '命中上限必须声明截断');
  assert.equal(defaultBody.totalMatching, null);
  assert.ok(Array.isArray(defaultBody.actors), '响应必须带成员筛选选项');

  // — 成员选项不来自最近 500 条结果 —
  const actorIds = defaultBody.actors.map((option: { actorUserId: string }) => option.actorUserId);
  assert.ok(actorIds.includes(low.principal.userId), '低频成员必须在成员选项里');
  assert.ok(actorIds.includes(disabled.principal.userId), '历史停用成员也必须在成员选项里');
  assert.equal(defaultBody.actors.filter((option: { displayName: string }) => option.displayName === '李四').length, 2,
    '两位同名成员是两个选项，不能按姓名合并');

  // — 管理员按成员查询到低频成员 —
  const lowResponse = await route.GET(request(`https://studio.example.test/api/team/tasks?actorUserId=${low.principal.userId}`, adminCookie));
  assert.equal(lowResponse.status, 200);
  const lowBody = await lowResponse.json();
  assert.deepEqual(lowBody.items.map((entry: { operationId: string }) => entry.operationId), [lowId]);
  assert.equal(lowBody.truncated, false, '单成员单条结果不得误标截断');

  // — 同名成员按 ID 筛选互不串台 —
  const sameABody = await (await route.GET(request(`https://studio.example.test/api/team/tasks?actorUserId=${sameA.principal.userId}`, adminCookie))).json();
  const sameBBody = await (await route.GET(request(`https://studio.example.test/api/team/tasks?actorUserId=${sameB.principal.userId}`, adminCookie))).json();
  assert.ok(sameABody.items.every((entry: { actorUserId: string }) => entry.actorUserId === sameA.principal.userId));
  assert.ok(sameBBody.items.every((entry: { actorUserId: string }) => entry.actorUserId === sameB.principal.userId));
  assert.equal(sameBBody.items.some((entry: { operationId: string }) => entry.operationId === lowId), false);

  // — 状态过滤与取消语义不回归 —
  const canceledBody = await (await route.GET(request(`https://studio.example.test/api/team/tasks?status=canceled&actorUserId=${sameB.principal.userId}`, adminCookie))).json();
  assert.ok(canceledBody.items.some((entry: { operationId: string }) => entry.operationId === canceled));
  assert.ok(canceledBody.items.every((entry: { status: string }) => entry.status === 'canceled'));
  const deferredBody = await (await route.GET(request('https://studio.example.test/api/team/tasks?status=deferred', adminCookie))).json();
  assert.equal(deferredBody.items.some((entry: { operationId: string }) => entry.operationId === canceled), false,
    'stage_canceled 不得被 deferred 过滤捞回');
  assert.ok(deferredBody.items.some((entry: { operationId: string }) => entry.operationId === disabledWaiting));

  // — 员工篡改 actorUserId 查询他人被拒 —
  const tampered = await route.GET(request(
    `https://studio.example.test/api/team/tasks?actorUserId=${sameA.principal.userId}`, low.cookie,
  ));
  assert.equal(tampered.status, 403, '员工篡改 actorUserId 必须 403');
  const tamperedBody = await tampered.json();
  assert.equal(tamperedBody.error, 'task_query_forbidden');
  assert.equal(JSON.stringify(tamperedBody).includes(sameA.principal.userId), false, '拒绝响应不得回显他人 ID');

  // — 员工默认只看自己，且选项只有自己 —
  const employeeBody = await (await route.GET(request('https://studio.example.test/api/team/tasks', low.cookie))).json();
  assert.deepEqual(employeeBody.items.map((entry: { operationId: string }) => entry.operationId), [lowId]);
  assert.deepEqual(employeeBody.actors.map((option: { actorUserId: string }) => option.actorUserId), [low.principal.userId],
    '员工不得枚举团队名册');

  // — 停用成员本人仍是正当查询者（只读历史） —
  const disabledBody = await (await route.GET(request('https://studio.example.test/api/team/tasks', disabled.cookie))).json();
  assert.ok(disabledBody.items.some((entry: { operationId: string }) => entry.operationId === disabledWaiting));

  // — 无关员工查不到别人的任务 —
  const otherBody = await (await route.GET(request('https://studio.example.test/api/team/tasks', other.cookie))).json();
  assert.deepEqual(otherBody.items, []);
  assert.equal(otherBody.truncated, false);

  console.log('PASS: team tasks route grouping contract — actor options, 500 truncation, same-name, cancel semantics, permissions');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
