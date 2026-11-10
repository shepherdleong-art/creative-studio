// 12 号票：控制台接口级验收。
//
// 断言三件事：
// 1. 数量卡与任务数据一致、最近任务行与全员任务详情一致（点一行能打开那一条）；
// 2. 开工前清单与就绪检查一致（同一份 proxyAvailable / cosConfigured / pools.ready+blockers）；
// 3. 筛选正确、员工看不到全员任务与他人数据、重试只放行明确失败。
//
// 走真实路由（`app/api/team/**` 的 GET/POST）与真实 SQLite，不访问任何供应商。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-console-routes-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-console-routes',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-release-console',
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
const { readPoolAdminState } = await import('../lib/team-service/pools.ts');
const { readConsoleOverview } = await import('../lib/team-service/console-overview.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-console-routes', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-console-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-console-password' });
const admin = adminSession.principal;
async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(admin, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-console-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-console-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}
const alice = await account('0001', '张三');
const bob = await account('0002', '李四');
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];

const overviewRoute = await import('../app/api/team/console/overview/route.ts');
const detailRoute = await import('../app/api/team/tasks/detail/route.ts');
const retryRoute = await import('../app/api/team/tasks/retry/route.ts');
const tasksRoute = await import('../app/api/team/tasks/route.ts');
const poolsRoute = await import('../app/api/team/pools/route.ts');

function request(url: string, cookie: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `${cookie}; __Host-team_csrf=csrf-test`);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-csrf-token', 'csrf-test');
  if (!headers.has('x-creative-studio-client-version')) headers.set('x-creative-studio-client-version', '0.7.1');
  if (!headers.has('x-creative-studio-client-api')) headers.set('x-creative-studio-client-api', '1');
  return new Request(url, { ...init, headers });
}
const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }) satisfies RequestInit;

