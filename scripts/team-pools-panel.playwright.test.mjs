// 13 号票：控制台「模型与名额」的页面级验收（一个名额池一行）。
//
// 自带隔离环境：临时数据根 + server 模式 + 回环端口 + 断外网，自己初始化首管理员、
// 建一个员工账号、建两个同一个真实上游的图片供应商，然后用 Chromium 与 WebKit
// 分别验证页面行为（两种内核下都要成立）：
//
//   1. 账号行数 = 名额池数（同一个池下的两个模型只占一行）；
//   2. 改名额保存后，状态与顶部计数都更新（接口与页面一起看）；
//   3. 输入名额时不丢焦点（每敲一个字符后焦点还在同一格）；
//   4. 内部池编号默认看不到，展开并点开才看得到；
//   5. 同一凭据分属不同池时给出提醒，且只提醒不自动合并；
//   6. 员工访问被拒绝（沿用现有权限入口）。
//
// 用法：
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/team-pools-panel.playwright.test.mjs
// 环境变量（都有默认值）：
//   TEAM_POOLS_BROWSERS=chromium,webkit   TEAM_POOLS_EVIDENCE_DIR=...
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { buildPoolAdminView } from '../lib/team-service/pool-admin-view.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const evidenceDirectory = process.env.TEAM_POOLS_EVIDENCE_DIR
  ?? path.join(repoRoot, 'storage', 'test-evidence', 'team-pools-panel');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-pools-panel-'));
const browsersToRun = (process.env.TEAM_POOLS_BROWSERS ?? 'chromium,webkit')
  .split(',').map((value) => value.trim()).filter(Boolean);
fs.mkdirSync(evidenceDirectory, { recursive: true });

const result = {
  schemaVersion: 1, assertions: [], evidence: [], pageErrors: [], navigationCancelledFetches: [], browserRuns: [],
};
const secrets = new Set();
let server = null;
let baseUrl = '';
let port = 0;

/**
 * WebKit 会把**文档跳转时被取消的请求**报成 pageerror（05 号票已踩过同一坑）：
 *   - "…/api/… due to access control checks."（上一页的会话/列表请求在卸载时被中止）
 *   - "TypeError: Load failed"（同一个被中止请求冒泡到 window）
 * 本测试在同一页上连续 goto 多屏，必然产生这种记录；Chromium 不报。
 * 只把这两类**浏览器侧请求取消**单独归档，其它任何异常照旧算失败。
 */
