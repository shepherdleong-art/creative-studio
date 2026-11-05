import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';
import ExcelJS from 'exceljs';

/**
 * 票 01 真会话浏览器验收：管理员在公共资源页上传→预览→发布，员工读取同一团队版本。
 *
 * 抄 `scripts/team-acceptance-http.playwright.test.mjs` 的 freePort/environment/
 * startServer/stopServer 与 init-admin 用法：真实 `next dev` + 真实 server 模式 +
 * 真实登录会话 + Chromium 页面操作，不走 mock。
 *
 * 运行：
 *   node scripts/team-viral-template-browser.acceptance.mjs
 * 证据写到 `outputs/ticket-01-viral-template-browser/`（gitignored）。
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-viral-browser-'));
const evidenceDirectory = process.env.VIRAL_TEMPLATE_EVIDENCE_DIR
  ? path.resolve(process.env.VIRAL_TEMPLATE_EVIDENCE_DIR)
  : path.join(repoRoot, 'outputs', 'ticket-01-viral-template-browser');
fs.mkdirSync(evidenceDirectory, { recursive: true });
const deploymentId = 'deployment-viral-browser';
const secrets = new Set();
const assertions = [];
let server = null;
let serverOutput = '';
let baseUrl = '';
let port = 0;
let browser = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sanitize(text) {
  let safe = String(text).split(root).join('[isolated-data-root]');
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/(?:__Host-team_(?:session|csrf))=[^\s;]+/g, '[redacted-cookie]');
}
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const selected = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return selected;
}
function environment() {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'viral-template-browser',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  };
}
function startServer() {
  const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  server = spawn(process.execPath, [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: environment(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    serverOutput += String(chunk);
    fs.appendFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(String(chunk)));
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  await Promise.race([exited, sleep(10_000)]);
  server = null;
}
async function waitReady() {
  const deadline = Date.now() + 240_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`隔离 Next 服务提前退出 ${server.exitCode}: ${sanitize(serverOutput).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch { /* startup wait */ }
    await sleep(300);
  }
  throw new Error(`隔离 Next 服务 readiness 超时，最后状态 ${lastStatus}: ${sanitize(serverOutput).slice(-4000)}`);
}

