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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-lifecycle-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-lifecycle-routes',
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
const { registerRootScope, registerInheritedScope } = await import('../lib/team-service/resource-scopes.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-lifecycle-routes', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const admin = await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-lifecycle-password');
const created = await service.createUser(admin, { employeeId: '0001', displayName: '员工', role: 'employee' });
const employeeLogin = await service.login({ employeeId: '0001', password: created.credential });
const employee = await service.changeOwnPassword(employeeLogin.principal, created.credential, 'employee-lifecycle-password');
const adminCookie = sessionCookie(adminLogin.token).split(';', 1)[0];
const employeeCookie = sessionCookie(employeeLogin.token).split(';', 1)[0];

db.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('provider', '测试', 'http://127.0.0.1')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-a', '项目', 'provider', 'model', '')").run();
registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: employee.userId });
db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path) VALUES ('image-a', 'project-a', 'input', 'a.png', 'a.png')").run();
registerInheritedScope(db, {
  resourceType: 'image', resourceId: 'image-a', parent: { resourceType: 'project', resourceId: 'project-a' },
});
db.exec(`
  CREATE TABLE IF NOT EXISTS creative_canvases (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS batch_productions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS batch_scripts (id TEXT PRIMARY KEY, projectId TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS project_scripts (id TEXT PRIMARY KEY, projectId TEXT NOT NULL);
  INSERT INTO creative_canvases VALUES ('canvas-a', '画布');
  INSERT INTO batch_productions VALUES ('batch-a', 'project-a', '批次');
  INSERT INTO batch_scripts VALUES ('batch-script-a', 'project-a');
  INSERT INTO project_scripts VALUES ('project-script-a', 'project-a');
`);
registerRootScope(db, { resourceType: 'canvas', resourceId: 'canvas-a', ownerUserId: employee.userId });
for (const [resourceType, resourceId] of [
  ['batch', 'batch-a'], ['batch_script', 'batch-script-a'], ['project_script', 'project-script-a'],
] as const) {
  registerInheritedScope(db, { resourceType, resourceId, parent: { resourceType: 'project', resourceId: 'project-a' } });
}

const projectRoute = await import('../app/api/projects/[id]/route.ts');
const imageRoute = await import('../app/api/images/[id]/route.ts');
const canvasRoute = await import('../app/api/canvas/[id]/route.ts');
const batchRoute = await import('../app/api/batch-production/batches/[id]/route.ts');
const batchScriptRoute = await import('../app/api/batch-production/scripts/[scriptId]/route.ts');
const studioScriptRoute = await import('../app/api/projects/[id]/script-studio/scripts/[scriptId]/route.ts');
const projectsRoute = await import('../app/api/projects/route.ts');
const recycleRoute = await import('../app/api/team/recycle-bin/route.ts');
const restoreRoute = await import('../app/api/team/recycle-bin/restore/route.ts');
const cleanupRoute = await import('../app/api/team/cleanup/route.ts');
const sceneReferenceRoute = await import('../app/api/scene-references/[id]/route.ts');
const sceneReferenceListRoute = await import('../app/api/projects/[id]/scene-references/route.ts');
const shotSetRoute = await import('../app/api/shot-sets/[id]/route.ts');
const shotSetListRoute = await import('../app/api/projects/[id]/shot-sets/route.ts');
const titlePresetRoute = await import('../app/api/final-edit/title-presets/[id]/route.ts');
const titlePresetListRoute = await import('../app/api/final-edit/title-presets/route.ts');
const videoTemplateRoute = await import('../app/api/video-prompt-templates/[id]/route.ts');
const videoTemplateListRoute = await import('../app/api/video-prompt-templates/route.ts');
const finalVariantRoute = await import('../app/api/final-edit-variants/[id]/route.ts');

