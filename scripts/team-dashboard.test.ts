/**
 * 员工首页聚合（06 号票）——接口级。
 *
 * 首页五块内容与数据一致、非渲染阶段不显示百分比、空状态有下一步，
 * 这三条都是 UI 里最容易「看起来对、其实是假数字」的地方，所以放到接口级断言：
 *
 *   1. 只返回本人可见的项目与任务（员工之间不串）；
 *   2.「接着做」带真实的第几步；
 *   3.「正在生产」里非渲染阶段 percent 恒为 null，只有真实渲染任务才有百分比；
 *   4.「出错的任务」带阶段说明与下一步建议；
 *   5. 本月用量来自额度汇总，是只读数。
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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-dashboard-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: fixtureRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-dashboard',
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
const { registerRootScope, registerInheritedScope, createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: fixtureRoot, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-dashboard', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) })).available, true);
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) })).available, true,
  '共享执行设施必须就绪，才能造出「正在生产」的任务');
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-dashboard-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-dashboard-password' });
const adminPrincipal = adminSession.principal;

async function account(employeeId: string) {
  const created = await service.createUser(adminPrincipal, { employeeId, displayName: `成员${employeeId}`, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-dashboard-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-dashboard-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}
const alice = await account('0001');
const bob = await account('0002');

const dashboardRoute = await import('../app/api/team/dashboard/route.ts');
const get = (cookie: string) => new Request('https://studio.example.test/api/team/dashboard', {
  headers: { Cookie: cookie },
});

// ── 夹具：两个项目，进度不同；一个渲染任务；一条出错记录 ──
db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-test', '测试', '', 'test-key', 'gpt-image-2')").run();
const insertProject = db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, storeCode, productionType, productCode)
  VALUES (?, ?, 'provider-test', 'gpt-image-2', '', ?, ?, ?)`);
insertProject.run('project-alice', 'B店-XQ9A-AI种草-紫菜卷', 'B店', 'AI种草', 'XQ9A');
insertProject.run('project-bob', 'B店-PC672-AI种草-强尼', 'B店', 'AI种草', 'PC672');
registerRootScope(db, { resourceType: 'project', resourceId: 'project-alice', ownerUserId: alice.principal.userId });
registerRootScope(db, { resourceType: 'project', resourceId: 'project-bob', ownerUserId: bob.principal.userId });

// alice 的项目已走过第 1 步（有场景候选），第 2 步还没有产出。
const insertImage = db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, usage) VALUES (?, ?, ?, ?, ?, ?)`);
// Production image paths are absolute; include URL-special characters so the
// homepage must use the same storage URL conversion as the project list.
const sceneFilename = '场景 #1.png';
const scenePath = path.join(fixtureRoot, 'storage', 'outputs', sceneFilename);
fs.mkdirSync(path.dirname(scenePath), { recursive: true });
const sceneBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(scenePath, sceneBytes);
insertImage.run('image-alice-scene', 'project-alice', 'output', sceneFilename, scenePath, 'scene_gen');
insertImage.run('image-alice-input', 'project-alice', 'input', 'input.png', 'inputs/input.png', 'scene_seed');
insertImage.run('image-bob-scene', 'project-bob', 'output', 'scene.png', 'outputs/scene.png', 'scene_gen');
for (const [imageId, projectId] of [
  ['image-alice-scene', 'project-alice'], ['image-alice-input', 'project-alice'], ['image-bob-scene', 'project-bob'],
] as const) {
  registerInheritedScope(db, { resourceType: 'image', resourceId: imageId, parent: { resourceType: 'project', resourceId: projectId } });
}

// alice 有两条在飞任务（非渲染）+ 一条渲染任务。
db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt) VALUES ('job-alice-1', 'project-alice', 'image-alice-input', 'provider-test', 'gpt-image-2', '')`).run();
db.prepare(`INSERT INTO execution_operations (
  id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
  businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey, providerSnapshotJson,
  requiredPoolsJson, quoteJson, status, readySeq, createdAt, updatedAt
) VALUES ('op-alice-1', 'image/job-alice-1/submit/1', ?, 'project', 'project-alice', 'image', 'job-alice-1', 'submit', '1',
  'job-alice-1:submit', 1, 'hash', '{}', 'cardinality:1', '{}', '[]', '{}', 'pending', 1, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z')`)
  .run(alice.principal.userId);
registerInheritedScope(db, { resourceType: 'job', resourceId: 'job-alice-1', parent: { resourceType: 'project', resourceId: 'project-alice' } });
registerInheritedScope(db, { resourceType: 'execution_operation', resourceId: 'op-alice-1', parent: { resourceType: 'project', resourceId: 'project-alice' } });

db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt) VALUES ('job-bob-1', 'project-bob', 'image-bob-scene', 'provider-test', 'gpt-image-2', '')`).run();
db.prepare(`INSERT INTO execution_operations (
  id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
  businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey, providerSnapshotJson,
  requiredPoolsJson, quoteJson, status, readySeq, createdAt, updatedAt
) VALUES ('op-bob-1', 'image/job-bob-1/submit/1', ?, 'project', 'project-bob', 'image', 'job-bob-1', 'submit', '1',
  'job-bob-1:submit', 1, 'hash', '{}', 'cardinality:1', '{}', '[]', '{}', 'pending', 2, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z')`)
  .run(bob.principal.userId);

// 成片渲染任务：唯一能真实测量的阶段（进度 0.37）。
const { initFinalEditSchema } = await import('../lib/final-edit/schema.ts');
initFinalEditSchema(db);
db.prepare(`INSERT INTO final_edit_jobs (id, projectId, groupId, variantId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt)
  VALUES ('render-alice', 'project-alice', 'group-alice', NULL, 'render', 'running', 'rendering', 0.37, 'render-key', '{}', 0, 'CNY', '2026-11-08T00:00:00.000Z')`).run();

// 一条 alice 的失败记录，验证首页带上「哪一步 + 怎么办」。
const { recordTeamError } = await import('../lib/team-service/diagnostics.ts');
const errorRecord = await recordTeamError(db, {
  actorUserId: alice.principal.userId, module: 'image', taskId: 'job-alice-1',
  scope: { resourceType: 'project', resourceId: 'project-alice' },
  stage: 'download', code: 'download_failed', statusCode: 502,
  eventKey: 'dashboard-fixture-download',
});

try {
  // ── 员工 A：只看得到自己的东西 ──
  const aliceAccess = createTeamAccessContext({ db, principal: alice.principal });
  aliceAccess.registerFile!({
    absolutePath: scenePath, mimeType: 'image/png',
    references: [{ resourceType: 'image', resourceId: 'image-alice-scene', role: 'output' }],
  });
  const aliceBody = await runWithAccessContext(aliceAccess, async () => {
    const response = await dashboardRoute.GET(get(alice.cookie));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<import('../lib/team-service/dashboard.ts').EmployeeDashboard>;
  });

  assert.equal(aliceBody.greetingName, '成员0001', '问候语用登录人显示名');
  assert.deepEqual(aliceBody.projects.map((project) => project.id), ['project-alice'],
    '首页只能看到自己的项目');
  assert.deepEqual(aliceBody.projects[0].progress, { step: 2, label: '分镜', empty: true },
    '有场景候选、还没分镜产出 → 第 2 步');
  assert.equal(aliceBody.projects[0].storeCode, 'B店');
  assert.equal(aliceBody.projects[0].productionType, 'AI种草');
  const thumbnailUrl = aliceBody.projects[0].thumbnailImageUrl!;
  assert.equal(thumbnailUrl, `/api/images/outputs/${encodeURIComponent(sceneFilename)}`,
    '首页封面必须转换绝对磁盘路径，并编码文件名，不能将磁盘路径直接拼入 URL');
  const imageRoute = await import('../app/api/images/[...path]/route.ts');
  const imageRequest = (cookie: string) => new Request(new URL(thumbnailUrl, 'https://studio.example.test'), {
    headers: { Cookie: cookie },
  });
  const imageParams = { params: Promise.resolve({ path: ['outputs', sceneFilename] }) };
  const imageResponse = await runWithAccessContext(aliceAccess, () => imageRoute.GET(imageRequest(alice.cookie), imageParams));
  assert.equal(imageResponse.status, 200, '首页返回的封面链接必须实际可读取');
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), sceneBytes);
  const deniedImage = await runWithAccessContext(createTeamAccessContext({ db, principal: bob.principal }),
    () => imageRoute.GET(imageRequest(bob.cookie), imageParams));
  assert.equal(deniedImage.status, 404, '修复封面地址不能让其他成员读取该图片');

  // ── 非渲染阶段不显示百分比；渲染阶段才有 ──
  const percented = aliceBody.running.items.filter((item) => item.percent !== null);
  assert.equal(percented.length, 1, '整份「正在生产」里只有渲染任务带百分比');
  assert.equal(percented[0].percent, 37, '渲染任务用真实进度 0.37 → 37%');
  for (const item of aliceBody.running.items) {
    if (item.percent === null) assert.doesNotMatch(item.detail, /%/, `非渲染阶段不得出现百分比：${item.detail}`);
  }
  const imageItems = aliceBody.running.items.filter((item) => item.percent === null);
  assert.equal(imageItems.length, 1, 'alice 的图片任务还有 1 条在飞');
  assert.match(imageItems[0].detail, /第 1 条/, '非渲染阶段写「第几条」');

  // ── 出错的任务：哪一步 + 怎么办 ──
  assert.equal(aliceBody.errors.length, 1);
  assert.equal(aliceBody.errors[0].errorId, errorRecord.errorId);
  assert.equal(aliceBody.errors[0].stage, 'download');
  assert.ok(aliceBody.errors[0].actionHint.length > 8, '出错的任务必须给「能怎么办」');
  assert.equal(aliceBody.errors[0].scopeName, 'B店-XQ9A-AI种草-紫菜卷');

  // ── 本月用量：只读，来自额度汇总 ──
  assert.equal(typeof aliceBody.usage.monthChargedMinor, 'number');
  assert.equal(aliceBody.usage.monthChargedMinor, 0, '没有计费记录时本月已计为 0');
  assert.equal(aliceBody.usage.monthlyLimitMinor, null,
    '额度 0 表示「还没设额度」，首页按不限额显示，不能写成「额度 ¥0.00」');
  assert.equal(typeof aliceBody.usage.accountingPeriod, 'string');

  // ── 员工 B：完全看不到 A 的项目与任务 ──
  const bobAccess = createTeamAccessContext({ db, principal: bob.principal });
  const bobBody = await runWithAccessContext(bobAccess, async () => {
    const response = await dashboardRoute.GET(get(bob.cookie));
    assert.equal(response.status, 200);
    return response.json() as Promise<import('../lib/team-service/dashboard.ts').EmployeeDashboard>;
  });
  assert.deepEqual(bobBody.projects.map((project) => project.id), ['project-bob']);
  assert.deepEqual(bobBody.errors, [], '看不到别人的出错记录');
  assert.ok(bobBody.running.items.every((item) => !item.operationId.includes('alice')),
    '看不到别人的在飞任务');
  assert.ok(bobBody.running.items.every((item) => item.percent === null),
    'B 没有渲染任务，就不该出现任何百分比');

  // ── 空账号：空状态由各块自己表达（数据层给空数组，不编造条目） ──
  const carol = await account('0003');
  const carolAccess = createTeamAccessContext({ db, principal: carol.principal });
  const carolBody = await runWithAccessContext(carolAccess, async () => {
    const response = await dashboardRoute.GET(get(carol.cookie));
    assert.equal(response.status, 200);
    return response.json() as Promise<import('../lib/team-service/dashboard.ts').EmployeeDashboard>;
  });
  assert.deepEqual(carolBody.projects, []);
  assert.deepEqual(carolBody.running.items, []);
  assert.deepEqual(carolBody.errors, []);

  // ── 管理员调这个聚合也只取本人数据（运行总览归 12，用自己的接口） ──
  const adminAccess = createTeamAccessContext({ db, principal: adminPrincipal });
  const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];
  const adminBody = await runWithAccessContext(adminAccess, async () => {
    const response = await dashboardRoute.GET(get(adminCookie));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<import('../lib/team-service/dashboard.ts').EmployeeDashboard>;
  });
  assert.deepEqual(adminBody.projects, [], '管理员在员工首页聚合里不拿全团队项目（那归 12 的运行总览）');
  assert.deepEqual(adminBody.running.items, [], '管理员也不拿全团队任务');

  const { resolveTeamError, listTeamErrors, getTeamErrorDiagnostic } = await import('../lib/team-service/diagnostics.ts');
  resolveTeamError(db, alice.principal, errorRecord.errorId);
  const recovered = recordTeamError(db, { actorUserId: alice.principal.userId, module: 'images', stage: 'download', code: 'download_retry', outcome: 'recovered' });
  const afterResolution = await (await dashboardRoute.GET(get(alice.cookie))).json();
  assert.deepEqual(afterResolution.errors, [], '首页隐藏已处理及已自动恢复的记录');
  assert.equal(listTeamErrors(db, alice.principal).items.length, 2, '历史记录保留在错误中心');
  assert.equal(getTeamErrorDiagnostic(db, alice.principal, errorRecord.errorId).errorId, errorRecord.errorId);
  assert.equal(getTeamErrorDiagnostic(db, alice.principal, recovered.errorId).outcome, 'recovered');

  console.log('employee dashboard tests passed');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
