/** node scripts/brand-login-page.playwright.test.mjs
 *
 * 登录页 PRD 验收：新品牌、主张、归属文字、四种校验提示都贴在输入框旁，
 * 首次登录改密码流程通过，Chromium + WebKit 浅色/深色截图无错位。
 *
 * 起的是隔离的真实 Next dev server（临时数据根 + 固定回环端口），
 * 不读写用户自己的 data/ 与 storage/。首次路由编译需要 1–2 分钟，
 * 首屏超时给 180s。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from '@playwright/test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-login-page-'));
const evidenceDirectory = path.join(root, 'evidence');
fs.mkdirSync(evidenceDirectory, { recursive: true });

const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const deploymentId = 'deployment-brand-login';

const OLD_NAMES = ['产品素材工作台', 'Creative Studio', '团队生产控制台', '我的创作空间'];
const NEW_PASSWORD = 'Brand-login-2026';

const environment = () => ({
  ...process.env,
  NEXT_TELEMETRY_DISABLED: '1',
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: String(port),
  CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
  CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'brand-login-test',
  // 隔离环境只能跑在 http://127.0.0.1。`__Host-` Cookie 强制 Secure，
  // WebKit 在纯 HTTP 下会直接丢弃它（Chromium 对 loopback 宽松），
  // 登录就会因为拿不到 CSRF Cookie 而 403。这里用仓库已有的 local-team
  // 回环 Cookie 模式（团队桌面版走的就是它），让两个内核都能跑真实流程。
  CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
  CREATIVE_STUDIO_CANVAS_ENABLE: '0',
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
});

/**
 * 首管理员的初始化与恢复。一次性凭据只能用一次，而每个浏览器内核都要走一遍
 * 首次登录改密：第一个内核用 init-admin，之后用 recover-admin 重置同一个人，
 * 两条命令都会把 mustChangePassword 置回 1，所以每个内核拿到的都是「首次登录」。
 */
function issueAdministratorCredential(employeeId, displayName, { recover }) {
  const script = recover ? 'scripts/team-server/recover-admin.mjs' : 'scripts/team-server/init-admin.mjs';
  const args = recover
    ? [script, '--employee-id', employeeId]
    : [script, '--employee-id', employeeId, '--name', displayName];
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  assert.equal(result.status, 0, `管理员凭据签发失败：${result.stdout ?? ''}${result.stderr ?? ''}`);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(result.stdout ?? '')?.[1];
  assert.ok(credential, `输出里没有一次性凭据：${result.stdout ?? ''}`);
  return credential;
}

const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const server = spawn(
  process.execPath,
  [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
  { cwd: repoRoot, env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
server.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });

async function waitReady(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dev server 提前退出：\n${serverOutput.slice(-4000)}`);
    try {
      const response = await fetch(`${baseUrl}/team/login`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch { /* 仍在编译 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dev server 未在期限内就绪：\n${serverOutput.slice(-4000)}`);
}

const browsers = [];
const results = [];

