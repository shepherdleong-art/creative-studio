import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

/**
 * 票 06 跨功能验收：**同一个构建、同一个数据根**里同时成立五项用户问题。
 *
 * 五张功能票各自的定向测试与浏览器验收已在票内通过；本脚本不重复单票内部断言，
 * 只验证「合到一起之后仍然成立」：
 *  1. 管理员上传发布模板 → 员工搜索/选择（无资源 ID）；切版本后历史快照可读；
 *  2. 既有视频海报可见 + 视频通道 + 跨账号/未登录拒绝（票 02）；
 *  3. 团队任务默认发起人分组 + 成员/状态筛选 + 平铺（票 03）；
 *  4. H3/Wan 双卡片、单图参考/双图首尾帧/阻止态的服务端决策（票 05）；
 *  5. >11 MiB 大图在四种角色下都交付合规副本、原图不变（票 04）。
 *
 * 真实 `next dev` + 真实 server 模式 + 真实登录会话 + Chromium；付费调用 0 次。
 * 运行：node scripts/ticket-06-cross-acceptance.mjs
 * 证据：outputs/ticket-06-cross-evidence/（gitignored）
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-ticket06-'));
// 本进程内动态 import 的 lib 模块（预处理/派生副本）必须落在隔离根，绝不进仓库 storage。
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const evidenceDirectory = process.env.TICKET06_EVIDENCE_DIR
  ? path.resolve(process.env.TICKET06_EVIDENCE_DIR)
  : path.join(repoRoot, 'outputs', 'ticket-06-cross-evidence');
fs.mkdirSync(evidenceDirectory, { recursive: true });
const deploymentId = 'deployment-ticket06-cross';
const secrets = new Set();
const assertions = [];
const result = { schemaVersion: 1, port: null, assertions, evidence: [], pageErrors: [] };
let server = null;
let serverOutput = '';
let baseUrl = '';
let port = 0;
let browser = null;
let rawDb = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 断言失败时 finally 会关掉页面，任何仍在等待的 Playwright promise 会拒绝。
// 这里显式吞掉这类 reject，避免 unhandled rejection 盖住真正的断言错误。
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/Target page, context or browser has been closed|has been closed|Test ended/i.test(message)) return;
  result.pageErrors.push(`unhandledRejection: ${message}`);
});
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
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'ticket-06-cross',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  };
}
function startServer() {
  const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  server = spawn(process.execPath, [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot, env: environment(), windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    serverOutput += String(chunk);
    fs.writeFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(serverOutput).slice(-2_000_000));
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

async function loginAndRotate(page, employeeId, password, newPassword) {
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

/** 隐私库/私有条目登记：team_resource_scopes 的 rootType/rootId 是 NOT NULL，必须一并给。 */
function insertPrivateScope(resourceType, resourceId, ownerUserId, parent) {
  const at = '2026-10-01T00:00:00.000Z';
  rawDb.prepare(`INSERT INTO team_resource_scopes
      (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES (?, ?, ?, 'private', ?, ?, ?, ?, ?, ?)`).run(
    resourceType, resourceId, ownerUserId,
    parent ? parent.type : null, parent ? parent.id : null,
    parent ? parent.rootType : resourceType, parent ? parent.rootId : resourceId,
    at, at,
  );
}

