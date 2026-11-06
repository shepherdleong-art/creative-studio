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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-resource-candidates-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-resource-candidates',
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

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-resource-candidates', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams: { N: 1024, r: 8, p: 1 } });
const service = createTeamAuthService({ db, kdf, passwordParams: { N: 1024, r: 8, p: 1 } });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-resource-password');
const adminLoginAfterPassword = await service.login({ employeeId: '0000', password: 'admin-resource-password' });
const created = await service.createUser(adminLoginAfterPassword.principal, { employeeId: '0001', displayName: '员工', role: 'employee' });
const employeeLogin = await service.login({ employeeId: '0001', password: created.credential });
await service.changeOwnPassword(employeeLogin.principal, created.credential, 'employee-resource-password');
const employeeLoginAfterPassword = await service.login({ employeeId: '0001', password: 'employee-resource-password' });
const adminCookie = sessionCookie(adminLoginAfterPassword.token).split(';', 1)[0];
const employeeCookie = sessionCookie(employeeLoginAfterPassword.token).split(';', 1)[0];
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'script-backups') })).state, 'compatibility_only');
const publicRoute = await import('../app/api/team/public-resources/route.ts');
const templateRoute = await import('../app/api/video-prompt-templates/route.ts');

function request(method: string, cookie: string, body?: unknown) {
  return new Request('https://studio.example.test/api/team/public-resources', {
    method,
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

try {
  const employeeCandidates = await publicRoute.GET(request('GET', employeeCookie));
  assert.equal(employeeCandidates.status, 403, '员工不能读取管理发布候选');

  const empty = await publicRoute.GET(request('GET', adminCookie));
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json() as { candidates: unknown[] };
  assert.ok(Array.isArray(emptyBody.candidates), '候选必须来自真实资源列表');
  assert.ok(emptyBody.candidates.every((value) => (value as { published: boolean }).published), '首管理员只登记明确的内置公共资源');

  const createdTemplate = await templateRoute.POST(new Request('https://studio.example.test/api/video-prompt-templates', {
    method: 'POST',
    headers: {
      Cookie: `${adminCookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', 'content-type': 'application/json',
    },
    body: JSON.stringify({ name: '统一候选验收模板', description: '设置创建一次', prompt: '镜头缓慢推进，展示真实产品细节。' }),
  }));
  assert.equal(createdTemplate.status, 201);
  const template = (await createdTemplate.json() as { template: { id: string } }).template;

  const candidates = await publicRoute.GET(request('GET', adminCookie));
  const body = await candidates.json() as { candidates: Array<{ resourceType: string; resourceId: string; name: string; preview: string; published: boolean; settingsHref: string }> };
  const candidate = body.candidates.find((item) => item.resourceId === template.id);
  assert.ok(candidate, '设置创建的视频提示词必须自动进入候选，不需要重新上传');
  assert.equal(candidate.resourceType, 'video_prompt_template');
  assert.equal(candidate.name, '统一候选验收模板');
  assert.match(candidate.preview, /真实产品细节/);
  assert.equal(candidate.published, false);
  assert.equal(candidate.settingsHref, '/settings?section=motion-template');

  const employeePublish = await publicRoute.POST(request('POST', employeeCookie, { resourceType: 'video_prompt_template', resourceId: template.id }));
  assert.equal(employeePublish.status, 403, '员工伪造资源身份发布必须被拒绝');
  const rejectedVersionRoot = await publicRoute.POST(request('POST', adminCookie, { resourceType: 'script_catalog', resourceId: 'any-library' }));
  assert.equal(rejectedVersionRoot.status, 409, '05 不能以发布库根冒充 06 的完整版本发布');

  for (let index = 0; index < 2; index += 1) {
    const published = await publicRoute.POST(request('POST', adminCookie, { resourceType: 'video_prompt_template', resourceId: template.id }));
    assert.equal(published.status, 200);
    const publishedBody = await published.json() as { published: boolean; alreadyPublished: boolean };
    assert.equal(publishedBody.published, true);
    assert.equal(publishedBody.alreadyPublished, index === 1, '重复发布必须幂等');
  }
  const missing = await publicRoute.POST(request('POST', adminCookie, { resourceType: 'video_prompt_template', resourceId: 'not-a-resource' }));
  assert.equal(missing.status, 404, '伪造不存在的身份必须失败且不能报假成功');

  db.prepare("UPDATE team_resource_scopes SET deletedAt = '2026-11-06' WHERE resourceType = 'video_prompt_template' AND resourceId = ?").run(template.id);
  const afterDelete = await publicRoute.GET(request('GET', adminCookie));
  const deletedBody = await afterDelete.json() as { candidates: Array<{ resourceId: string }> };
  assert.equal(deletedBody.candidates.some((item) => item.resourceId === template.id), false, '已失效资源不能留作假候选');
  console.log('PASS: unified resource candidates, publication permissions and idempotency');

  // 下一条纵向切片：管理员创建的标题与 LUT 必须在员工真实制作入口生效。
  const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
  assert.notEqual((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'batch-backups') })).state, 'compatibility_only');
  const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
  const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
  const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
  db.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('provider', '测试', 'http://127.0.0.1')").run();
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-employee', '员工项目', 'provider', 'model', '')").run();
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-employee', ownerUserId: employeeLogin.principal.userId });
  const employeeContext = createTeamAccessContext({ db, principal: employeeLogin.principal });
  const titleRoute = await import('../app/api/final-edit/title-presets/route.ts');
  const createdTitle = await titleRoute.POST(new Request('https://studio.example.test/api/final-edit/title-presets', {
    method: 'POST', headers: { Cookie: `${adminCookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test', 'x-csrf-token': 'csrf', 'content-type': 'application/json' },
    body: JSON.stringify({ name: '公共标题', version: 2, stylesByPreset: {} }),
  }));
  assert.equal(createdTitle.status, 400, '无效标题预设必须失败且不得留下可发布假候选');

  const { defaultTextStyle } = await import('../lib/media-core/cover-domain.ts');
  const { OUTPUT_PRESETS } = await import('../lib/media-core/cover-types.ts');
  const stylesByPreset = Object.fromEntries(Object.keys(OUTPUT_PRESETS).map((key) => [key, {
    primary: defaultTextStyle('coverPrimary', 1080), secondary: defaultTextStyle('coverSecondary', 1080),
    framing: { scale: 1, offsetX: 0, offsetY: 0 },
  }]));
  const validTitle = await titleRoute.POST(new Request('https://studio.example.test/api/final-edit/title-presets', {
    method: 'POST', headers: { Cookie: `${adminCookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test', 'x-csrf-token': 'csrf', 'content-type': 'application/json' },
    body: JSON.stringify({ name: '公共标题', version: 2, stylesByPreset }),
  }));
  assert.equal(validTitle.status, 201);
  const title = await validTitle.json() as { id: string };
  const privateTitleResponse = await titleRoute.GET(new Request('https://studio.example.test/api/final-edit/title-presets', { headers: { Cookie: employeeCookie } }));
  assert.equal((await privateTitleResponse.json() as Array<{ id: string }>).some((item) => item.id === title.id), false);
  assert.equal((await publicRoute.POST(request('POST', adminCookie, { resourceType: 'title_preset', resourceId: title.id }))).status, 200);
  const publicTitleResponse = await titleRoute.GET(new Request('https://studio.example.test/api/final-edit/title-presets', { headers: { Cookie: employeeCookie } }));
  assert.equal((await publicTitleResponse.json() as Array<{ id: string }>).some((item) => item.id === title.id), true, '发布后员工制作页使用的同一标题接口必须可读');

  const { createManagedLut, resolveColorSnapshot, listProjectLuts } = await import('../lib/batch-production/lut-catalog.ts');
  const lutRelativePath = 'storage/luts/project-employee/team-lut.cube';
  const lutPath = path.join(root, lutRelativePath);
  fs.mkdirSync(path.dirname(lutPath), { recursive: true });
  fs.writeFileSync(lutPath, 'TITLE "team"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  const lutId = runWithAccessContext(employeeContext, () => createManagedLut(db, 'project-employee', {
    contentFingerprint: `sha256:${'d'.repeat(64)}`, displayName: '团队暖色.cube', relativePath: lutRelativePath, fileSizeBytes: 100,
  }));
  assert.equal(runWithAccessContext(employeeContext, () => listProjectLuts(db, 'project-employee').some((item) => item.id === lutId)), true);
  const adminLutCandidates = await publicRoute.GET(request('GET', adminCookie));
  const lutCandidateBody = await adminLutCandidates.json() as { candidates: Array<{ resourceId: string; published: boolean }> };
  const lutCandidate = lutCandidateBody.candidates.find((item) => item.resourceId === lutId);
  assert.equal(lutCandidate?.published, false, '员工自己项目的 LUT 出现在管理员候选，但仍是待发布');
  assert.equal((await publicRoute.POST(request('POST', adminCookie, { resourceType: 'lut', resourceId: lutId }))).status, 200);
  const otherProject = 'project-other-employee';
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, 'provider', 'model', '')").run(otherProject, '另一项目');
  registerRootScope(db, { resourceType: 'project', resourceId: otherProject, ownerUserId: employeeLogin.principal.userId });
  assert.equal(runWithAccessContext(employeeContext, () => listProjectLuts(db, otherProject).some((item) => item.id === lutId)), true, '公开 LUT 必须能进入另一项目的制作选择列表');
  assert.equal(runWithAccessContext(employeeContext, () => resolveColorSnapshot(db, otherProject, { lutId })).lutId, lutId, '公开 LUT 必须可冻结进员工自己的批次输入');

  fs.writeFileSync(path.join(root, 'storage/luts/project-employee/missing.cube'), 'temporarily available');
  const invalidLutId = runWithAccessContext(employeeContext, () => createManagedLut(db, 'project-employee', {
    contentFingerprint: `sha256:${'e'.repeat(64)}`, displayName: '失效.cube',
    relativePath: 'storage/luts/project-employee/missing.cube', fileSizeBytes: 1,
  }));
  fs.unlinkSync(path.join(root, 'storage/luts/project-employee/missing.cube'));
  const beforeInvalid = await publicRoute.GET(request('GET', adminCookie));
  assert.equal((await beforeInvalid.json() as { candidates: Array<{ resourceId: string }> }).candidates.some((item) => item.resourceId === invalidLutId), false, '真实文件失效的 LUT 不能进入候选');
  const invalidPublish = await publicRoute.POST(request('POST', adminCookie, { resourceType: 'lut', resourceId: invalidLutId }));
  assert.equal(invalidPublish.status, 409);
  assert.match((await invalidPublish.json() as { message: string }).message, /不可用|不存在/);
  assert.equal(db.prepare("SELECT visibility FROM team_resource_scopes WHERE resourceType = 'lut' AND resourceId = ?").pluck().get(invalidLutId), 'private', '失败不能改变原发布状态');
  console.log('PASS: title preset employee use and public LUT project selection');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