try {
  await waitReady();

  // 先建一个管理员账号；之后每个内核都用 recover 重置它，拿到新的首次登录凭据。
  const employeeId = 'brand-admin';
  let recover = false;

  for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const credential = issueAdministratorCredential(employeeId, `${name} 验收管理员`, { recover });
    recover = true;
    const browser = await launcher.launch({ headless: true });
    browsers.push(browser);
    const version = browser.version();
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const response = await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    assert.equal(response?.ok(), true, `${name}：登录页必须成功呈现`);
    await page.waitForLoadState('networkidle', { timeout: 180_000 });

    // ---------- 品牌面 ----------
    assert.match(await page.title(), /林视 Lin's Vision/, `${name}：浏览器标签必须是新名字`);
    const card = page.locator('section').first();
    await card.getByRole('heading', { name: "林视 Lin's Vision", exact: true }).waitFor({ timeout: 60_000 });
    await card.getByText('出片交给 AI，眼光留给你。', { exact: true }).waitFor();
    // 登录页底部归属文字（用户已确认）。
    await page.getByText("© 林视 Lin's Vision", { exact: true }).waitFor();
    // 新标志：登录卡片里的内联 SVG 用了品牌绿渐变。
    const markHtml = await card.locator('svg').first().innerHTML();
    assert.match(markHtml, /#46A97B/, `${name}：登录页标志必须用新品牌绿色`);
    assert.match(markHtml, /rotate\(-45 50 50\)/, `${name}：登录页标志必须是旋转 −45° 的叶子`);
    // 旧显示名不得出现在登录页自己的界面文字里。
    const loginText = await page.locator('main').innerText();
    for (const oldName of OLD_NAMES) {
      assert.ok(!loginText.includes(oldName), `${name}：登录页残留旧显示名「${oldName}」`);
    }
    // 全局顶栏（components/Header.tsx）归 05 号票；这里只记录，不判失败。
    const headerText = await page.locator('header').first().innerText().catch(() => '');
    const pendingInHeader = OLD_NAMES.filter((oldName) => headerText.includes(oldName));

    // ---------- 浅色 / 深色截图无错位（未登录态，登录后会被重定向走） ----------
    const screenshots = [];
    const backgrounds = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await page.waitForTimeout(300);
      const file = path.join(evidenceDirectory, `login-${name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: false });
      screenshots.push(file);

      const cardBox = await card.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(cardBox && viewport, `${name}/${theme}：卡片与视口必须可测`);
      assert.ok(cardBox.x >= 0 && cardBox.y >= 0, `${name}/${theme}：登录卡片被切到视口外（左上）`);
      assert.ok(
        cardBox.x + cardBox.width <= viewport.width + 1 && cardBox.y + cardBox.height <= viewport.height + 1,
        `${name}/${theme}：登录卡片被切到视口外（右下）`,
      );
      const attribution = await page.getByText("© 林视 Lin's Vision", { exact: true }).boundingBox();
      assert.ok(attribution, `${name}/${theme}：归属文字必须可见`);
      assert.ok(
        attribution.y >= cardBox.y + cardBox.height - 1,
        `${name}/${theme}：归属文字必须在登录卡片下方`,
      );
      const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
      assert.ok(background && background !== 'transparent', `${name}/${theme}：卡片背景不能是透明的`);
      backgrounds[theme] = background;
    }
    assert.notEqual(
      backgrounds.light,
      backgrounds.dark,
      `${name}：浅色与深色下登录卡片背景必须不同（说明走的是主题令牌，不是写死浅色）`,
    );
    const lightShot = fs.statSync(screenshots[0]).size;
    const darkShot = fs.statSync(screenshots[1]).size;
    assert.ok(lightShot > 5_000 && darkShot > 5_000, `${name}：浅色/深色截图内容可疑（${lightShot}/${darkShot} 字节）`);
    assert.notEqual(lightShot, darkShot, `${name}：浅色与深色截图不应是同一张图`);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

    // ---------- 四种校验提示都在输入框旁 ----------
    const employeeInput = page.locator('#login-employee-id');
    const passwordInput = page.locator('#login-current-password');
    const submit = page.getByRole('button', { name: '登录', exact: true });

    // ① 空工号
    await submit.click();
    const employeeError = page.locator('#login-employeeId-error');
    await employeeError.waitFor({ timeout: 15_000 });
    assert.equal(await employeeError.innerText(), '请输入工号');
    assert.equal(await employeeInput.getAttribute('aria-invalid'), 'true');
    const employeeBox = await employeeInput.boundingBox();
    const employeeErrorBox = await employeeError.boundingBox();
    assert.ok(employeeBox && employeeErrorBox, `${name}：工号框与提示必须可见`);
    assert.ok(
      employeeErrorBox.y >= employeeBox.y && employeeErrorBox.y - (employeeBox.y + employeeBox.height) < 40,
      `${name}：空工号提示必须紧贴在工号输入框旁`,
    );

    // ② 空密码
    const passwordError = page.locator('#login-currentPassword-error');
    await passwordError.waitFor({ timeout: 15_000 });
    assert.equal(await passwordError.innerText(), '请输入密码');
    const passwordBox = await passwordInput.boundingBox();
    const passwordErrorBox = await passwordError.boundingBox();
    assert.ok(passwordBox && passwordErrorBox, `${name}：密码框与提示必须可见`);
    assert.ok(
      passwordErrorBox.y >= passwordBox.y && passwordErrorBox.y - (passwordBox.y + passwordBox.height) < 40,
      `${name}：空密码提示必须紧贴在密码输入框旁`,
    );

    // 真凭据 + 工号 → 首次登录必须进入改密模式（而不是直接放行）。
    await employeeInput.fill(employeeId);
    await passwordInput.fill(credential);
    const loginResponsePending = page.waitForResponse(
      (server_response) => server_response.url().includes('/api/team/auth/login'),
      { timeout: 120_000 },
    );
    await submit.click();
    const loginResponse = await loginResponsePending;
    assert.equal(loginResponse.status(), 200, `${name}：登录接口必须成功（HTTP ${loginResponse.status()}）`);
    await page.locator('#login-new-password').waitFor({ timeout: 60_000 }).catch(async (cause) => {
      const text = (await page.locator('body').innerText()).slice(0, 600);
      throw new Error(`${name}：登录后未进入改密模式；页面文字=${text}`, { cause });
    });

    // ③ 新密码太短
    await page.locator('#login-current-password').fill(credential);
    await page.locator('#login-new-password').fill('123');
    await page.locator('#login-confirmation').fill('123');
    await page.getByRole('button', { name: '保存新密码并进入', exact: true }).click();
    const tooShort = page.locator('#login-newPassword-error');
    await tooShort.waitFor({ timeout: 15_000 });
    assert.match(await tooShort.innerText(), /至少 6 位/);
    const newPasswordBox = await page.locator('#login-new-password').boundingBox();
    const tooShortBox = await tooShort.boundingBox();
    assert.ok(
      newPasswordBox && tooShortBox && tooShortBox.y - (newPasswordBox.y + newPasswordBox.height) < 40,
      `${name}：新密码太短的提示必须紧贴在输入框旁`,
    );

    // ④ 两次不一致
    await page.locator('#login-new-password').fill(NEW_PASSWORD);
    await page.locator('#login-confirmation').fill(`${NEW_PASSWORD}-x`);
    await page.getByRole('button', { name: '保存新密码并进入', exact: true }).click();
    const mismatch = page.locator('#login-confirmation-error');
    await mismatch.waitFor({ timeout: 15_000 });
    assert.equal(await mismatch.innerText(), '两次输入的新密码不一致');
    const confirmationBox = await page.locator('#login-confirmation').boundingBox();
    const mismatchBox = await mismatch.boundingBox();
    assert.ok(
      confirmationBox && mismatchBox && mismatchBox.y - (confirmationBox.y + confirmationBox.height) < 40,
      `${name}：两次不一致的提示必须紧贴在确认框旁`,
    );

    // 全程都不该出现浏览器原生弹窗（noValidate + 我们自己的提示）。
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('form')[0]?.hasAttribute('novalidate')),
      true,
      `${name}：表单必须关闭浏览器原生校验提示`,
    );

    // ---------- 改密完成，回到登录页 ----------
    await page.locator('#login-confirmation').fill(NEW_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('reason') === 'password-changed', { timeout: 60_000 }),
      page.getByRole('button', { name: '保存新密码并进入', exact: true }).click(),
    ]);
    await page.getByText('密码已修改，请使用新密码重新登录。', { exact: true }).waitFor({ timeout: 60_000 });

    // 新密码可以真正登录进工作台。
    // 改密后会整页跳转，先等 React 重新水合完再填表——否则点击落在
    // 尚未绑定 onSubmit 的表单上，什么都不会发生（纯测试竞态）。
    await page.waitForLoadState('networkidle', { timeout: 120_000 });
    await page.getByRole('button', { name: '登录', exact: true }).waitFor({ timeout: 60_000 });
    await page.locator('#login-employee-id').fill(employeeId);
    await page.locator('#login-current-password').fill(NEW_PASSWORD);
    const reloginPending = page.waitForResponse(
      (server_response) => server_response.url().includes('/api/team/auth/login'),
      { timeout: 120_000 },
    );
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const relogin = await reloginPending;
    assert.equal(relogin.status(), 200, `${name}：改密后用新密码登录必须成功（HTTP ${relogin.status()}）`);
    await page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }).catch(async (cause) => {
      const text = (await page.locator('body').innerText()).slice(0, 600);
      throw new Error(`${name}：改密后未进入工作台；页面文字=${text}`, { cause });
    });
    // 管理员端页面标题必须是「林视控制台」。
    await page.waitForFunction(() => document.title.includes('林视'), null, { timeout: 120_000 });
    const workbenchTitle = await page.title();
    assert.match(workbenchTitle, /林视控制台/, `${name}：管理员端标题必须是林视控制台，实测 ${workbenchTitle}`);

    // 同一份 HTML 的 <title> 与静态首屏也对得上（不是只在客户端改的）。
    // 必须带会话 Cookie 取，否则看到的是登录页（未登录标题＝正式写法）。
    const adminHtml = await page.evaluate(() => fetch('/', {
      credentials: 'same-origin',
      headers: { accept: 'text/html' },
    }).then((response) => response.text()));
    const adminServerTitle = /<title>([^<]*)<\/title>/.exec(adminHtml)?.[1] ?? '';
    assert.match(adminServerTitle, /林视控制台/, `${name}：服务端 HTML 的标题也必须是林视控制台，实测 ${adminServerTitle}`);

    // 未登录（登录页）的标题必须是正式写法，不能猜端点。
    const anonymousContext = await browser.newContext({ locale: 'zh-CN' });
    try {
      const anonymousHtml = await anonymousContext.newPage()
        .then((anonymous) => anonymous.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
          .then((anonymousResponse) => anonymousResponse.text()));
      const anonymousTitle = /<title>([^<]*)<\/title>/.exec(anonymousHtml)?.[1] ?? '';
      assert.match(anonymousTitle, /林视 Lin/, `${name}：登录页标题必须是正式写法，实测 ${anonymousTitle}`);
      assert.doesNotMatch(anonymousTitle, /控制台|创作台/, `${name}：未登录时不得猜端点`);
    } finally {
      await anonymousContext.close();
    }

    // 员工端标题：管理员建一个员工账号，用它登录后标题必须是「林视创作台」。
    const created = await page.evaluate(async () => {
      const csrf = await fetch('/api/team/auth/csrf', { credentials: 'same-origin' })
        .then((response) => response.json());
      const response = await fetch('/api/team/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken },
        body: JSON.stringify({
          employeeId: `brand-emp-${Date.now().toString(36)}`,
          displayName: '员工端标题验收',
          role: 'employee',
        }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    });
    assert.equal(created.status, 201, `${name}：管理员必须能创建员工账号（HTTP ${created.status}）`);
    const employeeIdForTitle = created.body.user.employeeId;
    const employeeCredential = created.body.credential;

    const employeeContext = await browser.newContext({ locale: 'zh-CN' });
    const employeePage = await employeeContext.newPage();
    try {
      await employeePage.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await employeePage.waitForLoadState('networkidle', { timeout: 180_000 });
      await employeePage.locator('#login-employee-id').fill(employeeIdForTitle);
      await employeePage.locator('#login-current-password').fill(employeeCredential);
      await employeePage.getByRole('button', { name: '登录', exact: true }).click();
      // 首次登录仍要先改密；改完再用新密码进工作台。
      await employeePage.locator('#login-new-password').waitFor({ timeout: 60_000 });
      await employeePage.locator('#login-current-password').fill(employeeCredential);
      await employeePage.locator('#login-new-password').fill('Brand-employee-2026');
      await employeePage.locator('#login-confirmation').fill('Brand-employee-2026');
      await employeePage.getByRole('button', { name: '保存新密码并进入', exact: true }).click();
      await employeePage.waitForURL((url) => url.searchParams.get('reason') === 'password-changed', { timeout: 60_000 });
      await employeePage.waitForLoadState('networkidle', { timeout: 120_000 });
      await employeePage.locator('#login-employee-id').fill(employeeIdForTitle);
      await employeePage.locator('#login-current-password').fill('Brand-employee-2026');
      await employeePage.getByRole('button', { name: '登录', exact: true }).click();
      await employeePage.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 });
      await employeePage.waitForFunction(() => document.title.includes('林视'), null, { timeout: 120_000 });
      const employeeTitle = await employeePage.title();
      assert.match(employeeTitle, /林视创作台/, `${name}：员工端标题必须是林视创作台，实测 ${employeeTitle}`);
      assert.doesNotMatch(employeeTitle, /控制台/, `${name}：员工端不得出现控制台`);
    } finally {
      await employeeContext.close();
    }

    assert.deepEqual(pageErrors, [], `${name}：登录流程不应有页面脚本错误`);

    results.push({
      browser: name,
      version,
      employeeId,
      oldNamesPendingInSharedHeader: pendingInHeader,
      evidence: screenshots.map((file) => path.relative(root, file)),
      assertions: [
        '新品牌名与主张', '底部归属文字', '新叶子标志',
        '空工号提示贴身', '空密码提示贴身', '新密码太短提示贴身', '两次不一致提示贴身',
        '首次登录强制改密', '改密后可用新密码登录', '管理员端标题=林视控制台', '员工端标题=林视创作台',
        '浅色/深色截图无切裁', '浅色/深色卡片背景不同',
      ],
    });
    await context.close();
  }

  console.log(JSON.stringify({ ok: true, results, evidenceDirectory }, null, 2));
} finally {
  for (const browser of browsers) await browser.close().catch(() => undefined);
  if (server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}