const HEADER = ['类目', '子类目', '模板名称', '标题', '参考文案', '结构摘要', '模板ID'];
async function workbook(rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('全部模板');
  sheet.addRow(HEADER);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const result = { schemaVersion: 1, port: null, assertions, evidence: [], pageErrors: [] };
try {
  port = Number(process.env.VIRAL_TEMPLATE_PORT ?? 0) || await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  result.port = port;
  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', 'viral-admin', '--name', '公共资源管理员'], {
    cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  assert.equal(initialized.status, 0, `首管理员初始化失败：${sanitize(initialized.stderr ?? '')}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(adminCredential, `无法解析首管理员凭据：${sanitize(initialized.stdout)}`);
  secrets.add(adminCredential);

  // 员工账号：直接写库生成凭据太脆，改用管理员登录后经真实 API 创建。
  startServer();
  await waitReady();
  assertions.push(`真实 next dev 在临时数据根与端口 ${port} 启动，readiness 返回 200`);

  const adminPassword = `Viral-admin-${randomBytes(12).toString('base64url')}`;
  secrets.add(adminPassword);

  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();
  const adminContext = await browser.newContext({ locale: 'zh-CN', acceptDownloads: false });
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', (error) => result.pageErrors.push(`admin: ${error.message}`));

  // ---- 管理员登录 + 首次改密 ----
  // 首次登录不会导航：服务端返回 mustChangePassword，组件在同一页切到改密模式。
  // 因此等待「URL 离开登录页 或 出现新密码输入框」二者之一。
  async function loginAndMaybeRotate(page, employeeId, password, newPassword) {
    await page.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 180_000 });
    await page.locator('input[autocomplete="username"]').fill(employeeId);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    const loginResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/team/auth/login') && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: '登录', exact: true }).click();
    assert.equal((await loginResponse).status(), 200, `${employeeId} 登录必须成功`);
    await page.waitForFunction(() => (
      !window.location.pathname.startsWith('/team/login')
      || Boolean(document.querySelector('input[autocomplete="new-password"]'))
    ), undefined, { timeout: 120_000 });
    if (await page.locator('input[autocomplete="new-password"]').count() > 0) {
      await page.locator('input[autocomplete="new-password"]').first().fill(newPassword);
      await page.locator('input[autocomplete="new-password"]').nth(1).fill(newPassword);
      const changed = page.waitForResponse((response) => (
        response.url().endsWith('/api/team/auth/change-password') && response.request().method() === 'POST'
      ));
      await page.getByRole('button', { name: /保存新密码并进入/ }).click();
      assert.equal((await changed).status(), 200, `${employeeId} 首次改密必须成功`);
      await page.waitForURL((url) => !url.pathname.startsWith('/team/login'), { timeout: 120_000 });
    }
  }
  await loginAndMaybeRotate(adminPage, 'viral-admin', adminCredential, adminPassword);
  assertions.push('管理员经真实登录页建立会话（首次登录时完成强制改密）');

  /** 页面内带 CSRF 调 API。 */
  async function api(page, pathname, method = 'GET', body) {
    return page.evaluate(async ({ pathname, method, body }) => {
      const csrf = await fetch('/api/team/auth/csrf').then((response) => response.json());
      const response = await fetch(pathname, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: response.status, body: parsed };
    }, { pathname, method, body });
  }

  // ---- 创建员工账号（真实 API），供员工读取验收 ----
  const employeeCredential = `Viral-emp-${randomBytes(12).toString('base64url')}`;
  secrets.add(employeeCredential);
  const createdEmployee = await api(adminPage, '/api/team/users', 'POST', {
    employeeId: 'viral-emp', displayName: '模板使用员工', role: 'employee', credential: employeeCredential,
  });
  let employeePassword = employeeCredential;
  if (createdEmployee.status >= 400) {
    // 该接口不接收自定义凭据时回退到响应里的 credential。
    assert.equal(createdEmployee.status, 201, `创建员工失败：${JSON.stringify(createdEmployee.body).slice(0, 500)}`);
  }
  if (createdEmployee.body?.credential) {
    employeePassword = createdEmployee.body.credential;
    secrets.add(employeePassword);
  }

  // ---- 管理员进入公共资源页：上传 → 预览 → 发布 ----
  const resourcesResponse = await adminPage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  assert.equal(resourcesResponse?.status(), 200, '公共资源页必须由真实 HTTP 服务呈现');
  await adminPage.getByRole('heading', { name: '公共资源发布', exact: true }).waitFor({ timeout: 60_000 });
  await adminPage.getByRole('heading', { name: '爆文模板库', exact: true }).waitFor({ timeout: 30_000 });
  await adminPage.getByText('团队还没有发布任何爆文模板库', { exact: false }).waitFor({ timeout: 30_000 });

  const v1Rows = [
    ['床', '实木床', '实木床爆款', '实木床真香', '标题：实木床真香\n正文：整块实木框架，睡十年都不塌。', '钩子>痛点>卖点>逼单', 'tpl-bed'],
    ['沙发', '布艺沙发', '沙发模板', '坐下来就不想起来', '标题：坐下来就不想起来\n正文：坐深 60 公分，整个人陷进去。', '钩子>卖点>结尾', 'tpl-sofa'],
    ['', '', '占位模板', '', '测试文本', '', 'tpl-placeholder'],
  ];
  const v1Path = path.join(root, '团队爆文库_v1.xlsx');
  fs.writeFileSync(v1Path, await workbook(v1Rows));

  await adminPage.getByLabel('上传爆文模板 .xlsx', { exact: true }).setInputFiles(v1Path);
  await adminPage.getByText('发布预览（确认后才替换团队版本）', { exact: false }).waitFor({ timeout: 120_000 });
  const previewPanel = adminPage.locator('div').filter({ hasText: '发布预览（确认后才替换团队版本）' }).last();
  await previewPanel.getByText('条目总数：').waitFor({ timeout: 30_000 });
  const previewText = await previewPanel.innerText();
  assert.match(previewText, /条目总数：\s*3/, '预览必须显示总数 3');
  assert.match(previewText, /可用：\s*2/, '预览必须显示可用 2');
  assert.match(previewText, /占位不可用：\s*1/, '预览必须显示占位 1');
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '01-admin-preview.png'), fullPage: true });
  result.evidence.push('01-admin-preview.png');
  assertions.push('管理员在真实页面选择文件后看到预览报告（总数 3 / 可用 2 / 占位 1），此步尚未落库');

  assert.equal(
    (await api(adminPage, '/api/team/public-resources/viral-templates')).body?.current ?? null,
    null,
    '预览阶段团队当前版本必须仍为空',
  );

  const publishResponse = adminPage.waitForResponse((response) => (
    response.url().includes('/api/team/public-resources/viral-templates')
    && !response.url().includes('mode=preview')
    && response.request().method() === 'POST'
  ));
  await adminPage.getByRole('button', { name: '发布给团队', exact: true }).click();
  const published = await publishResponse;
  assert.equal(published.status(), 201, await published.text());
  await adminPage.getByText('已发布团队版本 v1', { exact: false }).waitFor({ timeout: 60_000 });
  await adminPage.getByText('团队当前版本 v1', { exact: false }).waitFor({ timeout: 30_000 });
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '02-admin-published.png'), fullPage: true });
  result.evidence.push('02-admin-published.png');
  assertions.push('管理员只需文件与界面按钮即发布成功，页面立即展示「团队当前版本 v1」');

  const teamState = (await api(adminPage, '/api/team/public-resources/viral-templates')).body;
  assert.equal(teamState.revisions.length, 1);
  assert.equal(teamState.current.entryCounts.usable, 2);
  const firstRevisionId = teamState.current.id;

  // ---- 员工读取同一团队版本（无需资源 ID） ----
  const employeeContext = await browser.newContext({ locale: 'zh-CN' });
  const employeePage = await employeeContext.newPage();
  employeePage.on('pageerror', (error) => result.pageErrors.push(`employee: ${error.message}`));
  const employeeNewPassword = `Viral-emp-${randomBytes(12).toString('base64url')}`;
  secrets.add(employeeNewPassword);
  await loginAndMaybeRotate(employeePage, 'viral-emp', employeePassword, employeeNewPassword);
  assertions.push('员工经独立浏览上下文与真实登录会话进入系统');

  const employeeView = await employeePage.evaluate(async () => {
    const response = await fetch('/api/script-studio/viral-templates', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(employeeView.status, 200);
  assert.equal(employeeView.body.source, 'team', '员工读取必须解析到团队当前版本');
  assert.equal(employeeView.body.current?.id, firstRevisionId);
  assert.equal(employeeView.body.canManage, false, '员工不可管理团队版本');
  assert.deepEqual(employeeView.body.revisions.map((revision) => revision.id), [firstRevisionId], '员工只看团队当前版本，不列历史');
  const employeeEntries = await employeePage.evaluate(async () => {
    const response = await fetch('/api/script-studio/viral-templates/entries?status=usable', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(employeeEntries.status, 200);
  assert.equal(employeeEntries.body.entries.length, 2, '员工能读到团队版本的可用条目');
  const employeeNames = employeeEntries.body.entries.map((entry) => entry.name).sort();
  assert.deepEqual(employeeNames, ['实木床爆款', '沙发模板']);
  assertions.push('员工读取同一团队当前版本（source=team、2 个可用条目），未使用任何资源 ID');

  // ---- 员工无权访问管理员发布入口、不能上传/发布 ----
  const employeeAdminEntry = await employeePage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'networkidle', timeout: 180_000 });
  await employeePage.waitForFunction(
    () => !window.location.pathname.startsWith('/team/admin/'),
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined);
  const employeeLandedPath = new URL(employeePage.url()).pathname;
  result.employeeLandedPath = employeeLandedPath;
  assert.notEqual(employeeLandedPath, '/team/admin/resources', `员工访问公共资源页必须被重定向，实际停在 ${employeeLandedPath}（HTTP ${employeeAdminEntry?.status()}）`);
  const employeeAdminHeading = await employeePage.getByRole('heading', { name: '爆文模板库', exact: true }).count();
  assert.equal(employeeAdminHeading, 0, '员工不得看到爆文模板库管理卡片');
  const employeePublish = await employeePage.evaluate(async () => {
    const csrf = await fetch('/api/team/auth/csrf').then((response) => response.json());
    const response = await fetch('/api/team/public-resources/viral-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.csrfToken },
      body: JSON.stringify({ revisionId: 'anything', baseRevisionId: null }),
    });
    return response.status;
  });
  assert.equal(employeePublish, 403, '员工 POST 发布必须被拒绝');
  assertions.push('员工访问公共资源页被重定向、POST 发布返回 403');

  // ---- 管理员发布第二个版本后，员工看到新版本；旧版本条目不连带进当前 ----
  const v2Path = path.join(root, '团队爆文库_v2.xlsx');
  fs.writeFileSync(v2Path, await workbook([
    ['床', '实木床', '实木床爆款二版', '二版标题', '标题：二版标题\n正文：新版静音床板，睡觉不吵。', '钩子>卖点', 'tpl-bed-v2'],
  ]));
  await adminPage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await adminPage.getByRole('heading', { name: '爆文模板库', exact: true }).waitFor({ timeout: 60_000 });
  await adminPage.getByLabel('上传爆文模板 .xlsx', { exact: true }).setInputFiles(v2Path);
  await adminPage.getByText('发布预览（确认后才替换团队版本）', { exact: false }).waitFor({ timeout: 120_000 });
  const publishSecond = adminPage.waitForResponse((response) => (
    response.url().includes('/api/team/public-resources/viral-templates')
    && !response.url().includes('mode=preview')
    && response.request().method() === 'POST'
  ));
  await adminPage.getByRole('button', { name: '发布给团队', exact: true }).click();
  assert.equal((await publishSecond).status(), 201);
  await adminPage.getByText('团队当前版本 v2', { exact: false }).waitFor({ timeout: 60_000 });
  // 历史版本行仍在，且可以「设为当前版本」。
  const historyRow = adminPage.getByRole('button', { name: '设为当前版本' });
  await historyRow.first().waitFor({ timeout: 30_000 });
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '03-admin-two-versions.png'), fullPage: true });
  result.evidence.push('03-admin-two-versions.png');

  const employeeAfterV2 = await employeePage.evaluate(async () => {
    const view = await fetch('/api/script-studio/viral-templates', { cache: 'no-store' }).then((response) => response.json());
    const entries = await fetch('/api/script-studio/viral-templates/entries?status=usable', { cache: 'no-store' }).then((response) => response.json());
    return { view, names: entries.entries.map((entry) => entry.name) };
  });
  assert.match(employeeAfterV2.view.current?.sourceFilename ?? '', /v2/, '员工必须看到新的团队当前版本');
  assert.deepEqual(employeeAfterV2.names, ['实木床爆款二版'], '员工只看到新版本条目');
  assertions.push('管理员发布第二版后员工立即读取新版本（旧版本条目不再出现在当前版本）');

  // ---- 从历史版本重激活：旧内容重导必须明确激活 ----
  await historyRow.first().click();
  await adminPage.getByText('该版本已重新激活为当前团队版本', { exact: false }).waitFor({ timeout: 60_000 });
  await adminPage.getByText('团队当前版本 v1', { exact: false }).waitFor({ timeout: 30_000 });
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '04-admin-reactivated-v1.png'), fullPage: true });
  result.evidence.push('04-admin-reactivated-v1.png');
  assertions.push('管理员从历史版本重激活后页面明确提示，并回到「团队当前版本 v1」');

  // ---- 员工侧页面截图（模板改写选择器读取团队版本） ----
  const projectCreated = await api(adminPage, '/api/projects', 'POST', {
    storeCode: 'B店', productCode: 'VIRAL-TEMPLATE-E2E', productionType: 'AI种草', editorName: '模板验收',
  });
  if (projectCreated.status < 400 && projectCreated.body?.id) {
    const projectId = projectCreated.body.id;
    const recommend = await employeePage.evaluate(async ({ projectId }) => {
      const response = await fetch(`/api/projects/${projectId}/script-studio/viral-template-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expandBeyondCategory: true }),
      });
      return { status: response.status, body: await response.json() };
    }, { projectId });
    // 没有卖点库时 404 是预期；只记录不失败。
    result.employeeRecommend = { projectId, status: recommend.status, message: recommend.body?.message ?? null };
  }

  const settingsPage = await employeePage.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  if (settingsPage?.status() === 200) {
    await employeePage.getByRole('button', { name: /脚本知识与模板/ }).first().click().catch(() => undefined);
    await employeePage.waitForTimeout(2_000);
    const settingsText = await employeePage.locator('body').innerText();
    if (settingsText.includes('爆文模板库')) {
      assert.doesNotMatch(settingsText, /导入 \.xlsx/, '员工设置页不应出现个人导入按钮（团队模式）');
      result.settingsShowsTeamVersion = settingsText.includes('公共资源');
    }
    await employeePage.screenshot({ path: path.join(evidenceDirectory, '05-employee-settings.png'), fullPage: true });
    result.evidence.push('05-employee-settings.png');
  }

  await employeeContext.close();
  await adminContext.close();
  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理页面异常');
  assertions.push('浏览器无未处理 pageerror');

  // ---- 落库事实复核（直接读 SQLite） ----
  const db = new Database(path.join(root, 'data', 'workbench.db'), { readonly: true });
  try {
    const libraries = db.prepare('SELECT id, ownerKey, currentRevisionId FROM script_studio_viral_tpl_libraries').all();
    assert.equal(libraries.length, 1, '只应存在一个团队库，没有产生员工个人库');
    assert.equal(libraries[0].ownerKey, '__team__');
    const scopes = db.prepare(`
      SELECT resourceType, visibility, COUNT(*) AS count FROM team_resource_scopes
      WHERE resourceType LIKE 'viral_template%' GROUP BY resourceType, visibility
    `).all();
    result.scopes = scopes;
    const entries = db.prepare(`SELECT COUNT(*) AS count FROM script_studio_viral_tpl_entries WHERE revisionId = ?`)
      .get(libraries[0].currentRevisionId);
    assert.equal(entries.count, 3, '当前团队版本（重激活的 v1）条目数为 3');
    result.database = { libraries, scopes, currentEntryCount: entries.count };
  } finally {
    db.close();
  }
  assertions.push('数据库复核：只有一个 __team__ 库、无员工私人库，当前版本条目数与解析结果一致');

  result.result = 'passed';
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(serverOutput).slice(-2_000_000));
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${sanitize(JSON.stringify(result, null, 2))}\n`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(sanitize(`viral template browser acceptance ${result.result}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`));
}
