import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-atomic-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: fixtureRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-atomic',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'disabled',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const { registerRootScope, assertScopeConsistency, createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: fixtureRoot, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-atomic', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-atomic-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-atomic-password' });
const adminPrincipal = adminSession.principal;
const admin = { principal: adminPrincipal, cookie: sessionCookie(adminSession.token).split(';', 1)[0] };
async function account(employeeId: string) {
  const created = await service.createUser(adminPrincipal, { employeeId, displayName: employeeId, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-atomic-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-atomic-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}
const userA = await account('0001');
const userB = await account('0002');

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-test', '测试', '', 'test-key', 'gpt-image-2')").run();
function unboundImage(id: string, ownerUserId: string) {
  db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path, usage) VALUES (?, NULL, 'input', ?, ?, 'scene_seed')").run(id, `${id}.png`, `originals/inputs/${id}.png`);
  registerRootScope(db, { resourceType: 'image', resourceId: id, ownerUserId });
  return id;
}

const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(fixtureRoot, 'canvas-backups') })).state, 'compatibility_only');
const projectsRoute = await import('../app/api/projects/route.ts');
const canvasRoute = await import('../app/api/canvas/route.ts');
const uploadRoute = await import('../app/api/upload/route.ts');
const regenerateRoute = await import('../app/api/jobs/[id]/regenerate/route.ts');
const { stopCanvasScheduler } = await import('../lib/creative-canvas/bootstrap.ts');
const { createCanvasRun } = await import('../lib/creative-canvas/tasks.ts');
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const { createTask } = await import('../lib/script-studio/tasks.ts');
const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
const { createBatchTask } = await import('../lib/batch-production/tasks.ts');
const { createAsset } = await import('../lib/batch-production/assets.ts');
const { createVideoJobsForShot } = await import('../lib/video-job-create.ts');
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(fixtureRoot, 'script-backups') })).state, 'compatibility_only');
assert.notEqual((await ensureBatchSchemaReady({ db, backupRoot: path.join(fixtureRoot, 'batch-backups') })).state, 'compatibility_only');
const accessA = createTeamAccessContext({ db, principal: userA.principal });