const CANCELLED_REQUEST_PATTERNS = [
  /^[^:]+: \/127\.0\.0\.1:\d+\/(?:api|__nextjs_)[^\s]* due to access control checks\.$/,
  /^[^:]+: TypeError: Load failed$/,
];
function recordPageError(label) {
  return (error) => {
    const message = `${label}: ${error.message}`;
    if (CANCELLED_REQUEST_PATTERNS.some((pattern) => pattern.test(message))) {
      result.navigationCancelledFetches.push(message);
    } else {
      result.pageErrors.push(message);
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sanitize(text) {
  let safe = String(text).split(root).join('[isolated-data-root]');
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
  return safe;
}
async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}
function environment() {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${path.join(repoRoot, 'scripts', 'team-server', 'no-external-network.cjs').replaceAll('\\', '/')}"`,
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-pools-panel-test',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'pools-panel-test',
    CREATIVE_STUDIO_CANVAS_ENABLE: '0',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
    // 回环明文下 WebKit 会丢弃 Secure cookie，必须走仓库准备的本地 cookie 名。
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
  };
}
function startServer() {
  const nextBinary = fileURLToPath(import.meta.resolve('next/dist/bin/next'));
  server = spawn(process.execPath, [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot, env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const log = fs.createWriteStream(path.join(evidenceDirectory, 'server.log'), { flags: 'a' });
  server.stdout.on('data', (chunk) => log.write(sanitize(String(chunk))));
  server.stderr.on('data', (chunk) => log.write(sanitize(String(chunk))));
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  server = null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  await Promise.race([exited, sleep(10_000)]);
}
async function waitReady() {
  const deadline = Date.now() + 300_000;
  let last = null;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`隔离 Next 服务提前退出 ${server.exitCode}：${sanitize(fs.readFileSync(path.join(evidenceDirectory, 'server.log'), 'utf8')).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      last = response.status;
      if (response.status === 200) return;
    } catch { /* 还在编译 */ }
    await sleep(500);
  }
  throw new Error(`隔离 Next 服务 readiness 超时，最后状态 ${last}`);
}
function cookiePair(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, '认证响应必须设置 cookie');
  return value.split(';', 1)[0];
}
async function request(session, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (session) {
    headers.set('Cookie', session.cookies.join('; '));
    headers.set('Origin', baseUrl);
    if (options.method && options.method !== 'GET') headers.set('x-csrf-token', session.csrf);
  }
  if (!headers.has('x-creative-studio-client-version')) headers.set('x-creative-studio-client-version', '0.7.1');
  if (!headers.has('x-creative-studio-client-api')) headers.set('x-creative-studio-client-api', '1');
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  const { json, ...init } = options;
  return fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(120_000), ...init, headers,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}
async function jsonRequest(session, pathname, options = {}, expected = null) {
  const response = await request(session, pathname, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (expected !== null) assert.equal(response.status, expected, `${options.method ?? 'GET'} ${pathname}: ${text.slice(0, 900)}`);
  return { response, body };
}
async function login(employeeId, password) {
  const csrfResponse = await request(null, '/api/team/auth/csrf');
  assert.equal(csrfResponse.status, 200);
  const csrfCookie = cookiePair(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const loginResponse = await fetch(`${baseUrl}/api/team/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: csrfCookie, Origin: baseUrl, 'x-csrf-token': csrf },
    body: JSON.stringify({ employeeId, password }),
  });
  assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
  return { employeeId, csrf, cookies: [csrfCookie, cookiePair(loginResponse)] };
}
async function changePassword(session, currentPassword, newPassword) {
  const changed = await jsonRequest(session, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword, newPassword },
  }, 200);
  assert.equal(changed.body.requiresReauthentication, true);
  return login(session.employeeId, newPassword);
}

/** 与 `lib/media-core/execution/media-provider-pool.ts` 同一套指纹算法（测试自己算，不问接口）。 */
function credentialFingerprint(baseUrlValue, apiKey) {
  const normalized = new URL(baseUrlValue).toString().replace(/\/$/, '');
  return createHash('sha256').update(`${normalized}\0${apiKey.trim()}`).digest('hex');
}

/** 登录页真登录（浏览器会话），后续所有页面检查复用同一个 context。 */
async function loginViaUi(page, employeeId, password) {
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  // 表单是受控组件：必须等 hydration 完成再填，否则填进去的值会被 React 首帧状态覆盖。
  await page.waitForLoadState('networkidle', { timeout: 240_000 });
  await page.locator('#login-employee-id').fill(employeeId);
  await page.locator('#login-current-password').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // 首屏编译可能很慢，`waitForURL(load)` 会等一次没有 load 事件的客户端跳转；
  // 这里轮询路径，等的是「真的离开登录页」这个事实。
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname !== '/team/login') {
      await page.waitForLoadState('domcontentloaded', { timeout: 240_000 }).catch(() => undefined);
      return;
    }
    await sleep(200);
  }
  const body = await page.locator('body').innerText().catch(() => '');
  throw new Error(`登录后没有离开登录页：${sanitize(body).slice(0, 400)}`);
}

/** 轮询 URL 路径：App Router 的 `redirect()` 走客户端跳转，没有 load 事件可等。 */
async function waitForPath(page, pathname, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname === pathname) return;
    await sleep(100);
  }
  throw new Error(`等待跳到 ${pathname} 超时，当前是 ${page.url()}`);
}