function request(method: string, url: string, cookie: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

try {
  const deleted = await projectRoute.DELETE(request('DELETE', 'https://studio.example.test/api/projects/project-a', employeeCookie), {
    params: Promise.resolve({ id: 'project-a' }),
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal((await deleted.json()).mode, 'soft');
  assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = 'project-a'").get(), 'server DELETE 不得硬删项目');

  const listed = await projectsRoute.GET(request('GET', 'https://studio.example.test/api/projects', employeeCookie));
  assert.deepEqual(await listed.json(), []);
  const recycle = await recycleRoute.GET(request('GET', 'https://studio.example.test/api/team/recycle-bin', employeeCookie));
  const recycleBody = await recycle.json() as { items: Array<{ resourceId: string }> };
  assert.ok(recycleBody.items.some((item) => item.resourceId === 'project-a'));

  const forbidden = await cleanupRoute.POST(request('POST', 'https://studio.example.test/api/team/cleanup', employeeCookie, {
    resourceType: 'project', resourceId: 'project-a',
  }));
  assert.equal(forbidden.status, 403);

  const restored = await restoreRoute.POST(request('POST', 'https://studio.example.test/api/team/recycle-bin/restore', employeeCookie, {
    resourceType: 'project', resourceId: 'project-a',
  }));
  assert.equal(restored.status, 200, await restored.clone().text());
  const relisted = await projectsRoute.GET(request('GET', 'https://studio.example.test/api/projects', employeeCookie));
  assert.equal((await relisted.json() as unknown[]).length, 1);

  const imageDeleted = await imageRoute.DELETE(request('DELETE', 'https://studio.example.test/api/images/image-a', employeeCookie), {
    params: Promise.resolve({ id: 'image-a' }),
  });
  assert.equal(imageDeleted.status, 200, await imageDeleted.clone().text());
  assert.ok(db.prepare("SELECT 1 FROM image_assets WHERE id = 'image-a'").get());
  const projectDetail = await projectRoute.GET(request('GET', 'https://studio.example.test/api/projects/project-a', employeeCookie), {
    params: Promise.resolve({ id: 'project-a' }),
  });
  const detail = await projectDetail.json() as { images: unknown[] };
  assert.deepEqual(detail.images, [], '已软删图片不得出现在项目图片列表');

  const canvasDeleted = await canvasRoute.DELETE(request('DELETE', 'https://studio.example.test/api/canvas/canvas-a', employeeCookie), {
    params: Promise.resolve({ id: 'canvas-a' }),
  });
  assert.equal(canvasDeleted.status, 200, await canvasDeleted.clone().text());
  const batchDeleted = await batchRoute.DELETE(request('DELETE', 'https://studio.example.test/api/batch-production/batches/batch-a?projectId=project-a', employeeCookie), {
    params: Promise.resolve({ id: 'batch-a' }),
  });
  assert.equal(batchDeleted.status, 200, await batchDeleted.clone().text());
  const batchScriptDeleted = await batchScriptRoute.DELETE(request('DELETE', 'https://studio.example.test/api/batch-production/scripts/batch-script-a?projectId=project-a', employeeCookie), {
    params: Promise.resolve({ scriptId: 'batch-script-a' }),
  });
  assert.equal(batchScriptDeleted.status, 200, await batchScriptDeleted.clone().text());
  const studioScriptDeleted = await studioScriptRoute.DELETE(request('DELETE', 'https://studio.example.test/api/projects/project-a/script-studio/scripts/project-script-a', employeeCookie), {
    params: Promise.resolve({ id: 'project-a', scriptId: 'project-script-a' }),
  });
  assert.equal(studioScriptDeleted.status, 200, await studioScriptDeleted.clone().text());
  for (const [table, id] of [
    ['creative_canvases', 'canvas-a'], ['batch_productions', 'batch-a'],
    ['batch_scripts', 'batch-script-a'], ['project_scripts', 'project-script-a'],
  ]) {
    assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id), `${table} 不得硬删`);
  }
  assert.equal(db.prepare("SELECT deletedAt FROM team_resource_scopes WHERE resourceType = 'project' AND resourceId = 'project-a'").pluck().get(), null,
    '删除详情脚本不得误删项目');
  assert.ok(adminCookie);

  // 场景参考图、分镜组：server DELETE 进入回收站，正常列表隐藏。
  db.prepare("INSERT INTO scene_references (id, projectId, imageAssetId, name) VALUES ('scene-a', 'project-a', 'image-a', '场景')").run();
  registerInheritedScope(db, {
    resourceType: 'scene_reference', resourceId: 'scene-a', parent: { resourceType: 'project', resourceId: 'project-a' },
  });
  const sceneDeleted = await sceneReferenceRoute.DELETE(
    request('DELETE', 'https://studio.example.test/api/scene-references/scene-a', employeeCookie),
    { params: Promise.resolve({ id: 'scene-a' }) },
  );
  assert.equal(sceneDeleted.status, 200, await sceneDeleted.clone().text());
  assert.equal((await sceneDeleted.json()).mode, 'soft');
  assert.ok(db.prepare("SELECT 1 FROM scene_references WHERE id = 'scene-a'").get(), '场景参考图不得硬删');
  const scenes = await sceneReferenceListRoute.GET(
    request('GET', 'https://studio.example.test/api/projects/project-a/scene-references', employeeCookie),
    { params: Promise.resolve({ id: 'project-a' }) },
  );
  assert.deepEqual(await scenes.json(), [], '已软删场景参考图不得出现在列表');

  db.prepare("INSERT INTO shot_sets (id, projectId, name) VALUES ('set-a', 'project-a', '分镜组')").run();
  registerInheritedScope(db, {
    resourceType: 'shot_set', resourceId: 'set-a', parent: { resourceType: 'project', resourceId: 'project-a' },
  });
  const setDeleted = await shotSetRoute.DELETE(
    request('DELETE', 'https://studio.example.test/api/shot-sets/set-a', employeeCookie),
    { params: Promise.resolve({ id: 'set-a' }) },
  );
  assert.equal(setDeleted.status, 200, await setDeleted.clone().text());
  assert.ok(db.prepare("SELECT 1 FROM shot_sets WHERE id = 'set-a'").get(), '分镜组不得硬删');
  const sets = await shotSetListRoute.GET(
    request('GET', 'https://studio.example.test/api/projects/project-a/shot-sets', employeeCookie),
    { params: Promise.resolve({ id: 'project-a' }) },
  );
  assert.deepEqual(await sets.json(), [], '已软删分镜组不得出现在列表');

  // 个人模板与标题预设：软删后列表隐藏，管理员可永久清理且重复调用幂等。
  db.prepare("INSERT INTO video_prompt_templates (id, name, prompt) VALUES ('template-a', '自建模板', '镜头推进')").run();
  registerRootScope(db, { resourceType: 'video_prompt_template', resourceId: 'template-a', ownerUserId: employee.userId });
  const templateDeleted = await videoTemplateRoute.DELETE(
    request('DELETE', 'https://studio.example.test/api/video-prompt-templates/template-a', employeeCookie),
    { params: Promise.resolve({ id: 'template-a' }) },
  );
  assert.equal(templateDeleted.status, 200, await templateDeleted.clone().text());
  const templates = await videoTemplateListRoute.GET(
    request('GET', 'https://studio.example.test/api/video-prompt-templates', employeeCookie),
  );
  assert.equal((await templates.json() as Array<{ id: string }>).some((row) => row.id === 'template-a'), false);

  db.prepare("INSERT INTO final_edit_title_presets (id, name, stylesByPresetJson, createdAt, updatedAt) VALUES ('preset-a', '预设', '{}', '2026-11-04', '2026-11-04')").run();
  registerRootScope(db, { resourceType: 'title_preset', resourceId: 'preset-a', ownerUserId: employee.userId });
  const presetDeleted = await titlePresetRoute.DELETE(
    request('DELETE', 'https://studio.example.test/api/final-edit/title-presets/preset-a', employeeCookie),
    { params: Promise.resolve({ id: 'preset-a' }) },
  );
  assert.equal(presetDeleted.status, 200, await presetDeleted.clone().text());
  const presets = await titlePresetListRoute.GET(
    request('GET', 'https://studio.example.test/api/final-edit/title-presets', employeeCookie),
  );
  assert.equal((await presets.json() as Array<{ id: string }>).some((row) => row.id === 'preset-a'), false);

  // 成片草稿：软删后仍保留数据，供恢复。
  db.prepare("INSERT INTO shot_sets (id, projectId, name) VALUES ('set-b', 'project-a', '成片分镜组')").run();
  registerInheritedScope(db, {
    resourceType: 'shot_set', resourceId: 'set-b', parent: { resourceType: 'project', resourceId: 'project-a' },
  });
  db.prepare(`INSERT INTO final_edit_groups (
      id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash, narrationConfigJson,
      coverTitleJson, textStylesJson, createdAt, updatedAt
    ) VALUES ('group-a', 'project-a', '', 'set-b', '{}', 'hash', '{}', '{}', '{}', '2026-11-04', '2026-11-04')`).run();
  registerInheritedScope(db, {
    resourceType: 'final_group', resourceId: 'group-a', parent: { resourceType: 'shot_set', resourceId: 'set-b' },
  });
  db.prepare(`INSERT INTO final_edit_variants (id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson, createdAt, updatedAt)
    VALUES ('variant-a', 'group-a', 1, 'vertical', '{}', '{}', '{}', '2026-11-04', '2026-11-04')`).run();
  registerInheritedScope(db, {
    resourceType: 'final_variant', resourceId: 'variant-a', parent: { resourceType: 'final_group', resourceId: 'group-a' },
  });
  const variantDeleted = await finalVariantRoute.DELETE(
    request('DELETE', 'https://studio.example.test/api/final-edit-variants/variant-a', employeeCookie),
    { params: Promise.resolve({ id: 'variant-a' }) },
  );
  assert.equal(variantDeleted.status, 200, await variantDeleted.clone().text());
  assert.ok(db.prepare("SELECT 1 FROM final_edit_variants WHERE id = 'variant-a'").get(), '成片草稿不得硬删');

  const templateCleanup = await cleanupRoute.POST(request('POST', 'https://studio.example.test/api/team/cleanup', adminCookie, {
    resourceType: 'video_prompt_template', resourceId: 'template-a',
  }));
  assert.equal(templateCleanup.status, 200, await templateCleanup.clone().text());
  assert.equal(db.prepare("SELECT 1 FROM video_prompt_templates WHERE id = 'template-a'").get(), undefined);
  const templateCleanupAgain = await cleanupRoute.POST(request('POST', 'https://studio.example.test/api/team/cleanup', adminCookie, {
    resourceType: 'video_prompt_template', resourceId: 'template-a',
  }));
  assert.equal(templateCleanupAgain.status, 200, await templateCleanupAgain.clone().text());
  assert.equal((await templateCleanupAgain.json() as { job: { status: string } }).job.status, 'completed', '重复清理必须幂等');

  console.log('PASS: server DELETE is soft, lists hide recycle items, owner restores and employees cannot permanently clean');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
