import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
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
        ? base : ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-error-automation-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-error-automation',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-error-automation-v1',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
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
const { withTeamRoute } = await import('../lib/team-service/route-wrapper.ts');
const errorsRoute = await import('../app/api/team/errors/route.ts');
const diagnosticRoute = await import('../app/api/team/errors/[id]/diagnostics/route.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { createTeamExecutionRuntime } = await import('../lib/team-service/bootstrap.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { clearCanvasCapabilities, registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { createCanvas, saveCanvasGraph } = await import('../lib/creative-canvas/repository.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { createCanvasScheduler } = await import('../lib/creative-canvas/scheduler.ts');
const { createCanvasFixtureAdapter } = await import('../lib/creative-canvas/adapters/fixture.ts');
const { listTeamErrors, getTeamErrorDiagnostic } = await import('../lib/team-service/diagnostics.ts');
const { retryCanvasTaskDownload, requestCanvasTaskCancel: requestCanvasCancelForTest } = await import('../lib/creative-canvas/recovery.ts');
const { wakeFinalEditWorker, waitForFinalEditJobsIdle } = await import('../lib/final-edit/worker.ts');
const { setExecutionModuleRuntime, clearExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-error-automation', trustedOrigin: 'https://studio.example.test',
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
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-error-automation-password');
const adminLoginAfterChange = await service.login({ employeeId: '0000', password: 'admin-error-automation-password' });
const admin = adminLoginAfterChange.principal;
async function account(employeeId: string) {
  const created = await service.createUser(admin, { employeeId, displayName: employeeId, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-error-automation-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-error-automation-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}
const alice = await account('0001');
const bob = await account('0002');
const adminCookie = sessionCookie(adminLoginAfterChange.token).split(';', 1)[0];
db.prepare(`INSERT INTO providers (id, name, baseUrl, model, type, enabled) VALUES ('fixture-provider', '离线夹具', 'http://127.0.0.1', 'fixture-image', 'fixture', 0)`).run();
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-alice', '自动诊断项目', 'fixture-provider', 'fixture-image', '')`).run();
db.prepare(`INSERT INTO team_resource_scopes (
  resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt
) VALUES ('project', 'project-alice', ?, 'private', NULL, NULL, 'project', 'project-alice', '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:00.000Z')`).run(alice.principal.userId);

function request(pathname: string, cookie: string): Request {
  return new Request(`https://studio.example.test${pathname}`, {
    headers: { Cookie: cookie, 'x-creative-studio-client-version': '0.7.1' },
  });
}

try {
  const failingGET = withTeamRoute('/api/projects/[id]', 'GET', async () => {
    throw new Error('fixture storage failed: Authorization: Bearer SECRET; source text must not be recorded');
  });
  const failed = await failingGET(request('/api/projects/project-alice', alice.cookie), { params: Promise.resolve({ id: 'project-alice' }) });
  assert.equal(failed.status, 500);
  const failedBody = await failed.json() as { error: string; message: string; errorId?: string };
  assert.equal(failedBody.error, 'internal_error');
  assert.ok(failedBody.errorId, '业务 API 异常响应必须自动携带错误编号');
  assert.equal(JSON.stringify(failedBody).includes('SECRET'), false);
  assert.equal(JSON.stringify(failedBody).includes('source text'), false);
  const responseFailureGET = withTeamRoute('/api/projects/[id]', 'GET', async () => Response.json({ error: 'storage_write_failed', message: '存储未完成' }, { status: 500 }));
  const responseFailure = await responseFailureGET(request('/api/projects/project-alice', alice.cookie), { params: Promise.resolve({ id: 'project-alice' }) });
  assert.equal(responseFailure.status, 500);
  assert.ok(responseFailure.headers.get('x-creative-studio-error-id'), 'handler 已转为 5xx 的真实故障也必须自动编号');
  const responseFailureBody = await responseFailure.json();
  assert.equal(responseFailureBody.errorId, undefined, '原 JSON 响应体不被诊断改写');
  assert.ok(responseFailure.headers.get('x-creative-studio-error-id'));
  assert.equal(responseFailureBody.error, 'storage_write_failed');
  assert.equal(responseFailureBody.message, '存储未完成', '保留原业务响应');

  const own = await errorsRoute.GET(request('/api/team/errors', alice.cookie));
  const ownBody = await own.json() as { items: Array<Record<string, unknown> & { scope?: { resourceId: string } | null }> };
  assert.equal(own.status, 200, JSON.stringify(ownBody));
  const automatic = ownBody.items.find((item) => item.errorId === failedBody.errorId);
  assert.ok(automatic, '错误必须来自实际 route handler，而不是测试直接写记录');
  assert.equal(automatic.actorUserId, alice.principal.userId);
  assert.equal(automatic.scope?.resourceId, 'project-alice');
  assert.equal(automatic.origin, 'server_api');
  assert.equal(automatic.outcome, 'final');
  assert.match(String(automatic.safeMessage), /接口|处理/);
  assert.match(String(automatic.actionHint), /重试|管理员/);
  assert.equal(automatic.taskHref, null, '没有可信任务时不得伪造跳转');
  assert.equal(automatic.model, null, '无法确认的模型必须明确缺失');

  const other = await errorsRoute.GET(request(`/api/team/errors?errorId=${failedBody.errorId}`, bob.cookie));
  assert.deepEqual((await other.json()).items, []);
  const otherDiagnostic = await diagnosticRoute.GET(request(`/api/team/errors/${failedBody.errorId}/diagnostics`, bob.cookie), { params: Promise.resolve({ id: failedBody.errorId! }) });
  assert.equal(otherDiagnostic.status, 404);
  const diagnostic = await diagnosticRoute.GET(request(`/api/team/errors/${failedBody.errorId}/diagnostics`, adminCookie), { params: Promise.resolve({ id: failedBody.errorId! }) });
  assert.equal(diagnostic.status, 200);
  const diagnosticText = await diagnostic.text();
  for (const forbidden of ['SECRET', 'Authorization', 'source text', 'headers', 'body', 'stack', 'apiKey', 'signature']) {
    assert.equal(diagnosticText.includes(forbidden), false, `诊断不得包含 ${forbidden}`);
  }

  const duplicate = await failingGET(request('/api/projects/project-alice', alice.cookie), { params: Promise.resolve({ id: 'project-alice' }) });
  assert.equal((await duplicate.json()).errorId, failedBody.errorId, '同一稳定失败事件不得生成重复记录');
  const validationGET = withTeamRoute('/api/projects/[id]', 'GET', async () => Response.json({ error: 'invalid_input' }, { status: 400 }));
  assert.equal((await validationGET(request('/api/projects/project-alice', alice.cookie), { params: Promise.resolve({ id: 'project-alice' }) })).status, 400);
  assert.equal((await errorsRoute.GET(request('/api/team/errors', alice.cookie))).status, 200);

  assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state, 'compatibility_only');
  const identity = { instanceId: 'error-automation-worker', fence: 1 };
  registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-error-automation' });
  const runtime = createTeamExecutionRuntime({
    config: {
      mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
      deploymentId: 'deployment-error-automation', trustedOrigin: 'https://studio.example.test',
    }, db,
  });
  await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-error-automation', signal: new AbortController().signal });
  updateActorPolicy(db, { actorId: alice.principal.userId, monthlyLimitMinor: null, personalConcurrency: 1, concurrencyMode: 'fixed', paused: false, expectedVersion: 1 });
  upsertExecutionPool(db, {
    poolKey: 'diagnostic-fixture:remote', kind: 'remote', capacity: 1, enabled: true,
    mappingSnapshot: { providerIdentity: 'diagnostic-fixture' }, expectedVersion: 0,
  });
  clearCanvasCapabilities();
  registerCanvasCapability({
    key: 'diagnostic-fixture-image', displayName: '离线失败注入', providerKind: 'external',
    providerIdentity: 'diagnostic-fixture', modelAlias: 'fixture-image-v3', mediaKind: 'image',
    modes: ['text-to-image'], inputs: [], parameters: [], cancellation: false,
    evidence: 'candidate', evidenceNote: '只使用隔离 fixture，不访问供应商。',
  });
  const access = createTeamAccessContext({ db, principal: alice.principal });
  const canvasId = runWithAccessContext(access, () => createCanvas(db, { name: '自动诊断画布' }).id);
  runWithAccessContext(access, () => saveCanvasGraph({
    db, canvasId, expectedGraphRevision: 0,
    graph: {
      schemaVersion: 1,
      nodes: [{ id: 'generate', kind: 'image-generation', position: { x: 0, y: 0 }, data: {
        title: '故障生成', modelKey: 'diagnostic-fixture-image', generationMode: 'text-to-image',
        prompt: '不会进入诊断的素材正文', parameters: {}, references: [], referenceLabelCounter: 0,
      } }], edges: [],
    },
  }));
  const taskId = runWithAccessContext(access, () => startCanvasRun({
    db, request: { canvasId, mode: 'single', targetNodeId: 'generate', requestKey: 'download-failure' },
  })).tasks[0]!.id;
  const adapter = createCanvasFixtureAdapter({ defaultScript: { download: 'fail', delayMs: 1 } });
  const scheduler = createCanvasScheduler({
    db, workerId: 'error-automation-worker', adapter, storageRoot: path.join(root, 'storage', 'canvas'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 0, sleep: async () => {},
  });
  try {
    await scheduler.tick();
    await scheduler.drain();
  } finally {
    await scheduler.stop();
  }
  const workerErrors = listTeamErrors(db, { userId: alice.principal.userId, role: 'employee' }).items
    .filter((item) => item.taskId === taskId);
  assert.equal(workerErrors.length, 1, '真实 scheduler 的下载失败必须自动产生一条诊断');
  const workerError = workerErrors[0]!;
  assert.equal(workerError.stage, 'download');
  assert.equal(workerError.origin, 'worker');
  assert.equal(workerError.outcome, 'final');
  assert.equal(workerError.scope?.resourceId, canvasId);
  assert.equal(workerError.model, 'fixture-image-v3');
  assert.ok(workerError.attemptId);
  assert.ok(workerError.operationId);
  assert.ok(workerError.taskHref);
  const serializedWorker = JSON.stringify(listTeamErrors(db, { userId: admin.userId, role: 'admin' }, { errorId: workerError.errorId }));
  for (const forbidden of ['不会进入诊断的素材正文', 'apiKey', 'baseUrl', 'Authorization', 'providerSnapshot']) {
    assert.equal(serializedWorker.includes(forbidden), false, `worker 输出不得包含 ${forbidden}`);
  }
  const crossWorker = await errorsRoute.GET(request(`/api/team/errors?errorId=${workerError.errorId}`, bob.cookie));
  assert.deepEqual((await crossWorker.json()).items, [], '其他员工不能查询 worker 诊断');
  const workerPackage = getTeamErrorDiagnostic(db, { userId: admin.userId, role: 'admin' }, workerError.errorId);
  assert.equal(workerPackage.model, 'fixture-image-v3');
  assert.equal(workerPackage.actorUserId, alice.principal.userId);
  assert.equal(JSON.stringify(workerPackage).includes('不会进入诊断的素材正文'), false);

  adapter.setScriptForNode('generate', { download: 'succeed', delayMs: 1 });
  runWithAccessContext(access, () => retryCanvasTaskDownload(db, { taskId }));
  const recoveredScheduler = createCanvasScheduler({
    db, workerId: 'error-automation-recovery', adapter, storageRoot: path.join(root, 'storage', 'canvas'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 0, sleep: async () => {},
  });
  try {
    await recoveredScheduler.tick();
    await recoveredScheduler.drain();
  } finally {
    await recoveredScheduler.stop();
  }
  assert.equal(listTeamErrors(db, { userId: alice.principal.userId, role: 'employee' }, { errorId: workerError.errorId }).items[0]?.outcome, 'recovered', '恢复后必须保留原事件并明确标为已恢复');
  assert.equal(adapter.submitCountForNode('generate'), 1, '补下载不得再次付费生成');

  const failedTaskId = runWithAccessContext(access, () => startCanvasRun({
    db, request: { canvasId, mode: 'single', targetNodeId: 'generate', requestKey: 'submit-failure' },
  })).tasks[0]!.id;
  adapter.setScriptForNode('generate', { submit: 'fail', delayMs: 1 });
  const submitScheduler = createCanvasScheduler({
    db, workerId: 'error-automation-submit', adapter, storageRoot: path.join(root, 'storage', 'canvas'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 0, sleep: async () => {},
  });
  try {
    await submitScheduler.tick();
    await submitScheduler.drain();
  } finally {
    await submitScheduler.stop();
  }
  const submitErrors = listTeamErrors(db, { userId: alice.principal.userId, role: 'employee' }).items
    .filter((item) => item.taskId === failedTaskId && item.stage === 'remote_submit');
  assert.equal(submitErrors.length, 1, '供应商明确拒绝提交也必须自动记录');
  assert.equal(submitErrors[0]?.code, 'fixture_submit_rejected');
  assert.equal(submitErrors[0]?.model, 'fixture-image-v3');

  const beforeCancelCount = listTeamErrors(db, { userId: alice.principal.userId, role: 'employee' }).items.length;
  const cancelledTaskId = runWithAccessContext(access, () => startCanvasRun({
    db, request: { canvasId, mode: 'single', targetNodeId: 'generate', requestKey: 'normal-cancel' },
  })).tasks[0]!.id;
  const cancelledAdapter = {
    kind: 'cancel-fixture',
    async prepare(): Promise<void> {},
    async submit(): Promise<{ providerTaskId: string }> {
      runWithAccessContext(access, () => requestCanvasCancelForTest(db, { taskId: cancelledTaskId }));
      return { providerTaskId: 'should-not-be-submitted' };
    },
    async poll(): Promise<{ status: 'succeeded' }> { return { status: 'succeeded' }; },
    async download(): Promise<{ bytes: Buffer; mimeType: string }> { return { bytes: Buffer.alloc(0), mimeType: 'image/png' }; },
  };
  const cancelledScheduler = createCanvasScheduler({
    db, workerId: 'error-automation-cancel', adapter: cancelledAdapter, storageRoot: path.join(root, 'storage', 'canvas'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 0, sleep: async () => {},
  });
  try {
    await cancelledScheduler.tick();
    await cancelledScheduler.drain();
  } finally {
    await cancelledScheduler.stop();
  }
  const cancellationArtifacts = listTeamErrors(db, { userId: alice.principal.userId, role: 'employee' }).items;
  assert.equal(cancellationArtifacts.length, beforeCancelCount, `正常取消不得写入系统故障：${JSON.stringify(cancellationArtifacts.filter((item) => item.taskId === cancelledTaskId))}`);

  const mediaJobId = 'media-storage-failure';
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO final_edit_jobs (id, projectId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt)
    VALUES (?, 'project-alice', 'render', 'queued', 'queued', 0, ?, ?, 0, 'CNY', ?)`)
    .run(mediaJobId, mediaJobId, JSON.stringify({ version: 1, privateSourceText: '不得进入诊断', variant: { id: 'missing-variant' } }), at);
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('final_job', ?, ?, 'private', 'project', 'project-alice', 'project', 'project-alice', ?, ?)`)
    .run(mediaJobId, alice.principal.userId, at, at);
  db.prepare(`INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, roleAtAcceptance, createdAt)
    VALUES ('final_edit', ?, ?, 'project', 'project-alice', '{}', 'employee', ?)`).run(mediaJobId, alice.principal.userId, at);
  setExecutionModuleRuntime({ facade: runtime.facade, ...identity });
  wakeFinalEditWorker();
  assert.equal(await waitForFinalEditJobsIdle(10_000), 0, '真实媒体 worker 必须完成失败收尾');
  const mediaWaitDeadline = Date.now() + 5_000;
  while (db.prepare('SELECT status FROM final_edit_jobs WHERE id = ?').pluck().get(mediaJobId) === 'queued' && Date.now() < mediaWaitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.prepare('SELECT status FROM final_edit_jobs WHERE id = ?').pluck().get(mediaJobId), 'failed');
  const mediaErrors = listTeamErrors(db, { userId: alice.principal.userId, role: 'employee' }).items
    .filter((item) => item.taskId === mediaJobId);
  assert.equal(mediaErrors.length, 1, '真实媒体 worker 的渲染／存储失败必须进入错误中心');
  assert.equal(mediaErrors[0]?.stage, 'local_media');
  assert.equal(mediaErrors[0]?.model, null);
  assert.equal(JSON.stringify(getTeamErrorDiagnostic(db, { userId: alice.principal.userId, role: 'employee' }, mediaErrors[0]!.errorId)).includes('不得进入诊断'), false);
  clearExecutionModuleRuntime();
  runtime.closeNewWork();
  clearCanvasCapabilities();

  console.log('PASS: automatic server API error capture, safe ownership and diagnostics');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
