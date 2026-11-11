// 06 号票：全员任务服务端分页交互的浏览器级验收（真实浏览器 + 隔离服务 + 隔离数据根）。
//
// 固定数据（功能方案第 8 节）：503 个制作任务 / 505 条执行记录，其中一个统一任务有
// 3 条执行记录；其中 2 个任务失败（一个可重试）；1 条关键词只存在于第 505 条记录。
//
// 覆盖：
//   1. 默认 25 个制作任务、总数文案 503/505、21 页、末页 3 个、pageSize=50 → 11 页；
//   2. 搜索走服务端 q（约 300ms 防抖、Enter 立即、保持焦点），跨 500 条命中，姓名/工号/模型/任务编号可用；
//   3. 分组只作用于当前页（组标题「本页 N 项」），平铺/分组不改页、不改本页任务集合；
//   4. 深链打开当前页外详情；翻页保持详情；关闭保留页与筛选；关闭后焦点归还；加载中/失败/不存在反馈；
//   5. 列表错误与详情错误独立、失败不伪装空结果；竞态下旧响应不覆盖新条件；越界页按响应 page 收敛；
//   6. 失败任务重试走原接口，成功后刷新详情与当前页（显示回队），无额外模型提交；
//   7. 员工只看到本人、他人详情 404 说明、不请求成员管理接口；侧栏角标显示全范围 505 而非 25/50。
//
// 运行（默认 next dev；推荐先构建后置 TEAM_TASK_TEST_PRODUCTION=1 用 standalone）：
//   node scripts/team-task-pagination.playwright.test.mjs
// 生产模式：TEAM_TASK_TEST_PRODUCTION=1 node scripts/team-task-pagination.playwright.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const evidenceDirectory = process.env.TEAM_TASK_EVIDENCE_DIR
  ?? path.join(repoRoot, 'outputs', '2026-11-11-工作台版本标记与团队列表易用性', 'evidence', '06', 'browser');
fs.mkdirSync(evidenceDirectory, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-task-pagination-ui-'));
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
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-task-pagination-ui',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'task-pagination-ui-test',
    CREATIVE_STUDIO_CANVAS_ENABLE: '1',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
    CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
  };
}