try {
  port = Number(process.env.TICKET06_PORT ?? 0) || await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  result.port = port;

  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', '0600', '--name', '综合验收管理员'], {
    cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  assert.equal(initialized.status, 0, `首管理员初始化失败：${sanitize(initialized.stderr ?? '')}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(adminCredential, `无法解析首管理员凭据：${sanitize(initialized.stdout)}`);
  secrets.add(adminCredential);

  startServer();
  await waitReady();
  assertions.push(`同一构建的真实 next dev 在临时数据根启动，端口 ${port}，readiness 200`);

  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();
  const adminContext = await browser.newContext({ locale: 'zh-CN' });
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', (error) => result.pageErrors.push(`admin: ${error.message}`));
  const adminPassword = `T06-admin-${randomBytes(12).toString('base64url')}`;
  secrets.add(adminPassword);
  await loginAndRotate(adminPage, '0600', adminCredential, adminPassword);
  assertions.push('管理员经真实登录页建立会话（首次登录完成强制改密）');

  // ── 员工账号：无私人库（0601）、私人空库（0602）、私人非空库（0603）──
  const employees = [
    { employeeId: '0601', displayName: '员工甲无库' },
    { employeeId: '0602', displayName: '员工乙空库' },
    { employeeId: '0603', displayName: '员工丙非空库' },
  ];
  const employeePasswords = new Map();
  for (const entry of employees) {
    const created = await api(adminPage, '/api/team/users', 'POST', {
      employeeId: entry.employeeId, displayName: entry.displayName, role: 'employee',
    });
    assert.equal(created.status, 201, `创建员工 ${entry.employeeId} 失败：${JSON.stringify(created.body).slice(0, 400)}`);
    const credential = created.body?.credential;
    assert.ok(credential, `创建 ${entry.employeeId} 必须返回一次性凭据`);
    secrets.add(credential);
    const password = `T06-emp-${randomBytes(12).toString('base64url')}`;
    secrets.add(password);
    employeePasswords.set(entry.employeeId, { credential, password });
  }
  assertions.push('管理员经真实 API 建 3 名员工（无私人库 / 私人空库 / 私人非空库）');

  rawDb = new Database(path.join(root, 'data', 'workbench.db'));
  rawDb.pragma('busy_timeout = 10000');
  const userIdOf = (employeeId) => rawDb.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get(employeeId);
  const userIds = Object.fromEntries(employees.map((entry) => [entry.employeeId, userIdOf(entry.employeeId)]));
  for (const entry of employees) assert.ok(userIds[entry.employeeId], `必须能查到 ${entry.employeeId} 的 userId`);

  // 私人空库（乙）
  const emptyLibraryId = randomUUID();
  rawDb.prepare(`INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, ownerKey, createdAt, updatedAt)
    VALUES (?, NULL, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(emptyLibraryId, userIds['0602']);
  insertPrivateScope('viral_template_library', emptyLibraryId, userIds['0602'], null);

  // 私人非空库（丙）：1 条私有条目，用来证明「非空私人库也不遮团队版本、也不泄露给同事」
  const personalLibraryId = randomUUID();
  const personalRevisionId = randomUUID();
  const personalEntryId = randomUUID();
  rawDb.prepare(`INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, ownerKey, createdAt, updatedAt)
    VALUES (?, NULL, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(personalLibraryId, userIds['0603']);
  insertPrivateScope('viral_template_library', personalLibraryId, userIds['0603'], null);
  rawDb.prepare(`INSERT INTO script_studio_viral_tpl_revisions
      (id, libraryId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
    VALUES (?, ?, 1, '私人历史.xlsx', 'private-legacy-sha', '{}', '2026-10-01T00:00:00.000Z')`).run(personalRevisionId, personalLibraryId);
  insertPrivateScope('viral_template_revision', personalRevisionId, userIds['0603'],
    { type: 'viral_template_library', id: personalLibraryId, rootType: 'viral_template_library', rootId: personalLibraryId });
  rawDb.prepare(`INSERT INTO script_studio_viral_tpl_entries
      (id, revisionId, sourceTemplateId, category, subCategory, name, title, refText,
       structureRaw, structureSummary, structure, structureOrigin, rawColumnsJson,
       sourceSheet, sourceRow, sourceFileSha256, contentHash, status, statusReason, statusUpdatedBy, createdAt)
    VALUES (?, ?, 'tpl-private', '床', '实木床', '私人草稿', '私人草稿', '标题：私人\n正文：只属于丙自己。',
       '', '', '钩子>卖点', 'fallback', '{}', '全部模板', 2, 'private-legacy-sha', 'private-hash', 'usable', '', 'import', '2026-10-01T00:00:00.000Z')`)
    .run(personalEntryId, personalRevisionId);
  insertPrivateScope('viral_template_entry', personalEntryId, userIds['0603'],
    { type: 'viral_template_revision', id: personalRevisionId, rootType: 'viral_template_library', rootId: personalLibraryId });
  rawDb.prepare('UPDATE script_studio_viral_tpl_libraries SET currentRevisionId = ? WHERE id = ?').run(personalRevisionId, personalLibraryId);
  assertions.push('预置私人空库与私人非空库（含 1 条私有条目），复现修复前的历史数据形态');

  // ══ 问题 1：管理员上传发布 → 员工搜索/选择（无资源 ID）══
  const resourcesResponse = await adminPage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  assert.equal(resourcesResponse?.status(), 200, '公共资源页必须真实返回 200');
  await adminPage.getByRole('heading', { name: '爆文模板库', exact: true }).waitFor({ timeout: 60_000 });
  await adminPage.getByText('团队还没有发布任何爆文模板库', { exact: false }).waitFor({ timeout: 30_000 });

  const v1Path = path.join(root, '综合验收_团队爆文库_v1.xlsx');
  fs.writeFileSync(v1Path, await workbook([
    ['床', '实木床', '实木床爆款', '实木床真香', '标题：实木床真香\n正文：整块实木框架，睡十年都不塌。', '钩子>痛点>卖点>逼单', 'tpl-bed'],
    ['沙发', '布艺沙发', '沙发模板', '坐下来就不想起来', '标题：坐下来就不想起来\n正文：坐深 60 公分，整个人陷进去。', '钩子>卖点>结尾', 'tpl-sofa'],
  ]));
  await adminPage.getByLabel('上传爆文模板 .xlsx', { exact: true }).setInputFiles(v1Path);
  await adminPage.getByText('发布预览（确认后才替换团队版本）', { exact: false }).waitFor({ timeout: 120_000 });
  const previewPanel = adminPage.locator('div').filter({ hasText: '发布预览（确认后才替换团队版本）' }).last();
  await previewPanel.getByText('条目总数：').waitFor({ timeout: 30_000 });
  assert.match(await previewPanel.innerText(), /条目总数：\s*2/, '预览必须显示总数 2');
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '01-admin-preview.png'), fullPage: true });
  result.evidence.push('01-admin-preview.png');
  // 预览阶段不得落库
  assert.equal((await api(adminPage, '/api/team/public-resources/viral-templates')).body?.current ?? null, null,
    '预览阶段团队当前版本必须仍为空');

  // 注意：页面上「发布给团队」按钮不止一个（预览面板内 + 历史版本行都有），
  // 必须在预览面板作用域内定位，否则 Playwright strict mode 会拒绝。
  const publishFirst = adminPage.waitForResponse((response) => (
    response.url().includes('/api/team/public-resources/viral-templates')
    && !response.url().includes('mode=preview')
    && response.request().method() === 'POST'
  )).catch((error) => ({ status: () => 0, text: async () => `waitForResponse 失败：${error.message}` }));
  await previewPanel.getByRole('button', { name: '发布给团队', exact: true }).click();
  const publishFirstResponse = await publishFirst;
  assert.equal(publishFirstResponse.status(), 201, await publishFirstResponse.text());
  await adminPage.getByText('团队当前版本 v1', { exact: false }).waitFor({ timeout: 60_000 });
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '02-admin-published-v1.png'), fullPage: true });
  result.evidence.push('02-admin-published-v1.png');
  const teamStateV1 = (await api(adminPage, '/api/team/public-resources/viral-templates')).body;
  assert.equal(teamStateV1.current.entryCounts.usable, 2);
  const v1RevisionId = teamStateV1.current.id;
  assertions.push('管理员仅用文件与界面按钮发布 v1（全程无资源 ID 输入），页面显示「团队当前版本 v1」');

  const employeeContexts = new Map();
  for (const entry of employees) {
    const context = await browser.newContext({ locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', (error) => result.pageErrors.push(`${entry.employeeId}: ${error.message}`));
    const { credential, password } = employeePasswords.get(entry.employeeId);
    await loginAndRotate(page, entry.employeeId, credential, password);
    employeeContexts.set(entry.employeeId, { context, page });
  }
  assertions.push('3 名员工各自独立浏览上下文 + 真实登录会话');

  for (const entry of employees) {
    const { page } = employeeContexts.get(entry.employeeId);
    const view = await page.evaluate(async () => {
      const response = await fetch('/api/script-studio/viral-templates', { cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(view.status, 200);
    assert.equal(view.body.source, 'team', `${entry.employeeId} 必须解析到团队版本`);
    assert.equal(view.body.current?.id, v1RevisionId, `${entry.employeeId}（${entry.displayName}）必须读到同一团队版本`);
    assert.equal(view.body.canManage, false);
    const entries = await page.evaluate(async () => {
      const response = await fetch('/api/script-studio/viral-templates/entries?status=usable', { cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(entries.body.entries.length, 2, `${entry.employeeId} 必须读到 2 个团队可用条目`);
    assert.deepEqual(entries.body.entries.map((item) => item.name).sort(), ['实木床爆款', '沙发模板']);
  }
  assertions.push('无私人库 / 私人空库 / 私人非空库 3 名员工读到同一团队当前版本与 2 个可用条目（私人条目不可见）');

  const { page: employeePage } = employeeContexts.get('0603');
  const searched = await employeePage.evaluate(async () => {
    const response = await fetch('/api/script-studio/viral-templates/entries?status=usable&q=%E6%B2%99%E5%8F%91', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(searched.status, 200);
  assert.deepEqual(searched.body.entries.map((entry) => entry.name), ['沙发模板'], '员工按关键词搜索团队模板必须命中');
  assertions.push('员工按关键词搜索团队模板命中（服务端查询参数，不是前端过滤）');

  // 建一个项目，供任务中心与视频工位使用（项目必须绑定一个已存在的图片供应商）。
  const crossProvider = await api(adminPage, '/api/providers', 'POST', {
    name: '综合验收夹具供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-not-a-real-key',
    model: 'gpt-image-2', type: 'openai-compatible',
  });
  assert.ok(crossProvider.status < 400 && crossProvider.body?.id,
    `建夹具供应商失败：${JSON.stringify(crossProvider.body).slice(0, 400)}`);
  const projectCreated = await api(adminPage, '/api/projects', 'POST', {
    storeCode: 'B店', productCode: 'T06-CROSS', productionType: 'AI种草', editorName: '综合验收',
    providerId: crossProvider.body.id, model: 'gpt-image-2', size: '1024x1024',
  });
  assert.ok(projectCreated.status < 400 && projectCreated.body?.id, `建项目失败：${JSON.stringify(projectCreated.body).slice(0, 400)}`);
  const crossProjectId = projectCreated.body.id;
  result.crossProjectId = crossProjectId;

  // 管理员发布 v2：员工立即读到新版本
  const v2Path = path.join(root, '综合验收_团队爆文库_v2.xlsx');
  fs.writeFileSync(v2Path, await workbook([
    ['床', '实木床', '实木床爆款二版', '二版标题', '标题：二版标题\n正文：新版静音床板。', '钩子>卖点', 'tpl-bed-v2'],
  ]));
  await adminPage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await adminPage.getByRole('heading', { name: '爆文模板库', exact: true }).waitFor({ timeout: 60_000 });
  await adminPage.getByLabel('上传爆文模板 .xlsx', { exact: true }).setInputFiles(v2Path);
  await adminPage.getByText('发布预览（确认后才替换团队版本）', { exact: false }).waitFor({ timeout: 120_000 });
  const previewPanelV2 = adminPage.locator('div').filter({ hasText: '发布预览（确认后才替换团队版本）' }).last();
  await previewPanelV2.getByText('条目总数：').waitFor({ timeout: 30_000 });
  const publishSecond = adminPage.waitForResponse((response) => (
    response.url().includes('/api/team/public-resources/viral-templates')
    && !response.url().includes('mode=preview')
    && response.request().method() === 'POST'
  )).catch((error) => ({ status: () => 0, text: async () => `waitForResponse 失败：${error.message}` }));
  await previewPanelV2.getByRole('button', { name: '发布给团队', exact: true }).click();
  const publishSecondResponse = await publishSecond;
  assert.equal(publishSecondResponse.status(), 201, await publishSecondResponse.text());
  await adminPage.getByText('团队当前版本 v2', { exact: false }).waitFor({ timeout: 60_000 });
  await adminPage.getByRole('button', { name: '设为当前版本' }).first().waitFor({ timeout: 30_000 });
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '03-admin-two-versions.png'), fullPage: true });
  result.evidence.push('03-admin-two-versions.png');

  const afterV2 = await employeePage.evaluate(async () => {
    const view = await fetch('/api/script-studio/viral-templates', { cache: 'no-store' }).then((r) => r.json());
    const entries = await fetch('/api/script-studio/viral-templates/entries?status=usable', { cache: 'no-store' }).then((r) => r.json());
    return { current: view.current, names: entries.entries.map((entry) => entry.name) };
  });
  assert.notEqual(afterV2.current.id, v1RevisionId, '员工必须读到新的当前版本');
  assert.deepEqual(afterV2.names, ['实木床爆款二版'], '员工只看到 v2 条目');
  assertions.push('管理员发布 v2 后员工立即读到新当前版本（旧版本条目不混入当前）');

  // 历史快照：v1 修订条目仍按 ID 可读，内容不变（历史任务/断连重试口径）
  const adminOldSnapshot = await api(adminPage, `/api/script-studio/viral-templates/entries?revisionId=${encodeURIComponent(v1RevisionId)}&status=all`);
  assert.equal(adminOldSnapshot.status, 200, '已发布历史版本条目必须仍可按 ID 读取');
  assert.equal(adminOldSnapshot.body.entries.length, 2, 'v1 的 2 条条目必须保留');
  assert.ok(adminOldSnapshot.body.entries.some((entry) => entry.refText.includes('睡十年都不塌')), 'v1 快照内容必须保持原样');
  const employeeOldSnapshot = await employeePage.evaluate(async ({ revisionId }) => {
    const response = await fetch(`/api/script-studio/viral-templates/entries?revisionId=${encodeURIComponent(revisionId)}&status=all`, { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, { revisionId: v1RevisionId });
  result.employeeOldRevision = { status: employeeOldSnapshot.status, count: employeeOldSnapshot.body?.entries?.length ?? null };
  assertions.push('切到 v2 后 v1 修订条目仍按 ID 可读且内容不变（历史任务/断连重试沿用冻结快照）');

  // 员工越权：不能 POST 发布
  const employeePublish = await employeePage.evaluate(async () => {
    const csrf = await fetch('/api/team/auth/csrf').then((r) => r.json());
    const response = await fetch('/api/team/public-resources/viral-templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.csrfToken },
      body: JSON.stringify({ revisionId: 'anything', baseRevisionId: null }),
    });
    return response.status;
  });
  assert.equal(employeePublish, 403, '员工 POST 发布必须被拒绝');
  assertions.push('员工 POST 发布团队模板被拒 403');

  // ══ 问题 3：团队任务默认发起人分组 ══
  const insertOp = rawDb.prepare(`
    INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, waitReason, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', 'r1', ?, 1, 'h', '{}', 'image.submit', '{}', '[]', '{}', ?, ?, ?, ?, ?)
  `);
  const seedCount = rawDb.transaction(() => {
    let seq = 0;
    // 乙：一条最早任务（会在「最近记录上限」里被更新任务挤出，但成员名册仍可选到）
    seq += 1;
    insertOp.run('t06-low', 'key-t06-low', userIds['0602'], crossProjectId, 'task-t06-low', 'biz-t06-low',
      'succeeded', seq, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    // 甲：多条较新任务
    for (let index = 0; index < 6; index += 1) {
      seq += 1;
      const at = new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
      insertOp.run(`t06-a-${index}`, `key-t06-a-${index}`, userIds['0601'], crossProjectId,
        `task-t06-a-${index}`, `biz-t06-a-${index}`, 'succeeded', seq, null, at, at);
    }
    // 丙：等待中 + 已取消
    seq += 1;
    insertOp.run('t06-c-wait', 'key-t06-c-wait', userIds['0603'], crossProjectId, 'task-t06-c-wait', 'biz-t06-c-wait',
      'deferred', seq, 'actor_disabled', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
    seq += 1;
    insertOp.run('t06-c-cancel', 'key-t06-c-cancel', userIds['0603'], crossProjectId, 'task-t06-c-cancel', 'biz-t06-c-cancel',
      'pending', seq, 'stage_canceled', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
    return seq;
  }).immediate?.() ?? null;
  const taskRows = rawDb.prepare("SELECT COUNT(*) AS n FROM execution_operations WHERE id LIKE 't06-%'").get().n;
  assert.equal(taskRows, 9, `任务夹具必须有 9 条记录，实测 ${taskRows}`);
  assertions.push(`隔离库写入 9 条执行记录（3 名发起人，含等待中与已取消）${seedCount ? '' : ''}`);

  await adminPage.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await adminPage.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 60_000 });
  // 默认视图必须是分组，且每组带 actorUserId
  await adminPage.locator('[data-testid="task-actor-group"]').first().waitFor({ timeout: 30_000 });
  const groupedUi = await adminPage.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-testid="task-actor-group"]')];
    return {
      count: groups.length,
      actorIds: groups.map((group) => group.getAttribute('data-actor-user-id')),
      text: document.body.innerText.slice(0, 6000),
      pressed: [...document.querySelectorAll('button[aria-pressed]')].map((button) => ({ label: button.innerText.trim(), pressed: button.getAttribute('aria-pressed') })),
    };
  });
  assert.ok(groupedUi.count >= 3, `默认按发起人分组必须至少有 3 组，实测 ${groupedUi.count}`);
  assert.ok(groupedUi.actorIds.every(Boolean), '每个分组必须带 actorUserId');
  assert.equal(new Set(groupedUi.actorIds).size, groupedUi.actorIds.length, '分组身份不得重复（同名成员不混组）');
  const groupedPressed = groupedUi.pressed.find((item) => item.label.includes('按发起人分组'));
  assert.equal(groupedPressed?.pressed, 'true', '默认视图必须是按发起人分组');
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '04-tasks-grouped.png'), fullPage: true });
  result.evidence.push('04-tasks-grouped.png');
  assertions.push(`团队任务页默认按发起人分组（${groupedUi.count} 组，每组带 actorUserId，身份唯一）`);

  // 平铺切换 + 同页刷新保持视图
  await adminPage.getByRole('button', { name: '平铺', exact: true }).click();
  await adminPage.waitForTimeout(600);
  const flatState = await adminPage.evaluate(() => ({
    groups: document.querySelectorAll('[data-testid="task-actor-group"]').length,
    pressed: [...document.querySelectorAll('button[aria-pressed]')].map((b) => ({ label: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') })),
  }));
  assert.equal(flatState.groups, 0, '平铺视图不得再有分组容器');
  assert.equal(flatState.pressed.find((item) => item.label === '平铺')?.pressed, 'true');
  await adminPage.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await adminPage.waitForTimeout(1_200);
  const afterReload = await adminPage.evaluate(() => ({
    groups: document.querySelectorAll('[data-testid="task-actor-group"]').length,
    pressed: [...document.querySelectorAll('button[aria-pressed]')].map((b) => ({ label: b.innerText.trim(), pressed: b.getAttribute('aria-pressed') })),
  }));
  assert.equal(afterReload.pressed.find((item) => item.label === '平铺')?.pressed, 'true', '同页刷新必须保留平铺视图');
  await adminPage.screenshot({ path: path.join(evidenceDirectory, '05-tasks-flat-reloaded.png'), fullPage: true });
  result.evidence.push('05-tasks-flat-reloaded.png');
  // 切回分组
  await adminPage.getByRole('button', { name: '按发起人分组', exact: true }).click();
  await adminPage.locator('[data-testid="task-actor-group"]').first().waitFor({ timeout: 30_000 });
  assertions.push('平铺/分组切换可用，同页刷新保留当前视图');

  const tasksApi = await api(adminPage, '/api/team/tasks');
  assert.equal(tasksApi.status, 200);
  assert.equal(tasksApi.body.limit, 500);
  assert.equal(tasksApi.body.truncated, false);
  assert.equal(tasksApi.body.totalMatching, null, '本轮不做全历史分页，必须显式 null');
  const actorIds = new Set(tasksApi.body.items.map((item) => item.actorUserId));
  assert.equal(actorIds.size, 3, `任务必须覆盖 3 名发起人，实测 ${actorIds.size}`);
  assert.ok(tasksApi.body.actors.length >= 3, '成员名册必须覆盖全部成员');
  for (const item of tasksApi.body.items) {
    assert.ok(item.employeeId, '每条任务必须带工号');
    assert.ok(item.actorDisplayName, '每条任务必须带姓名');
  }
  assertions.push('任务 API：3 名发起人、每项带姓名+工号、limit=500/truncated=false/totalMatching=null');

  const filtered = await api(adminPage, `/api/team/tasks?actorUserId=${encodeURIComponent(userIds['0602'])}`);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.items.length >= 1, '按成员筛选必须查出低频成员任务');
  assert.ok(filtered.body.items.every((item) => item.actorUserId === userIds['0602']), '成员筛选必须严格按 actorUserId');
  const canceled = await api(adminPage, '/api/team/tasks?status=canceled');
  assert.equal(canceled.status, 200);
  assert.ok(canceled.body.items.length >= 1 && canceled.body.items.every((item) => item.status === 'canceled'),
    '状态筛选 canceled 必须只返回取消语义记录');
  const waiting = await api(adminPage, '/api/team/tasks?status=deferred');
  assert.equal(waiting.status, 200);
  assert.ok(waiting.body.items.every((item) => item.status !== 'canceled'), '等待筛选不得把已取消记录捞回来');
  assertions.push('成员筛选（服务端 actorUserId）与状态筛选（含取消语义、等待不被取消污染的）真实 HTTP 可用');

  const employeeTasks = await employeePage.evaluate(async () => {
    const response = await fetch('/api/team/tasks', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(employeeTasks.status, 200);
  assert.ok(employeeTasks.body.items.every((item) => item.actorUserId === userIds['0603']), '员工只能查自己');
  const tampered = await employeePage.evaluate(async ({ otherId }) => {
    const response = await fetch(`/api/team/tasks?actorUserId=${encodeURIComponent(otherId)}`, { cache: 'no-store' });
    return response.status;
  }, { otherId: userIds['0601'] });
  assert.equal(tampered, 403, '员工篡改 actorUserId 必须 403');
  assertions.push('员工查询仅本人；篡改 actorUserId 返回 403（不能绕过权限）');

  // ══ 问题 2：既有视频海报 + 视频通道 + 跨账号/未登录拒绝 ══
  const posterFixture = spawnSync(process.execPath, [
    'scripts/team-server/seed-video-poster-fixture.mjs',
    '--mode', 'server', '--owner-a', userIds['0601'], '--owner-b', userIds['0603'],
  ], { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 300_000, windowsHide: true });
  assert.equal(posterFixture.status, 0, `海报夹具失败：${sanitize(posterFixture.stderr ?? '').slice(-2000)}`);
  const posterLine = /FIXTURE_RESULT (.+)/.exec(posterFixture.stdout);
  assert.ok(posterLine, `夹具必须输出 FIXTURE_RESULT：${sanitize(posterFixture.stdout).slice(-1000)}`);
  const poster = JSON.parse(posterLine[1]);
  result.posterFixture = { projectId: poster.projectId, shotSetId: poster.shotSetId };

  const { page: ownerPage } = employeeContexts.get('0601');
  // 第四步分镜组用 localStorage 预置（沿用既有恢复逻辑，这里不是测组选择）。
  await ownerPage.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: `creative-studio:video-shot-set:${poster.projectId}`, value: poster.shotSetId });
  const ownerProjectResponse = await ownerPage.goto(`${baseUrl}/projects/${poster.projectId}?tab=video`,
    { waitUntil: 'networkidle', timeout: 180_000 });
  assert.equal(ownerProjectResponse?.status(), 200, '所属员工的项目页必须 200');
  // 结果卡里的受保护海报：用组件真实的 alt 选择器
  const posterSelector = '.result-thumb img[alt="视频缩略图"]';
  await ownerPage.locator(posterSelector).first().waitFor({ timeout: 60_000 }).catch(() => undefined);
  await ownerPage.waitForTimeout(2_000);
  const posterState = await ownerPage.evaluate((query) => {
    const image = document.querySelector(query);
    if (!image) return { present: false };
    const allImages = [...document.querySelectorAll('img')];
    return {
      present: true,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      currentSrc: image.currentSrc,
      usesOptimiser: image.currentSrc.includes('/_next/image'),
      fallbackShown: Boolean(document.querySelector('[data-testid="video-poster-fallback"]')),
      totalImages: allImages.length,
      loadedImages: allImages.filter((item) => item.complete && item.naturalWidth > 0).length,
    };
  }, posterSelector);
  result.posterState = posterState;
  await ownerPage.screenshot({ path: path.join(evidenceDirectory, '06-owner-video-poster.png'), fullPage: true });
  result.evidence.push('06-owner-video-poster.png');
  assert.equal(posterState.present, true, '所属员工页面上必须出现受保护海报元素（.result-thumb img[alt="视频缩略图"]）');
  assert.equal(posterState.complete, true, '海报必须加载完成');
  assert.equal(posterState.naturalWidth, 640, `海报必须真的解码出 640 宽，实测 ${posterState.naturalWidth}`);
  assert.equal(posterState.naturalHeight, 360, `海报必须真的解码出 360 高，实测 ${posterState.naturalHeight}`);
  assert.equal(posterState.usesOptimiser, false, '受保护海报不得经 Next 图片优化器');
  assertions.push(`所属员工在真实浏览器页面上真的解码出既有视频海报 ${posterState.naturalWidth}×${posterState.naturalHeight}（不经 _next/image 优化器）`);

  const posterHttp = await ownerPage.evaluate(async ({ url }) => {
    const response = await fetch(url, { cache: 'no-store' });
    const buffer = await response.arrayBuffer();
    return {
      status: response.status,
      bytes: buffer.byteLength,
      cacheControl: response.headers.get('cache-control') ?? '',
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)))
        .map((value) => value.toString(16).padStart(2, '0')).join(''),
    };
  }, { url: poster.posterUrl });
  assert.equal(posterHttp.status, 200, '所属员工读取受保护海报必须 200');
  assert.match(posterHttp.cacheControl, /no-store/, '受保护图片必须 no-store');
  assert.equal(posterHttp.sha256, poster.posterSha256, '浏览器取到的海报字节必须与磁盘一致');
  assertions.push('所属员工取受保护海报 200、no-store、字节 SHA-256 与磁盘一致');

  const videoHttp = await ownerPage.evaluate(async ({ url }) => {
    const response = await fetch(url, { cache: 'no-store' });
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  }, { url: poster.videoUrl });
  assert.equal(videoHttp.status, 200, '视频通道必须 200');
  assert.equal(videoHttp.bytes, poster.videoBytes, '视频字节必须与磁盘一致');
  assertions.push(`视频播放/下载通道可用（HTTP 200，${videoHttp.bytes} 字节，与磁盘一致）`);

  // 跨账号拒绝：先把其他员工页导航到同源页面，再在同源上下文里带会话取海报。
  const { page: otherPage } = employeeContexts.get('0603');
  await otherPage.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const crossDenied = await otherPage.evaluate(async ({ url }) => {
    const response = await fetch(url, { cache: 'no-store' });
    return response.status;
  }, { url: poster.posterUrl });
  assert.equal(crossDenied, 404, '其他员工读取他人海报必须 404');
  const crossOtherProject = await otherPage.evaluate(async ({ projectId }) => {
    const response = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
    return response.status;
  }, { projectId: poster.projectId });
  assert.ok([403, 404].includes(crossOtherProject), `其他员工读取他人项目必须 403/404，实测 ${crossOtherProject}`);
  assertions.push(`跨账号拒绝：其他员工读取他人海报 404、他人项目 ${crossOtherProject}`);

  const anonymousContext = await browser.newContext({ locale: 'zh-CN' });
  const anonymousPage = await anonymousContext.newPage();
  // 未登录浏览器会被重定向到登录页 —— 那仍是同源，可以带出真实 401/403 的图片响应。
  await anonymousPage.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const anonymousDenied = await anonymousPage.evaluate(async ({ url }) => {
    const response = await fetch(url, { cache: 'no-store' });
    return response.status;
  }, { url: poster.posterUrl });
  assert.ok([401, 403].includes(anonymousDenied), `未登录读取受保护海报必须 401/403，实测 ${anonymousDenied}`);
  await anonymousContext.close();
  assertions.push(`未登录读取受保护海报被拒（${anonymousDenied}）`);

  // ══ 问题 4：H3/Wan 双卡片与服务端自动模式决策 ══
  const autoFixture = spawnSync(process.execPath, [
    'scripts/team-server/seed-auto-mode-fixture.mjs', '--mode', 'server', '--owner', userIds['0601'],
  ], { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 300_000, windowsHide: true });
  assert.equal(autoFixture.status, 0, `自动模式夹具失败：${sanitize(autoFixture.stderr ?? '').slice(-2000)}`);
  const autoLine = /FIXTURE_RESULT (.+)/.exec(autoFixture.stdout);
  assert.ok(autoLine, `自动模式夹具必须输出 FIXTURE_RESULT：${sanitize(autoFixture.stdout).slice(-1000)}`);
  const auto = JSON.parse(autoLine[1]);
  result.autoFixture = { projectId: auto.projectId, shotSetId: auto.shotSetId };

  // 第四步同样用 localStorage 预置分镜组（沿用既有恢复逻辑）。
  await ownerPage.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: `creative-studio:video-shot-set:${auto.projectId}`, value: auto.shotSetId });
  const videoStepResponse = await ownerPage.goto(`${baseUrl}/projects/${auto.projectId}?tab=video`,
    { waitUntil: 'domcontentloaded', timeout: 120_000 });
  assert.equal(videoStepResponse?.status(), 200, '视频工位页面必须 200');
  // 组件真实选择器（与票 05 验收一致）
  const CARD = '.video-motion-card';
  const PAIR = '[data-testid="video-frame-pair"]';
  const HINT = '[data-testid="video-auto-mode-hint"]';
  await ownerPage.waitForSelector(CARD, { timeout: 120_000 });
  // 显式切到公司 H3：避免页面默认停在别的供应商上造成「没看到双卡片」的假失败。
  const providerSelect = ownerPage.locator(`${CARD} select`).first();
  await providerSelect.waitFor({ timeout: 60_000 });
  await providerSelect.selectOption('company-minimax-h3');
  await ownerPage.waitForTimeout(800);
  const autoFacts = await ownerPage.evaluate(({ cardSelector, pairSelector, hintSelector }) => {
    const card = document.querySelector(cardSelector);
    if (!card) return { present: false };
    const pair = card.querySelector(pairSelector);
    const hint = card.querySelector(hintSelector);
    const tailTile = pair?.querySelector('.video-frame-tail, .video-frame-empty');
    const bodyText = document.body.innerText;
    return {
      present: true,
      pairPresent: Boolean(pair),
      hint: hint?.textContent?.trim() ?? null,
      providerValue: card.querySelector('select')?.value ?? null,
      tailTileRole: tailTile?.classList.contains('video-frame-tail') ? 'loaded'
        : tailTile?.classList.contains('video-frame-empty') ? 'empty' : null,
      hasFirstFrameText: /首帧/.test(bodyText),
      hasModeSwitch: /(生成模式).{0,12}(切换|选择)/.test(bodyText),
    };
  }, { cardSelector: CARD, pairSelector: PAIR, hintSelector: HINT });
  result.autoUi = autoFacts;
  await ownerPage.screenshot({ path: path.join(evidenceDirectory, '07-video-dual-card.png'), fullPage: true });
  result.evidence.push('07-video-dual-card.png');
  assert.equal(autoFacts.present, true, '视频工位必须渲染出运动卡片');
  assert.equal(autoFacts.providerValue, 'company-minimax-h3', `必须已切到公司 H3，实测 ${autoFacts.providerValue}`);
  assert.equal(autoFacts.pairPresent, true, 'H3 必须渲染出首帧/尾帧双卡片容器');
  assert.equal(autoFacts.hasFirstFrameText, true, '必须展示首帧卡');
  assert.equal(autoFacts.tailTileRole, 'empty', `单图草稿时尾帧卡必须处于「添加」空态，实测 ${autoFacts.tailTileRole}`);
  assert.match(String(autoFacts.hint ?? ''), /单图参考|按单图/, `H3 单图草稿提示必须说明按单图参考生成，实测「${autoFacts.hint}」`);
  assert.equal(autoFacts.hasModeSwitch, false, '不得出现人工模式切换控件');
  assertions.push(`H3 视频工位默认双卡片、尾帧卡空态、提示按单图参考生成、无人工模式切换（provider=${autoFacts.providerValue}）`);

  // Wan 同样必须是双卡片（切模型，不换页面）
  await providerSelect.selectOption('company-wan-3-0');
  await ownerPage.waitForTimeout(800);
  const wanFacts = await ownerPage.evaluate(({ cardSelector, pairSelector, hintSelector }) => {
    const card = document.querySelector(cardSelector);
    const pair = card?.querySelector(pairSelector);
    const hint = card?.querySelector(hintSelector);
    const tailTile = pair?.querySelector('.video-frame-tail, .video-frame-empty');
    return {
      providerValue: card?.querySelector('select')?.value ?? null,
      pairPresent: Boolean(pair),
      hint: hint?.textContent?.trim() ?? null,
      tailTileRole: tailTile?.classList.contains('video-frame-tail') ? 'loaded'
        : tailTile?.classList.contains('video-frame-empty') ? 'empty' : null,
    };
  }, { cardSelector: CARD, pairSelector: PAIR, hintSelector: HINT });
  result.autoWan = wanFacts;
  await ownerPage.screenshot({ path: path.join(evidenceDirectory, '08-wan-dual-card.png'), fullPage: true });
  result.evidence.push('08-wan-dual-card.png');
  assert.equal(wanFacts.providerValue, 'company-wan-3-0', `必须已切到公司 Wan，实测 ${wanFacts.providerValue}`);
  assert.equal(wanFacts.pairPresent, true, 'Wan 也必须渲染出首帧/尾帧双卡片容器');
  assert.equal(wanFacts.tailTileRole, 'empty', 'Wan 单图草稿时尾帧卡必须为空态');
  assertions.push('Wan 视频工位同样默认双卡片、尾帧卡空态（两模型在同一构建里都成立）');

  {
    const autoMode = await import('../lib/video-auto-mode.ts');
    const cases = [
      { name: '单图', tail: 'none', expect: 'reference-to-video', blocked: false },
      { name: '有效尾帧', tail: 'ready', expect: 'image-to-video', blocked: false },
      { name: '上传中/失败', tail: 'pending', expect: null, blocked: true },
    ];
    for (const model of ['minimax-h3', 'wan-3.0']) {
      for (const item of cases) {
        const decision = autoMode.decideVideoGenerationMode({
          providerType: 'openai-video', model, tailFrameState: item.tail,
          // 故意给相反的显式模式：自动模式必须忽略前端的 generationMode
          explicitMode: item.tail === 'ready' ? 'reference-to-video' : 'image-to-video',
        });
        assert.equal(decision.automatic, true, `${model} 必须命中自动模式`);
        assert.equal(decision.blocked, item.blocked, `${model}/${item.name} 阻止状态错误`);
        if (item.expect) assert.equal(decision.generationMode, item.expect, `${model}/${item.name} 必须决策为 ${item.expect}`);
      }
      const other = autoMode.decideVideoGenerationMode({
        providerType: 'openai-video', model: 'kling-3.0', tailFrameState: 'ready', explicitMode: 'reference-to-video',
      });
      assert.equal(other.automatic, false, '可灵 3.0 不得进入自动模式');
      assert.equal(other.generationMode, 'reference-to-video', '非目标模型沿用显式模式');
    }
    // 精确 allowlist：前缀/大小写近似都不行
    for (const model of ['minimax-h3-pro', 'wan-3', 'minimax-h3 ', 'MINIMAX-H3']) {
      assert.equal(autoMode.isVideoAutoModeTarget('openai-video', model), false, `${model} 不得被前缀/近似匹配命中`);
    }
    assert.equal(autoMode.isVideoAutoModeTarget('jimeng', 'minimax-h3'), false, '非 openai-video 类型不得进入自动模式');
    assertions.push('两模型 × 单图/有效尾帧/上传中 的服务端决策正确且忽略前端显式模式；可灵不受影响；allowlist 精确匹配');
  }

  // ══ 问题 5：>11 MiB 大图在创建/交付两阶段都合规 ══
  {
    const prep = await import('../lib/video-reference-preprocess.ts');
    const budget = await import('../lib/video-reference-preprocess.ts');
    const largePath = path.join(root, 't06-large.png');
    await sharp({ create: { width: 3400, height: 3200, channels: 3, background: { r: 30, g: 90, b: 160 } } })
      .png({ compressionLevel: 0 }).toFile(largePath);
    const bytes = fs.statSync(largePath).size;
    assert.ok(bytes > 11 * 1024 * 1024, `大图夹具必须 >11 MiB，实测 ${bytes}`);
    const hash = createHash('sha256').update(fs.readFileSync(largePath)).digest('hex');
    const roles = [
      ['minimax-h3', 'reference'], ['wan-3.0', 'reference'],
      ['minimax-h3', 'first-frame'], ['wan-3.0', 'last-frame'],
    ];
    const delivered = [];
    for (const [model, role] of roles) {
      const outcome = await prep.prepareVideoJobImage({ providerType: 'openai-video', model, role, absolutePath: largePath });
      assert.ok(outcome, `${model}/${role} 必须返回预处理结果（严格路径不得静默跳过）`);
      // 返回值是 { prepared } 包装：原图合规时也会返回，但 derived=false。
      const prepared = outcome.prepared;
      const limit = role === 'last-frame' ? 4_800_000 : 10 * 1024 * 1024;
      assert.ok(prepared.byteSize <= limit, `${model}/${role} 交付字节必须在预算内（实测 ${prepared.byteSize} > ${limit}）`);
      assert.ok(['image/jpeg', 'image/png'].includes(prepared.mimeType), `${model}/${role} 交付 MIME 必须受支持`);
      assert.ok(prepared.width <= 4096 && prepared.height <= 4096, `${model}/${role} 交付尺寸必须在预算内`);
      assert.equal(prepared.derived, true, `${model}/${role} 超预算原图必须物化派生副本`);
      assert.notEqual(prepared.absolutePath, largePath, '不得就地改写原图');
      delivered.push({ model, role, byteSize: prepared.byteSize, mimeType: prepared.mimeType, derived: prepared.derived });
    }
    assert.equal(createHash('sha256').update(fs.readFileSync(largePath)).digest('hex'), hash, '原图字节不得被修改');
    // 预算合同只对两个模型生效，不得扩散
    assert.equal(budget.videoImageBudget('jimeng', 'doubao-seedance-2-5-260628', 'reference'), null,
      '其他供应商类型不得获得本票的严格预算');
    result.largeImage = { sourceBytes: bytes, delivered };
    assertions.push(`>11 MiB 原图（${(bytes / 1024 / 1024).toFixed(1)} MiB）在两模型 × 参考/首帧/尾帧四种角色下都物化合规副本，原图哈希不变，预算不外溢到其他模型`);
  }

  // ══ 落库事实复核 ══
  const libraries = rawDb.prepare('SELECT id, ownerKey, currentRevisionId FROM script_studio_viral_tpl_libraries ORDER BY createdAt').all();
  const teamLibraries = libraries.filter((row) => row.ownerKey === '__team__');
  assert.equal(teamLibraries.length, 1, '必须只有一个团队库');
  assert.equal(libraries.filter((row) => row.ownerKey === userIds['0601']).length, 0, '读请求不得为无库员工建私人库');
  assert.ok(libraries.some((row) => row.ownerKey === userIds['0602']), '乙的私人空库保持原样');
  assert.ok(libraries.some((row) => row.ownerKey === userIds['0603']), '丙的私人非空库保持原样');
  result.database = { libraryCount: libraries.length, teamLibraryCount: teamLibraries.length };
  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理 pageerror');
  assertions.push('落库复核：唯一 __team__ 库、读请求未建库、两名员工的私人库保持原样；浏览器无未处理异常');

  result.result = 'passed';
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer();
  try { rawDb?.close(); } catch { /* already closed */ }
  fs.writeFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(serverOutput).slice(-2_000_000));
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${sanitize(JSON.stringify(result, null, 2))}\n`);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* isolated root */ }
  console.log(sanitize(`ticket-06 cross acceptance ${result.result}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`));
}
