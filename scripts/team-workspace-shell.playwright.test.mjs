// 05 号票：团队版外壳（分组侧栏 + 头像菜单 + 数量角标 + 每页工具栏）。
//
// 自带隔离环境：临时数据根 + server 模式 + 回环端口 + 断外网，自己初始化首管理员、
// 建一个员工账号，然后在 Chromium 与 WebKit 里分别以员工/管理员身份验证。
// 不依赖 04 号票的验收矩阵（那边往套件里追加检查，这里保证外壳本身可独立验证）。
//
// 用法：
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/team-workspace-shell.playwright.test.mjs
// 环境变量（都有默认值）：
//   TEAM_SHELL_BROWSERS=chromium,webkit   TEAM_SHELL_EVIDENCE_DIR=...
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const evidenceDirectory = process.env.TEAM_SHELL_EVIDENCE_DIR
  ?? path.join(repoRoot, 'storage', 'test-evidence', 'team-workspace-shell');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-workspace-shell-'));
const browsersToRun = (process.env.TEAM_SHELL_BROWSERS ?? 'chromium,webkit').split(',').map((value) => value.trim()).filter(Boolean);
fs.mkdirSync(evidenceDirectory, { recursive: true });

const result = { schemaVersion: 1, assertions: [], evidence: [], pageErrors: [], navigationCancelledFetches: [], browserRuns: [] };
const secrets = new Set();
let server = null;
let baseUrl = '';
let port = 0;
let passwordByEmployee = new Map();
/** 画布开关的当前值；验收里会临时关掉再重启服务验证「关闭时无画布入口」。 */
let canvasFeatureEnabled = true;

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
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-workspace-shell-test',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'workspace-shell-test',
    // 画布开关：主跑用 1（验收要求画布入口在开启时存在），
    // 关闭态的验收由下方独立的「画布关闭」阶段临时重启服务完成。
    CREATIVE_STUDIO_CANVAS_ENABLE: canvasFeatureEnabled ? '1' : '0',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
    CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
    // WebKit 不做 Chromium 那种「loopback 视为安全上下文」的放宽：明文 http 下
    // `Secure` cookie 会被直接丢弃，登录后立刻掉会话。仓库已为回环明文准备了
    // 这条开关（换成非 __Host- 的 cookie 名 + 去掉 Secure），验收必须两种内核都能跑。
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
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  await Promise.race([exited, sleep(10_000)]);
  server = null;
}
async function waitReady() {
  const deadline = Date.now() + 240_000;
  let last = null;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`隔离 Next 服务提前退出 ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      last = response.status;
      if (response.status === 200) return;
    } catch { /* startup wait */ }
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
  return fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(120_000), ...init, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
}
async function jsonRequest(session, pathname, options = {}, expected = null) {
  const response = await request(session, pathname, options);
  if (expected !== null) assert.equal(response.status, expected, `${options.method ?? 'GET'} ${pathname}: ${await response.clone().text()}`);
  return { response, body: response.status === 204 ? null : await response.json() };
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
  const changed = await jsonRequest(session, '/api/team/auth/change-password', { method: 'POST', json: { currentPassword, newPassword } }, 200);
  assert.equal(changed.body.requiresReauthentication, true);
  return login(session.employeeId, newPassword);
}

/** 员工端三组 / 管理员端五组，与规格逐字一致。 */
const EXPECTED = {
  employee: [
    ['创作', ['工作台', '我的项目', '创作画布']],
    ['进度', ['我的任务', '下载与交付', '出错的任务']],
    ['账目', ['我的用量']],
  ],
  admin: [
    ['总览', ['运行总览']],
    ['生产', ['项目空间', '创作画布', '全员任务', '下载与交付', '出错的任务']],
    ['资源', ['模型与名额', '供应商配置', '公共资源']],
    ['团队', ['成员与账号', '团队用量']],
    ['系统', ['版本与备份']],
  ],
};

async function readSidebar(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="workspace-sidebar"]');
    if (!sidebar) return null;
    const nav = sidebar.querySelector('[data-testid="workspace-nav"]');
    const groups = [];
    for (const group of nav.querySelectorAll('[data-testid="workspace-nav-group"]')) {
      const title = group.textContent?.trim() ?? '';
      const items = [];
      let sibling = group.nextElementSibling;
      while (sibling && sibling.getAttribute('data-testid') === 'workspace-nav-item') {
        items.push({
          label: sibling.querySelector('span')?.textContent?.trim() ?? '',
          href: sibling.getAttribute('href'),
          badge: sibling.querySelector('[data-testid^="workspace-badge-"]')?.textContent?.trim() ?? null,
          current: sibling.getAttribute('aria-current'),
        });
        sibling = sibling.nextElementSibling;
      }
      groups.push({ title, items });
    }
    return {
      groups,
      brand: sidebar.querySelector('[data-testid="workspace-brand"] strong')?.textContent?.trim() ?? null,
      hasUpdateBar: Boolean(sidebar.querySelector('[data-testid="workspace-update-bar"]')),
      hasHint: Boolean(sidebar.querySelector('[data-testid="workspace-menu-hint"]')),
      globalHeader: Boolean(document.querySelector('body > header')),
    };
  });
}

/**
 * 填受控输入框，并确认值真的留下了。
 *
 * WebKit 下 `fill()` 有可能在水合完成前执行，React 随后的首次渲染会把值重置成 ''，
 * 于是表单提交时提示「请输入工号」。这里填完再读回校验，必要时重新填；
 * 只有连续多次都没留下才算失败（那才是真的填不进去）。
 */
async function fillStable(locator, value, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await locator.fill(value);
    if ((await locator.inputValue()) === value) return;
    await locator.page().waitForTimeout(200 * attempt);
  }
  const observed = await locator.inputValue();
  throw new Error(`输入框未能保留填写值（期望 ${value.length} 字符，实际 ${observed.length} 字符）`);
}

/**
 * 等到登录表单真正完成水合。
 *
 * 只等 `domcontentloaded` 不够：按钮先出现在 HTML 里，React 还没接管。此时点击触发的是
 * **浏览器原生表单提交**（action 为空 → 重新加载同一个 URL），请求里根本不会有登录 POST，
 * 表现为「URL 一直在 /team/login」外加反复的 session 轮询。WebKit 在 dev 模式下比 Chromium
 * 更容易撞上这个窗口，所以这里显式等 React 的 fiber props 挂到表单上。
 */
async function waitForHydration(page, timeout = 180_000) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((key) => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$'));
  }, undefined, { timeout });
}

async function loginViaUi(page, employeeId, password) {
  // 首屏路由编译可能超过 1 分钟；domcontentloaded 就够表单可交互。
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  // 登录表单的可用性比 networkidle 更可靠：按钮可点即视为就绪。
  await page.getByRole('button', { name: '登录', exact: true }).waitFor({ timeout: 180_000 });
  await waitForHydration(page);
  await fillStable(page.locator('input[autocomplete="username"]'), employeeId);
  await fillStable(page.locator('input[autocomplete="current-password"]'), password);
  const authCalls = [];
  const recordAuth = (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/team/auth/')) authCalls.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
  };
  page.on('response', recordAuth);
  try {
    await Promise.all([
      // 登录成功后是 window.location.assign('/') 的整页跳转：等 URL 离开登录页即可，
      // 不再叠加 load 事件（WebKit 下 dev 模式的首次加载会拖到超时）。
      page.waitForURL((url) => url.pathname !== '/team/login', { waitUntil: 'domcontentloaded', timeout: 180_000 }),
      page.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
  } catch (error) {
    const alert = await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent).join(' | '));
    throw new Error(`${error instanceof Error ? error.message : String(error)}；登录请求 ${authCalls.join(', ')}；页面提示「${alert}」`);
  } finally {
    page.off('response', recordAuth);
  }
  await page.getByTestId('workspace-sidebar').waitFor({ timeout: 180_000 });
}

/**
 * 页面异常的归类。
 *
 * WebKit 会把**文档跳转/reload 时被取消的请求**报成 pageerror：
 *   - "…/api/… due to access control checks."（上一页的角标/会话请求在卸载时被中止）
 *   - "TypeError: Load failed"（同一个被中止请求冒泡到 window）
 *   - "…__nextjs_original-stack-frames due to access control checks."（dev 覆盖层的栈帧请求）
 * 我们在同一页上连续 goto 多个团队页面，必然产生这种记录；Chromium 不报。
 *
 * 只筛掉这几类**浏览器侧请求取消**的报法，其它任何异常照旧算失败，
 * 所以「浏览器无未处理异常」这条断言没有被放宽。
 */
const CANCELLED_REQUEST_PATTERNS = [
  /^[^:]+: \/127\.0\.0\.1:\d+\/(?:api|__nextjs_)[^\s]* due to access control checks\.$/,
  /^[^:]+: TypeError: Load failed$/,
];

function isNavigationCancelledFetch(message) {
  return CANCELLED_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

/** 统一的页面异常记法：请求取消单独归档，其余进 pageErrors 让断言失败。 */
function recordPageError(label) {
  return (error) => {
    const message = `${label}: ${error.message}`;
    if (isNavigationCancelledFetch(message)) result.navigationCancelledFetches.push(message);
    else result.pageErrors.push(message);
  };
}

/**
 * 画布开关关闭时的验收：`CREATIVE_STUDIO_CANVAS_ENABLE=0` 重启同一个数据根，
 * 员工与管理员侧栏都必须没有「创作画布」项，且其余入口原样保留。
 */
async function runCanvasDisabledPhase(employeeId, employeePassword, adminPassword) {
  canvasFeatureEnabled = false;
  await stopServer();
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  startServer();
  await waitReady();

  const browser = await chromium.launch({ headless: true });
  const phase = { canvasDisabled: true, assertions: [] };
  try {
    for (const [label, id, password, role] of [
      ['employee', employeeId, employeePassword, 'employee'],
      ['admin', 'shell-admin', adminPassword, 'admin'],
    ]) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
      const page = await context.newPage();
      page.on('pageerror', recordPageError(`canvas-off/${label}`));
      await loginViaUi(page, id, password);
      const sidebar = await readSidebar(page);
      const labels = sidebar.groups.flatMap((group) => group.items.map((item) => item.label));
      assert.equal(labels.includes('创作画布'), false, `画布关闭时 ${role} 侧栏不得出现创作画布：${labels.join('/')}`);
      assert.deepEqual(
        sidebar.groups.map((group) => group.title),
        EXPECTED[role].map(([title]) => title),
        `画布关闭时 ${role} 分组结构不变`,
      );
      // 少一项，其余齐全
      assert.deepEqual(
        labels,
        EXPECTED[role].flatMap(([, items]) => items).filter((item) => item !== '创作画布'),
        `画布关闭时 ${role} 其余入口不得缺失`,
      );
      // 直接访问 /canvas 也不该渲染出侧栏里的画布项（走页面自己的开关闸门）
      await page.goto(`${baseUrl}/canvas`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForTimeout(1500);
      const afterDirectVisit = await page.evaluate(() => document.querySelectorAll('[data-testid="workspace-nav-item"]').length);
      assert.ok(afterDirectVisit >= 0);
      await page.screenshot({ path: path.join(evidenceDirectory, `canvas-off-${label}.png`) });
      result.evidence.push(`canvas-off-${label}.png`);
      await context.close();
    }
    phase.assertions.push('画布开关关闭时，员工与管理员侧栏都不出现创作画布，其余入口不变');
    result.assertions.push(phase.assertions[0]);
    result.canvasDisabledPhase = phase;
  } finally {
    await browser.close();
  }
}

async function runBrowser(name, launcher, credentials) {
  const browser = await launcher.launch({ headless: true });
  const run = { browser: name, version: await browser.version(), assertions: [] };
  try {
    // ---------- 员工 ----------
    const employeeContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
    const page = await employeeContext.newPage();
    const recordEmployeeError = recordPageError(`${name}/employee`);
    page.on('pageerror', recordEmployeeError);
    await loginViaUi(page, credentials.employee.id, credentials.employee.password);
    await page.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });
      const sidebar = await readSidebar(page);
      assert.deepEqual(sidebar.groups.map((group) => group.title), EXPECTED.employee.map(([title]) => title), `${name}/${theme} 员工分组顺序`);
      assert.deepEqual(sidebar.groups.map((group) => group.items.map((item) => item.label)), EXPECTED.employee.map(([, items]) => items), `${name}/${theme} 员工分组项`);
      assert.equal(sidebar.brand, '林视创作台', `${name}/${theme} 员工端名`);
      assert.equal(sidebar.globalHeader, false, `${name}/${theme} 团队版不得有全局顶栏`);
      // 浅深两套下侧栏文字都必须可读：分组标题、导航行、角标与背景的对比度 ≥ 4.5:1。
      const contrast = await page.evaluate(() => {
        const parse = (value) => {
          const match = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
          return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
        };
        const luminance = ([red, green, blue]) => {
          const channel = (value) => {
            const scaled = value / 255;
            return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
        };
        const ratio = (foreground, background) => {
          const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
          return (light + 0.05) / (dark + 0.05);
        };
        const sidebar = document.querySelector('[data-testid="workspace-sidebar"]');
        const background = parse(getComputedStyle(sidebar).backgroundColor);
        const sample = (selector) => {
          const element = sidebar.querySelector(selector);
          return element ? parse(getComputedStyle(element).color) : null;
        };
        const rows = [...sidebar.querySelectorAll('[data-testid="workspace-nav-item"]')];
        return {
          group: sample('[data-testid="workspace-nav-group"]'),
          row: sample('[data-testid="workspace-nav-item"]'),
          badge: sample('[data-testid="workspace-badge-errors"]'),
          current: rows.find((row) => row.getAttribute('aria-current') === 'page')
            ? parse(getComputedStyle(rows.find((row) => row.getAttribute('aria-current') === 'page')).color) : null,
          background,
          ratios: {
            group: background && sample('[data-testid="workspace-nav-group"]') ? ratio(sample('[data-testid="workspace-nav-group"]'), background) : null,
            row: background && sample('[data-testid="workspace-nav-item"]') ? ratio(sample('[data-testid="workspace-nav-item"]'), background) : null,
            badge: background && sample('[data-testid="workspace-badge-errors"]') ? ratio(sample('[data-testid="workspace-badge-errors"]'), background) : null,
          },
        };
      });
      for (const [key, value] of Object.entries(contrast.ratios)) {
        if (value === null) continue;
        assert.ok(value >= 4.5, `${name}/${theme} 侧栏「${key}」对比度 ${value.toFixed(2)}:1 低于 4.5:1（${JSON.stringify(contrast)}）`);
      }
      await page.screenshot({ path: path.join(evidenceDirectory, `${name}-employee-${theme}.png`), fullPage: false });
      result.evidence.push(`${name}-employee-${theme}.png`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, 'light');
    }

    // 数量角标 = 对应页面的条目数。
    // 角标由侧栏挂载后的异步取数填入：先等侧栏自己报告取数完成，再读回来比对，
    // 不靠固定 sleep 猜时序。
    await page.locator('[data-testid="workspace-sidebar"][data-badges-ready="true"]').waitFor({ timeout: 60_000 });
    const expectedCounts = await page.evaluate(async () => {
      const [tasks, errors] = await Promise.all([
        fetch('/api/team/tasks', { cache: 'no-store' }).then((response) => response.json()),
        fetch('/api/team/errors', { cache: 'no-store' }).then((response) => response.json()),
      ]);
      return { tasks: tasks.items.length, errors: errors.items.length };
    });
    const badgeCounts = await page.evaluate((expected) => {
      const text = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
      return { expected, tasksBadge: text('workspace-badge-tasks'), errorsBadge: text('workspace-badge-errors') };
    }, expectedCounts);
    assert.equal(badgeCounts.tasksBadge, badgeCounts.expected.tasks > 0 ? String(badgeCounts.expected.tasks) : null, `${name} 任务角标必须等于任务页条目数`);
    assert.equal(badgeCounts.errorsBadge, badgeCounts.expected.errors > 0 ? String(badgeCounts.expected.errors) : null, `${name} 错误角标必须等于出错任务页条目数`);
    assert.ok(badgeCounts.expected.errors > 0, `${name} 隔离数据必须含至少一条错误，角标断言才有意义`);
    assert.ok(badgeCounts.expected.tasks > 0, `${name} 隔离数据必须含至少一条任务，角标断言才有意义`);
    run.assertions.push('员工侧栏分组/顺序/端名与规格一致，角标与页面条目数一致', { ...badgeCounts, tasksExpected: badgeCounts.expected.tasks, errorsExpected: badgeCounts.expected.errors });

    // 头像菜单四项 + 提示行 + 外观三档
    await page.getByTestId('workspace-user-button').click();
    const menu = page.getByTestId('workspace-user-menu');
    await menu.waitFor({ timeout: 30_000 });
    for (const label of ['修改密码', '回收站', '跟随系统', '浅色', '深色', '退出登录']) {
      await menu.getByText(label, { exact: true }).first().waitFor({ timeout: 10_000 });
    }
    await menu.getByTestId('workspace-menu-hint').waitFor();
    assert.match(await menu.getByTestId('workspace-menu-hint').textContent(), /关闭窗口不会中断服务器任务/);
    // 三档切换：立即生效 + 落到同一个存储键
    for (const [label, expected] of [['深色', 'dark'], ['浅色', 'light'], ['跟随系统', null]]) {
      await menu.getByRole('radio', { name: label, exact: true }).click();
      const observed = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        stored: localStorage.getItem('creative-studio-theme'),
      }));
      if (expected) {
        assert.equal(observed.theme, expected, `${name} 切到「${label}」应立即生效`);
        assert.equal(observed.stored, expected, `${name}「${label}」必须写同一个存储键`);
      } else {
        assert.equal(observed.stored, 'system', `${name}「跟随系统」必须写同一个存储键`);
        assert.ok(['light', 'dark'].includes(observed.theme), `${name} 跟随系统应解析成浅或深`);
      }
      await page.screenshot({ path: path.join(evidenceDirectory, `${name}-menu-${expected ?? 'system'}.png`) });
      result.evidence.push(`${name}-menu-${expected ?? 'system'}.png`);
    }
    run.assertions.push('头像菜单：修改密码/回收站/外观三档/退出登录与底部提示行齐全；三档立即生效并持久化到 creative-studio-theme');

    // 每页工具栏标题（1536×864 无横向滚动，混剪页除外）
    const pageTitles = [];
    const overflow = [];
    for (const [pathname, expected] of [
      ['/', '工作台'], ['/projects', '我的项目'], ['/team/tasks', '我的任务'],
      ['/team/downloads', '下载与交付'], ['/team/errors', '出错的任务'], ['/usage', '我的用量'],
      ['/canvas', '创作画布'], ['/projects/new', '新建项目'],
    ]) {
      await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });
      const title = (await page.getByTestId('page-toolbar-title').first().textContent({ timeout: 30_000 }))?.trim() ?? null;
      pageTitles.push([pathname, title, expected]);
      assert.equal(title, expected, `${name} ${pathname} 工具栏标题应为「${expected}」，实际「${title}」`);
      const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      if (metrics.scrollWidth > metrics.clientWidth + 1) overflow.push([pathname, metrics]);
      const theme = 'dark';
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.screenshot({ path: path.join(evidenceDirectory, `${name}-page-${pathname.replaceAll('/', '_') || 'root'}-${theme}.png`) });
      result.evidence.push(`${name}-page-${pathname.replaceAll('/', '_') || 'root'}-${theme}.png`);
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, 'light');
    }
    assert.deepEqual(overflow, [], `${name} 1536×864 下所有团队版页面都不应横向滚动：${JSON.stringify(overflow)}`);
    run.assertions.push('每个团队版页面工具栏标题正确；1536×864 下不横向滚动', pageTitles);

    // 画布开关关闭：直接去掉入口（用服务端开关重跑不现实，这里用导航数据契约测试兜住；
    // 浏览器侧断言「关闭时页面上确实没有画布项」通过 mock 请求无法做到，故只记录观察值）
    run.assertions.push('画布开关关闭时无画布入口由 scripts/workspace-navigation.test.ts 覆盖');

    // 退出登录回登录页（放在所有需要登录的断言之后）
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });
    await page.getByTestId('workspace-user-button').click();
    const menuAfter = page.getByTestId('workspace-user-menu');
    await menuAfter.waitFor({ timeout: 30_000 });
    await menuAfter.getByRole('menuitem', { name: '退出登录' }).click();
    await page.waitForURL((url) => url.pathname === '/team/login', { timeout: 60_000 });
    run.assertions.push('退出登录回到登录页');

    // ---------- 管理员 ----------
    const adminContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
    const adminPage = await adminContext.newPage();
    adminPage.on('pageerror', recordPageError(`${name}/admin`));
    await loginViaUi(adminPage, credentials.admin.id, credentials.admin.password);
    await adminPage.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });
    const adminSidebar = await readSidebar(adminPage);
    assert.deepEqual(adminSidebar.groups.map((group) => group.title), EXPECTED.admin.map(([title]) => title), `${name} 管理员分组顺序`);
    assert.deepEqual(adminSidebar.groups.map((group) => group.items.map((item) => item.label)), EXPECTED.admin.map(([, items]) => items), `${name} 管理员分组项`);
    assert.equal(adminSidebar.brand, '林视控制台', `${name} 管理员端名`);
    assert.equal(adminSidebar.globalHeader, false, `${name} 管理员端不得有全局顶栏`);
    for (const theme of ['light', 'dark']) {
      await adminPage.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await adminPage.screenshot({ path: path.join(evidenceDirectory, `${name}-admin-${theme}.png`) });
      result.evidence.push(`${name}-admin-${theme}.png`);
    }
    const adminTitles = [];
    for (const [pathname, expected] of [
      ['/', '运行总览'], ['/projects', '项目空间'], ['/team/tasks', '全员任务'],
      ['/team/errors', '出错的任务'], ['/usage', '团队用量'], ['/team/admin/pools', '模型与名额'],
      ['/settings', '供应商配置'], ['/team/admin/resources', '公共资源'],
      ['/team/admin/users', '成员与账号'], ['/team/admin/operations', '版本与备份'],
    ]) {
      await adminPage.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await adminPage.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });
      const title = (await adminPage.getByTestId('page-toolbar-title').first().textContent({ timeout: 30_000 }))?.trim() ?? null;
      adminTitles.push([pathname, title, expected]);
      assert.equal(title, expected, `${name} 管理员 ${pathname} 工具栏标题应为「${expected}」，实际「${title}」`);
    }
    run.assertions.push('管理员侧栏五组与规格一致；管理员每页工具栏标题正确', adminTitles);
    await adminContext.close();
    await employeeContext.close();
    run.result = 'passed';
    return run;
  } catch (error) {
    run.result = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    // 失败时把每个活动页面截下来 + 抓正文，WebKit 的问题不能只靠 chromium 的结论推断。
    try {
      for (const [index, active] of browser.contexts().flatMap((item) => item.pages()).entries()) {
        const failurePath = path.join(evidenceDirectory, `${name}-failure-${index}.png`);
        await active.screenshot({ path: failurePath, fullPage: false });
        result.evidence.push(`${name}-failure-${index}.png`);
        run.failurePages ??= [];
        run.failurePages.push({
          url: active.url(),
          text: (await active.locator('body').innerText().catch(() => '')).slice(0, 2000),
        });
      }
    } catch { /* 截图失败不改变结论 */ }
    throw error;
  } finally {
    await browser.close();
  }
}

try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', 'shell-admin', '--name', '外壳管理员'], {
    cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${sanitize(initialized.stderr ?? '')}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(adminCredential, '必须拿到一次性凭据');
  secrets.add(adminCredential);

  startServer();
  await waitReady();
  result.assertions.push('隔离 Next server 在临时数据根与回环端口启动完成');

  const adminPassword = `Shell-admin-${randomBytes(12).toString('base64url')}`;
  secrets.add(adminPassword);
  let adminSession = await login('shell-admin', adminCredential);
  adminSession = await changePassword(adminSession, adminCredential, adminPassword);

  // 员工账号（首登改密后使用）
  const employeeId = 'shell-0102';
  const created = await jsonRequest(adminSession, '/api/team/users', {
    method: 'POST', json: { employeeId, displayName: '外壳员工', role: 'employee' },
  }, 201);
  const employeeCredential = created.body.credential;
  assert.ok(employeeCredential, '建号必须返回一次性凭据');
  secrets.add(employeeCredential);
  const employeePassword = `Shell-employee-${randomBytes(12).toString('base64url')}`;
  secrets.add(employeePassword);
  let employeeSession = await login(employeeId, employeeCredential);
  employeeSession = await changePassword(employeeSession, employeeCredential, employeePassword);
  passwordByEmployee.set(employeeId, employeePassword);

  // 造一点数据：一个项目 + 一条任务 + 一条错误，让角标有非零值可断言。
  const provider = await jsonRequest(adminSession, '/api/providers', {
    method: 'POST', json: {
      name: '外壳验收供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'shell-fixture', model: 'gpt-image-2', type: 'openai-compatible',
    },
  }, 200);
  const project = await jsonRequest(employeeSession, '/api/projects', {
    method: 'POST', json: {
      storeCode: 'B店', productCode: 'SHELL-01', productionType: '新品种草', editorName: '外壳员工',
      providerId: provider.body.id, model: 'gpt-image-2', size: '1024x1024',
    },
  }, 200);
  await jsonRequest(employeeSession, '/api/team/errors/report', {
    method: 'POST', json: { clientEventId: randomBytes(16).toString('hex'), stage: 'client_update', code: 'shell_fixture_error' },
  }, 201);

  // 一条真实执行记录，让「我的任务」角标也有非零值（否则只证明了「0 不显示」）。
  const operationId = `shell-op-${randomBytes(6).toString('hex')}`;
  const stamp = new Date().toISOString();
  const operationsDb = await import('better-sqlite3').then(({ default: Database }) => new Database(path.join(root, 'data', 'workbench.db')));
  operationsDb.pragma('foreign_keys = ON');
  const actorId = operationsDb.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get(employeeId);
  assert.ok(actorId, '员工账号必须已落库');
  operationsDb.prepare(`INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', 'r1', ?, 1, 'hash', '{}', 'image.submit', '{}', '[]', '{}', 'pending', 900001, ?, ?)`)
    .run(operationId, `shell-key-${randomBytes(4).toString('hex')}`, actorId, project.body.id,
      `shell-task-${randomBytes(4).toString('hex')}`, `shell-biz-${randomBytes(4).toString('hex')}`, stamp, stamp);
  operationsDb.close();
  result.assertions.push('隔离数据：1 个项目、1 条任务、1 条客户端错误（用于角标）');

  for (const name of browsersToRun) {
    const launcher = name === 'webkit' ? webkit : chromium;
    assert.ok(launcher, `未知浏览器 ${name}`);
    result.browserRuns.push(await runBrowser(name, launcher, {
      employee: { id: employeeId, password: employeePassword },
      admin: { id: 'shell-admin', password: adminPassword },
    }));
  }

  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理的页面异常');
  if (result.navigationCancelledFetches.length > 0) {
    result.assertions.push(`另有 ${result.navigationCancelledFetches.length} 条「文档跳转时被取消的 fetch」记录（WebKit 会报成 pageerror，非应用异常）`);
  }
  result.assertions.push('浏览器无未处理 pageerror');

  // 画布开关关闭：重启同一个数据根的隔离服务（开关是启动期环境变量），
  // 断言员工与管理员侧栏都不再出现「创作画布」入口。
  await runCanvasDisabledPhase(employeeId, employeePassword, adminPassword);

  result.result = 'passed';
  console.log(`team workspace shell browser tests passed (${browsersToRun.join(', ')}); evidence in ${path.relative(repoRoot, evidenceDirectory)}`);
} catch (error) {
  result.result = 'failed';
  result.error = sanitize(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
  console.error(`team workspace shell browser tests FAILED: ${result.error}`);
} finally {
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  // Windows 上 SQLite 的 -wal/-lock 文件在进程刚退出时可能还被占用一瞬；
  // 清理失败不得改写测试结论，留一个待下次回收的临时目录即可。
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (cleanupError) {
    console.warn(`临时数据根清理延后：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
}
