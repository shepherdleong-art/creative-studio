import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest } from 'next/server.js';

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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-matrix-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: fixtureRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-matrix',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'disabled',
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
const { registerRootScope, registerInheritedScope } = await import('../lib/team-service/resource-scopes.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: fixtureRoot, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-matrix', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({
  db, employeeId: '0000', displayName: '管理员', kdf, passwordParams,
});
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);

const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(
  adminLogin.principal, initialized.credential, 'admin-matrix-password',
);
const adminSession = await service.login({ employeeId: '0000', password: 'admin-matrix-password' });
const adminPrincipal = adminSession.principal;
const admin = { principal: adminPrincipal, cookie: sessionCookie(adminSession.token).split(';', 1)[0] };
async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(adminPrincipal, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-matrix-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-matrix-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}

const userA = await account('0001', '甲');
const userB = await account('0002', '乙');

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-test', '测试', '', 'test-key', 'gpt-image-2')").run();
const provider = db.prepare('SELECT id FROM providers LIMIT 1').get() as { id: string };
for (const id of ['project-a', 'project-b']) {
  db.prepare('INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, provider.id, 'gpt-image-2', '');
}
registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: userA.principal.userId });
registerRootScope(db, { resourceType: 'project', resourceId: 'project-b', ownerUserId: userB.principal.userId });

const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(fixtureRoot, 'canvas-backups') })).state, 'compatibility_only');
for (const id of ['canvas-a', 'canvas-b']) {
  db.prepare(`INSERT INTO creative_canvases (id, name, graphRevision, graphJson, viewportJson, createdAt, updatedAt)
    VALUES (?, ?, 0, '{"schemaVersion":1,"nodes":[],"edges":[]}', '{}', '2026-11-02', '2026-11-02')`).run(id, id);
}
registerRootScope(db, { resourceType: 'canvas', resourceId: 'canvas-a', ownerUserId: userA.principal.userId });
registerRootScope(db, { resourceType: 'canvas', resourceId: 'canvas-b', ownerUserId: userB.principal.userId });
const copyGraph = {
  schemaVersion: 1,
  nodes: [{ id: 'node-1', kind: 'image-generation', position: { x: 0, y: 0 }, data: {
    title: '场景图', modelKey: null, generationMode: 'text-to-image', prompt: '测试', parameters: {}, references: [], referenceLabelCounter: 0,
  } }],
  edges: [],
};
db.prepare('UPDATE creative_canvases SET graphJson = ? WHERE id = ?').run(JSON.stringify(copyGraph), 'canvas-a');
db.prepare(`INSERT INTO creative_canvas_assets (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, ready, createdAt)
  VALUES ('canvas-asset-a', 'canvas-a', 'image', 'canvas/canvas-a/asset.png', 'hash-a', 'image/png', 1, 1, '2026-11-02')`).run();
registerInheritedScope(db, {
  resourceType: 'canvas_asset', resourceId: 'canvas-asset-a',
  parent: { resourceType: 'canvas', resourceId: 'canvas-a' },
});

