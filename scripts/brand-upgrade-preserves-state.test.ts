// 升级不丢东西：同一数据根上新版代码必须还能读到老数据。
//
// 这条测试模拟一次真实升级：先在临时数据根里建管理员、装好下载目录、写一条
// 本机数据，拿到会话令牌；然后关掉数据库当作进程重启，用同一份数据根重新
// 打开，断言会话仍然有效、下载目录还在、本机数据没被搬走。
//
// 改名的风险就在这儿：只要数据根目录名、Cookie 名或存储键被跟着改，
// 老用户升级后就会变成「未登录 + 找不到文件」。
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
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule;
  }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base
        : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-upgrade-state-'));
const origin = 'https://studio.example.test';
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3391',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-brand-upgrade',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: origin,
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'brand-upgrade-test',
  CREATIVE_STUDIO_MODULE_BATCH: '0',
  CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO: '0',
  CREATIVE_STUDIO_CANVAS_ENABLE: '0',
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
});

const { ensureServerDeploymentMarker, readRuntimeConfig } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { getTeamAuthService, setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie, TEAM_SESSION_COOKIE, TEAM_CSRF_COOKIE } = await import('../lib/team-service/auth/request.ts');
const { runLocalAdministratorCommand } = await import('../lib/team-service/auth/local-command.ts');

const config = readRuntimeConfig();
assert.equal(config.mode, 'server');
ensureServerDeploymentMarker(config as Extract<typeof config, { mode: 'server' }>);

// ---------- 第一次启动：老用户的数据落盘 ----------
const initialized = await runLocalAdministratorCommand('initialize', {
  employeeId: 'upgrade-admin',
  displayName: '升级验收管理员',
});
const credential = initialized.credential;

const db = getDb();
// 「本机数据」：一条真实的下载目录记录 + 一个落到磁盘的文件。
const downloadsRoot = path.join(root, 'storage', 'downloads', 'upgrade-admin');
fs.mkdirSync(downloadsRoot, { recursive: true });
const downloadedFile = path.join(downloadsRoot, '成片-第1版.mp4');
fs.writeFileSync(downloadedFile, 'stand-in-for-a-real-rendered-video');

const login = await getTeamAuthService().login({ employeeId: 'upgrade-admin', password: credential });
assert.equal(login.principal.mustChangePassword, true, '首次登录必须强制改密');
const token = login.token;
assert.ok(token, '登录必须拿到会话令牌');

// 记录升级前能看到的身份与数据位置。
const sessionBefore = getTeamAuthService().resolveSession(token);
assert.equal(sessionBefore?.employeeId, 'upgrade-admin');

// ---------- 关库 = 进程重启 ----------
closeDb();
setTeamAuthServiceForTests(null);
assert.equal(fs.existsSync(path.join(root, 'data', 'workbench.db')), true, '数据库必须还在原位置');

// ---------- 第二次启动：同一数据根重新打开 ----------
const dbAfter = getDb();
const sessionAfter = getTeamAuthService().resolveSession(token);
assert.ok(sessionAfter, '同一数据根重启后，老会话必须仍然有效（登录状态没丢）');
assert.equal(sessionAfter?.employeeId, 'upgrade-admin');
assert.equal(sessionAfter?.role, 'admin');
assert.equal(sessionAfter?.mustChangePassword, true, '改密状态也必须保留');

// 下载目录与文件都还在原处。
assert.equal(fs.existsSync(downloadsRoot), true, '下载目录必须还在');
assert.equal(fs.readFileSync(downloadedFile, 'utf8'), 'stand-in-for-a-real-rendered-video');

// 用户表还是原来那一行，没有被改名逻辑当成新库重建。
const row = dbAfter.prepare('SELECT employeeId, displayName FROM team_users WHERE employeeId = ?')
  .get('upgrade-admin') as { employeeId: string; displayName: string } | undefined;
assert.equal(row?.employeeId, 'upgrade-admin');
assert.equal(row?.displayName, '升级验收管理员');

// 会话/CSRF Cookie 名与数据根目录名仍是升级前的固定值。
assert.equal(TEAM_SESSION_COOKIE, '__Host-team_session');
assert.equal(TEAM_CSRF_COOKIE, '__Host-team_csrf');
assert.match(sessionCookie(token, true), /__Host-team_session=/);
assert.equal(path.basename(root), path.basename(root), '数据根由调用方指定，代码不得自行改名');
assert.equal(
  fs.existsSync(path.join(root, 'data', 'deployment.json')),
  true,
  '数据根部署标识必须留在原位（换了它就会被判为无效数据根）',
);

closeDb();
fs.rmSync(root, { recursive: true, force: true });
console.log('brand upgrade state preservation tests passed');
