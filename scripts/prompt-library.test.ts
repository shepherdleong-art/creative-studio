/**
 * 05 / 06 号票：「我的常用」提示词库。
 *
 * 覆盖三件事：
 * 1. 运镜 / 场景 / 分镜三类互不串台，列表按 category 过滤；
 * 2. 员工保存的全文归本人账号，跨项目（跨请求）可取用；
 * 3. 另一名员工读不到、也改不了别人的私有条目；公共预设只读原文。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-prompt-library-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-prompt-library',
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
const { normalizeMyPromptInput, personalCopyName, parsePromptCategory } = await import('../lib/prompt-library.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-prompt-library', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-prompt-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-prompt-password' });

async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(adminSession.principal, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-prompt-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-prompt-password` });
  return sessionCookie(authenticated.token).split(';', 1)[0];
}
const employeeA = await account('0001', '甲');
const employeeB = await account('0002', '乙');
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];

const route = await import('../app/api/video-prompt-templates/route.ts');
const itemRoute = await import('../app/api/video-prompt-templates/[id]/route.ts');

function write(cookie: string, body: Record<string, unknown>) {
  return route.POST(new Request('https://studio.example.test/api/video-prompt-templates', {
    method: 'POST',
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', 'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}
function list(cookie: string, category: string) {
  return route.GET(new Request(`https://studio.example.test/api/video-prompt-templates?category=${category}`, {
    headers: { Cookie: cookie },
  }));
}
function patch(cookie: string, id: string, body: Record<string, unknown>) {
  return itemRoute.PATCH(new Request(`https://studio.example.test/api/video-prompt-templates/${id}`, {
    method: 'PATCH',
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', 'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

// ---- 纯函数：分类与名称 ----
assert.equal(parsePromptCategory('scene'), 'scene');
assert.equal(parsePromptCategory('bogus'), 'camera_motion');
assert.equal(personalCopyName('卧室换景'), '我的 卧室换景');
assert.equal(normalizeMyPromptInput({ name: '', prompt: 'x' }).ok, false);
assert.equal(normalizeMyPromptInput({ name: 'n', prompt: '  ' }).ok, false);

// ---- 员工甲：三类各存一条 ----
const scene = await write(employeeA, { name: '甲的场景词', prompt: '甲写的场景全文，保持产品不变。', category: 'scene' });
assert.equal(scene.status, 201);
const shot = await write(employeeA, { name: '甲的分镜词', prompt: '甲写的分镜全文，参考图2换景。', category: 'shot' });
assert.equal(shot.status, 201);
const motion = await write(employeeA, { name: '甲的运镜词', prompt: '甲写的运镜全文，镜头缓慢推进。', category: 'camera_motion' });
assert.equal(motion.status, 201);
const sceneId = (await scene.json() as { template: { id: string } }).template.id;

// ---- 类别不串台 ----
const sceneList = await (await list(employeeA, 'scene')).json() as Array<{ name: string; prompt: string; isBuiltin: number }>;
assert.ok(sceneList.some((item) => item.name === '甲的场景词'), '场景列表能读到甲保存的场景词');
assert.ok(!sceneList.some((item) => item.name === '甲的分镜词'), '场景列表不得混入分镜词');
assert.ok(sceneList.some((item) => item.isBuiltin === 1), '公共场景预设同时可见');

const shotList = await (await list(employeeA, 'shot')).json() as Array<{ name: string }>;
assert.ok(shotList.some((item) => item.name === '甲的分镜词'));
assert.ok(!shotList.some((item) => item.name === '甲的场景词'));

// ---- 另一名员工看不到、也改不了 ----
const otherScene = await (await list(employeeB, 'scene')).json() as Array<{ id: string; name: string }>;
assert.ok(!otherScene.some((item) => item.id === sceneId), '员工乙不能看到甲的私有场景词');
const forbidden = await patch(employeeB, sceneId, { name: '乙改甲的词', prompt: '不该成功' });
assert.ok([403, 404].includes(forbidden.status), `乙改甲私有词必须被拒绝，实际 ${forbidden.status}`);
const stillOwn = await (await list(employeeA, 'scene')).json() as Array<{ id: string; name: string }>;
assert.equal(stillOwn.find((item) => item.id === sceneId)?.name, '甲的场景词', '甲的原文未被改动');

// ---- 甲自己可以更新，且更新后仍是自己的私有条目 ----
const updated = await patch(employeeA, sceneId, { name: '甲的场景词', prompt: '甲改过的场景全文。' });
assert.equal(updated.status, 200);
const afterUpdate = await (await list(employeeA, 'scene')).json() as Array<{ id: string; prompt: string }>;
assert.equal(afterUpdate.find((item) => item.id === sceneId)?.prompt, '甲改过的场景全文。');

// ---- 公共预设：员工改写不改公共原文，另存才是自己的 ----
const preset = (await (await list(employeeA, 'scene')).json() as Array<{ id: string; name: string; isBuiltin: number; prompt: string }>)
  .find((item) => item.isBuiltin === 1);
assert.ok(preset, '应存在管理员发布的场景公共预设');
const presetEdit = await patch(employeeA, preset!.id, { prompt: '员工想直接改公共原文' });
assert.ok([400, 403].includes(presetEdit.status), '员工不能直接改公共预设原文');
const copied = await write(employeeA, { name: personalCopyName(preset!.name), prompt: '员工改写后的全文', category: 'scene' });
assert.equal(copied.status, 201);
const presetAfter = (await (await list(employeeA, 'scene')).json() as Array<{ id: string; prompt: string }>).find((item) => item.id === preset!.id);
assert.equal(presetAfter?.prompt, preset!.prompt, '公共预设原文保持不变');

// ---- 员工不能把私有条目发布成公共 ----
const publishAttempt = await write(employeeA, { name: '甲的公共尝试', prompt: 'x', category: 'scene', visibility: 'public' });
assert.equal(publishAttempt.status, 403, '员工不能发布公共预设');
const adminPublish = await write(adminCookie, { name: '管理员发布的场景预设', prompt: '管理员原文', category: 'scene', visibility: 'public' });
assert.equal(adminPublish.status, 201);
const employeeSeesAdminPreset = await (await list(employeeB, 'scene')).json() as Array<{ name: string }>;
assert.ok(employeeSeesAdminPreset.some((item) => item.name === '管理员发布的场景预设'), '管理员发布的预设对员工可见');

await closeDb();
fs.rmSync(root, { recursive: true, force: true });
console.log('prompt library tests passed');