const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
assert.notEqual((await ensureBatchSchemaReady({ db, backupRoot: path.join(fixtureRoot, 'batch-backups') })).state, 'compatibility_only');
for (const [batchId, projectId] of [['batch-a', 'project-a'], ['batch-b', 'project-b']] as const) {
  db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES (?, ?, ?, 'draft', NULL, '{}', '2026-11-02', '2026-11-02')`).run(batchId, projectId, batchId);
  registerInheritedScope(db, { resourceType: 'batch', resourceId: batchId, parent: { resourceType: 'project', resourceId: projectId } });
}

const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(fixtureRoot, 'script-backups') })).state, 'compatibility_only');
db.prepare(`INSERT INTO project_scripts (id, projectId, currentRevisionId, createdAt, updatedAt)
  VALUES ('script-a', 'project-a', 'script-revision-a', '2026-11-02', '2026-11-02')`).run();
db.prepare(`INSERT INTO project_script_revisions (id, scriptId, revisionNumber, origin, contentJson, targetDurationSec, createdAt)
  VALUES ('script-revision-a', 'script-a', 1, 'manual_edit', '{"segments":[]}', 15, '2026-11-02')`).run();
registerInheritedScope(db, {
  resourceType: 'project_script', resourceId: 'script-a', parent: { resourceType: 'project', resourceId: 'project-a' },
});
registerInheritedScope(db, {
  resourceType: 'project_script_revision', resourceId: 'script-revision-a', parent: { resourceType: 'project_script', resourceId: 'script-a' },
});
db.prepare(`INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, createdAt, updatedAt)
  VALUES ('viral-library', 'viral-revision', '2026-11-02', '2026-11-02')`).run();
db.prepare(`INSERT INTO script_studio_viral_tpl_revisions (id, libraryId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
  VALUES ('viral-revision', 'viral-library', 1, 'fixture.xlsx', 'hash', '{}', '2026-11-02')`).run();
registerRootScope(db, {
  resourceType: 'viral_template_library', resourceId: 'viral-library', ownerUserId: admin.principal.userId, visibility: 'public',
});
registerInheritedScope(db, {
  resourceType: 'viral_template_revision', resourceId: 'viral-revision',
  parent: { resourceType: 'viral_template_library', resourceId: 'viral-library' }, visibility: 'public',
});

const projectsRoute = await import('../app/api/projects/route.ts');
const projectItemRoute = await import('../app/api/projects/[id]/route.ts');
const canvasRoute = await import('../app/api/canvas/route.ts');
const canvasItemRoute = await import('../app/api/canvas/[id]/route.ts');
const providersRoute = await import('../app/api/providers/route.ts');
const rawImagesRoute = await import('../app/api/images/[...path]/route.ts');
const canvasTasksRoute = await import('../app/api/canvas/tasks/route.ts');
const batchProductionsRoute = await import('../app/api/batch-production/batches/route.ts');
const usageRecordsRoute = await import('../app/api/usage/records/route.ts');
const logsRoute = await import('../app/api/projects/[id]/logs/route.ts');
const fontFavoritesRoute = await import('../app/api/font-favorites/route.ts');
const teamModelsRoute = await import('../app/api/team/models/route.ts');
const teamReconcileRoute = await import('../app/api/team/reconcile/route.ts');
const channelHealthRoute = await import('../app/api/team/channel-health/route.ts');
const canvasCopiesRoute = await import('../app/api/canvas/[id]/copies/route.ts');
const scriptGenerationRoute = await import('../app/api/projects/[id]/script-generation/route.ts');
const scriptCurrentRoute = await import('../app/api/projects/[id]/script-studio/scripts/[scriptId]/current/route.ts');
const viralEntriesRoute = await import('../app/api/script-studio/viral-templates/entries/route.ts');
const { stopCanvasScheduler } = await import('../lib/creative-canvas/bootstrap.ts');

const get = (url: string, cookie?: string) => new Request(url, { headers: cookie ? { Cookie: cookie } : {} });
const write = (url: string, cookie: string, body: unknown) => new Request(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Cookie: `${cookie}; __Host-team_csrf=matrix-csrf`,
    Origin: 'https://studio.example.test', 'x-csrf-token': 'matrix-csrf',
  },
  body: JSON.stringify(body),
});
const put = (url: string, cookie: string, body: unknown) => new Request(url, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json', Cookie: `${cookie}; __Host-team_csrf=matrix-csrf`,
    Origin: 'https://studio.example.test', 'x-csrf-token': 'matrix-csrf',
  },
  body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

for (const [imageId, projectId] of [['image-a', 'project-a'], ['image-b', 'project-b']] as const) {
  db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path) VALUES (?, ?, 'input', ?, ?)").run(imageId, projectId, `${imageId}.png`, `${imageId}.png`);
  registerInheritedScope(db, { resourceType: 'image', resourceId: imageId, parent: { resourceType: 'project', resourceId: projectId } });
}
for (const [jobId, projectId, imageId] of [['job-a', 'project-a', 'image-a'], ['job-b', 'project-b', 'image-b']] as const) {
  db.prepare("INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt) VALUES (?, ?, ?, 'provider-test', 'gpt-image-2', '')").run(jobId, projectId, imageId);
  registerInheritedScope(db, { resourceType: 'job', resourceId: jobId, parent: { resourceType: 'project', resourceId: projectId } });
}
for (const [taskId, canvasId] of [['canvas-task-a', 'canvas-a'], ['canvas-task-b', 'canvas-b']] as const) {
  db.prepare(`INSERT INTO creative_canvas_tasks (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot, createdAt, updatedAt)
    VALUES (?, ?, 'node-1', 1, 'image', 'queued', '{}', '{}', '2026-11-02', '2026-11-02')`).run(taskId, canvasId);
  registerInheritedScope(db, { resourceType: 'canvas_task', resourceId: taskId, parent: { resourceType: 'canvas', resourceId: canvasId } });
}
const insertUsage = db.prepare(`INSERT INTO usage_ledger (
  id, eventKey, coreModelKey, category, providerId, providerName, model, pricingVersion,
  callCount, quantity, unit, priceScale, unitPriceMicros, costMicros, detailJson,
  projectId, refType, refId, createdAt, actorUserId
) VALUES (?, ?, 'gpt-image-2', 'image', 'provider-test', '测试', 'gpt-image-2', 'v1', 1, 1, 'image', 1, 100, 100, '{}', ?, 'job', ?, '2026-11-02', ?)`);
insertUsage.run('usage-a', 'usage-a', 'project-a', 'job-a', userA.principal.userId);
insertUsage.run('usage-b', 'usage-b', 'project-b', 'job-b', userB.principal.userId);
insertUsage.run('usage-b-legacy', 'usage-b-legacy', 'project-b', 'job-b', '');

try {
  const fontsRoute = await import('../app/api/system-fonts/route.ts');
  const fontFileRoute = await import('../app/api/system-fonts/[id]/file/route.ts');
  const fontDirectory = path.join(fixtureRoot, 'storage', 'fonts');
  fs.mkdirSync(fontDirectory, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'packaging/fonts/ZCOOLKuaiLe-Regular.ttf'), path.join(fontDirectory, 'shared.ttf'));
  assert.equal((await fontsRoute.GET(get('https://studio.example.test/api/system-fonts'))).status, 401);
  const fontCatalog = await (await fontsRoute.GET(get('https://studio.example.test/api/system-fonts?refresh=1', userA.cookie))).json() as { fonts: Array<{ previewUrl: string }> };
  assert.ok(!JSON.stringify(fontCatalog).includes(fixtureRoot), '员工字体目录不能泄露服务器绝对路径');
  const fontUrl = fontCatalog.fonts[0].previewUrl;
  const fontId = fontUrl.split('/')[3];
  assert.equal((await fontFileRoute.GET(get(`https://studio.example.test${fontUrl}`), params(fontId))).status, 401);
  const fontResponse = await fontFileRoute.GET(get(`https://studio.example.test${fontUrl}`, userA.cookie), params(fontId));
  assert.equal(fontResponse.status, 200);
  assert.ok((await fontResponse.arrayBuffer()).byteLength > 100);
  assert.equal((await fontFileRoute.GET(get('https://studio.example.test/api/system-fonts/unknown/file', userA.cookie), params('unknown'))).status, 404);
  const usersItemRoute = await import('../app/api/team/users/[id]/route.ts');
  const memberToDelete = await service.createUser(admin.principal, { employeeId: '00999', displayName: '待删除成员', role: 'employee' });
  const deleteRequest = (cookie: string) => new Request(write(`https://studio.example.test/api/team/users/${memberToDelete.user.id}`, cookie, {}), { method: 'DELETE' });
  assert.equal((await usersItemRoute.DELETE(deleteRequest(userA.cookie), params(memberToDelete.user.id))).status, 403);
  assert.equal((await usersItemRoute.DELETE(deleteRequest(admin.cookie), params(memberToDelete.user.id))).status, 200);
  const packagingResources = await import('../app/api/packaging/templates/[...path]/route.ts');
  const packagingResource = (segments: string[], cookie?: string) => packagingResources.GET(
    get(`https://studio.example.test/api/packaging/templates/${segments.join('/')}`, cookie),
    { params: Promise.resolve({ path: segments }) },
  );
  assert.equal((await packagingResource(['overlay-journal', 'gsap.min.js'])).status, 401);
  for (const [resource, mime] of [
    ['gsap.min.js', 'text/javascript'], ['assets/bg-mask.png', 'image/png'],
    ['assets/cover-frame.png', 'image/png'], ['fonts/FZZDHJW.TTF', 'font/ttf'],
  ]) {
    const response = await packagingResource(['overlay-journal', ...resource.split('/')], userA.cookie);
    assert.equal(response.status, 200, `员工必须能加载包装资源 ${resource}`);
    assert.ok(response.headers.get('content-type')?.startsWith(mime));
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  assert.equal((await packagingResource(['overlay-journal', 'fonts', 'user', 'private.ttf'], userA.cookie)).status, 404);
  assert.equal((await packagingResource(['unknown-template', 'index.html'], userA.cookie)).status, 404);
  assert.equal((await packagingResource(['overlay-journal', '..', 'index.html'], userA.cookie)).status, 400);
  assert.equal((await projectsRoute.GET(get('https://studio.example.test/api/projects'))).status, 401);
  const listA = await projectsRoute.GET(get('https://studio.example.test/api/projects', userA.cookie));
  assert.equal(listA.status, 200);
  assert.deepEqual((await listA.json() as Array<{ id: string }>).map((project) => project.id), ['project-a']);

  const deniedProject = await projectItemRoute.GET(get('https://studio.example.test/api/projects/project-b', userA.cookie), params('project-b'));
  assert.equal(deniedProject.status, 403);
  const adminProject = await projectItemRoute.GET(get('https://studio.example.test/api/projects/project-b', admin.cookie), params('project-b'));
  assert.equal(adminProject.status, 200);

  const canvasesA = await canvasRoute.GET(get('https://studio.example.test/api/canvas', userA.cookie));
  assert.equal(canvasesA.status, 200);
  assert.deepEqual((await canvasesA.json() as { canvases: Array<{ id: string }> }).canvases.map((canvas) => canvas.id), ['canvas-a']);
  assert.equal((await canvasItemRoute.GET(get('https://studio.example.test/api/canvas/canvas-b', userA.cookie), params('canvas-b'))).status, 403);
  assert.equal((await canvasItemRoute.GET(get('https://studio.example.test/api/canvas/canvas-b', admin.cookie), params('canvas-b'))).status, 200);

  assert.equal((await providersRoute.GET(get('https://studio.example.test/api/providers', userA.cookie))).status, 403);
  assert.equal((await providersRoute.GET(get('https://studio.example.test/api/providers', admin.cookie))).status, 200);
  const raw = await rawImagesRoute.GET(get('https://studio.example.test/api/images/inputs/secret.png', userA.cookie), {
    params: Promise.resolve({ path: ['inputs', 'secret.png'] }),
  });
  assert.equal(raw.status, 404);
  assert.equal(raw.headers.get('Cache-Control'), 'no-store');

  const tasksA = await canvasTasksRoute.GET(get('https://studio.example.test/api/canvas/tasks', userA.cookie));
  assert.equal(tasksA.status, 200);
  const taskListA = (await tasksA.json() as { tasks: Array<{ id: string; canvasName: string }> }).tasks;
  assert.deepEqual(taskListA.map((task) => task.id), ['canvas-task-a']);
  assert.deepEqual(taskListA.map((task) => task.canvasName), ['canvas-a']);

  const duplicateProjectQuery = await batchProductionsRoute.GET(new NextRequest(
    'https://studio.example.test/api/batch-production/batches?projectId=project-b&projectId=project-a',
    { headers: { Cookie: userA.cookie } },
  ));
  assert.equal(duplicateProjectQuery.status, 403);
  const duplicateProjectQueryAfterAuthorizedValues = await batchProductionsRoute.GET(new NextRequest(
    'https://studio.example.test/api/batch-production/batches?projectId=project-a&projectId=project-a&projectId=project-b',
    { headers: { Cookie: userA.cookie } },
  ));
  assert.equal(duplicateProjectQueryAfterAuthorizedValues.status, 403, '重复 query 必须逐值授权，不能在前面的同主体值后停止');

  const canvasCopy = await canvasCopiesRoute.POST(write('https://studio.example.test/api/canvas/canvas-a/copies', userA.cookie, {
    sourceCanvasId: 'canvas-a', snapshotKey: 'copy-with-result', nodes: copyGraph.nodes, edges: [],
    resultAssetIds: { 'node-1': 'canvas-asset-a' },
  }), params('canvas-a'));
  assert.equal(canvasCopy.status, 200, await canvasCopy.text());

  const scriptTemplateId = await scriptGenerationRoute.POST(write(
    'https://studio.example.test/api/projects/project-a/script-generation', userA.cookie,
    { templateId: 'scene_seeding' },
  ), params('project-a'));
  assert.equal(scriptTemplateId.status, 400);
  assert.equal((await scriptTemplateId.json() as { error?: string }).error, '缺少生成任务 ID');

  const currentRevision = await scriptCurrentRoute.PUT(put(
    'https://studio.example.test/api/projects/project-a/script-studio/scripts/script-a/current', userA.cookie,
    { revisionId: 'script-revision-a' },
  ), { params: Promise.resolve({ id: 'project-a', scriptId: 'script-a' }) });
  assert.equal(currentRevision.status, 200, await currentRevision.text());

  const viralEntries = await viralEntriesRoute.GET(new NextRequest(
    'https://studio.example.test/api/script-studio/viral-templates/entries?revisionId=viral-revision',
    { headers: { Cookie: userB.cookie } },
  ));
  assert.equal(viralEntries.status, 200, await viralEntries.text());

  const usageA = await usageRecordsRoute.GET(get('https://studio.example.test/api/usage/records', userA.cookie));
  assert.equal(usageA.status, 200);
  assert.deepEqual((await usageA.json() as { items: Array<{ eventKey: string }> }).items.map((item) => item.eventKey), ['usage-a']);
  const usageAdmin = await usageRecordsRoute.GET(get('https://studio.example.test/api/usage/records', admin.cookie));
  assert.equal((await usageAdmin.json() as { items: Array<{ eventKey: string }> }).items.length, 3);

  const crossLogs = await logsRoute.GET(get('https://studio.example.test/api/projects/project-a/logs?jobId=job-b', userA.cookie), params('project-a'));
  assert.equal(crossLogs.status, 403);
  const adminLogs = await logsRoute.GET(get('https://studio.example.test/api/projects/project-b/logs?jobId=job-b', admin.cookie), params('project-b'));
  assert.equal(adminLogs.status, 200);

  const favorite = await fontFavoritesRoute.POST(write('https://studio.example.test/api/font-favorites', userA.cookie, { action: 'set', family: '测试字体', favorite: true }));
  assert.equal(favorite.status, 200);
  assert.deepEqual((await fontFavoritesRoute.GET(get('https://studio.example.test/api/font-favorites', userB.cookie)) as Response).status, 200);
  assert.deepEqual((await (await fontFavoritesRoute.GET(get('https://studio.example.test/api/font-favorites', userB.cookie))).json() as { favorites: string[] }).favorites, []);
  assert.deepEqual((await (await fontFavoritesRoute.GET(get('https://studio.example.test/api/font-favorites', userA.cookie))).json() as { favorites: string[] }).favorites, ['测试字体']);

  const models = await teamModelsRoute.GET(get('https://studio.example.test/api/team/models?kind=image', userA.cookie));
  assert.equal(models.status, 200);
  const modelText = await models.text();
  assert.equal(modelText.includes('"baseUrl"'), false);
  assert.equal(modelText.includes('"apiKey"'), false);
  assert.equal(modelText.includes('"keyEnv"'), false);
  assert.equal(modelText.includes('test-key'), false);
  const imageModels = JSON.parse(modelText) as Array<{ id: string; type: string; model: string }>;
  assert.equal(imageModels[0]?.id, 'unified-image2', 'team image API leads with the unified Image 2 anchor');
  assert.ok(imageModels.some((model) => model.id === 'company-gateway-seedream-5-0-pro'), 'other image models keep their original visibility');
  assert.ok(imageModels.some((model) => model.id === 'company-gateway-nano-banana-pro'));
  assert.equal(
    imageModels.some((model) => model.id === 'company-gateway-image2-medium'
      || model.id === 'company-gateway-qiniuyun-gpt-image-2-medium'),
    false,
    'the two real Image 2 channels stay hidden from the employee model menu',
  );

  assert.equal((await teamReconcileRoute.GET(get('https://studio.example.test/api/team/reconcile'))).status, 401);
  assert.equal(
    (await teamReconcileRoute.GET(get('https://studio.example.test/api/team/reconcile', userA.cookie))).status,
    403,
    'employees cannot inspect another member reconciliation details',
  );
  const reconcileAdmin = await teamReconcileRoute.GET(
    get('https://studio.example.test/api/team/reconcile?status=all', admin.cookie),
  );
  assert.equal(reconcileAdmin.status, 200, await reconcileAdmin.clone().text());
  const reconcileText = await reconcileAdmin.text();
  assert.equal(reconcileText.includes('"baseUrl"'), false);
  assert.equal(reconcileText.includes('"apiKey"'), false);
  assert.equal(
    (await teamReconcileRoute.POST(write(
      'https://studio.example.test/api/team/reconcile',
      userA.cookie,
      { mediaTaskId: 'unknown', channelKey: 'qiniu', attemptId: 'unknown', action: 'still_unknown', evidence: 'test' },
    ))).status,
    403,
  );
  assert.equal((await channelHealthRoute.GET(get(
    'https://studio.example.test/api/team/channel-health', userA.cookie,
  ))).status, 403, 'channel health is administrator-only');
  const health = await channelHealthRoute.GET(get(
    'https://studio.example.test/api/team/channel-health', admin.cookie,
  ));
  const healthText = await health.text();
  assert.equal(health.status, 200, healthText);
  assert.equal(healthText.includes('apiKey'), false);
  assert.equal(healthText.includes('baseUrl'), false);
  const healthBody = JSON.parse(healthText) as {
    items: Array<{ healthKey: string; version: number; state: string }>;
  };
  assert.equal(healthBody.items.length, 2);
  assert.equal((await channelHealthRoute.POST(write(
    'https://studio.example.test/api/team/channel-health', userA.cookie,
    { action: 'clear', healthKey: healthBody.items[0].healthKey, expectedVersion: healthBody.items[0].version },
  ))).status, 403);
  const cleared = await channelHealthRoute.POST(write(
    'https://studio.example.test/api/team/channel-health', admin.cookie,
    { action: 'clear', healthKey: healthBody.items[0].healthKey, expectedVersion: healthBody.items[0].version },
  ));
  assert.equal(cleared.status, 200, await cleared.text());

  const failures: string[] = [];
  const resolveRoute = await import('../app/api/team/errors/[id]/resolve/route.ts');
  const { recordTeamError, listTeamErrors } = await import('../lib/team-service/diagnostics.ts');
  const errorToResolve = recordTeamError(db, { actorUserId: userA.principal.userId, module: 'projects', stage: 'server_api', code: 'thumbnail_failed' });
  const resolveUrl = `https://studio.example.test/api/team/errors/${errorToResolve.errorId}/resolve`;
  assert.equal((await resolveRoute.POST(new Request(resolveUrl, { method: 'POST', headers: { Cookie: userA.cookie } }), params(errorToResolve.errorId))).status, 403, '处理接口必须校验 CSRF');
  assert.equal((await resolveRoute.POST(write(resolveUrl, '', {}), params(errorToResolve.errorId))).status, 401);
  assert.equal((await resolveRoute.POST(write(resolveUrl, userB.cookie, {}), params(errorToResolve.errorId))).status, 404);
  assert.equal((await resolveRoute.POST(write(resolveUrl, userA.cookie, {}), params(errorToResolve.errorId))).status, 200);
  assert.equal((await resolveRoute.POST(write(resolveUrl, admin.cookie, {}), params(errorToResolve.errorId))).status, 200);
  assert.equal(listTeamErrors(db, userA.principal, { errorId: errorToResolve.errorId }).items.length, 1);
  assert.equal(listTeamErrors(db, userA.principal, { errorId: errorToResolve.errorId, actionableOnly: true }).items.length, 0);
  const { withTeamRoute } = await import('../lib/team-service/route-wrapper.ts');
  for (const suffix of ['a', 'b']) {
    db.prepare(`INSERT INTO batch_assets (id, projectId, sourceKind, locationJson, contentFingerprint,
      mediaKind, mediaJson, status, createdAt, updatedAt)
      VALUES (?, ?, 'managed', '{}', ?, 'video', '{}', 'online', '2026-11-09', '2026-11-09')`)
      .run(`batch-asset-${suffix}`, `project-${suffix}`, `fingerprint-${suffix}`);
    registerInheritedScope(db, { resourceType: 'batch_asset', resourceId: `batch-asset-${suffix}`,
      parent: { resourceType: 'project', resourceId: `project-${suffix}` } });
  }
  // 用真实路由授权层复现 AI 分析的 assetIds 数组，不启动付费生成。
  const analyzeAssets = withTeamRoute('/api/batch-production/batches/[id]/assets/analyze', 'POST', async () => Response.json({ accepted: true }));
  const analyzeUrl = 'https://studio.example.test/api/batch-production/batches/batch-a/assets/analyze?projectId=project-a';
  const ownAssets = await analyzeAssets(write(analyzeUrl, userA.cookie, { assetIds: ['batch-asset-a'] }), params('batch-a'));
  assert.equal(ownAssets.status, 200, await ownAssets.clone().text());
  assert.equal((await analyzeAssets(write(analyzeUrl, userA.cookie, { assetIds: ['batch-asset-b'] }), params('batch-a'))).status, 403);
  assert.equal((await analyzeAssets(write(analyzeUrl, admin.cookie, { assetIds: ['batch-asset-b'] }), params('batch-a'))).status, 403,
    '管理员也不能把别的项目素材放进当前批次');
  assert.equal((await analyzeAssets(write(analyzeUrl, userA.cookie, { assetIds: ['missing-asset'] }), params('batch-a'))).status, 404);
  for (const route of [
    '/api/projects/[id]/final-edit/draft',
    '/api/projects/[id]/final-edit/preflight',
    '/api/projects/[id]/final-edit/start',
  ]) {
    // These requests still call the field scriptDraftId, but the UI sends a project_scripts ID.
    const handler = withTeamRoute(route, 'POST', async () => Response.json({ accepted: true }));
    const own = await handler(write(`https://studio.example.test${route.replace('[id]', 'project-a')}`, userA.cookie, {
      scriptDraftId: 'script-a',
    }), params('project-a'));
    if (own.status !== 200) failures.push(`${route}: expected 200, got ${own.status} ${await own.text()}`);
    const cross = await handler(write(`https://studio.example.test${route.replace('[id]', 'project-b')}`, userB.cookie, {
      scriptDraftId: 'script-a',
    }), params('project-b'));
    assert.notEqual(cross.status, 200, '不能把他人的项目脚本带入混剪');
  }
  const batchReadinessRoute = await import('../app/api/batch-production/readiness/route.ts');
  const readiness = await batchReadinessRoute.GET(get('https://studio.example.test/api/batch-production/readiness', userA.cookie));
  if (readiness.status !== 200) failures.push(`batch readiness: expected 200, got ${readiness.status} ${await readiness.text()}`);
  const recovery = withTeamRoute('/api/batch-production/recovery', 'GET', async () => Response.json({ accepted: true }));
  assert.equal((await recovery(get('https://studio.example.test/api/batch-production/recovery', userA.cookie))).status, 403, '开放状态读取不能开放管理员恢复检查');
  assert.deepEqual(failures, [], '员工混剪与批量生产入口应可访问');

  console.log('team API A/B/admin matrix tests passed');
} finally {
  await stopCanvasScheduler();
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