function write(url: string, cookie: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${cookie}; __Host-team_csrf=atomic-csrf`,
      Origin: 'https://studio.example.test',
      'x-csrf-token': 'atomic-csrf',
    },
    body: JSON.stringify(body),
  });
}
function projectBody(sceneSeedImageId: string, shotImageIds: string[], ownerUserId?: string) {
  return {
    providerId: 'provider-test', model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1k',
    storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷',
    sceneSeedImageId, shotImageIds, scenePrompt: '生成场景', shotPrompt: '生成分镜', generationCount: 1,
    ...(ownerUserId ? { ownerUserId } : {}),
  };
}

function uploadRequest(cookie: string, buffer: Buffer) {
  const form = new FormData();
  form.set('role', 'input');
  form.set('usage', 'scene_seed');
  form.set('preprocessEnabled', 'false');
  form.set('files', new File([new Uint8Array(buffer)], 'upload.png', { type: 'image/png' }));
  return new Request('https://studio.example.test/api/upload', {
    method: 'POST',
    headers: { Cookie: `${cookie}; __Host-team_csrf=atomic-csrf`, Origin: 'https://studio.example.test', 'x-csrf-token': 'atomic-csrf' },
    body: form,
  });
}

try {
  const beforeA = (db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count;
  const responseA = await projectsRoute.POST(write('https://studio.example.test/api/projects', userA.cookie,
    projectBody(unboundImage('image-a-scene', userA.principal.userId), [unboundImage('image-a-shot', userA.principal.userId)])));
  const responseABody = await responseA.text();
  assert.equal(responseA.status, 200, responseABody);
  const createdA = JSON.parse(responseABody) as { id: string };
  const projectAScope = assertScopeConsistency(db, 'project', createdA.id);
  assert.equal(projectAScope.ownerUserId, userA.principal.userId);
  const initialJobs = db.prepare('SELECT id FROM jobs WHERE projectId = ?').all(createdA.id) as Array<{ id: string }>;
  assert.equal(initialJobs.length, 1);
  for (const job of initialJobs) {
    assertScopeConsistency(db, 'job', job.id);
    const principal = db.prepare("SELECT actorUserId FROM team_task_principals WHERE module = 'image' AND taskId = ?").get(job.id) as { actorUserId: string };
    assert.equal(principal.actorUserId, userA.principal.userId);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM team_resource_scopes WHERE resourceType = 'shot_set' AND rootId = ?").get(createdA.id) as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM team_resource_scopes WHERE resourceType = 'shot' AND rootId = ?").get(createdA.id) as { count: number }).count, 1);

  const denied = await projectsRoute.POST(write('https://studio.example.test/api/projects', userB.cookie,
    projectBody('image-a-scene', ['image-a-shot'])));
  assert.equal(denied.status, 403);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count, beforeA + 1);

  db.exec(`CREATE TRIGGER fail_task_principal BEFORE INSERT ON team_task_principals BEGIN SELECT RAISE(ABORT, 'injected principal failure'); END;`);
  const rollback = await projectsRoute.POST(write('https://studio.example.test/api/projects', userA.cookie,
    projectBody(unboundImage('image-rollback-scene', userA.principal.userId), [unboundImage('image-rollback-shot', userA.principal.userId)])));
  assert.equal(rollback.status, 500);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count, beforeA + 1);
  assert.equal((db.prepare("SELECT projectId FROM image_assets WHERE id = 'image-rollback-scene'").get() as { projectId: string | null }).projectId, null);
  assert.equal(assertScopeConsistency(db, 'image', 'image-rollback-scene').parentId, null);
  db.exec('DROP TRIGGER fail_task_principal');

  const canvasResponse = await canvasRoute.POST(write('https://studio.example.test/api/canvas', userA.cookie, { name: '甲画布' }));
  const canvasBody = await canvasResponse.text();
  assert.equal(canvasResponse.status, 201, canvasBody);
  const canvasId = (JSON.parse(canvasBody) as { canvas: { id: string } }).canvas.id;
  assert.equal(assertScopeConsistency(db, 'canvas', canvasId).ownerUserId, userA.principal.userId);

  db.exec(`CREATE TRIGGER fail_canvas_scope BEFORE INSERT ON team_resource_scopes WHEN NEW.resourceType = 'canvas' BEGIN SELECT RAISE(ABORT, 'injected scope failure'); END;`);
  const canvasRollback = await canvasRoute.POST(write('https://studio.example.test/api/canvas', userA.cookie, { name: '必须回滚' }));
  assert.equal(canvasRollback.status, 500);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM creative_canvases WHERE name = '必须回滚'").get() as { count: number }).count, 0);
  db.exec('DROP TRIGGER fail_canvas_scope');

  const adminCreated = await projectsRoute.POST(write('https://studio.example.test/api/projects', admin.cookie,
    projectBody(unboundImage('image-admin-scene', userA.principal.userId), [unboundImage('image-admin-shot', userA.principal.userId)], userA.principal.userId)));
  const adminCreatedBody = await adminCreated.text();
  assert.equal(adminCreated.status, 200, adminCreatedBody);
  const adminProject = JSON.parse(adminCreatedBody) as { id: string };
  assert.equal(assertScopeConsistency(db, 'project', adminProject.id).ownerUserId, userA.principal.userId);
  const adminJob = db.prepare('SELECT id FROM jobs WHERE projectId = ?').get(adminProject.id) as { id: string };
  assert.equal((db.prepare("SELECT actorUserId FROM team_task_principals WHERE module = 'image' AND taskId = ?").get(adminJob.id) as { actorUserId: string }).actorUserId, admin.principal.userId);

  const originalJobId = initialJobs[0]!.id;
  db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(originalJobId);
  const deniedRegenerate = await regenerateRoute.POST(write('https://studio.example.test/api/jobs/x/regenerate', userB.cookie, {
    prompt: '越权重做', referenceImageIds: ['image-a-shot'],
  }), { params: Promise.resolve({ id: originalJobId }) });
  assert.equal(deniedRegenerate.status, 403);
  const adminRegenerate = await regenerateRoute.POST(write('https://studio.example.test/api/jobs/x/regenerate', admin.cookie, {
    prompt: '管理员代重做', referenceImageIds: [unboundImage('image-regenerate-admin', userA.principal.userId)],
  }), { params: Promise.resolve({ id: originalJobId }) });
  const regenerateBody = await adminRegenerate.text();
  assert.equal(adminRegenerate.status, 200, regenerateBody);
  const regeneratedId = (JSON.parse(regenerateBody) as { newJobId: string }).newJobId;
  assert.equal((db.prepare("SELECT actorUserId FROM team_task_principals WHERE module = 'image' AND taskId = ?").get(regeneratedId) as { actorUserId: string }).actorUserId, admin.principal.userId);
  assert.equal(assertScopeConsistency(db, 'image', 'image-regenerate-admin').rootId, createdA.id);

  db.exec(`CREATE TRIGGER fail_regenerate_principal BEFORE INSERT ON team_task_principals WHEN NEW.module = 'image' BEGIN SELECT RAISE(ABORT, 'injected regenerate principal failure'); END;`);
  const rollbackRegenerate = await regenerateRoute.POST(write('https://studio.example.test/api/jobs/x/regenerate', admin.cookie, {
    prompt: '必须回滚', referenceImageIds: [unboundImage('image-regenerate-rollback', userA.principal.userId)],
  }), { params: Promise.resolve({ id: originalJobId }) });
  assert.equal(rollbackRegenerate.status, 500);
  assert.equal(assertScopeConsistency(db, 'image', 'image-regenerate-rollback').parentId, null);
  assert.deepEqual(db.prepare("SELECT projectId FROM image_assets WHERE id = 'image-regenerate-rollback'").get() as { projectId: string | null }, { projectId: null });
  db.exec('DROP TRIGGER fail_regenerate_principal');

  const graph = {
    schemaVersion: 1,
    nodes: [{ id: 'node-1', kind: 'image-generation', position: { x: 0, y: 0 }, data: {
      title: '场景图', modelKey: null, generationMode: 'text-to-image', prompt: '测试', parameters: {}, references: [], referenceLabelCounter: 0,
    } }],
    edges: [],
  };
  db.prepare('UPDATE creative_canvases SET graphRevision = 1, graphJson = ? WHERE id = ?').run(JSON.stringify(graph), canvasId);
  db.prepare(`INSERT INTO creative_canvas_node_states (canvasId, nodeId, nodeEpoch, createdAt, updatedAt) VALUES (?, 'node-1', 1, '2026-11-02', '2026-11-02')`).run(canvasId);
  const canvasPlan: import('../lib/creative-canvas/planner.ts').CanvasPlan = {
    canvasId, mode: 'single', graphRevision: 1, requestKey: 'atomic-run-1', fingerprint: 'fingerprint-1',
    scope: ['node-1'], reused: [],
    tasks: [{
      nodeId: 'node-1', nodeEpoch: 1, mediaKind: 'image', capabilityKey: 'fixture', providerIdentity: 'fixture',
      modelAlias: 'fixture/image', generationMode: 'text-to-image', prompt: '测试', parameters: {}, inputs: [],
    }],
  };
  const run = runWithAccessContext(accessA, () => createCanvasRun(db, { plan: canvasPlan, requestHash: 'hash-1' }));
  assert.equal(run.idempotentReplay, false);
  assertScopeConsistency(db, 'canvas_run', run.run.id);
  assertScopeConsistency(db, 'canvas_task', run.tasks[0]!.id);
  db.exec(`CREATE TRIGGER fail_canvas_principal BEFORE INSERT ON team_task_principals WHEN NEW.module = 'canvas' BEGIN SELECT RAISE(ABORT, 'injected canvas principal failure'); END;`);
  assert.throws(() => runWithAccessContext(accessA, () => createCanvasRun(db, {
    plan: { ...canvasPlan, requestKey: 'atomic-run-rollback', fingerprint: 'fingerprint-rollback' },
    requestHash: 'hash-rollback',
  })));
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM creative_canvas_runs WHERE requestKey = 'atomic-run-rollback'").get() as { count: number }, { count: 0 });
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM creative_canvas_tasks WHERE canvasId = ? AND nodeId = 'node-1'").get(canvasId) as { count: number }, { count: 1 });
  db.exec('DROP TRIGGER fail_canvas_principal');

  const taskInput = { projectId: createdA.id, requestKey: 'studio-1', mode: 'first_extraction', inputSnapshot: {}, requestedCount: 1 } as const;
  const studioTask = runWithAccessContext(accessA, () => createTask(db, taskInput));
  assert.equal(studioTask.created, true);
  assertScopeConsistency(db, 'script_studio_task', studioTask.task.id);
  assert.equal(runWithAccessContext(accessA, () => createTask(db, taskInput)).created, false);
  db.exec(`CREATE TRIGGER fail_studio_principal BEFORE INSERT ON team_task_principals WHEN NEW.module = 'script_studio' BEGIN SELECT RAISE(ABORT, 'injected studio principal failure'); END;`);
  assert.throws(() => runWithAccessContext(accessA, () => createTask(db, { ...taskInput, requestKey: 'studio-rollback' })));
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM script_studio_tasks WHERE requestKey = 'studio-rollback'").get() as { count: number }, { count: 0 });
  db.exec('DROP TRIGGER fail_studio_principal');

  db.prepare(`INSERT INTO video_providers (id, name, type, defaultModel, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, apiKey, enabled)
    VALUES ('video-test', '视频测试', 'jimeng', 'doubao-seedance-2-5-260628', '', '', '', 'http://local', 'key', 1)`).run();
  const shotSetId = (db.prepare('SELECT id FROM shot_sets WHERE projectId = ?').get(createdA.id) as { id: string }).id;
  const shotId = (db.prepare('SELECT id FROM shots WHERE shotSetId = ?').get(shotSetId) as { id: string }).id;
  const videoInput: Parameters<typeof createVideoJobsForShot>[0] = {
    shotSetId, shotId,
    items: [{ prompt: '生成视频', templateId: null, providerId: 'video-test', durationSec: 5, tailImageId: null, multiShot: null, generationMode: 'image-to-video', referenceAssetIds: [], aspectRatio: null, resolution: null }],
  };
  const videoResult = await runWithAccessContext(accessA, () => createVideoJobsForShot(videoInput));
  assert.equal(videoResult.ok, true);
  if (!videoResult.ok) throw new Error('video creation failed');
  assertScopeConsistency(db, 'video_job', videoResult.videoJobIds[0]!);
  db.exec(`CREATE TRIGGER fail_video_principal BEFORE INSERT ON team_task_principals WHEN NEW.module = 'video' BEGIN SELECT RAISE(ABORT, 'injected video principal failure'); END;`);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get() as { count: number }, { count: 1 });
  await assert.rejects(runWithAccessContext(accessA, () => createVideoJobsForShot(videoInput)));
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM video_jobs').get() as { count: number }, { count: 1 });
  db.exec('DROP TRIGGER fail_video_principal');

  const batchId = runWithAccessContext(accessA, () => createBatchProduction(db, createdA.id, '原子批次'));
  const batchAssetId = runWithAccessContext(accessA, () => createAsset(db, {
    projectId: createdA.id, sourceKind: 'managed', locationJson: {}, contentFingerprint: 'a'.repeat(64), mediaKind: 'image', mediaJson: {},
  }));
  const batchTaskId = runWithAccessContext(accessA, () => createBatchTask(db, createdA.id, {
    batchId, workType: 'asset_prepare', targetKind: 'asset', targetId: batchAssetId,
  }));
  assertScopeConsistency(db, 'batch_task', batchTaskId);
  db.exec(`CREATE TRIGGER fail_batch_principal BEFORE INSERT ON team_task_principals WHEN NEW.module = 'batch' BEGIN SELECT RAISE(ABORT, 'injected batch principal failure'); END;`);
  const batchAsset2 = runWithAccessContext(accessA, () => createAsset(db, {
    projectId: createdA.id, sourceKind: 'managed', locationJson: {}, contentFingerprint: 'b'.repeat(64), mediaKind: 'image', mediaJson: {},
  }));
  assert.throws(() => runWithAccessContext(accessA, () => createBatchTask(db, createdA.id, {
    batchId, workType: 'asset_prepare', targetKind: 'asset', targetId: batchAsset2,
  })));
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM batch_tasks WHERE targetId = ?").get(batchAsset2) as { count: number }, { count: 0 });
  db.exec('DROP TRIGGER fail_batch_principal');

  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png().toBuffer();
  const imageCountBefore = db.prepare('SELECT COUNT(*) FROM image_assets').pluck().get();
  const upload = await uploadRoute.POST(uploadRequest(userA.cookie, png));
  const uploadBody = await upload.json() as { error?: string; uploadEndpoint?: string };
  assert.equal(upload.status, 409);
  assert.equal(uploadBody.error, 'controlled_upload_required');
  assert.equal(uploadBody.uploadEndpoint, '/api/team/uploads');
  assert.equal(db.prepare('SELECT COUNT(*) FROM image_assets').pluck().get(), imageCountBefore, '旧 multipart 拒绝前不得创建图片实体');

  console.log('team atomic creation tests passed');
} finally {
  await stopCanvasScheduler();
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
