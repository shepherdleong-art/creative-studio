/**
 * 服务器统一管理的生产参数（06 号票）——接口级。
 *
 * 覆盖任务单的四条验收：
 *   1. 团队版建项目：请求里带 concurrency/timeoutMs 被忽略，落库用服务器默认值；
 *      新项目同时落服务器默认视频并发。
 *   2. 团队版「已有项目新提交」走 start：请求里的并发/超时被忽略，队列拿到的
 *      是服务器默认值（`getEffectiveImageConcurrency` 与执行池逻辑保持不变，
 *      只换输入）。upload 路径的图片预处理参数同样被丢弃。
 *   3. 改服务器默认值后，新裁决用新值。
 *   4. 本地版仍按请求里的值。
 *
 * 走正式路由（`app/api/projects/route.ts`）+ 隔离数据根，写法照
 * `scripts/team-atomic-create.test.ts`。不联网、不碰真实数据根。
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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-production-defaults-'));
const previousEnv = { ...process.env };
const SERVER_ENV = {
  CREATIVE_STUDIO_DATA_ROOT: fixtureRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-production-defaults',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
};
Object.assign(process.env, SERVER_ENV);

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { resolveProductionParams, BUILTIN_PRODUCTION_DEFAULTS } = await import('../lib/team-service/production-defaults.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: fixtureRoot, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-production-defaults', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(fixtureRoot) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-production-defaults');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-production-defaults' });
const adminPrincipal = adminSession.principal;
const created = await service.createUser(adminPrincipal, { employeeId: '0001', displayName: '甲', role: 'employee' });
const login = await service.login({ employeeId: '0001', password: created.credential });
await service.changeOwnPassword(login.principal, created.credential, 'employee-production-defaults');
const authenticated = await service.login({ employeeId: '0001', password: 'employee-production-defaults' });
const employee = { principal: authenticated.principal, cookie: sessionCookie(authenticated.token).split(';', 1)[0] };

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-test', '测试', '', 'test-key', 'gpt-image-2')").run();
function unboundImage(id: string, ownerUserId: string) {
  db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path, usage) VALUES (?, NULL, 'input', ?, ?, 'scene_seed')").run(id, `${id}.png`, `originals/inputs/${id}.png`);
  registerRootScope(db, { resourceType: 'image', resourceId: id, ownerUserId });
  return id;
}

const projectsRoute = await import('../app/api/projects/route.ts');
const runRoute = await import('../app/api/projects/[id]/run/route.ts');
const uploadRoute = await import('../app/api/upload/route.ts');

function write(url: string, cookie: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${cookie}; __Host-team_csrf=production-csrf`,
      Origin: 'https://studio.example.test',
      'x-csrf-token': 'production-csrf',
    },
    body: JSON.stringify(body),
  });
}
function projectBody(sceneSeedImageId: string, shotImageIds: string[], extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-test', model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1k',
    storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷',
    sceneSeedImageId, shotImageIds, scenePrompt: '生成场景', shotPrompt: '生成分镜', generationCount: 1,
    ...extra,
  };
}
function readProject(id: string) {
  return db.prepare('SELECT concurrency, videoConcurrency, timeoutMs, maxAttempts FROM projects WHERE id = ?').get(id) as {
    concurrency: number; videoConcurrency: number; timeoutMs: number; maxAttempts: number;
  };
}

try {
  // ── 1. 团队版建项目：请求里的并发/超时被忽略 ──
  const createdA = await projectsRoute.POST(write('https://studio.example.test/api/projects', employee.cookie,
    projectBody(unboundImage('image-a-scene', employee.principal.userId), [unboundImage('image-a-shot', employee.principal.userId)], {
      concurrency: 3, videoConcurrency: 2, timeoutMs: 45_000, preprocessEnabled: false, targetMaxSide: 512, jpegQuality: 60,
    })));
  const createdABody = await createdA.text();
  assert.equal(createdA.status, 200, createdABody);
  const projectA = JSON.parse(createdABody) as { id: string };
  assert.deepEqual(readProject(projectA.id), {
    concurrency: 10,
    videoConcurrency: 10,
    timeoutMs: 600_000,
    maxAttempts: 2,
  }, '团队版建项目必须用服务器默认并发/视频并发/超时，忽略请求里的同名字段');

  // ── 2. 已有项目新提交（start）：队列用服务器默认值 ──
  // 先把项目改成客户端会写入的「更小」的值，模拟历史项目 / 旧客户端留下的数据。
  db.prepare('UPDATE projects SET concurrency = 2, timeoutMs = 12_000 WHERE id = ?').run(projectA.id);
  const startResponse = await runRoute.POST(write('https://studio.example.test/api/projects/x/run', employee.cookie, {
    action: 'start', concurrency: 1, timeoutMs: 1_000,
  }), { params: Promise.resolve({ id: projectA.id }) });
  const startBody = await startResponse.text();
  assert.equal(startResponse.status, 200, startBody);
  const startLog = db.prepare(`SELECT message FROM job_logs WHERE projectId = ? AND message LIKE '队列启动%' ORDER BY createdAt DESC LIMIT 1`)
    .pluck().get(projectA.id) as string | undefined;
  assert.ok(startLog, '队列启动必须留下可断言的日志');
  assert.match(startLog!, /concurrency=10, requested=10, maxAttempts=2, timeout=600000ms/,
    `已有项目新提交的任务也必须用服务器默认值，实际日志：${startLog}`);

  // start 之后队列可能仍在跑（fixture key 的任务只受理不执行），取消掉避免干扰后续断言。
  await runRoute.POST(write('https://studio.example.test/api/projects/x/run', employee.cookie, { action: 'cancel' }),
    { params: Promise.resolve({ id: projectA.id }) }).then((response) => response.arrayBuffer());

  // ── 3. 团队版 upload 路径的图片预处理：server 模式直接拒绝旧 multipart 入口，
  //    受控上传 /api/team/uploads 的图片选项替换在下面的纯函数断言里覆盖。 ──
  const form = new FormData();
  form.set('role', 'input');
  form.set('usage', 'scene_seed');
  form.set('preprocessEnabled', 'false');
  form.set('targetMaxSide', '512');
  form.set('jpegQuality', '60');
  form.set('files', new File([new Uint8Array([1, 2, 3])], 'upload.png', { type: 'image/png' }));
  const uploadResponse = await uploadRoute.POST(new Request('https://studio.example.test/api/upload', {
    method: 'POST',
    headers: {
      Cookie: `${employee.cookie}; __Host-team_csrf=production-csrf`,
      Origin: 'https://studio.example.test',
      'x-csrf-token': 'production-csrf',
    },
    body: form,
  }));
  const uploadBody = await uploadResponse.json() as { error?: string };
  assert.equal(uploadResponse.status, 409);
  assert.equal(uploadBody.error, 'controlled_upload_required',
    '团队版的图片必须走受控上传（那里的预处理参数由服务器统一决定）');

  // ── 3b. 受控上传：客户端 imageOptions 里的预处理三项被服务器默认值替换 ──
  // 走真正的 `/api/team/uploads` 路由，落库证据是 team_uploads.imageOptionsJson。
  const uploadsRoute = await import('../app/api/team/uploads/route.ts');
  const { createHash } = await import('node:crypto');
  const projectB = JSON.parse(await projectsRoute.POST(write('https://studio.example.test/api/projects', employee.cookie,
    projectBody('', []))).then((response) => response.text())) as { id: string };
  const fakeBytes = Buffer.alloc(64 * 1024, 7);
  const fakeSha = createHash('sha256').update(fakeBytes).digest('hex');
  const controlledUpload = await uploadsRoute.POST(write('https://studio.example.test/api/team/uploads', employee.cookie, {
    targetKind: 'project_image',
    targetScope: { resourceType: 'project', resourceId: projectB.id },
    usage: 'image',
    relativeName: 'raw.png',
    mimeType: 'image/png',
    expectedSize: fakeBytes.length,
    expectedSha256: fakeSha,
    sourceFingerprint: 'source-fingerprint',
    idempotencyKey: 'production-defaults-upload',
    // 客户端（可能是旧客户端）带来的预处理参数：必须被服务器默认值替换。
    imageOptions: { role: 'input', usage: 'scene_seed', preprocessEnabled: false, targetMaxSide: 512, jpegQuality: 60 },
  }));
  const controlledBody = await controlledUpload.text();
  assert.equal(controlledUpload.status, 200, controlledBody);
  const controlled = JSON.parse(controlledBody) as { uploadId: string };
  const storedOptions = db.prepare('SELECT imageOptionsJson FROM team_uploads WHERE id = ?')
    .pluck().get(controlled.uploadId) as string;
  assert.deepEqual(JSON.parse(storedOptions), {
    role: 'input', usage: 'scene_seed', preprocessEnabled: true, targetMaxSide: 1536, jpegQuality: 85,
  }, '受控上传落库的图片预处理参数必须是服务器默认值，忽略客户端传的 false / 512 / 60');

  // ── 4. 改服务器默认值后，新裁决用新值 ──
  const tunedDefaults = {
    timeoutMs: 900_000,
    projectConcurrency: 4,
    videoConcurrency: 3,
    imagePreprocess: { enabled: false, targetMaxSide: 2048, jpegQuality: 92 },
  };
  assert.deepEqual(
    resolveProductionParams({ mode: 'server', defaults: tunedDefaults, requested: { concurrency: 9, timeoutMs: 1 } }),
    tunedDefaults,
    '改服务器默认值后必须用新值，且仍忽略请求值',
  );

  // ── 5. 本地版仍按请求里的值 ──
  delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
  delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  delete process.env.CREATIVE_STUDIO_PORT;
  delete process.env.CREATIVE_STUDIO_DEPLOYMENT_ID;
  delete process.env.CREATIVE_STUDIO_TRUSTED_ORIGIN;
  assert.equal(resolveProductionParams({ mode: 'local', requested: { concurrency: 3 } }).projectConcurrency, 3,
    '本地版必须保留请求里的并发');
  assert.equal(resolveProductionParams({ mode: 'local', requested: { timeoutMs: 45_000 } }).timeoutMs, 45_000,
    '本地版必须保留请求里的超时');
  assert.deepEqual(resolveProductionParams({ mode: 'local' }), {
    timeoutMs: BUILTIN_PRODUCTION_DEFAULTS.timeoutMs,
    projectConcurrency: BUILTIN_PRODUCTION_DEFAULTS.projectConcurrency,
    videoConcurrency: BUILTIN_PRODUCTION_DEFAULTS.videoConcurrency,
    imagePreprocess: BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess,
  }, '本地版缺省回退到同一套默认值');

  console.log('production defaults route tests passed');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
