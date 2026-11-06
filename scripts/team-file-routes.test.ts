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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-file-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-file-routes',
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
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { registerReadyTeamFile } = await import('../lib/team-service/files/index.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-file-routes', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-file-routes-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-file-routes-password' });
const admin = adminSession.principal;
async function account(employeeId: string) {
  const created = await service.createUser(admin, { employeeId, displayName: employeeId, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-file-routes-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-file-routes-password` });
  return { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };
}
const userA = await account('0001');
const userB = await account('0002');
registerRootScope(db, { resourceType: 'test_resource', resourceId: 'resource-a', ownerUserId: userA.principal.userId });
registerRootScope(db, { resourceType: 'test_resource', resourceId: 'resource-b', ownerUserId: userB.principal.userId });
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'inputs'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'videos'), { recursive: true });
const imageBytes = Buffer.from('not-a-real-image-but-route-authorization-is-independent-of-codecs');
fs.writeFileSync(path.join(storageRoot, 'inputs', 'a.png'), imageBytes);
fs.writeFileSync(path.join(storageRoot, 'videos', 'b.mp4'), Buffer.from('0123456789'));
const fileA = registerReadyTeamFile(db, {
  storageRoot, absolutePath: path.join(storageRoot, 'inputs', 'a.png'), mimeType: 'image/png', ownerUserId: userA.principal.userId,
  references: [{ resourceType: 'test_resource', resourceId: 'resource-a' }],
});
registerReadyTeamFile(db, {
  storageRoot, absolutePath: path.join(storageRoot, 'videos', 'b.mp4'), mimeType: 'video/mp4', ownerUserId: userB.principal.userId,
  references: [{ resourceType: 'test_resource', resourceId: 'resource-b' }],
});

const imagesRoute = await import('../app/api/images/[...path]/route.ts');
const videosRoute = await import('../app/api/videos/[...path]/route.ts');
const filesRoute = await import('../app/api/team/files/[id]/route.ts');
const get = (url: string, cookie: string, headers: Record<string, string> = {}) => new Request(url, { headers: { Cookie: cookie, ...headers } });

try {
  const own = await imagesRoute.GET(get('https://studio.example.test/api/images/inputs/a.png', userA.cookie, { Range: 'bytes=2-8' }), {
    params: Promise.resolve({ path: ['inputs', 'a.png'] }),
  });
  assert.equal(own.status, 206);
  assert.equal(own.headers.get('Cache-Control'), 'private, no-store');
  assert.ok(own.headers.get('ETag'));
  assert.equal(Buffer.from(await own.arrayBuffer()).toString(), imageBytes.subarray(2, 9).toString());

  const cross = await imagesRoute.GET(get('https://studio.example.test/api/images/inputs/a.png', userB.cookie), {
    params: Promise.resolve({ path: ['inputs', 'a.png'] }),
  });
  assert.equal(cross.status, 404);
  const missingRegistration = await videosRoute.GET(get('https://studio.example.test/api/videos/b.mp4', userB.cookie), {
    params: Promise.resolve({ path: ['videos', 'b.mp4'] }),
  });
  assert.equal(missingRegistration.status, 200, await missingRegistration.clone().text());
  assert.equal((await videosRoute.GET(get('https://studio.example.test/api/videos/b.mp4', userA.cookie), {
    params: Promise.resolve({ path: ['videos', 'b.mp4'] }),
  })).status, 404);

  const byId = await filesRoute.GET(get(`https://studio.example.test/api/team/files/${fileA.id}`, userA.cookie), {
    params: Promise.resolve({ id: fileA.id }),
  });
  assert.equal(byId.status, 200);
  assert.equal(Buffer.from(await byId.arrayBuffer()).toString(), imageBytes.toString());
  assert.equal((await filesRoute.GET(get(`https://studio.example.test/api/team/files/${fileA.id}`, userB.cookie), {
    params: Promise.resolve({ id: fileA.id }),
  })).status, 404);

  fs.writeFileSync(path.join(storageRoot, 'inputs', 'unregistered.png'), 'secret');
  assert.equal((await imagesRoute.GET(get('https://studio.example.test/api/images/inputs/unregistered.png', userA.cookie), {
    params: Promise.resolve({ path: ['inputs', 'unregistered.png'] }),
  })).status, 404);
  console.log('PASS: legacy media paths and team file route enforce session + entity + ready file authorization');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
