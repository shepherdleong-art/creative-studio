// 06 号票：员工首页 + 新建项目页的页面级行为验收。
//
// 04 的验收矩阵只量尺寸（不横向滚动、控件不被切、画面比例），
// 而本票的三条验收是行为：五块内容与数据一致、非渲染阶段不显示百分比、
// 新建项目页无超时/并发/预处理 + 项目名实时预览且打字不丢焦点 + 缺项提示在按钮旁 +
// 创建后进第 1 步。
//
// 所以这里自带隔离环境（照 05 的 `team-workspace-shell.playwright.test.mjs`）：
// 临时数据根 + server 模式 + 回环端口 + 断外网，用正式 API 建管理员/员工/项目/任务，
// 然后在 Chromium 与 WebKit 里以员工身份走这两屏。不联网、不碰真实数据根。
//
// 用法：
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/team-workbench-pages.playwright.test.mjs
// 环境变量：
//   TEAM_WORKBENCH_BROWSERS=chromium,webkit
//   TEAM_WORKBENCH_EVIDENCE_DIR=<证据目录>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const evidenceDirectory = process.env.TEAM_WORKBENCH_EVIDENCE_DIR
  ?? path.join(repoRoot, 'outputs', 'team-workbench-pages');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-workbench-pages-'));
const engines = (process.env.TEAM_WORKBENCH_BROWSERS ?? 'chromium,webkit')
  .split(',').map((value) => value.trim()).filter(Boolean);
fs.mkdirSync(evidenceDirectory, { recursive: true });