async function runBrowser(name, launcher, credentials) {
  const run = { browser: name, version: null, assertions: [], result: 'passed' };
  const browser = await launcher.launch({ headless: true });
  try {
    run.version = await browser.version();
    result.assertions.push(`${name} ${run.version} 实际启动`);

    // ---------- 员工：入口被拒绝 ----------
    const employeeContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    try {
      const employeePage = await employeeContext.newPage();
      employeePage.on('pageerror', recordPageError(`employee/${name}`));
      await loginViaUi(employeePage, credentials.employee.id, credentials.employee.password);
      const employeeNavigation = await employeePage.goto(`${baseUrl}/team/admin/pools`, {
        waitUntil: 'domcontentloaded', timeout: 240_000,
      });
      assert.equal(employeeNavigation?.status(), 200, '员工访问被重定向到自己的主页，不是 500');
      // 服务端 `redirect('/')` 在 App Router 里是客户端路由跳转，不会有 load 事件；
      // 直接轮询 URL，比等一次永远不发生的导航更可靠。
      await waitForPath(employeePage, '/', 60_000);
      assert.equal(await employeePage.getByTestId('pool-row').count(), 0, '员工看不到任何名额池行');
      const forbidden = await employeePage.evaluate(async () => {
        const response = await fetch('/api/team/pools', { cache: 'no-store' });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(forbidden.status, 403, '员工读取名额池接口必须 403');
      assert.equal(JSON.stringify(forbidden.body).includes('media:'), false, '拒绝响应里不得出现池键');
      run.assertions.push('员工访问 /team/admin/pools 被拒绝（页面回首页、接口 403）');
    } finally {
      await employeeContext.close();
    }

    // ---------- 管理员 ----------
    const adminContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    try {
      const page = await adminContext.newPage();
      page.on('pageerror', recordPageError(`admin/${name}`));
      await loginViaUi(page, credentials.admin.id, credentials.admin.password);

      const beforeState = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
      const sharedPool = beforeState.pools.find((pool) => pool.poolKey === 'media:company');
      assert.ok(sharedPool, '验收夹具里必须有一个共享名额池');

      await page.goto(`${baseUrl}/team/admin/pools`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      // 外壳那条工具栏在页面挂载后才登记让位（05 号票），过渡瞬间可能同时存在两条；
      // 与 05 的验收一致，按第一条判断标题。
      await page.getByTestId('page-toolbar-title').first().getByText('模型与名额', { exact: true }).waitFor({ timeout: 60_000 });
      await page.getByTestId('pool-row').first().waitFor({ timeout: 60_000 });

      const rowCount = await page.getByTestId('pool-row').count();
      // 「账号行数 = 名额池数」：每一个已存进服务器的名额池都必须有且只有一行。
      // 同一池下的两个模型合进这一行；还没成池的账号（例如内置但没配密钥的公司网关模型）
      // 也各占一行，否则管理员没地方给它们设名额——路由 12 号票的总览也按同一口径读。
      assert.equal(
        await page.locator('[data-testid="pool-row"][data-pool-configured="true"]').count(),
        beforeState.pools.length,
        `已有名额池必须每个一行（${beforeState.pools.length}）`,
      );
      const expectedRows = buildPoolAdminView(beforeState).rows.length;
      assert.equal(rowCount, expectedRows, `账号行数必须等于聚合出来的行数（${expectedRows}）`);
      assert.ok(rowCount < beforeState.requirements.length, '不再按模型拆行：行数必须少于模型数');
      run.assertions.push(`账号行数 ${rowCount} = 名额池行数 ${expectedRows}；其中已配置池 ${beforeState.pools.length} 个，模型 ${beforeState.requirements.length} 条`);

      // Image 2 排队等待时间与名额池同一管理员页；保存后服务端持久，员工不能覆盖。
      // 02 号票改名：区块叫「模型通道分流」，字段叫「Image 2 排队等待时间」（单位秒），
      // 说明必须写清「七牛名额满时先等待；腾讯可用才转交；只影响 Image 2 提交前排队，不是生成超时」。
      const laneSection = page.getByRole('region', { name: '模型通道分流' });
      await laneSection.waitFor({ timeout: 30_000 });
      assert.match(await laneSection.innerText(), /Image 2 排队等待时间/);
      assert.match(await laneSection.innerText(), /七牛名额满时先等待；达到设定时间仍满，且腾讯通道可用时，才转交腾讯。/);
      assert.match(await laneSection.innerText(), /仅适用于 Image 2 的提交前排队，不是生成超时。/);
      const congestionInput = laneSection.getByLabel('Image 2 排队等待时间（秒）', { exact: true });
      await congestionInput.waitFor({ timeout: 30_000 });
      assert.equal(await congestionInput.inputValue(), String(beforeState.unifiedImageCongestion.imageCongestionThresholdSec));
      const saveCongestion = laneSection.getByRole('button', { name: '保存等待时间', exact: true });

      // 负数、小数、超范围都是客户端校验拦下：提示改名，且不会发保存请求。
      for (const invalid of ['-1', '1.5', '3601']) {
        await congestionInput.fill(invalid);
        await saveCongestion.click();
        await page.getByText('Image 2 排队等待时间必须是 0–3600 的整数秒。', { exact: true }).waitFor({ timeout: 30_000 });
        const unchanged = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
        assert.equal(
          unchanged.unifiedImageCongestion.imageCongestionThresholdSec,
          beforeState.unifiedImageCongestion.imageCongestionThresholdSec,
          `非法值 ${invalid} 不得被保存`,
        );
      }
      run.assertions.push('Image 2 排队等待时间：负数 / 小数 / 超范围由客户端拦下且不发保存请求');

      // 0 与 3600 是合法边界：0 = 不额外等待；3600 = 最多等一小时。保存后服务端必须是原字段。
      for (const boundary of [0, 3600]) {
        await congestionInput.fill(String(boundary));
        await saveCongestion.click();
        await page.getByText(new RegExp(`Image 2 排队等待时间已保存为 ${boundary} 秒`)).waitFor({ timeout: 60_000 });
        const savedBoundary = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
        assert.equal(
          savedBoundary.unifiedImageCongestion.imageCongestionThresholdSec,
          boundary,
          `边界值 ${boundary} 必须被接受并保存`,
        );
      }
      run.assertions.push('Image 2 排队等待时间：0 与 3600 两个边界值合法且服务端生效');

      const nextCongestion = beforeState.unifiedImageCongestion.imageCongestionThresholdSec === 10 ? 30 : 10;
      await congestionInput.fill(String(nextCongestion));
      const congestionPost = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== '/api/team/pools') return false;
        if (response.request().method() !== 'POST') return false;
        return (response.request().postData() ?? '').includes('unifiedImageCongestion');
      });
      await saveCongestion.click();
      // 保存 payload 的字段名不变：继续写 imageCongestionThresholdSec + expectedVersion。
      const congestionPayload = (await congestionPost).request().postData() ?? '';
      assert.match(congestionPayload, /"imageCongestionThresholdSec":\d+/);
      assert.match(congestionPayload, /"expectedVersion":\d+/);
      await page.getByText(new RegExp(`Image 2 排队等待时间已保存为 ${nextCongestion} 秒`)).waitFor({ timeout: 60_000 });
      const settingsState = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
      assert.equal(
        settingsState.unifiedImageCongestion.imageCongestionThresholdSec,
        nextCongestion,
        '管理员修改的 Image 2 排队等待时间必须持久化',
      );
      // 已保存的值要保留：刷新后输入框仍是服务器上的值，不会回到默认 30。
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 240_000 });
      await laneSection.waitFor({ timeout: 60_000 });
      assert.equal(
        await laneSection.getByLabel('Image 2 排队等待时间（秒）', { exact: true }).inputValue(),
        String(nextCongestion),
        '刷新后已保存的等待时间必须保留',
      );
      run.assertions.push(`管理员保存 Image 2 排队等待时间=${nextCongestion} 秒（payload 字段不变），刷新后保留`);

      // 已配置的那一行（页面按 `data-pool-key` 认池，不按账号名拼法）。
      const companyRow = page.locator('[data-testid="pool-row"][data-pool-key="media:company"]').first();
      await companyRow.waitFor({ timeout: 30_000 });
      credentials.accountName = (await companyRow.getByTestId('pool-account-name').innerText()).trim();
      assert.equal(await companyRow.getByText('2 个模型共用', { exact: true }).count(), 1, '同一个池下的两个模型必须汇总成一行');
      assert.equal(await page.getByText('media:company', { exact: true }).count(), 0, '内部池编号默认必须看不到');

      await companyRow.getByRole('button', { name: /^展开 / }).click();
      await companyRow.getByText('包含的模型', { exact: true }).waitFor({ timeout: 30_000 });
      // 展开后 `<details>` 里的编号在 DOM 里、但收起时不可见：按可见性判断，不按元素个数。
      const poolKeyText = companyRow.getByText('media:company', { exact: true }).first();
      assert.equal(await poolKeyText.isVisible(), false, '展开后仍要先点开才看得到编号');
      await companyRow.getByText('排查用的内部编号', { exact: true }).click();
      await poolKeyText.waitFor({ timeout: 30_000 });
      assert.equal(await poolKeyText.isVisible(), true, '点开「排查用的内部编号」才显示');
      run.assertions.push('内部池编号默认隐藏，展开并点开「排查用的内部编号」才显示');

      // 保存前的服务器状态（页面上的行就是它的聚合结果）。
      const beforeSavedState = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
      const beforeRow = buildPoolAdminView(beforeSavedState).rows.find((row) => row.poolKey === 'media:company');
      assert.ok(beforeRow);
      const targetCapacity = beforeRow.capacity + 5;

      // 输入名额不丢焦点：逐字输入后焦点还在同一格，值也全部落进输入框。
      const capacity = companyRow.getByRole('spinbutton');
      const capacityLabel = await capacity.getAttribute('aria-label');
      await capacity.click();
      await capacity.fill('');
      for (const digit of String(targetCapacity)) {
        await capacity.press(digit);
        const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
        assert.equal(focused, capacityLabel, `输入「${digit}」之后焦点必须还在名额输入框`);
      }
      assert.equal(await capacity.inputValue(), String(targetCapacity), '逐字输入不丢字');

      // 保存：先在预览里确认，再真正保存；保存后状态与顶部计数一起更新。
      const topLineBefore = await page.locator('[data-testid="page-toolbar"] small').first().textContent();
      const savedResponse = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== '/api/team/pools') return false;
        if (response.request().method() !== 'POST') return false;
        return !(response.request().postData() ?? '').includes('"preview":true');
      });
      await companyRow.getByRole('button', { name: '保存', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 30_000 });
      await dialog.getByText('确认改动名额', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '保存名额', exact: true }).click();
      assert.equal((await savedResponse).status(), 200, '保存名额必须由正式接口成功受理');
      await page.getByText(new RegExp(`名额已保存为 ${targetCapacity}`)).first().waitFor({ timeout: 60_000 });
      await companyRow.getByText('可以用', { exact: true }).waitFor({ timeout: 30_000 });

      const afterState = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
      const savedPool = afterState.pools.find((pool) => pool.poolKey === 'media:company');
      assert.equal(savedPool.capacity, targetCapacity, `改一次名额，整个池的容量都变成 ${targetCapacity}`);
      assert.equal(savedPool.version, beforeRow.version + 1, '一次保存只推进一个版本号');
      for (const entityId of credentials.providerIds) {
        const requirement = afterState.requirements.find((item) => item.key === `image:${entityId}`);
        assert.ok(requirement, `${entityId} 必须仍在 requirements 里`);
        assert.equal(requirement.poolKey, 'media:company');
        assert.equal(requirement.status, 'ready', `${entityId} 跟着池一起生效`);
        assert.equal(requirement.poolVersion, savedPool.version, `${entityId} 看到同一个新版本号`);
      }
      const topLineAfter = await page.locator('[data-testid="page-toolbar"] small').first().textContent();
      // 顶部计数就是同一份聚合的 summary：保存后必须与「服务器最新状态」一致。
      const afterView = buildPoolAdminView(afterState);
      const expectedTop = `${afterView.summary.ready} 个账号可以用，${afterView.summary.unconfigured} 个没设名额，`
        + `${afterView.summary.credentialMissing} 个缺密钥${afterView.summary.disabled > 0 ? `，${afterView.summary.disabled} 个已停用` : ''}`;
      assert.equal(topLineAfter?.trim(), expectedTop, '顶部计数必须等于最新聚合结果');
      assert.ok(
        afterView.summary.ready >= 1,
        '刚保存好的账号必须算进「可以用」',
      );
      assert.equal(
        await companyRow.getByRole('spinbutton').inputValue(),
        String(targetCapacity),
        '保存后输入框回到服务器值',
      );
      run.assertions.push(`改一次名额保存后池容量=${savedPool.capacity}、两个模型的版本=${savedPool.version}、顶部计数「${topLineBefore?.trim()}」→「${topLineAfter?.trim()}」`);
      void topLineBefore;

      // 同一凭据分属两个池：页面从打开起就要提醒，而且不会替管理员自动合并。
      const warning = page.getByRole('status', { name: '同一凭据被分到多个名额池' });
      await warning.waitFor({ timeout: 30_000 });
      assert.match(await warning.innerText(), /建议合并/);
      // 提醒只写在页面上：接口里的两个池都还在，行数也没被合并。
      const afterWarning = (await jsonRequest(credentials.adminApi, '/api/team/pools', {}, 200)).body;
      assert.equal(afterWarning.pools.length, beforeState.pools.length, '提醒不得自动合并：池一个都没少');
      assert.equal(
        await page.getByTestId('pool-row').count(),
        buildPoolAdminView(afterWarning).rows.length,
        '提醒后行数仍等于聚合出来的行数',
      );
      assert.equal(
        await page.locator(`[data-testid="pool-row"][data-pool-key="media:company"]`).count(),
        1,
        '共享池仍单独占一行',
      );
      assert.equal(
        await page.locator(`[data-testid="pool-row"][data-pool-key="${credentials.legacyPoolKey}"]`).count(),
        1,
        '同一凭据的另一个池也单独一行，没有被并进共享池',
      );
      run.assertions.push('同一凭据分属不同池时页面提醒，且不自动合并');

      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
          try { localStorage.setItem('creative-studio-theme', value); } catch { /* 无偏好也继续 */ }
        }, theme);
        await page.waitForTimeout(200);
        const file = `pools-${name}-${theme}.png`;
        await page.screenshot({ path: path.join(evidenceDirectory, file), fullPage: true });
        result.evidence.push(file);
      }
      run.assertions.push('浅色与深色都截图留证');
    } finally {
      await adminContext.close();
    }
  } catch (error) {
    run.result = 'failed';
    run.error = sanitize(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
  return run;
}

try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  startServer();
  await waitReady();
  result.assertions.push('隔离 Next server 在临时数据根与回环端口启动完成（无外网）');

  const initialized = spawnSync(process.execPath, [
    'scripts/team-server/init-admin.mjs', '--employee-id', 'pools-admin', '--name', '名额管理员',
  ], { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true });
  assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${sanitize(initialized.stderr ?? '')}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
  assert.ok(adminCredential, '必须拿到一次性凭据');
  secrets.add(adminCredential);

  const adminPassword = `Pools-admin-${randomBytes(9).toString('base64url')}`;
  secrets.add(adminPassword);
  let adminSession = await login('pools-admin', adminCredential);
  adminSession = await changePassword(adminSession, adminCredential, adminPassword);

  const employeeId = 'pools-0102';
  const created = await jsonRequest(adminSession, '/api/team/users', {
    method: 'POST', json: { employeeId, displayName: '名额员工', role: 'employee' },
  }, 201);
  const employeeCredential = created.body.credential;
  assert.ok(employeeCredential, '建号必须返回一次性凭据');
  secrets.add(employeeCredential);
  const employeePassword = `Pools-employee-${randomBytes(9).toString('base64url')}`;
  secrets.add(employeePassword);
  let employeeSession = await login(employeeId, employeeCredential);
  employeeSession = await changePassword(employeeSession, employeeCredential, employeePassword);

  // 两个 Key 属于同一个真实上游（同 baseUrl、不同 Key），管理员显式绑到同一个名额池。
  const gatewayBaseUrl = 'http://127.0.0.1:9';
  const providerIds = [];
  for (const suffix of ['A', 'B']) {
    const createdProvider = await jsonRequest(adminSession, '/api/providers', {
      method: 'POST',
      json: {
        name: `公司网关账号 ${suffix}`, baseUrl: gatewayBaseUrl,
        apiKey: `pools-fixture-${suffix}`, model: 'gpt-image-2', type: 'openai-compatible',
      },
    }, 200);
    assert.ok(createdProvider.body.id, '供应商必须由正式接口创建');
    providerIds.push(createdProvider.body.id);
  }
  const [providerA, providerB] = providerIds;
  await jsonRequest(adminSession, '/api/team/pools', {
    method: 'POST',
    json: {
      changes: [
        {
          action: 'bind-media-upstream', entityType: 'image', entityId: providerA,
          poolKey: 'media:company', capacity: 3, expectedVersion: 0,
        },
        {
          action: 'bind-media-upstream', entityType: 'image', entityId: providerB,
          poolKey: 'media:company', capacity: 3, expectedVersion: 1,
        },
      ],
    },
  }, 200);
  const configured = (await jsonRequest(adminSession, '/api/team/pools', {}, 200)).body;
  assert.equal(configured.pools.filter((pool) => pool.poolKey === 'media:company').length, 1, '两个 Key 共享一个池');
  assert.equal(
    configured.bindings.filter((binding) => binding.poolKey === 'media:company').length,
    2,
    '两个 Key 都绑到了同一个池',
  );
  const fingerprintA = credentialFingerprint(gatewayBaseUrl, 'pools-fixture-A');
  // 同一枚凭据再落到第二个池（真实场景：管理员在别的入口把这个账号又配了一次）。
  // 用正式接口写一个 legacy 映射池，池里就是这个指纹——页面必须提醒，接口不许自动合并。
  const legacyPoolKey = `media:split-${fingerprintA.slice(0, 8)}`;
  await jsonRequest(adminSession, '/api/team/pools', {
    method: 'POST',
    json: {
      changes: [{
        action: 'upsert', poolKey: legacyPoolKey, kind: 'remote', capacity: 1, enabled: true,
        mappingSnapshot: {
          protocol: 'legacy-media-upstream/1', baseUrl: gatewayBaseUrl,
          credentialFingerprint: fingerprintA,
        },
        expectedVersion: 0,
      }],
    },
  }, 200);
  const splitState = (await jsonRequest(adminSession, '/api/team/pools', {}, 200)).body;
  assert.equal(splitState.pools.length, 2, '验收夹具：同一凭据分别落在两个池');
  assert.equal(
    buildPoolAdminView(splitState).warnings.length,
    1,
    '验收夹具：两个池共用同一枚凭据，必须触发一条提醒',
  );

  const credentials = {
    admin: { id: 'pools-admin', password: adminPassword },
    employee: { id: employeeId, password: employeePassword },
    adminApi: adminSession,
    employeeApi: employeeSession,
    providerIds,
    accountName: '公司网关账号 A 等 2 个账号',
    baseUrlValue: gatewayBaseUrl,
    fingerprintA,
    legacyPoolKey,
  };
  const launchers = { chromium, webkit };
  for (const name of browsersToRun) {
    assert.ok(launchers[name]?.launch, `Playwright 没有 ${name} 内核`);
    result.browserRuns.push(await runBrowser(name, launchers[name], credentials));
  }
  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理的页面异常');
  result.assertions.push('两种内核都没有未处理的 pageerror');
  if (result.navigationCancelledFetches.length > 0) {
    result.assertions.push(`另有 ${result.navigationCancelledFetches.length} 条「文档跳转时被取消的 fetch」记录（WebKit 会报成 pageerror，非应用异常）`);
  }

  const failed = result.browserRuns.filter((run) => run.result !== 'passed');
  assert.deepEqual(failed, [], `浏览器验收失败：${JSON.stringify(failed)}`);
  result.result = 'passed';
  result.assertions.push('模型与名额页面级验收通过');
  console.log(`team pools panel ${result.result}; evidence written without session cookies`);
} catch (error) {
  result.result = 'failed';
  result.error = sanitize(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  console.error(`team pools panel failed: ${result.error}`);
} finally {
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
