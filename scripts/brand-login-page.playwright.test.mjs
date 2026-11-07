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

const environment = () => ({
  ...process.env,
  NEXT_TELEMETRY_DISABLED: '1',
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: String(port),
  CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
  CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'brand-login-test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '0',
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
});

// 首管理员：一次性凭据只显示一次，改密流程就从它开始。
const initialized = spawnSync(
  process.execPath,
  ['scripts/team-server/init-admin.mjs', '--employee-id', 'brand-admin', '--name', '品牌验收管理员'],
  { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true },
);
assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${initialized.stderr ?? ''}`);
const initialCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
assert.ok(initialCredential, `初始化输出里没有一次性凭据：${initialized.stdout ?? ''}`);
const newPassword = 'Brand-login-2026';

const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
let server = spawn(process.execPath, [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: repoRoot, env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
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

  for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
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
    // 旧显示名一个都不许出现。
    const bodyText = await page.locator('body').innerText();
    for (const oldName of ['产品素材工作台', 'Creative Studio', '团队生产控制台', '我的创作空间']) {
      assert.ok(!bodyText.includes(oldName), `${name}：登录页残留旧显示名「${oldName}」`);
    }

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
    // 提示必须紧贴输入框，而不是页面顶部/底部的一条总错误。
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

    // 真密码 + 工号 → 首次登录必须进入改密模式（而不是直接放行）。
    await employeeInput.fill('brand-admin');
    await passwordInput.fill(initialCredential);
    await submit.click();
    await page.locator('#login-new-password').waitFor({ timeout: 60_000 });

    // ③ 新密码太短
    await page.locator('#login-current-password').fill(initialCredential);
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
    await page.locator('#login-new-password').fill(newPassword);
    await page.locator('#login-confirmation').fill(`${newPassword}-x`);
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
    await page.locator('#login-confirmation').fill(newPassword);
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('reason') === 'password-changed', { timeout: 60_000 }),
      page.getByRole('button', { name: '保存新密码并进入', exact: true }).click(),
    ]);
    await page.getByText('密码已修改，请使用新密码重新登录。', { exact: true }).waitFor({ timeout: 60_000 });

    // 新密码可以真正登录进工作台首页。
    await page.locator('#login-employee-id').fill('brand-admin');
    await page.locator('#login-current-password').fill(newPassword);
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
      page.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
    // 管理员端页面标题必须是「林视控制台」。
    await page.waitForFunction(() => document.title.includes('林视'), null, { timeout: 120_000 });
    const workbenchTitle = await page.title();
    assert.match(workbenchTitle, /林视控制台/, `${name}：管理员端标题必须是林视控制台，实测 ${workbenchTitle}`);

    // ---------- 浅色 / 深色截图无错位 ----------
    const screenshots = [];
    for (const theme of ['light', 'dark']) {
      await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await page.waitForLoadState('networkidle', { timeout: 180_000 });
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await page.waitForTimeout(300);
      const file = path.join(evidenceDirectory, `login-${name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: false });
      screenshots.push(file);

      // 卡片必须完整落在视口内、不被切；输入框与提示之间不重叠。
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
      // 深色下卡片背景必须真的换了色（不吃浅色写死值）。
      const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
      assert.match(background, /^rgba?\(/, `${name}/${theme}：卡片背景色必须是计算出的令牌值`);
    }
    const lightShot = fs.statSync(screenshots[0]).size;
    const darkShot = fs.statSync(screenshots[1]).size;
    assert.ok(lightShot > 5_000 && darkShot > 5_000, `${name}：浅色/深色截图内容可疑（${lightShot}/${darkShot} 字节）`);
    assert.notEqual(lightShot, darkShot, `${name}：浅色与深色截图不应是同一张图`);

    assert.deepEqual(pageErrors, [], `${name}：登录流程不应有页面脚本错误`);

    results.push({
      browser: name, version,
      evidence: screenshots.map((file) => path.relative(root, file)),
      assertions: [
        '新品牌名与主张', '底部归属文字', '新叶子标志',
        '空工号提示贴身', '空密码提示贴身', '新密码太短提示贴身', '两次不一致提示贴身',
        '首次登录强制改密', '改密后可用新密码登录', '管理员端标题=林视控制台',
        '浅色/深色截图无切裁',
      ],
    });
    await context.close();
  }

  console.log(JSON.stringify({ ok: true, results, evidenceDirectory }, null, 2));
} finally {
  for (const browser of browsers) await browser.close().catch(() => undefined);
  if (server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
