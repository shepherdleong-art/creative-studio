// 12 号票页面级行为验收（真实浏览器 + 隔离服务）。
//
// 覆盖验收清单里只能在页面上证明的几条：
//   1. 运行总览点最近任务表一行 → 打开全员任务里这一条的详情（URL 带 taskId）；
//   2. 暂停生产先说明：点「取消」不暂停、点「确认暂停」才暂停、暂停后能「恢复运行」；
//   3. 全员任务搜索打字不丢焦点，无结果显示说明与「清除筛选」，点它会清空；
//   4. 员工打开 /team/tasks 只看到自己的任务，且运行总览接口被拒。
//
// 自带隔离环境：临时数据根 + server 模式 + 回环端口 + 断外网 + 真实账号。
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

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const evidenceDirectory = process.env.TEAM_CONSOLE_EVIDENCE_DIR
  ?? path.join(repoRoot, 'storage', 'test-evidence', 'team-console');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-console-'));
fs.mkdirSync(evidenceDirectory, { recursive: true });
const result = { schemaVersion: 1, assertions: [], evidence: [], pageErrors: [] };
let server = null;
let baseUrl = '';
let port = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-team-console-page',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'team-console-page-test',
    CREATIVE_STUDIO_CANVAS_ENABLE: '1',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
    CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
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
  server.stdout.on('data', (chunk) => log.write(String(chunk)));
  server.stderr.on('data', (chunk) => log.write(String(chunk)));
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
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`隔离服务提前退出 ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (response.status === 200) return;
    } catch { /* startup wait */ }
    await sleep(500);
  }
  throw new Error('隔离服务 readiness 超时');
}

function cookiePair(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, '认证响应必须设置 cookie');
  return value.split(';', 1)[0];
}

async function login(employeeId, password) {
  const csrfResponse = await fetch(`${baseUrl}/api/team/auth/csrf`);
  const csrfCookie = cookiePair(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const response = await fetch(`${baseUrl}/api/team/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: csrfCookie, Origin: baseUrl, 'x-csrf-token': csrf },
    body: JSON.stringify({ employeeId, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return { employeeId, csrf, cookies: [csrfCookie, cookiePair(response)] };
}

async function api(session, pathname, method = 'GET', body) {
  const headers = new Headers({ Cookie: session.cookies.join('; '), Origin: baseUrl });
  if (method !== 'GET') { headers.set('x-csrf-token', session.csrf); headers.set('Content-Type', 'application/json'); }
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

async function loginViaUi(page, employeeId, password) {
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('input[autocomplete="username"]').fill(employeeId);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 90_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  await page.getByTestId('workspace-sidebar').waitFor({ timeout: 90_000 });
}

/** 直接落一条执行记录（任务接口只读这张表），并登记资源归属。 */
function seedOperation({ id, actorId, projectId, status, taskId, waitReason, updatedAt }) {
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  db.pragma('foreign_keys = ON');
  const at = updatedAt ?? new Date().toISOString();
  const seq = Number.parseInt(randomBytes(3).toString('hex'), 16) + 1;
  db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', 'r1', ?, 1, 'hash', '{}', 'image.submit', ?, '[]', '{}', ?, ?, ?, ?, ?)`)
    .run(id, `console-key-${id}`, actorId, projectId, taskId, `console-biz-${id}`,
      JSON.stringify({ name: '控制台验收供应商', model: 'gpt-image-2' }), status, waitReason ?? null, seq, at, at);
  db.close();
}

let browser;
try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  startServer();
  await waitReady();

  // ---- 账号与基础数据 ----
  // 首管理员走与其他团队验收同一条 CLI 入口（04 的 ui-acceptance 也用它）。
  const init = spawnSync(
    process.execPath,
    ['scripts/team-server/init-admin.mjs', '--employee-id', 'console-admin', '--name', '控制台管理员'],
    { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(init.status, 0, `首管理员初始化失败：${init.stderr || init.stdout}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(init.stdout ?? '')?.[1];
  assert.ok(adminCredential, `没能从初始化输出里取到一次性凭据：${(init.stdout ?? '').slice(-1500)}`);
  const adminSessionInitial = await login('console-admin', adminCredential);
  const adminPassword = 'console-admin-password-2026';
  const changed = await api(adminSessionInitial, '/api/team/auth/change-password', 'POST', {
    currentPassword: adminCredential, newPassword: adminPassword,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const adminSession = await login('console-admin', adminPassword);

  const employeeId = 'console-employee';
  const employeePassword = 'console-employee-password-2026';
  const created = await api(adminSession, '/api/team/users', 'POST', { employeeId, displayName: '控制台员工', role: 'employee' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const employeeInitial = await login(employeeId, created.body.credential);
  const employeeChanged = await api(employeeInitial, '/api/team/auth/change-password', 'POST', {
    currentPassword: created.body.credential, newPassword: employeePassword,
  });
  assert.equal(employeeChanged.status, 200, JSON.stringify(employeeChanged.body));
  const employeeSession = await login(employeeId, employeePassword);

  const provider = await api(adminSession, '/api/providers', 'POST', {
    name: '控制台验收供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'console-fixture',
    model: 'gpt-image-2', type: 'openai-compatible',
  });
  assert.equal(provider.status, 200, JSON.stringify(provider.body));
  const project = await api(employeeSession, '/api/projects', 'POST', {
    storeCode: 'B店', productCode: 'CONSOLE-01', productionType: '新品种草', editorName: '控制台员工',
    providerId: provider.body.id, model: 'gpt-image-2', size: '1024x1024',
  });
  assert.equal(project.status, 200, JSON.stringify(project.body));

  const userIds = new Database(path.join(root, 'data', 'workbench.db'));
  const adminId = userIds.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get('console-admin');
  const employeeUserId = userIds.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get(employeeId);
  userIds.close();

  seedOperation({ id: 'console-op-employee', actorId: employeeUserId, projectId: project.body.id, status: 'failed', taskId: 'console-task-employee' });
  seedOperation({ id: 'console-op-admin', actorId: adminId, projectId: project.body.id, status: 'accepted', taskId: 'console-task-admin' });
  /** 固定 3 位小数的稳定操作编号，便于在页面上断言。 */
  result.assertions.push('隔离数据：2 个账号、1 个项目、2 条任务（员工失败 1 条、管理员在跑 1 条）');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (error) => result.pageErrors.push(error.message));

  // ---- 1) 管理员：运行总览 → 点最近任务行 → 详情 ----
  await loginViaUi(page, 'console-admin', adminPassword);
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('count-running').waitFor({ timeout: 90_000 });
  await page.getByText('读取运行总览…', { exact: true }).waitFor({ state: 'detached', timeout: 90_000 }).catch(() => undefined);
  const counts = await page.evaluate(() => ({
    running: document.querySelector('[data-testid="count-running"] strong')?.textContent?.trim(),
    failed: document.querySelector('[data-testid="count-failed"] strong')?.textContent?.trim(),
  }));
  assert.equal(counts.running, '1', '正在跑应与数据一致');
  assert.equal(counts.failed, '1', '出错应与数据一致');
  const rows = page.getByTestId('recent-task-row');
  assert.ok(await rows.count() >= 1, '最近任务表应有行');
  const firstOperation = await rows.first().getAttribute('data-operation-id');
  await rows.first().click();
  await page.waitForURL((url) => url.pathname === '/team/tasks' && url.searchParams.get('taskId') === firstOperation, { timeout: 60_000 });
  await page.getByTestId('task-detail').waitFor({ timeout: 60_000 });
  assert.equal(await page.getByTestId('recent-task-row').count(), 0, '全员任务页没有总览的行');
  result.assertions.push('点运行总览的最近任务行，跳到 /team/tasks?taskId=<执行记录> 并打开详情');
  await page.screenshot({ path: path.join(evidenceDirectory, 'console-task-detail.png'), fullPage: true });
  result.evidence.push('console-task-detail.png');

  // 详情直链可刷新重开（供其他页跳转）。
  const detailUrl = `${baseUrl}/team/tasks?taskId=${firstOperation}`;
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail').waitFor({ timeout: 90_000 });
  result.assertions.push('详情链接刷新后仍直接打开同一条任务（直链可用）');

  // ---- 2) 全员任务：搜索不丢焦点、无结果有说明与清除筛选 ----
  const search = page.getByLabel('查找任务', { exact: true });
  await search.click();
  await search.fill('控制台员工');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '');
  assert.equal(focused, '查找任务', '打字后焦点必须仍在搜索框');
  const valueAfterTyping = await search.inputValue();
  assert.equal(valueAfterTyping, '控制台员工');
  await search.fill('绝不可能匹配的任务-search');
  await page.getByText('当前筛选没有团队任务。', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText(/没有匹配到项目名、模型、姓名、工号或任务编号/u).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
  assert.equal(await search.inputValue(), '', '清除筛选应清空搜索');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查找任务', '清除筛选后焦点回搜索框');
  await page.getByTestId('task-row').first().waitFor({ timeout: 30_000 });
  result.assertions.push('搜索打字不丢焦点；无结果显示说明与「清除筛选」，点击后清空并保留焦点');
  await page.screenshot({ path: path.join(evidenceDirectory, 'console-tasks-cleared.png'), fullPage: true });
  result.evidence.push('console-tasks-cleared.png');

  // 按发起人筛选（管理员能看到全员）。选项文案是「姓名（工号）」，用 value=用户 id 选中。
  const memberFilter = page.getByLabel('发起人', { exact: true });
  await memberFilter.selectOption(employeeUserId);
  await page.waitForTimeout(1000);
  const filteredIds = await page.getByTestId('task-row').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-operation-id')));
  assert.deepEqual(filteredIds, ['console-op-employee'], '按发起人筛选只留该成员的任务');
  result.assertions.push('按发起人筛选只留该成员的任务');

  // ---- 3) 暂停生产：取消不暂停、确认才暂停、暂停后能恢复 ----
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('count-running').waitFor({ timeout: 90_000 });
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ timeout: 30_000 });
  assert.match(await dialog.innerText(), /已经在跑的继续/u, '说明必须写清已在跑的继续');
  assert.match(await dialog.innerText(), /不再开始新的生成/u);
  await page.screenshot({ path: path.join(evidenceDirectory, 'console-pause-dialog.png') });
  result.evidence.push('console-pause-dialog.png');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  const stateAfterCancel = await api(adminSession, '/api/team/production-control');
  assert.equal(stateAfterCancel.body.paused, false, '点取消不得暂停');
  const stillRunning = await page.getByTestId('production-status').innerText();
  assert.match(stillRunning, /运行中/u, '取消后界面仍是运行中');
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  await dialog.waitFor({ timeout: 30_000 });
  await page.getByTestId('confirm-pause').click();
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  await page.getByTestId('production-status').filter({ hasText: '已暂停' }).waitFor({ timeout: 30_000 });
  const stateAfterPause = await api(adminSession, '/api/team/production-control');
  assert.equal(stateAfterPause.body.paused, true, '点确认才真的暂停');
  await page.screenshot({ path: path.join(evidenceDirectory, 'console-paused.png') });
  result.evidence.push('console-paused.png');
  await page.getByRole('button', { name: '恢复运行', exact: true }).click();
  await page.getByTestId('production-status').filter({ hasText: '运行中' }).waitFor({ timeout: 30_000 });
  const stateAfterResume = await api(adminSession, '/api/team/production-control');
  assert.equal(stateAfterResume.body.paused, false, '暂停后必须能恢复');
  result.assertions.push('暂停先说明：取消不暂停、确认才暂停、暂停后能恢复（状态用接口复核）');

  // ---- 4) 员工：只看到自己的任务，运行总览被拒 ----
  const employeeContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
  const employeePage = await employeeContext.newPage();
  employeePage.on('pageerror', (error) => result.pageErrors.push(`employee: ${error.message}`));
  await loginViaUi(employeePage, employeeId, employeePassword);
  await employeePage.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await employeePage.getByTestId('task-row').first().waitFor({ timeout: 90_000 });
  const employeeIds = await employeePage.getByTestId('task-row').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-operation-id')));
  assert.deepEqual(employeeIds, ['console-op-employee'], '员工只看到自己的任务');
  assert.equal(await employeePage.getByLabel('发起人', { exact: true }).count(), 0, '员工没有发起人筛选');
  const employeeOverview = await api(employeeSession, '/api/team/console/overview');
  assert.equal(employeeOverview.status, 403, '员工不得读取运行总览');
  const employeeCrossDetail = await api(employeeSession, '/api/team/tasks/detail?taskId=console-op-admin');
  assert.equal(employeeCrossDetail.status, 404, '员工打不开别人的任务详情');
  result.assertions.push('员工只看到自己的任务、没有发起人筛选、运行总览与别人详情都被拒');
  await employeePage.screenshot({ path: path.join(evidenceDirectory, 'console-tasks-employee.png'), fullPage: true });
  result.evidence.push('console-tasks-employee.png');

  // 深色两态各截一张（供人工比对）。
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('creative-studio-theme', value);
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByTestId('count-running').waitFor({ timeout: 90_000 });
    await page.screenshot({ path: path.join(evidenceDirectory, `console-overview-${theme}.png`), fullPage: true });
    result.evidence.push(`console-overview-${theme}.png`);
  }

  assert.deepEqual(result.pageErrors, [], '页面不得出现未处理异常');
  result.result = 'passed';
  console.log(`team console page tests passed; evidence in ${path.relative(repoRoot, evidenceDirectory)}`);
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  console.error(`team console page tests FAILED: ${result.error}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 上偶尔被占用，留待下次回收 */ }
}