const result = { schemaVersion: 1, assertions: [], evidence: [], pageErrors: [], browserRuns: [] };
const secrets = new Set();
let server = null;
let baseUrl = '';
let port = 0;
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
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-workbench-pages-test',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'workbench-pages-test',
    CREATIVE_STUDIO_CANVAS_ENABLE: '1',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: 'disabled',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
    // 回环明文 http 下 WebKit 会丢掉 Secure cookie，仓库已为此准备了这条开关。
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
    // 服务器统一管理生产参数的默认值：故意改成非起步值，用来验证「改默认值生效」。
    CREATIVE_STUDIO_PRODUCTION_TIMEOUT_MS: '720000',
    CREATIVE_STUDIO_PRODUCTION_PROJECT_CONCURRENCY: '6',
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
  const deadline = Date.now() + 300_000;
  let last = null;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`隔离服务提前退出 ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      last = response.status;
      if (response.status === 200) return;
    } catch { /* startup wait */ }
    await sleep(500);
  }
  throw new Error(`隔离服务 readiness 超时，最后状态 ${last}`);
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
  return { response, body: await response.json() };
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

/** 与 05 采用同一套「等水合 + 填稳」的手法：WebKit 在 dev 模式下这两步都必须等。 */
async function waitForHydration(page, timeout = 180_000) {
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((key) => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$'));
  }, undefined, { timeout });
}
async function fillStable(locator, value, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await locator.fill(value);
    if ((await locator.inputValue()) === value) return;
    await locator.page().waitForTimeout(200 * attempt);
  }
  throw new Error(`输入框未能保留填写值：${value}`);
}
async function loginViaUi(page, employeeId, password) {
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.getByRole('button', { name: '登录', exact: true }).waitFor({ timeout: 180_000 });
  await waitForHydration(page);
  await fillStable(page.locator('input[autocomplete="username"]'), employeeId);
  await fillStable(page.locator('input[autocomplete="current-password"]'), password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { waitUntil: 'domcontentloaded', timeout: 180_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  await page.getByTestId('workspace-sidebar').waitFor({ timeout: 180_000 });
}

async function readDashboard(page) {
  return page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    const running = [...document.querySelectorAll('[data-testid="dashboard-running"]')].map((element) => ({
      text: element.textContent?.trim() ?? '',
      hasBar: Boolean(element.querySelector('i')),
    }));
    return {
      toolbarTitle: text('[data-testid="page-toolbar"] h1'),
      productionLine: text('[data-testid="workbench-production-line"]'),
      sectionTitles: [...document.querySelectorAll('.group-heading')].map((element) => (
        element.querySelector('span')?.textContent?.trim() ?? element.textContent?.trim() ?? ''
      )),
      projectCount: document.querySelectorAll('[data-testid="dashboard-project"]').length,
      running,
      usageText: text('[data-testid="dashboard-usage"]'),
      hasNewProjectLink: Boolean(document.querySelector('a[href="/projects/new"]')),
    };
  });
}

/**
 * WebKit 会把**文档跳转时被取消的请求**报成 pageerror（Chromium 不报）。
 * 与 05 号票 `team-workspace-shell.playwright.test.mjs` 的 `CANCELLED_REQUEST_PATTERNS`
 * 同一套判据、同一理由：我们在一页上连续 goto 多个页面，上一页的会话轮询必然被中止。
 * 只筛这两类浏览器侧请求取消，其它任何异常照旧算失败。
 */
const CANCELLED_REQUEST_PATTERNS = [
  /^[^:]+: \/127\.0\.0\.1:\d+\/(?:api|__nextjs_)[^\s]* due to access control checks\.$/,
  /^[^:]+: TypeError: Load failed$/,
];
function isNavigationCancelledFetch(message) {
  return CANCELLED_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}
function recordPageError(label) {
  return (error) => {
    const message = `${label}: ${error.message}`;
    if (!isNavigationCancelledFetch(message)) result.pageErrors.push(message);
  };
}

async function runEmployeePages(engineName, employee, project) {
  const launcher = engineName === 'webkit' ? webkit : chromium;
  const browser = await launcher.launch({ headless: true });
  const phase = { engine: engineName, assertions: [] };
  try {
    for (const [label, width, height] of [['1536x864', 1536, 864], ['1024x720', 1024, 720]]) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height } });
      const page = await context.newPage();
      page.on('pageerror', recordPageError(`${engineName}/${label}`));

      // ── 首页 ──
      await loginViaUi(page, employee.employeeId, employee.password);
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await page.getByTestId('workbench-production-line').waitFor({ timeout: 180_000 });
      await page.getByText('接着做', { exact: true }).first().waitFor({ timeout: 60_000 });
      const home = await readDashboard(page);
      assert.match(home.toolbarTitle ?? '', /好，|夜深了|早上好|中午好|下午好|晚上好/,
        `首页工具栏要显示问候语，实际「${home.toolbarTitle}」`);
      assert.ok(home.hasNewProjectLink, '首页工具栏必须有「新建项目」');
      // 五块内容与数据一致：出错的任务 / 接着做 / 正在生产 / 新建 / 本月用量。
      for (const title of ['出错的任务', '接着做', '正在生产', '新建', '本月用量']) {
        assert.ok(home.sectionTitles.includes(title), `首页必须有「${title}」区块，实际 ${home.sectionTitles.join('/')}`);
      }
      assert.equal(home.projectCount >= 1, true, '「接着做」必须显示刚才建好的项目');
      // 非渲染阶段不显示百分比：文档里不得出现「已完成 NN%」（那是渲染专用文案）。
      const pageText = await page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(pageText, /已完成 \d+%/, '没有渲染任务时不得出现百分比进度');
      for (const item of home.running) {
        assert.doesNotMatch(item.text, /%/, `非渲染任务不得显示百分比：${item.text}`);
      }
      // 「本月用量」只读：不能出现输入框。
      const usageInputs = await page.evaluate(() => document.querySelectorAll('[data-testid="dashboard-usage"] input').length);
      assert.equal(usageInputs, 0, '本月用量必须只读');
      await page.screenshot({ path: path.join(evidenceDirectory, `home-${engineName}-${label}.png`) });
      result.evidence.push(`home-${engineName}-${label}.png`);

      // ── 新建项目页 ──
      await page.goto(`${baseUrl}/projects/new`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await page.getByTestId('new-project-submit').waitFor({ timeout: 180_000 });
      await waitForHydration(page);
      const controls = await page.evaluate(() => ({
        // 只扫表单本体：工具的副标题里可以有「由服务器统一管理」这类说明，
        // 但表单控件区绝不能出现这四个控件。
        text: document.querySelector('form')?.innerText ?? '',
        labels: [...document.querySelectorAll('form label')].map((element) => element.textContent?.trim() ?? ''),
      }));
      for (const removed of ['超时', '并发数', '图片预处理', 'JPEG 质量']) {
        assert.equal(controls.text.includes(removed), false, `新建项目表单不得出现「${removed}」：\n${controls.text.slice(0, 800)}`);
      }
      // 保留的字段都在（以表单 label 为准）。
      for (const kept of ['店铺', '型号', '子型号', '生产类型', '剪辑师', '模型', '画面比例', '清晰度']) {
        assert.equal(controls.text.includes(kept), true, `新建项目页必须保留「${kept}」`);
      }
      // 剪辑师默认当前登录人（会话读完才回填，所以等它真的填上）。
      await page.waitForFunction(
        (displayName) => document.querySelector('input[aria-label="剪辑师"]')?.value === displayName,
        employee.displayName, { timeout: 60_000 },
      );

      // 项目名实时预览：边填边变。
      await page.getByLabel('店铺', { exact: true }).selectOption('B店');
      await page.getByLabel('型号', { exact: true }).fill('XQ9A');
      await page.getByLabel('生产类型', { exact: true }).selectOption({ index: 1 });
      await page.getByLabel('型号', { exact: true }).focus();
      await page.getByLabel('型号', { exact: true }).press('End');
      await page.getByLabel('型号', { exact: true }).type('Z', { delay: 40 });
      // 打字不丢焦点：焦点仍在型号输入框。
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      assert.equal(focused, '型号', `打字时不得丢焦点，实际焦点在「${focused}」`);
      await page.getByLabel('型号', { exact: true }).fill('XQ9A');
      const preview = await page.getByTestId('project-name-preview').innerText();
      assert.match(preview, /B店-XQ9A-/, `项目名必须实时预览服务器规则，实际「${preview}」`);
      // 改一个字段，预览立刻跟着变。
      await page.getByLabel('子型号', { exact: true }).fill('PRO');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="project-name-preview"]')?.textContent?.includes('PRO'),
        undefined, { timeout: 15_000 },
      );

      // 缺项提示写在按钮旁：清空必填项后按钮旁出现提示，且不弹 alert。
      let dialogAppeared = false;
      page.on('dialog', (dialog) => { dialogAppeared = true; void dialog.dismiss(); });
      await page.getByLabel('型号', { exact: true }).fill('');
      await page.getByTestId('new-project-submit').click();
      await page.waitForTimeout(500);
      const hint = await page.getByTestId('new-project-hint').innerText();
      assert.match(hint, /还差.*型号/, `缺项提示必须写在按钮旁，实际「${hint}」`);
      assert.equal(dialogAppeared, false, '校验提示不许用浏览器弹窗');
      assert.equal(page.url().includes('/projects/new'), true, '缺项时不得离开新建页');
      await page.screenshot({ path: path.join(evidenceDirectory, `projects-new-${engineName}-${label}.png`) });
      result.evidence.push(`projects-new-${engineName}-${label}.png`);

      // 填完 → 创建 → 进入第 1 步，且第 1 步有空状态与下一步提示。
      await page.getByLabel('型号', { exact: true }).fill('XQ9A');
      await page.getByTestId('new-project-submit').click();
      await page.waitForURL((url) => /^\/projects\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 180_000 });
      const createdUrl = page.url();
      await page.waitForFunction(
        () => document.body.innerText.includes('原始场景图'),
        undefined, { timeout: 180_000 },
      );
      const stepOne = await page.evaluate(() => document.body.innerText);
      assert.match(stepOne, /原始场景图/, '第 1 步必须出现「原始场景图」上传区');
      assert.match(stepOne, /先上传/, '第 1 步空状态必须写明下一步');
      result.assertions.push(`${engineName}/${label}：创建后进入第 1 步 ${new URL(createdUrl).pathname} 并有空状态提示`);

      await context.close();
    }
    phase.assertions.push(`${engineName}：首页五块内容与数据一致、非渲染不显示百分比、新建项目页无四控件、项目名实时预览、打字不丢焦点、缺项提示在按钮旁、创建后进第 1 步`);
    result.assertions.push(phase.assertions.at(-1));
  } finally {
    await browser.close();
    result.browserRuns.push(phase);
  }
}

async function prepareFixtures() {
  // 首管理员：走仓库自己的 init-admin（与 05 / 04 同一套隔离手法）。
  // 它只打印「已初始化首管理员 9000。一次性凭据（仅显示本次）：<credential>」。
  const init = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'team-server', 'init-admin.mjs'),
    '--employee-id', '9000',
    '--name', '页面验收管理员',
  ], { cwd: repoRoot, env: environment(), encoding: 'utf8', windowsHide: true });
  if (init.status !== 0) throw new Error(`初始化管理员失败：${sanitize(init.stderr || init.stdout)}`);
  const credential = /一次性凭据.*?：\s*(\S+)/.exec(init.stdout.trim())?.[1];
  assert.ok(credential, `init-admin 输出必须包含一次性凭据：${sanitize(init.stdout).slice(0, 200)}`);
  secrets.add(credential);
  const initialAdmin = await login('9000', credential);
  await jsonRequest(initialAdmin, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword: credential, newPassword: 'admin-workbench-password' },
  }, 200);
  secrets.add('admin-workbench-password');
  const admin = await login('9000', 'admin-workbench-password');

  const employeeId = '9100';
  const created = await jsonRequest(admin, '/api/team/users', {
    method: 'POST', json: { employeeId, displayName: '界面验收员工', role: 'employee' },
  }, 201);
  secrets.add(created.body.credential);
  const initial = await login(employeeId, created.body.credential);
  await jsonRequest(initial, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword: created.body.credential, newPassword: 'employee-workbench-password' },
  }, 200);
  secrets.add('employee-workbench-password');
  const employee = await login(employeeId, 'employee-workbench-password');

  // Provider + 项目（员工本人名下），首页「接着做」才有内容。
  const provider = await jsonRequest(admin, '/api/providers', {
    method: 'POST', json: { name: '页面验收 fixture 供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-not-a-real-key', model: 'gpt-image-2', type: 'openai-compatible' },
  }, 200);
  const project = await jsonRequest(employee, '/api/projects', {
    method: 'POST', json: {
      storeCode: 'B店', productCode: 'UI-ACCEPT', productSubmodel: '', productionType: 'AI种草',
      editorName: '界面验收员工', providerId: provider.body.id, model: 'gpt-image-2', size: '1024x1024',
      // 故意带上客户端旧值：团队版必须忽略它们。
      concurrency: 1, timeoutMs: 1000,
    },
  }, 200);

  return {
    admin,
    employee: { ...employee, password: 'employee-workbench-password', displayName: '界面验收员工' },
    project: project.body,
  };
}

try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  startServer();
  await waitReady();
  const fixtures = await prepareFixtures();

  // 接口级同时确认「团队版用服务器默认值」：服务器默认并发被改成 6、超时 720000。
  const projectRow = await jsonRequest(fixtures.employee, `/api/projects/${fixtures.project.id}`, {}, 200);
  assert.equal(projectRow.body.concurrency, 6, `团队版建项目必须用服务器默认并发 6，实际 ${projectRow.body.concurrency}`);
  assert.equal(projectRow.body.timeoutMs, 720_000, `团队版建项目必须用服务器默认超时 720000，实际 ${projectRow.body.timeoutMs}`);
  result.assertions.push('接口：请求里带 concurrency=1/timeoutMs=1000，团队版落库仍是服务器默认 6 / 720000');

  for (const engineName of engines) await runEmployeePages(engineName, fixtures.employee, fixtures.project);

  assert.deepEqual(result.pageErrors, [], `浏览器不得有未处理异常：${result.pageErrors.slice(0, 3).join(' | ')}`);
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), JSON.stringify({
    ...result,
    fixtures: { projectId: fixtures.project.id, employeeId: fixtures.employee.employeeId },
    isolatedDataRoot: true,
  }, null, 2));
  console.log(`工作台页面验收 passed：${result.assertions.length} 条断言，${engines.join('+')}`);
  console.log(`证据目录：${evidenceDirectory}`);
} finally {
  await stopServer();
  // Windows 上 Next dev 子进程刚被 taskkill 时还可能短暂占着 SQLite 锁文件；
  // 清理失败不影响验收结论，最多重试几次推进，仍失败就留给系统临时目录回收。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(root, { recursive: true, force: true }); break; }
    catch { await sleep(1000 * (attempt + 1)); }
  }
}