function nowIso(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

/**
 * 直接插一条执行记录：任务接口只读 `execution_operations`（+ jobs/video_jobs/projects），
 * 这里按同一形状造数据，避免为了造一条历史任务真的去跑队列。
 */
let operationSequence = 0;
function insertOperation(input: {
  id: string; actorUserId: string; status: string; module?: string; taskId?: string;
  scopeId?: string; updatedAt?: string; waitReason?: string;
}) {
  operationSequence += 1;
  const at = input.updatedAt ?? nowIso();
  db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', ?, ?, ?, 'submit', 'r1', ?, 1, 'hash', '{}', 'image.submit', ?, '[]', '{}', ?, ?, ?, ?, ?)`)
    .run(
      input.id, `key-${input.id}`, input.actorUserId, input.scopeId ?? 'project-a',
      input.module ?? 'image', input.taskId ?? input.id,
      `business-${input.id}`, JSON.stringify({ name: '公司网关', model: 'gpt-image-2' }),
      input.status, input.waitReason ?? null, operationSequence, at, at,
    );
}

try {
  db.prepare("INSERT INTO providers (id, name, type, model, baseUrl, apiKey) VALUES ('provider-fixture', '界面验收 fixture 供应商', 'openai-compatible', 'gpt-image-2', 'http://127.0.0.1:9', 'fixture')").run();
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt, status) VALUES ('project-a', '洁面乳详情页', 'provider-fixture', 'gpt-image-2', '', 'draft')").run();
  // 转发的既有重试路由会做资源级授权（图片任务 → project/job 作用域），所以项目要登记归属。
  const { registerRootScope, registerInheritedScope } = await import('../lib/team-service/resource-scopes.ts');
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: alice.principal.userId });

  // ---- 员工不可看运行总览 ----
  for (const [label, cookie] of [['张三', alice.cookie], ['李四', bob.cookie]] as const) {
    const denied = await overviewRoute.GET(request('https://studio.example.test/api/team/console/overview', cookie));
    assert.equal(denied.status, 403, `${label}不得查看运行总览`);
  }

  // ---- 全 0 空状态：还没跑任何东西 ----
  const empty = await overviewRoute.GET(request('https://studio.example.test/api/team/console/overview', adminCookie));
  assert.equal(empty.status, 200, await empty.clone().text());
  const emptyBody = await empty.json();
  assert.equal(emptyBody.empty, true, '没有任务时必须给出全 0 空状态标记');
  assert.deepEqual(emptyBody.counts, { running: 0, queued: 0, completedToday: 0, failed: 0, total: 0 });
  assert.deepEqual(emptyBody.recent, []);
  assert.deepEqual(emptyBody.members, []);
  assert.equal(emptyBody.setup.ready, false, '新环境三件事都没配好');
  assert.equal(emptyBody.setup.items.length, 3);
  // 06 号票的服务器默认参数若已接入，控制台必须读到真实值；未接入时是 null。
  // 两种都不算错，但**绝不能**出现「接入了一半」的半成品形状。
  if (emptyBody.productionDefaults === null) {
    console.log('PASS: 服务器默认值未接入（06 未合并时的预期）');
  } else {
    const defaults = emptyBody.productionDefaults as Record<string, unknown>;
    assert.equal(defaults.concurrencyMode, 'shared-pool', '控制台不得把旧兼容存值显示成单项目并发上限');
    assert.equal(typeof defaults.timeoutMs, 'number');
    assert.equal(typeof defaults.projectConcurrency, 'number');
    assert.ok((defaults.timeoutMs as number) > 0 && (defaults.projectConcurrency as number) > 0);
    console.log('PASS: 服务器默认值已接入且形状完整');
  }
  console.log('PASS: 管理员可读运行总览；空环境给出全 0 空状态与三件待办');

  // ---- 造任务：正在跑 / 排队 / 今天完成 / 出错 / 已取消 ----
  db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path) VALUES ('asset-in', 'project-a', 'input', '产品原图.png', 'storage/asset-in.png')").run();
  const insertJob = db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status)
    VALUES (?, 'project-a', 'asset-in', 'provider-fixture', 'gpt-image-2', '', ?)`);
  insertJob.run('job-failed', 'failed');
  insertJob.run('job-queued', 'pending');
  registerInheritedScope(db, { resourceType: 'job', resourceId: 'job-failed', parent: { resourceType: 'project', resourceId: 'project-a' } });
  registerInheritedScope(db, { resourceType: 'job', resourceId: 'job-queued', parent: { resourceType: 'project', resourceId: 'project-a' } });
  insertOperation({ id: 'op-running-1', actorUserId: alice.principal.userId, status: 'accepted', taskId: 'job-queued' });
  insertOperation({ id: 'op-running-2', actorUserId: bob.principal.userId, status: 'admitted', taskId: 'job-queued' });
  insertOperation({ id: 'op-queued-1', actorUserId: alice.principal.userId, status: 'pending', taskId: 'job-queued' });
  insertOperation({ id: 'op-done-today', actorUserId: alice.principal.userId, status: 'succeeded', taskId: 'job-queued', updatedAt: nowIso(-5) });
  insertOperation({ id: 'op-done-yesterday', actorUserId: bob.principal.userId, status: 'succeeded', taskId: 'job-queued', updatedAt: new Date(Date.now() - 30 * 3600_000).toISOString() });
  insertOperation({ id: 'op-failed-1', actorUserId: alice.principal.userId, status: 'failed', taskId: 'job-failed', updatedAt: nowIso(-1) });
  insertOperation({ id: 'op-unknown-1', actorUserId: bob.principal.userId, status: 'unknown', taskId: 'job-queued' });
  // 「已取消」在台账里不是独立状态：status 仍为 pending + waitReason=stage_canceled。
  insertOperation({ id: 'op-canceled-1', actorUserId: alice.principal.userId, status: 'pending', taskId: 'job-queued', waitReason: 'stage_canceled' });
  db.prepare(`INSERT INTO team_error_records (id, actorUserId, module, taskId, operationId, stage, code, safeMessage, createdAt)
    VALUES ('err-failed-1', ?, 'image', 'job-failed', 'op-failed-1', 'remote_submit', 'provider_rejected', '供应商拒绝了这次提交。', ?)`)
    .run(alice.principal.userId, nowIso(-1));

  // 服务端函数直接算一遍，作为「与任务数据一致」的对照。
  const expected = readConsoleOverview(db, { userId: admin.userId, role: 'admin' }, {
    runtime: { proxyAvailable: null, cosConfigured: null }, productionDefaults: null,
  });
  const overview = await overviewRoute.GET(request('https://studio.example.test/api/team/console/overview', adminCookie));
  assert.equal(overview.status, 200);
  const body = await overview.json();
  assert.equal(body.empty, false);
  assert.deepEqual(body.counts, expected.counts, '数量卡必须与任务数据一致');
  assert.deepEqual(body.counts, { running: 2, queued: 1, completedToday: 1, failed: 2, total: 8 });
  assert.equal(body.recent.length, expected.recent.length);
  assert.deepEqual(body.recent.map((row: { operationId: string }) => row.operationId),
    expected.recent.map((row: { operationId: string }) => row.operationId), '最近任务顺序必须与纯函数一致');
  for (const row of body.recent) {
    assert.match(row.href, /^\/team\/tasks\?taskId=/u, '每一行都必须自带详情链接');
    for (const key of ['taskLabel', 'projectName', 'actorName', 'modelLabel', 'statusLabel', 'timeLabel']) {
      assert.ok(row[key], `最近任务行缺列 ${key}`);
    }
  }
  // 数量卡与列表接口一致：四项加起来 + 已取消 = 全部可见任务。
  const list = await tasksRoute.GET(request('https://studio.example.test/api/team/tasks', adminCookie));
  const listBody = await list.json();
  assert.equal(listBody.items.length, body.taskTotal, '数量卡的分母就是全员任务页的条目数');
  const byStatus = new Map<string, number>();
  for (const item of listBody.items) byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
  assert.equal(body.counts.running, (byStatus.get('admitted') ?? 0) + (byStatus.get('accepted') ?? 0));
  assert.equal(body.counts.queued, (byStatus.get('pending') ?? 0) + (byStatus.get('deferred') ?? 0));
  assert.equal(body.counts.failed, (byStatus.get('failed') ?? 0) + (byStatus.get('unknown') ?? 0));
  console.log('PASS: 数量卡、最近任务行与任务数据一致，每行都带详情链接');

  // ---- 名额占用 / 开工前清单与就绪检查一致 ----
  const poolsBody = await (await poolsRoute.GET(request('https://studio.example.test/api/team/pools', adminCookie))).json();
  assert.equal(body.setup.items.length, 3);
  assert.equal(body.setup.items[2].state, poolsBody.ready ? 'ok' : 'action', '名额池状态必须与 /api/team/pools 的 ready 一致');
  assert.deepEqual(
    body.setup.items[2].reasons,
    poolsBody.blockers,
    '名额池待处理项必须原样来自 /api/team/pools 的 blockers',
  );
  assert.equal(body.setup.ready, poolsBody.ready && body.setup.items[0].state === 'ok' && body.setup.items[1].state === 'ok');
  for (const item of body.setup.items) {
    assert.ok(item.href.startsWith('/'), `${item.key} 必须写明去处`);
    assert.ok(item.actionLabel, `${item.key} 必须有动作名`);
  }
  assert.deepEqual(body.pools, [], '还没有名额池时名额占用为空数组，不是空表');
  console.log('PASS: 开工前清单与就绪检查一致，每项都写明状态与去处');

  // 配一个名额池后，占用按池出现，清单里名额项随之变化。
  const { upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
  upsertExecutionPool(db, { poolKey: 'media:test', kind: 'remote', capacity: 4, enabled: true, mappingSnapshot: { protocol: 'media-remote/1' }, expectedVersion: 0 });
  const afterPool = await (await overviewRoute.GET(request('https://studio.example.test/api/team/console/overview', adminCookie))).json();
  assert.equal(afterPool.pools.length, 1);
  assert.equal(afterPool.pools[0].poolKey, 'media:test');
  assert.equal(afterPool.pools[0].used, 0);
  assert.equal(afterPool.pools[0].hint, '还能再跑 4 条');
  assert.equal(
    afterPool.setup.items[2].state,
    readPoolAdminState(db, { userId: admin.userId, role: 'admin' }).ready ? 'ok' : 'action',
    '加池后清单仍与就绪检查同一口径',
  );
  console.log('PASS: 名额占用按池一行，与 /api/team/pools 同口径');

  // ---- 详情：直链可打开、员工拿不到别人的 ----
  const detail = await detailRoute.GET(request('https://studio.example.test/api/team/tasks/detail?taskId=op-failed-1', adminCookie));
  assert.equal(detail.status, 200, await detail.clone().text());
  const detailBody = await detail.json();
  assert.equal(detailBody.item.operationId, 'op-failed-1');
  assert.equal(detailBody.item.errorId, 'err-failed-1');
  assert.equal(detailBody.item.errorStage, 'remote_submit', '详情必须写清失败阶段');
  assert.equal(detailBody.item.errorCode, 'provider_rejected');
  assert.equal(detailBody.item.errorMessage, '供应商拒绝了这次提交。');
  assert.equal(detailBody.item.model, 'gpt-image-2', '详情必须写清模型');
  assert.ok(Array.isArray(detailBody.item.modelCalls));
  assert.equal(detailBody.item.href, undefined, '详情不需要自引用链接');

  const badId = await detailRoute.GET(request('https://studio.example.test/api/team/tasks/detail?taskId=../../etc/passwd', adminCookie));
  assert.equal(badId.status, 400);
  const missing = await detailRoute.GET(request('https://studio.example.test/api/team/tasks/detail?taskId=op-does-not-exist', adminCookie));
  assert.equal(missing.status, 404);

  const aliceDetail = await detailRoute.GET(request('https://studio.example.test/api/team/tasks/detail?taskId=op-failed-1', alice.cookie));
  assert.equal(aliceDetail.status, 200, '员工可以打开自己的任务详情');
  const bobDetail = await detailRoute.GET(request('https://studio.example.test/api/team/tasks/detail?taskId=op-failed-1', bob.cookie));
  assert.equal(bobDetail.status, 404, '员工打不开别人的任务详情，且不泄露存在性');
  console.log('PASS: 任务详情可直链打开、写清错误编号/阶段/模型，员工看不到别人的');

  // ---- 筛选正确 ----
  const aliceOnly = await (await tasksRoute.GET(request(`https://studio.example.test/api/team/tasks?actorUserId=${alice.principal.userId}`, adminCookie))).json();
  assert.ok(aliceOnly.items.length > 0);
  assert.ok(aliceOnly.items.every((item: { actorUserId: string }) => item.actorUserId === alice.principal.userId), '按发起人筛选只返回该成员');
  const failedOnly = await (await tasksRoute.GET(request('https://studio.example.test/api/team/tasks?status=failed', adminCookie))).json();
  assert.ok(failedOnly.items.length > 0);
  assert.ok(failedOnly.items.every((item: { status: string }) => item.status === 'failed'), '按状态筛选只返回该状态');
  const employeeList = await (await tasksRoute.GET(request('https://studio.example.test/api/team/tasks', alice.cookie))).json();
  assert.ok(employeeList.items.every((item: { actorUserId: string }) => item.actorUserId === alice.principal.userId), '员工只看到自己的任务');
  assert.ok(employeeList.items.length < listBody.items.length, '员工条目数少于全员条目数');
  const crossFilter = await tasksRoute.GET(request(`https://studio.example.test/api/team/tasks?actorUserId=${bob.principal.userId}`, alice.cookie));
  assert.equal(crossFilter.status, 403, '员工不能按别人筛选');
  console.log('PASS: 发起人/状态筛选正确，员工只能看自己的');

  // ---- 重试：只放行明确失败；待核查与越权都拒绝 ----
  const retryOther = await retryRoute.POST(request('https://studio.example.test/api/team/tasks/retry', bob.cookie, {
    method: 'POST', ...json({ operationId: 'op-failed-1' }),
  }));
  assert.equal(retryOther.status, 404, '员工不能重试别人的任务，且不泄露任务是否存在');

  const retryUnknown = await retryRoute.POST(request('https://studio.example.test/api/team/tasks/retry', adminCookie, {
    method: 'POST', ...json({ operationId: 'op-unknown-1' }),
  }));
  assert.equal(retryUnknown.status, 400, '提交结果待核查不得重试');
  assert.match((await retryUnknown.json()).message, /核对结果/u);

  const retryRunning = await retryRoute.POST(request('https://studio.example.test/api/team/tasks/retry', adminCookie, {
    method: 'POST', ...json({ operationId: 'op-running-1' }),
  }));
  assert.equal(retryRunning.status, 400, '正在跑的任务不得重试');

  const retryFailed = await retryRoute.POST(request('https://studio.example.test/api/team/tasks/retry', adminCookie, {
    method: 'POST', ...json({ operationId: 'op-failed-1' }),
  }));
  assert.equal(retryFailed.status, 200, await retryFailed.clone().text());
  const retryBody = await retryFailed.json();
  assert.equal(retryBody.ok, true);
  assert.equal(retryBody.queued, true);
  const jobRow = db.prepare("SELECT status, attempt FROM jobs WHERE id = 'job-failed'").get() as { status: string; attempt: number };
  assert.equal(jobRow.status, 'pending', '重试后业务任务回到排队');
  assert.equal(jobRow.attempt, 0);
  const afterRetry = await (await tasksRoute.GET(request('https://studio.example.test/api/team/tasks', adminCookie))).json();
  const retriedItem = afterRetry.items.find((item: { operationId: string }) => item.operationId === 'op-failed-1');
  assert.equal(retriedItem.status, 'pending', '任务列表把回到排队的这条读成「排队中」');
  console.log('PASS: 重试只放行明确失败的图片/视频任务，重试后回到排队，越权与待核查都被拒绝');

  // ---- 员工访问管理员接口全部被拒 ----
  assert.equal((await poolsRoute.GET(request('https://studio.example.test/api/team/pools', alice.cookie))).status, 403);
  console.log('PASS: 员工访问管理员接口被拒');

  console.log('\nteam console routes contract passed');
} finally {
  adminSession.token = '';
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