function startServer() {
  const production = process.env.TEAM_TASK_TEST_PRODUCTION === '1';
  const standalone = path.join(repoRoot, '.next', 'standalone');
  assert.ok(!production || fs.existsSync(path.join(standalone, 'server.js')), '生产模式必须先 npm run build 产出 .next/standalone/server.js');
  const nextBinary = fileURLToPath(import.meta.resolve('next/dist/bin/next'));
  server = spawn(process.execPath, production
    ? [path.join(standalone, 'server.js')]
    : [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: production ? standalone : repoRoot,
    env: production
      ? { ...environment(), NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1' }
      : environment(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`隔离服务提前退出 ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (response.status === 200) return;
    } catch { /* startup wait */ }
    await sleep(400);
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

// ---- 固定数据：503 制作任务 / 505 执行记录 ----
const GROUP_TOTAL = 503;
const RECORD_TOTAL = 505;
const DEEP_KEYWORD = 'deep-history-keyword';
const RETRY_TASK_ID = 'single-task-003';
const RETRY_OPERATION_ID = 'single-op-003';

function seedTaskHistory({ adminId, employeeId, projectId, providerId }) {
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    db.pragma('foreign_keys = ON');
    const insertOperation = db.prepare(`INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq,
      createdAt, updatedAt, mediaTaskId, channelKey
    ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', ?, ?, 1, 'hash', '{}', 'image.submit', ?, '[]', '{}', ?, NULL, ?, ?, ?, ?, NULL)`);
    const providerSnapshot = JSON.stringify({ name: '任务页验收供应商', model: 'fixture-image-model' });
    const now = Date.now();
    let readySeq = 700_000;
    db.transaction(() => {
      // 统一任务：3 条执行记录 = 1 个制作任务（最新，页面第一组）。
      for (let index = 1; index <= 3; index += 1) {
        const operationId = `unified-op-${index}`;
        const at = new Date(now - 10_000 - index).toISOString();
        insertOperation.run(
          operationId, `key-${operationId}`, employeeId, projectId, 'unified-showcase-task', `r${index}`,
          `unified-biz-${index}`, providerSnapshot, 'succeeded', readySeq + index, at, at, 'media-unified-showcase',
        );
      }
      readySeq += 100;
      // 502 个独立制作任务；第 502 个是「500 条之外」的关键词记录（员工自己的旧任务）。
      for (let index = 1; index <= 502; index += 1) {
        const operationId = `single-op-${String(index).padStart(3, '0')}`;
        const taskId = index === 502 ? `${DEEP_KEYWORD}-task` : `single-task-${String(index).padStart(3, '0')}`;
        const actorId = index === 502 ? employeeId : adminId;
        const status = index === 3 || index === 4 ? 'failed' : 'succeeded';
        const at = new Date(now - 60_000 - index * 1000).toISOString();
        insertOperation.run(
          operationId, `key-${operationId}`, actorId, projectId, taskId, 'r1',
          `biz-${index}`, providerSnapshot, status, readySeq + index, at, at, null,
        );
        if (status === 'failed') {
          db.prepare('UPDATE execution_operations SET status = ? WHERE id = ?').run(status, operationId);
        }
      }
      // 可重试的图片任务：原重试入口要求 jobs 行存在且已失败（不会真的调用供应商）。
      db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path) VALUES ('task-fixture-input', ?, 'input', '任务页验收输入.png', 'storage/task-fixture-input.png')")
        .run(projectId);
      db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status)
        VALUES (?, ?, 'task-fixture-input', ?, 'fixture-image-model', 'fixture', 'failed')`).run(RETRY_TASK_ID, projectId, providerId);
      // 原重试入口是受控资源路由：任务页转发到 /api/jobs/[id]/retry 前，这里按正式登记格式
      // 给 job 补一条归属登记（父级=项目），否则会被资源授权拒绝。仅写隔离数据根。
      const at = new Date(now - 61_000).toISOString();
      db.prepare(`INSERT INTO team_resource_scopes (
        resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt
      ) VALUES ('job', ?, ?, 'private', 'project', ?, 'project', ?, ?, ?)`)
        .run(RETRY_TASK_ID, employeeId, projectId, projectId, at, at);
    })();
    const groups = db.prepare(`SELECT COUNT(DISTINCT groupId) FROM (
      SELECT CASE WHEN NULLIF(mediaTaskId, '') IS NOT NULL THEN 'unified:' || mediaTaskId ELSE 'operation:' || id END AS groupId
      FROM execution_operations
    )`).pluck().get();
    const records = db.prepare('SELECT COUNT(*) FROM execution_operations').pluck().get();
    assert.equal(groups, GROUP_TOTAL, '夹具必须造出 503 个制作任务');
    assert.equal(records, RECORD_TOTAL, '夹具必须造出 505 条执行记录');
  } finally {
    db.close();
  }
}

/** 数据变少后测试越界页：删掉最旧的 30 个独立制作任务（503 → 473 组，末页变第 19 页）。 */
function deleteOldestSingleTasks(count = 30) {
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    const removed = db.prepare(`DELETE FROM execution_operations WHERE id IN (
      SELECT id FROM execution_operations WHERE mediaTaskId IS NULL ORDER BY updatedAt ASC LIMIT ?
    )`).run(count).changes;
    assert.equal(removed, count, '越界收敛夹具必须删掉指定数量的旧任务');
  } finally {
    db.close();
  }
}

function readJobStatus(taskId) {
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    return db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(taskId);
  } finally {
    db.close();
  }
}

// ---- 页面等待/断言小工具 ----
async function waitForSummary(page, needle, timeout = 30_000) {
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="task-list-summary"]')?.textContent?.includes(value) ?? false,
    needle, { timeout },
  );
  return page.getByTestId('task-list-summary').innerText();
}

async function waitForRowCount(page, count, timeout = 30_000) {
  await page.waitForFunction(
    (value) => document.querySelectorAll('[data-testid="task-row"]').length === value,
    count, { timeout },
  );
}

async function waitForPagination(page, text, timeout = 30_000) {
  await page.getByTestId('pagination-status').first().filter({ hasText: text }).waitFor({ timeout });
}

function listRequestUrls(page) {
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/team/tasks?')) requests.push({ url: request.url(), at: Date.now() });
  });
  return requests;
}

function queryOf(requestUrl) {
  return new URL(requestUrl).searchParams;
}

let browser;
let activePage = null;
let listRequests = [];
try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  startServer();
  await waitReady();

  // ---- 账号与基础数据（走正式入口，不绕过业务校验） ----
  const init = spawnSync(
    process.execPath,
    ['scripts/team-server/init-admin.mjs', '--employee-id', 'task-admin', '--name', '任务页管理员'],
    { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(init.status, 0, `首管理员初始化失败：${init.stderr || init.stdout}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(init.stdout ?? '')?.[1];
  assert.ok(adminCredential, `没能从初始化输出里取到一次性凭据：${(init.stdout ?? '').slice(-1500)}`);
  const adminInitial = await login('task-admin', adminCredential);
  const adminPassword = '{{SECRET_9m2xq7ab}}';
  const changed = await api(adminInitial, '/api/team/auth/change-password', 'POST', { currentPassword: adminCredential, newPassword: adminPassword });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const adminSession = await login('task-admin', adminPassword);

  const employeeId = 'task-employee';
  const employeePassword = '{{SECRET_p4wz8k3c}}';
  const created = await api(adminSession, '/api/team/users', 'POST', { employeeId, displayName: '任务页员工', role: 'employee' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const employeeInitial = await login(employeeId, created.body.credential);
  const employeeChanged = await api(employeeInitial, '/api/team/auth/change-password', 'POST', { currentPassword: created.body.credential, newPassword: employeePassword });
  assert.equal(employeeChanged.status, 200, JSON.stringify(employeeChanged.body));
  const employeeSession = await login(employeeId, employeePassword);

  const provider = await api(adminSession, '/api/providers', 'POST', {
    name: '任务页验收供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'task-fixture-key',
    model: 'fixture-image-model', type: 'openai-compatible',
  });
  assert.equal(provider.status, 200, JSON.stringify(provider.body));
  const project = await api(employeeSession, '/api/projects', 'POST', {
    storeCode: 'B店', productCode: 'UI-TASK', productionType: '新品种草', editorName: '任务页员工',
    providerId: provider.body.id, model: 'fixture-image-model', size: '1024x1024',
  });
  assert.equal(project.status, 200, JSON.stringify(project.body));

  const ids = new Database(path.join(root, 'data', 'workbench.db'));
  ids.pragma('foreign_keys = ON');
  const adminId = ids.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get('task-admin');
  const employeeUserId = ids.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get(employeeId);
  ids.close();
  seedTaskHistory({ adminId, employeeId: employeeUserId, projectId: project.body.id, providerId: provider.body.id });
  result.assertions.push('隔离数据：503 个制作任务 / 505 条执行记录（含 1 个 3 条记录的统一任务、2 个失败任务、1 条 500 条之外的关键词记录）');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  listRequests = listRequestUrls(page);
  page.on('response', async (response) => {
    if (!response.url().includes('/api/team/tasks?')) return;
    try {
      const body = await response.json();
      result.responses ??= [];
      result.responses.push({
        url: response.url(), status: response.status(),
        total: body?.pagination?.total, totalRecords: body?.totalRecords, items: body?.items?.length,
      });
    } catch { /* 非 JSON 响应忽略 */ }
  });

  await loginViaUi(page, 'task-admin', adminPassword);
  await page.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForRowCount(page, 25);
  await waitForPagination(page, '第 1 / 21 页');

  // ---- 1) 默认 25 个制作任务 + 完整总数 + 末页 ----
  let summary = await waitForSummary(page, '503 个制作任务');
  assert.match(summary, /503 个制作任务/, '总数是完整制作任务数，不是当前页数组长度');
  assert.match(summary, /505 条执行记录/, '执行记录总数读 totalRecords');
  assert.equal((await page.getByTestId('pagination-total').first().innerText()).trim(), '共 503 个制作任务');
  assert.equal(await page.getByTestId('pagination-prev').first().isDisabled(), true, '第 1 页禁用上一页');
  assert.equal(await page.getByTestId('pagination-next').first().isDisabled(), false, '第 1 页可翻下一页');
  assert.equal(await page.getByTestId('actor-group-count').count(), 2, '第一页只有两个发起人分组');
  const groupCounts = await page.getByTestId('actor-group-count').allInnerTexts();
  assert.ok(groupCounts.includes('本页 1 项'), '统一任务所属成员组标题必须是「本页 1 项」');
  assert.ok(groupCounts.includes('本页 24 项'), '其余 24 个制作任务在管理员组，标题「本页 24 项」');
  const multiRecordRow = page.getByTestId('task-row').filter({ hasText: '同一制作任务 3 条执行记录' });
  assert.equal(await multiRecordRow.count(), 1, '3 条执行记录只占一行制作任务');
  result.assertions.push('默认第一页 25 个制作任务；文案 503 个制作任务 / 505 条执行记录；组标题「本页 1 项」「本页 24 项」');
  await page.screenshot({ path: path.join(evidenceDirectory, 'tasks-page-1.png'), fullPage: true });
  result.evidence.push('tasks-page-1.png');

  // 侧栏角标读全范围执行记录数（03 已改），不显示 25/50。
  await page.getByTestId('workspace-badge-tasks').filter({ hasText: '505' }).waitFor({ timeout: 30_000 });
  assert.equal((await page.getByTestId('workspace-badge-tasks').innerText()).trim(), '505', '侧栏任务角标是 505 条执行记录');
  result.assertions.push('侧栏任务角标显示 505（全范围执行记录），不是 25/50');

  // ---- 2) 分组/平铺只改展示 ----
  await page.getByRole('button', { name: '平铺', exact: true }).click();
  await page.getByTestId('task-flat-list').waitFor({ timeout: 10_000 });
  await waitForRowCount(page, 25);
  assert.match(await waitForSummary(page, '503 个制作任务'), /第 1 \/ 21 页/, '切平铺不改页码/总页数');
  await page.getByRole('button', { name: '按发起人分组', exact: true }).click();
  await page.getByTestId('actor-group').first().waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId('task-row').count(), 25, '切回分组还是同一批 25 个制作任务');
  result.assertions.push('平铺/按发起人分组只改展示，页码、总页数与本页任务集合不变');

  // ---- 3) 翻页只发一次请求；pageSize=50 回第 1 页 ----
  listRequests.length = 0;
  await page.getByTestId('pagination-next').first().click();
  await waitForPagination(page, '第 2 / 21 页');
  await waitForRowCount(page, 25);
  assert.equal(listRequests.length, 1, '翻页只发一次列表请求');
  assert.equal(queryOf(listRequests[0].url).get('page'), '2');
  assert.equal(queryOf(listRequests[0].url).get('pageSize'), '25');
  assert.equal(await page.getByTestId('pagination-prev').first().isDisabled(), false);
  result.assertions.push('翻页只发一次 page=2 请求，不预取、不重复请求');

  await page.getByTestId('pagination-size').first().selectOption('50');
  await waitForPagination(page, '第 1 / 11 页');
  await waitForRowCount(page, 50);
  assert.match(await waitForSummary(page, '503 个制作任务'), /505 条执行记录/, '改每页条数不影响总数');
  await page.getByTestId('pagination-size').first().selectOption('25');
  await waitForPagination(page, '第 1 / 21 页');
  await waitForRowCount(page, 25);
  result.assertions.push('每页条数 25/50 生效且改条数回第 1 页（503 个制作任务 → 11 页）');

  // ---- 4) 搜索：服务端 q、防抖、Enter 立即、保持焦点、跨 500 条命中 ----
  const search = page.getByLabel('查找任务', { exact: true });
  listRequests.length = 0;
  const typedAt = Date.now();
  await search.fill(DEEP_KEYWORD);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查找任务', '输入后焦点仍在搜索框');
  await sleep(150);
  assert.equal(
    listRequests.some((request) => queryOf(request.url).get('q') === DEEP_KEYWORD),
    false,
    '打字后 150ms 内不得发请求（约 300ms 防抖）',
  );
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="task-list-summary"]')?.textContent?.includes(expected) ?? false,
    '共 1 个制作任务', { timeout: 30_000 },
  );
  const debounceRequest = listRequests.find((request) => queryOf(request.url).get('q') === DEEP_KEYWORD);
  assert.ok(debounceRequest, '防抖后必须发服务端搜索请求');
  assert.ok(debounceRequest.at - typedAt >= 250, '搜索请求必须经过约 300ms 防抖');
  assert.equal(queryOf(debounceRequest.url).get('page'), '1', '搜索变化回第 1 页');
  assert.equal(await page.getByTestId('task-row').count(), 1, '500 条之外的关键词也能命中（服务端全历史搜索）');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查找任务', '搜索加载后焦点不丢');
  result.assertions.push('搜索走服务端 q：约 300ms 防抖、输入不丢焦点、500 条之外的关键词能命中、搜索回第 1 页');

  // Enter 立即搜索（不等防抖）。用工号搜索（项目名里含员工姓名，姓名会命中全部任务）。
  listRequests.length = 0;
  await search.fill('task-employee');
  const enterAt = Date.now();
  await search.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="task-list-summary"]')?.textContent?.includes('共 2 个制作任务') ?? false,
    null, { timeout: 30_000 },
  );
  const enterRequest = listRequests.find((request) => queryOf(request.url).get('q') === 'task-employee');
  assert.ok(enterRequest, 'Enter 必须立即发服务端搜索');
  assert.ok(enterRequest.at - enterAt < 250, 'Enter 立即搜索，不等 300ms 防抖');
  assert.equal(await page.getByTestId('task-row').count(), 2, '按工号搜索命中该成员的任务');
  result.assertions.push('Enter 立即搜索（不等防抖），工号可搜索');

  // 姓名 / 模型 / 任务编号仍可搜索（原能力保留）。
  for (const [keyword, expectedRows, expectedTotal] of [
    ['任务页管理员', 25, '共 501 个制作任务'], // 姓名（发起人）
    ['fixture-image-model', 25, '共 503 个制作任务'], // 模型
    ['single-task-010', 1, '共 1 个制作任务'], // 任务编号
  ]) {
    await search.fill(keyword);
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="task-list-summary"]')?.textContent?.includes(expected) ?? false,
      expectedTotal, { timeout: 30_000 },
    );
    assert.equal(await page.getByTestId('task-row').count(), expectedRows, `搜索「${keyword}」应显示 ${expectedRows} 个制作任务`);
  }
  result.assertions.push('姓名、模型、任务编号搜索保留原能力（全部在服务端执行）');

  // 清除筛选 + 成员选项来自完整用户数据（不是当前页去重）。
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await waitForPagination(page, '第 1 / 21 页');
  assert.equal(await search.inputValue(), '', '清除筛选清空搜索');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查找任务', '清除筛选后焦点回搜索框');
  await page.getByLabel('状态', { exact: true }).selectOption('failed');
  await waitForSummary(page, '共 2 个制作任务');
  const memberOptions = await page.getByLabel('发起人', { exact: true }).locator('option').allTextContents();
  assert.equal(memberOptions.length, 3, '成员下拉 = 全部成员 + 占位项，与当前页只剩管理员任务无关');
  assert.ok(memberOptions.some((text) => text.includes('任务页员工')), '成员选项来自完整成员数据，含当前页没有任务的成员');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await waitForSummary(page, '503 个制作任务');
  result.assertions.push('清除筛选恢复全量；管理员成员选项来自完整成员数据（不随当前页变化）');

  // ---- 5) 详情：旧链接/当前页外、翻页保持、关闭保留页与筛选、焦点归还 ----
  const deepDetailUrl = `${baseUrl}/team/tasks?taskId=single-op-502`;
  await page.goto(deepDetailUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail-content').waitFor({ timeout: 60_000 });
  await page.getByTestId('task-detail-off-page').waitFor({ timeout: 10_000 });
  assert.match(await page.getByTestId('task-list-summary').innerText(), /第 1 \/ 21 页/, '深链详情不改变列表页');
  assert.equal(await page.getByTestId('task-row').count(), 25, '深链详情打开时列表仍是第一页 25 项');
  result.assertions.push('`?taskId=` 深链能直接打开当前页/500 条之外的合法任务，并明确说明「不在当前列表页」');
  await page.screenshot({ path: path.join(evidenceDirectory, 'tasks-detail-deeplink.png'), fullPage: true });
  result.evidence.push('tasks-detail-deeplink.png');

  await page.getByTestId('pagination-next').first().click();
  await waitForPagination(page, '第 2 / 21 页');
  await page.getByTestId('task-detail-content').waitFor({ timeout: 10_000 });
  await page.getByTestId('task-detail-off-page').waitFor({ timeout: 10_000 });
  assert.equal(queryOf(page.url()).get('taskId'), 'single-op-502', '翻页不改变已打开的详情');
  result.assertions.push('翻页不改变已打开详情');

  await page.getByTestId('task-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTestId('task-detail').waitFor({ state: 'detached', timeout: 10_000 });
  await waitForPagination(page, '第 2 / 21 页');
  assert.equal(queryOf(page.url()).get('taskId'), null, '关闭详情清理 taskId，但保留列表页');
  result.assertions.push('关闭详情保留列表页');

  // 关闭后焦点归还触发按钮。
  await page.getByTestId('pagination-prev').first().click();
  await waitForPagination(page, '第 1 / 21 页');
  await waitForRowCount(page, 25);
  const focusRow = page.getByTestId('task-row').nth(3);
  const focusOperationId = await focusRow.getAttribute('data-operation-id');
  await focusRow.click();
  await page.getByTestId('task-detail-content').waitFor({ timeout: 30_000 });
  await page.getByTestId('task-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTestId('task-detail').waitFor({ state: 'detached', timeout: 10_000 });
  await sleep(120);
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('data-operation-id')),
    focusOperationId,
    '关闭详情后焦点回到触发行',
  );
  result.assertions.push('关闭详情后焦点归还触发行');

  // 筛选保留：按成员筛选后打开/关闭详情，筛选与页码不变。
  await page.getByLabel('发起人', { exact: true }).selectOption(employeeUserId);
  await waitForSummary(page, '共 2 个制作任务');
  const filteredRow = page.getByTestId('task-row').first();
  await filteredRow.click();
  await page.getByTestId('task-detail-content').waitFor({ timeout: 30_000 });
  await page.getByTestId('task-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTestId('task-detail').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await page.getByLabel('发起人', { exact: true }).inputValue(), employeeUserId, '关闭详情保留成员筛选');
  assert.match(await waitForSummary(page, '共 2 个制作任务'), /第 1 \/ 1 页/);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await waitForSummary(page, '503 个制作任务');
  result.assertions.push('关闭详情保留列表页与筛选');

  // ---- 6) 详情加载中 / 失败 / 已不存在；列表错误与详情错误独立 ----
  const detailRoute = '**/api/team/tasks/detail**';
  await page.route(detailRoute, async (route) => {
    await sleep(1500);
    await route.continue().catch(() => undefined);
  });
  await page.goto(deepDetailUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail-loading').waitFor({ timeout: 10_000 });
  await page.getByTestId('task-detail-content').waitFor({ timeout: 30_000 });
  await page.unroute(detailRoute);
  result.assertions.push('详情加载中有明确反馈');

  await page.route(detailRoute, async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture', message: '详情读取失败（测试注入）' }) }).catch(() => undefined);
  });
  await page.goto(deepDetailUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail-error').waitFor({ timeout: 30_000 });
  assert.match(await page.getByTestId('task-detail-error').innerText(), /详情读取失败（测试注入）/);
  await page.unroute(detailRoute);
  await page.getByRole('button', { name: '重新读取详情', exact: true }).click();
  await page.getByTestId('task-detail-content').waitFor({ timeout: 30_000 });
  result.assertions.push('详情读取失败有错误与重试，重试后恢复');

  await page.goto(`${baseUrl}/team/tasks?taskId=missing-operation-000`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail-missing').waitFor({ timeout: 30_000 });
  assert.match(await page.getByTestId('task-detail-missing').innerText(), /没有找到这条任务/);
  assert.equal(await page.getByTestId('task-detail-content').count(), 0, '不存在的任务不渲染详情正文');
  result.assertions.push('详情已不存在有明确说明，不伪装成空详情');

  // 列表错误与详情错误独立：详情打开时列表失败仍保留详情。
  await page.goto(deepDetailUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail-content').waitFor({ timeout: 60_000 });
  const listRoute = '**/api/team/tasks?*';
  await page.route(listRoute, async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture', message: '列表读取失败（测试注入）' }) }).catch(() => undefined);
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByTestId('task-list-error').waitFor({ timeout: 30_000 });
  assert.match(await page.getByTestId('task-list-error').innerText(), /列表读取失败（测试注入）/);
  assert.match(await page.getByTestId('task-list-summary').innerText(), /任务总数读取失败；请重试，不显示为 0 条/, '列表失败不伪装 0 条');
  await page.getByTestId('task-detail-content').waitFor({ timeout: 10_000 });
  await page.unroute(listRoute);
  await page.getByRole('button', { name: '重试读取列表', exact: true }).click();
  await waitForRowCount(page, 25);
  await page.getByTestId('task-detail-content').waitFor({ timeout: 10_000 });
  result.assertions.push('列表错误与详情错误独立；列表失败显示错误与重试，不伪装空结果/0 条');
  await page.screenshot({ path: path.join(evidenceDirectory, 'tasks-list-error.png'), fullPage: true });
  result.evidence.push('tasks-list-error.png');
  await page.getByTestId('task-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTestId('task-detail').waitFor({ state: 'detached', timeout: 10_000 });

  // ---- 7) 请求竞态：旧搜索的晚到响应不得覆盖新条件 ----
  listRequests.length = 0;
  await page.route(listRoute, async (route) => {
    if (!route.request().url().includes('q=slow-race')) { await route.continue(); return; }
    const response = await route.fetch().catch(() => null);
    await sleep(1800);
    if (response) await route.fulfill({ response }).catch(() => undefined);
  });
  const slowRequestSeen = page.waitForRequest((request) => request.url().includes('q=slow-race'), { timeout: 15_000 });
  await search.fill('slow-race');
  await slowRequestSeen;
  await search.fill('task-employee');
  await waitForSummary(page, '共 2 个制作任务');
  await sleep(2200);
  assert.equal(await search.inputValue(), 'task-employee', '搜索框保留最新关键词');
  assert.match(await page.getByTestId('task-list-summary').innerText(), /共 2 个制作任务/, '旧搜索的晚到响应不得覆盖新条件');
  await waitForRowCount(page, 2);
  assert.equal(await page.getByTestId('task-list-error').count(), 0);
  await page.unroute(listRoute);
  result.assertions.push('请求竞态：旧搜索的晚到响应被丢弃，界面保持最新条件');
  await page.screenshot({ path: path.join(evidenceDirectory, 'tasks-race-final.png'), fullPage: true });
  result.evidence.push('tasks-race-final.png');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await waitForSummary(page, '503 个制作任务');

  // ---- 8) 末页 + 越界收敛（数据减少后刷新保留页并收敛一次） ----
  await page.getByTestId('pagination-jump').first().fill('21');
  await page.getByTestId('pagination-jump-submit').first().click();
  await waitForPagination(page, '第 21 / 21 页');
  await waitForRowCount(page, 3);
  assert.equal(await page.getByTestId('pagination-next').first().isDisabled(), true, '末页禁用下一页');
  result.assertions.push('末页 3 个制作任务（503 = 20×25 + 3），末页禁用下一页');
  await page.screenshot({ path: path.join(evidenceDirectory, 'tasks-last-page.png'), fullPage: true });
  result.evidence.push('tasks-last-page.png');

  deleteOldestSingleTasks(30);
  listRequests.length = 0;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await waitForPagination(page, '第 19 / 19 页', 60_000);
  await waitForRowCount(page, 23);
  await sleep(800);
  const convergenceRequests = listRequests.filter((request) => queryOf(request.url).get('q') === null);
  assert.ok(convergenceRequests.length <= 2, `越界收敛最多重发一次（实际 ${convergenceRequests.length} 次）`);
  assert.equal(await page.getByTestId('pagination-next').first().isDisabled(), true);
  result.assertions.push('数据减少导致越界时，刷新保留页并按响应 pagination.page 收敛一次（21 → 19），不循环重请求');

  // ---- 9) 重试：走原接口，成功后刷新详情与当前页，显示回队 ----
  await page.goto(`${baseUrl}/team/tasks?taskId=${RETRY_OPERATION_ID}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByTestId('task-detail-content').waitFor({ timeout: 60_000 });
  await page.getByTestId('retry-task').waitFor({ timeout: 10_000 });
  assert.equal(readJobStatus(RETRY_TASK_ID), 'failed', '重试前业务任务已失败');
  listRequests.length = 0;
  await page.getByTestId('retry-task').click();
  await page.getByText(/已重新加入队列/).first().waitFor({ timeout: 30_000 });
  await page.getByTestId('task-detail-content').filter({ hasText: '排队中' }).waitFor({ timeout: 30_000 });
  assert.equal(readJobStatus(RETRY_TASK_ID), 'pending', '重试走原 /api/jobs/[id]/retry，业务任务回到排队');
  assert.ok(listRequests.length >= 1, '重试成功后刷新当前页');
  assert.equal(await page.getByTestId('task-list-error').count(), 0);
  result.assertions.push('失败任务重试走原重试接口；成功后刷新详情与当前页并显示「排队中」，没有额外模型提交');
  await page.screenshot({ path: path.join(evidenceDirectory, 'tasks-retry.png'), fullPage: true });
  result.evidence.push('tasks-retry.png');

  // ---- 10) 员工：只见本人、他人详情 404、不请求成员管理接口 ----
  const employeeContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
  const employeePage = await employeeContext.newPage();
  employeePage.on('pageerror', (error) => result.pageErrors.push(`employee: ${error.message}`));
  const employeeRequests = [];
  employeePage.on('request', (request) => employeeRequests.push(request.url()));
  await loginViaUi(employeePage, employeeId, employeePassword);
  await employeePage.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitForRowCount(employeePage, 1);
  await waitForSummary(employeePage, '共 1 个制作任务');
  assert.match(await employeePage.getByTestId('task-list-summary').innerText(), /3 条执行记录/, '员工只看到自己的 3 条执行记录');
  assert.equal(await employeePage.getByLabel('发起人', { exact: true }).count(), 0, '员工没有发起人筛选');
  assert.equal(employeeRequests.some((url) => url.includes('/api/team/users')), false, '员工不得请求无权的成员管理接口');
  await employeePage.getByTestId('workspace-badge-tasks').filter({ hasText: '3' }).waitFor({ timeout: 30_000 });
  result.assertions.push('员工只看到本人任务（1 个制作任务 / 3 条执行记录）、无发起人筛选、不请求 /api/team/users');

  await employeePage.goto(`${baseUrl}/team/tasks?taskId=single-op-001`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await employeePage.getByTestId('task-detail-missing').waitFor({ timeout: 30_000 });
  assert.match(await employeePage.getByTestId('task-detail-missing').innerText(), /没有找到这条任务/);
  assert.equal(await employeePage.getByTestId('task-detail-content').count(), 0, '员工看不到他人任务详情');
  const detailText = await employeePage.getByTestId('task-detail').innerText();
  assert.equal(detailText.includes('single-op-001'), false, '404 不泄漏他人任务编号');
  result.assertions.push('员工打开他人任务详情显示 404 说明，不泄漏详情');
  await employeePage.screenshot({ path: path.join(evidenceDirectory, 'tasks-employee.png'), fullPage: true });
  result.evidence.push('tasks-employee.png');
  await employeeContext.close();

  assert.deepEqual(result.pageErrors, [], '页面不得出现未处理异常');
  result.result = 'passed';
  console.log(`team task pagination tests passed; evidence in ${path.relative(repoRoot, evidenceDirectory)}`);
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (activePage) {
    try {
      await activePage.screenshot({ path: path.join(evidenceDirectory, 'failure.png'), fullPage: true });
      result.failurePage = {
        url: activePage.url(),
        summary: await activePage.getByTestId('task-list-summary').innerText().catch(() => null),
        search: await activePage.getByLabel('查找任务', { exact: true }).inputValue().catch(() => null),
        rows: await activePage.getByTestId('task-row').count().catch(() => null),
        recentListRequests: listRequests.slice(-8).map((request) => ({ url: request.url, at: request.at })),
      };
    } catch { /* 页面已关闭时忽略诊断 */ }
  }
  process.exitCode = 1;
  console.error(`team task pagination tests FAILED: ${result.error}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 上偶尔被占用，留待下次回收 */ }
}
