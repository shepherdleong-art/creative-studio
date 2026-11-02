import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-transfer-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-transfer-routes',
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

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-transfer-routes', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
const readiness = await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
assert.equal(readiness.available, true, JSON.stringify(readiness));
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const admin = await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-transfer-routes-password');
async function account(employeeId: string) {
  const created = await service.createUser(admin, { employeeId, displayName: employeeId, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  const principal = await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-transfer-routes-password`);
  return { principal, cookie: sessionCookie(login.token).split(';', 1)[0] };
}
const userA = await account('0001');
const userB = await account('0002');
registerRootScope(db, { resourceType: 'test_resource', resourceId: 'resource-a', ownerUserId: userA.principal.userId });
registerRootScope(db, { resourceType: 'test_resource', resourceId: 'resource-b', ownerUserId: userB.principal.userId });

const uploadsRoute = await import('../app/api/team/uploads/route.ts');
const uploadRoute = await import('../app/api/team/uploads/[id]/route.ts');
const partRoute = await import('../app/api/team/uploads/[id]/parts/[part]/route.ts');
const completeRoute = await import('../app/api/team/uploads/[id]/complete/route.ts');
const devicesRoute = await import('../app/api/team/devices/route.ts');
const downloadsRoute = await import('../app/api/team/downloads/route.ts');
const receiptsRoute = await import('../app/api/team/downloads/receipts/route.ts');
const legacyUploadRoute = await import('../app/api/upload/route.ts');
const legacyBatchImportRoute = await import('../app/api/batch-production/assets/import/route.ts');
const legacyCanvasImportRoute = await import('../app/api/canvas/[id]/assets/route.ts');

function request(url: string, user: { cookie: string }, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Cookie', `${user.cookie}; __Host-team_csrf=csrf-test`);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-csrf-token', 'csrf-test');
  return new Request(url, { ...init, headers });
}
const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }) satisfies RequestInit;

try {
  const bytes = Buffer.alloc(192 * 1024 + 17);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 253;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const createdResponse = await uploadsRoute.POST(request('https://studio.example.test/api/team/uploads', userA, {
    method: 'POST', ...json({
      target: { resourceType: 'test_resource', resourceId: 'resource-a' },
      relativeName: 'route/output.bin', mimeType: 'application/octet-stream', usage: 'output',
      expectedSize: bytes.length, expectedSha256: digest, sourceFingerprint: 'route-source-v1',
      idempotencyKey: 'route-upload-v1', partSize: 128 * 1024,
    }),
  }));
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  const createdBody = await createdResponse.json();
  const uploadId = createdBody.uploadId as string;
  assert.ok(uploadId);
  assert.equal(createdBody.missingParts.length, 2);

  const partOne = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 31));
      controller.enqueue(bytes.subarray(31, 128 * 1024));
      controller.close();
    },
  });
  const putResponse = await partRoute.PUT(request(`https://studio.example.test/api/team/uploads/${uploadId}/parts/1`, userA, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: partOne, duplex: 'half',
  } as RequestInit), { params: Promise.resolve({ id: uploadId, part: '1' }) });
  assert.equal(putResponse.status, 200, await putResponse.clone().text());
  assert.equal((await putResponse.json()).byteSize, 128 * 1024);

  const crossPut = await partRoute.PUT(request(`https://studio.example.test/api/team/uploads/${uploadId}/parts/2`, userB, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes.subarray(128 * 1024),
  }), { params: Promise.resolve({ id: uploadId, part: '2' }) });
  assert.equal(crossPut.status, 404);
  const putTwo = await partRoute.PUT(request(`https://studio.example.test/api/team/uploads/${uploadId}/parts/2`, userA, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes.subarray(128 * 1024),
  }), { params: Promise.resolve({ id: uploadId, part: '2' }) });
  assert.equal(putTwo.status, 200, await putTwo.clone().text());

  const status = await uploadRoute.GET(request(`https://studio.example.test/api/team/uploads/${uploadId}`, userA), {
    params: Promise.resolve({ id: uploadId }),
  });
  assert.deepEqual((await status.json()).missingParts, []);
  const deviceResponse = await devicesRoute.POST(request('https://studio.example.test/api/team/devices', userA, {
    method: 'POST', ...json({ clientDeviceId: 'route-device', displayName: '路由设备', platform: 'win32-x64' }),
  }));
  assert.equal(deviceResponse.status, 200, await deviceResponse.clone().text());
  const device = await deviceResponse.json();
  const completedResponse = await completeRoute.POST(request(`https://studio.example.test/api/team/uploads/${uploadId}/complete`, userA, {
    method: 'POST', ...json({ expectedSha256: digest, sourceFingerprint: 'route-source-v1' }),
  }), { params: Promise.resolve({ id: uploadId }) });
  assert.equal(completedResponse.status, 200, await completedResponse.clone().text());
  const completed = await completedResponse.json();
  assert.equal(completed.file.size, bytes.length);
  const repeated = await completeRoute.POST(request(`https://studio.example.test/api/team/uploads/${uploadId}/complete`, userA, {
    method: 'POST', ...json({}),
  }), { params: Promise.resolve({ id: uploadId }) });
  assert.equal((await repeated.json()).file.fileId, completed.file.fileId);
  const downloadResponse = await downloadsRoute.GET(request(`https://studio.example.test/api/team/downloads?deviceId=${device.id}`, userA));
  const downloads = await downloadResponse.json();
  assert.equal(downloads.items.length, 1);
  assert.equal(downloads.items[0].manifest.fileId, completed.file.fileId);
  const receiptResponse = await receiptsRoute.POST(request('https://studio.example.test/api/team/downloads/receipts', userA, {
    method: 'POST', ...json({
      deviceId: device.id, fileId: completed.file.fileId, artifactVersion: completed.file.version,
      state: 'completed', etag: completed.file.etag, verifiedSha256: completed.file.sha256,
    }),
  }));
  assert.equal(receiptResponse.status, 200, await receiptResponse.clone().text());
  assert.equal((await receiptResponse.json()).state, 'completed');
  assert.equal((await (await downloadsRoute.GET(request(`https://studio.example.test/api/team/downloads?deviceId=${device.id}`, userA))).json()).items.length, 0);
  const crossDevice = await downloadsRoute.GET(request(`https://studio.example.test/api/team/downloads?deviceId=${device.id}`, userB));
  assert.equal(crossDevice.status, 404);

  const cancelled = await uploadRoute.DELETE(request(`https://studio.example.test/api/team/uploads/${uploadId}`, userA, { method: 'DELETE' }), {
    params: Promise.resolve({ id: uploadId }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).state, 'ready', 'ready 后取消不能撤销生产文件');

  const legacyRequests = [
    () => legacyUploadRoute.POST(request('https://studio.example.test/api/upload', userA, { method: 'POST', body: new FormData() })),
    () => legacyBatchImportRoute.POST(request('https://studio.example.test/api/batch-production/assets/import?projectId=project-a', userA, { method: 'POST', body: new FormData() })),
    () => legacyCanvasImportRoute.POST(request('https://studio.example.test/api/canvas/canvas-a/assets', userA, { method: 'POST', body: new FormData() }), {
      params: Promise.resolve({ id: 'canvas-a' }),
    }),
  ];
  for (const legacyRequest of legacyRequests) {
    const response = await legacyRequest() as Response;
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'controlled_upload_required');
    assert.equal(body.uploadEndpoint, '/api/team/uploads');
  }

  console.log('PASS: authenticated streaming upload routes, idempotent complete, device downloads/receipts and cross-user isolation');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
