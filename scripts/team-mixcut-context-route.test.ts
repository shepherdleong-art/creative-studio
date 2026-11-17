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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-mixcut-context-route-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-team-mixcut-context-route',
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
  deploymentId: 'deployment-team-mixcut-context-route', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const firstLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const adminPassword = 'team-mixcut-context-route-password';
await service.changeOwnPassword(firstLogin.principal, initialized.credential, adminPassword);
const adminLogin = await service.login({ employeeId: '0000', password: adminPassword });
const created = await service.createUser(adminLogin.principal, { employeeId: '0001', displayName: '成员', role: 'employee' });
const employeeFirstLogin = await service.login({ employeeId: '0001', password: created.credential });
const employeePassword = 'team-mixcut-context-employee-password';
await service.changeOwnPassword(employeeFirstLogin.principal, created.credential, employeePassword);
const employeeLogin = await service.login({ employeeId: '0001', password: employeePassword });
const employeeCookie = sessionCookie(employeeLogin.token).split(';', 1)[0];
db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('image-provider', 'test', '', '', 'test')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-a', 'test', 'image-provider', 'test', '')").run();
db.prepare("INSERT INTO shot_sets (id, projectId, name) VALUES ('set-a', 'project-a', '现有分镜组')").run();
registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: employeeLogin.principal.userId });
registerInheritedScope(db, { resourceType: 'shot_set', resourceId: 'set-a', parent: { resourceType: 'project', resourceId: 'project-a' } });
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-b', 'private', 'image-provider', 'test', '')").run();
db.prepare("INSERT INTO shot_sets (id, projectId, name) VALUES ('set-b', 'project-b', '其他成员分镜组')").run();
registerRootScope(db, { resourceType: 'project', resourceId: 'project-b', ownerUserId: adminLogin.principal.userId });
registerInheritedScope(db, { resourceType: 'shot_set', resourceId: 'set-b', parent: { resourceType: 'project', resourceId: 'project-b' } });
const contextRoute = await import('../app/api/projects/[id]/final-edit/context/route.ts');
const params = { params: Promise.resolve({ id: 'project-a' }) };
const get = (query = '', cookie = employeeCookie) => new Request(`https://studio.example.test/api/projects/project-a/final-edit/context${query}`, { headers: { Cookie: cookie } });

try {
  const baseline = await contextRoute.GET(get(), params);
  assert.equal(baseline.status, 200, await baseline.clone().text());
  const baselineBody = await baseline.json() as { shotSets: Array<{ id: string }>; currentShotSetId: string | null };
  assert.deepEqual(baselineBody.shotSets.map((item) => item.id), ['set-a']);
  assert.equal(baselineBody.currentShotSetId, 'set-a');

  const stale = await contextRoute.GET(get('?shotSetId=deleted-or-stale-set'), params);
  assert.equal(stale.status, 200, `失效分镜组参数应回退到现有分镜组，实际返回 ${stale.status}: ${await stale.clone().text()}`);
  const staleBody = await stale.json() as { shotSets: Array<{ id: string }>; currentShotSetId: string | null };
  assert.deepEqual(staleBody.shotSets.map((item) => item.id), ['set-a'], '失效选择不得清空项目已有分镜组');
  assert.equal(staleBody.currentShotSetId, 'set-a');

  const foreignSelection = await contextRoute.GET(get('?shotSetId=set-b'), params);
  assert.equal(foreignSelection.status, 200);
  const foreignBody = await foreignSelection.json() as typeof baselineBody;
  assert.deepEqual(foreignBody.shotSets.map((item) => item.id), ['set-a'], '其他项目的选择不得泄露分镜组');
  assert.equal(foreignBody.currentShotSetId, 'set-a');

  const forbiddenProject = await contextRoute.GET(new Request('https://studio.example.test/api/projects/project-b/final-edit/context?shotSetId=set-a', {
    headers: { Cookie: employeeCookie },
  }), { params: Promise.resolve({ id: 'project-b' }) });
  assert.equal(forbiddenProject.status, 403, '已授权分镜组参数不得绕过项目权限');
  const anonymous = await contextRoute.GET(get('', ''), params);
  assert.equal(anonymous.status, 401, '匿名访问仍须拒绝');

  const missingProject = await contextRoute.GET(get(), { params: Promise.resolve({ id: 'missing-project' }) });
  assert.equal(missingProject.status, 404, '不存在的项目仍必须返回 404');

  console.log('PASS: mixcut context keeps project authorization and falls back from stale shotSetId');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
