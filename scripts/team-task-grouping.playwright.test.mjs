// 团队任务发起人分组：真实 next dev + 真实登录会话 + Chromium 真渲染。
//
// 覆盖票 03 的浏览器要求：默认分组视图、分组/平铺切换、折叠、整页刷新后保留视图与筛选、
// 同名成员成组不混、500 条截断下低频成员仍可从成员选项选出并查到、深浅主题与窄屏。
// 不使用源码字符串断言。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-task-grouping-'));
const evidenceDirectory = process.env.TEAM_TASK_GROUPING_EVIDENCE_DIR
  ? path.resolve(process.env.TEAM_TASK_GROUPING_EVIDENCE_DIR)
  : path.join(root, 'evidence');
const resultPath = process.env.TEAM_TASK_GROUPING_RESULT_PATH
  ? path.resolve(process.env.TEAM_TASK_GROUPING_RESULT_PATH)
  : path.join(root, 'result.json');
fs.mkdirSync(evidenceDirectory, { recursive: true });

const deploymentId = 'deployment-team-task-grouping';
let server = null;
let serverOutput = '';
let port = 0;
let baseUrl = '';
let browser = null;
const result = { schemaVersion: 1, assertions: [], evidence: [], pageErrors: [], realPaidProviderCalls: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitize(text) {
  return String(text).split(root).join('[isolated-data-root]');
}

async function availablePort() {
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
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'team-task-grouping-local',
  };
}

// 工作树的 node_modules 是真实物理拷贝（不是指向主检出的 junction），
// 所以直接用它自带的 next 二进制、cwd 也留在工作树即可。
// 不要加 --webpack：本仓库 webpack 分支会因 sharp 可选依赖 @img/sharp-wasm32 缺失而 500。
const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');

function startServer() {
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
  const deadline = Date.now() + 180_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`隔离 Next 服务提前退出 ${server.exitCode}: ${sanitize(serverOutput).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch { /* 启动中 */ }
    await sleep(250);
  }
  throw new Error(`隔离 Next 服务 readiness 超时，最后状态 ${lastStatus}: ${sanitize(serverOutput).slice(-4000)}`);
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
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  const { json: body, ...init } = options;
  return fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(120_000),
    ...init,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonRequest(session, pathname, options = {}, expected = null) {
  const response = await request(session, pathname, options);
  if (expected !== null) {
    assert.equal(response.status, expected, `${options.method ?? 'GET'} ${pathname}: ${await response.clone().text()}`);
  }
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
  await jsonRequest(session, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword, newPassword },
  }, 200);
}

const users = [];
let adminSession = null;
let adminPassword = '';
const lowMember = { employeeId: '0320', displayName: '低频成员', password: '' };
const sameNameMembers = [
  { employeeId: '0301', displayName: '李四', password: '' },
  { employeeId: '0302', displayName: '李四', password: '' },
];
const disabledMember = { employeeId: '0399', displayName: '已停用成员', password: '' };

async function seedTasks() {
  // 通过真实 API 造会员；账号由后端生成一次性凭据，再改成已知密码。
  for (const entry of [...sameNameMembers, lowMember, disabledMember]) {
    const created = await jsonRequest(adminSession, '/api/team/users', {
      method: 'POST', json: { employeeId: entry.employeeId, displayName: entry.displayName, role: 'employee' },
    }, 201);
    const session = await login(entry.employeeId, created.body.credential);
    entry.password = `Task-grouping-${entry.employeeId}-${Math.random().toString(36).slice(2, 10)}`;
    await changePassword(session, created.body.credential, entry.password);
    users.push({ ...entry, session });
  }
  // 停用成员：先有任务再停用，用来验证「历史停用但仍有任务的成员可辨认」。
  await jsonRequest(adminSession, `/api/team/users/${await userIdOf(disabledMember.employeeId)}`, {
    method: 'PATCH', json: { status: 'disabled' },
  }, 200);
}

async function userIdOf(employeeId) {
  const body = await (await request(adminSession, '/api/team/users')).json();
  const user = body.users.find((entry) => entry.employeeId === employeeId);
  assert.ok(user, `找不到工号 ${employeeId}`);
  return user.id;
}

try {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const initialized = spawnSync(process.execPath, ['scripts/team-server/init-admin.mjs', '--employee-id', '0300', '--name', '任务分组管理员'], {
    cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${initialized.error?.code ?? ''} ${sanitize(initialized.stderr ?? '')}`);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout)?.[1];
  assert.ok(credential, '初始化输出必须包含一次性凭据');

  startServer();
  await waitReady();
  result.assertions.push('独立 Next server 在隔离数据根与回环端口完成真实启动与 readiness');

  adminSession = await login('0300', credential);
  adminPassword = `Task-grouping-admin-${Math.random().toString(36).slice(2, 10)}`;
  await changePassword(adminSession, credential, adminPassword);

  await seedTasks();
  result.assertions.push('管理员与 4 名员工经真实 HTTP 建号、登录并改密（含两位同名成员）');

  // —— 任务数据：低频成员的任务最早，随后制造 520 条较新的任务把它挤出最近 500 条 ——
  const projectId = await (async () => {
    const provider = await jsonRequest(adminSession, '/api/providers', {
      method: 'POST', json: {
        name: '任务分组验收供应商', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-not-a-real-key',
        model: 'gpt-image-2', type: 'openai-compatible',
      },
    }, 200);
    const project = await jsonRequest(adminSession, '/api/projects', {
      method: 'POST', json: {
        storeCode: 'B店', productCode: 'TASK-GROUPING', productionType: 'AI种草', editorName: '自动验收',
        providerId: provider.body.id, model: 'gpt-image-2', size: '1024x1024',
      },
    }, 200);
    return project.body.id;
  })();
  // 直接用隔离库写入执行记录：受理链路会触发真实供应商调度，本票只验证任务中心查询与分组。
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  db.pragma('busy_timeout = 10000');
  let sequence = 0;
  const insert = db.prepare(`
    INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, waitReason, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', 'r1', ?, 1, 'h', '{}', 'image.submit', '{}', '[]', '{}', ?, ?, ?, ?, ?)
  `);
  const seedRun = db.transaction(() => {
    const lowUserId = db.prepare("SELECT id FROM team_users WHERE employeeId = ?").pluck().get(lowMember.employeeId);
    const sameIds = db.prepare("SELECT id FROM team_users WHERE employeeId IN ('0301','0302') ORDER BY employeeId").pluck().all();
    const disabledId = db.prepare("SELECT id FROM team_users WHERE employeeId = ?").pluck().get(disabledMember.employeeId);
    sequence += 1;
    insert.run(`op-low-${sequence}`, `key-low-${sequence}`, lowUserId, projectId, `task-low-${sequence}`, `business-low-${sequence}`,
      'succeeded', sequence, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 520; index += 1) {
      sequence += 1;
      const at = new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
      insert.run(`op-same-${sequence}`, `key-same-${sequence}`, sameIds[0], projectId, `task-same-${sequence}`, `business-same-${sequence}`,
        'succeeded', sequence, null, at, at);
    }
    sequence += 1;
    insert.run(`op-disabled-${sequence}`, `key-disabled-${sequence}`, disabledId, projectId, `task-disabled-${sequence}`, `business-disabled-${sequence}`,
      'deferred', sequence, 'actor_disabled', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
    sequence += 1;
    insert.run(`op-canceled-${sequence}`, `key-canceled-${sequence}`, sameIds[1], projectId, `task-canceled-${sequence}`, `business-canceled-${sequence}`,
      'pending', sequence, 'stage_canceled', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
    return { lowUserId, sameIds, disabledId };
  });
  const seeded = seedRun();
  db.close();
  result.assertions.push('隔离库写入低频成员 1 条、较新任务 520 条、停用成员等待任务与 stage_canceled 任务');

  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', (error) => result.pageErrors.push(error.message));

  // —— 真实登录 ——
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle', { timeout: 120_000 });
  await page.locator('input[autocomplete="username"]').fill('0300');
  await page.locator('input[autocomplete="current-password"]').fill(adminPassword);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  const tasksResponse = await page.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  assert.equal(tasksResponse?.ok(), true, '团队任务页必须由真实 HTTP 服务成功呈现');
  await page.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText('读取团队任务…', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);

  // —— 默认视图：按发起人分组，默认展开 ——
  const groups = page.getByTestId('task-actor-group');
  await groups.first().waitFor({ timeout: 60_000 });
  const groupedPressed = await page.getByRole('button', { name: '按发起人分组', exact: true }).getAttribute('aria-pressed');
  assert.equal(groupedPressed, 'true', '默认必须是「按发起人分组」视图');
  const groupCount = await groups.count();
  assert.ok(groupCount >= 2, `默认分组至少要有两个组，实际 ${groupCount}`);
  const expandButton = page.getByRole('button', { name: '折叠该发起人' }).first();
  assert.equal(await expandButton.getAttribute('aria-expanded'), 'true', '组默认展开');
  const summaryText = await page.getByTestId('task-result-summary').innerText();
  assert.match(summaryText, /当前结果 500 条/, '总提示必须是当前结果条数');
  assert.match(summaryText, /最多返回最近 500 条记录/, '总提示必须明确最近记录上限');
  assert.match(summaryText, /已到上限，更早的记录未显示/, '命中上限必须明确截断');
  assert.match(summaryText, /不是该成员全部历史任务数/, '组计数不能误称全历史任务数');
  result.assertions.push('默认按发起人分组、组默认展开，总提示声明当前结果 500 条、上限与截断口径');
  await page.screenshot({ path: path.join(evidenceDirectory, '01-grouped-default.png'), fullPage: true });
  result.evidence.push('01-grouped-default.png');

  // —— 500 条截断下，低频成员仍能从成员选项找到并查出 ——
  // 成员/状态标签会立刻切换，但任务列表要等下一次 fetch 回来；
  // 所有筛选断言都按「分组演员 + 摘要文本」等真实刷新，不靠标签抢先通过。
  async function waitForGroupActors(expected) {
    const deadline = Date.now() + 60_000;
    let actual = [];
    while (Date.now() < deadline) {
      actual = await page.getByTestId('task-actor-group').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-actor-user-id')));
      if (actual.length === expected.length && actual.every((value, index) => value === expected[index])) return actual;
      await sleep(100);
    }
    return actual;
  }
  async function waitForSummary(pattern) {
    const deadline = Date.now() + 60_000;
    let text = '';
    while (Date.now() < deadline) {
      text = await page.getByTestId('task-result-summary').innerText();
      if (pattern.test(text)) return text;
      await sleep(100);
    }
    return text;
  }
  const memberSelect = page.getByLabel('成员', { exact: true });
  const optionLabels = await memberSelect.locator('option').allInnerTexts();
  assert.ok(optionLabels.some((label) => label.includes('低频成员') && label.includes('0320')),
    `成员选项必须包含被挤出最近 500 条的低频成员，实际选项：${JSON.stringify(optionLabels)}`);
  assert.ok(optionLabels.some((label) => label.includes('已停用成员') && label.includes('已停用')),
    '历史停用但仍可能有任务的成员必须在选项里且可辨认');
  const sameNameOptions = optionLabels.filter((label) => label.startsWith('李四'));
  assert.equal(sameNameOptions.length, 2, `两位同名成员必须是两个选项，实际：${JSON.stringify(sameNameOptions)}`);
  assert.ok(sameNameOptions.some((label) => label.includes('0301')) && sameNameOptions.some((label) => label.includes('0302')),
    '同名成员靠工号区分');
  await memberSelect.selectOption(seeded.lowUserId);
  // 成员标签立刻切换，任务列表要等下一次 fetch；按分组演员等待真实刷新。
  const lowGroupIds = await waitForGroupActors([seeded.lowUserId]);
  assert.deepEqual(lowGroupIds, [seeded.lowUserId], '低频成员筛选后只显示自己的组');
  const lowSummary = await page.getByTestId('task-result-summary').innerText();
  assert.match(lowSummary, /低频成员（工号 0320）当前结果 1 条/, '低频成员必须能查出自己的历史任务');
  assert.doesNotMatch(lowSummary, /已到上限/, '单条结果不得误标截断');
  result.assertions.push('超过 500 条较新任务后，低频成员仍可在成员选项中被选中并查出其低频任务');
  await page.screenshot({ path: path.join(evidenceDirectory, '02-low-frequency-member.png'), fullPage: true });
  result.evidence.push('02-low-frequency-member.png');

  // —— 同名成员各自成组，按 ID 筛选准确 ——
  await memberSelect.selectOption(seeded.sameIds[0]);
  const sameAGroupIds = await waitForGroupActors([seeded.sameIds[0]]);
  const sameAText = await waitForSummary(/李四（工号 0301）/);
  result.debugSameName = {
    seeded: seeded.sameIds,
    optionValues: await memberSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent }))),
    groupIds: sameAGroupIds,
    groupHeaders: await page.getByTestId('task-actor-group').evaluateAll((nodes) => nodes.map((node) => node.innerText.split('\n').slice(0, 4).join(' | '))),
    summary: await page.getByTestId('task-result-summary').innerText(),
    waitedSummary: sameAText,
  };
  assert.deepEqual(sameAGroupIds, [seeded.sameIds[0]], '同名成员 A 只能形成自己的组');
  assert.match(sameAText, /李四（工号 0301）/, '同名成员 A 的筛选标签必须带工号');
  await memberSelect.selectOption(seeded.sameIds[1]);
  const sameBGroupIds = await waitForGroupActors([seeded.sameIds[1]]);
  const sameBText = await waitForSummary(/当前结果 1 条/);
  assert.deepEqual(sameBGroupIds, [seeded.sameIds[1]], '同名成员 B 只能形成自己的组');
  assert.match(sameBText, /李四（工号 0302）当前结果 1 条/, '同名成员 B 的结果不得混入 A 的任务');
  result.assertions.push('两位同名成员按 actorUserId 各自成组，按 ID 筛选互不串台');

  // 取消语义在界面上不能回归：状态=已取消时必须能筛出 stage_canceled。
  await memberSelect.selectOption('');
  await page.getByLabel('状态', { exact: true }).selectOption('canceled');
  const canceledSummary = await waitForSummary(/当前结果 1 条/);
  assert.match(canceledSummary, /显示当前结果 1 条/, '取消过滤应只剩那条 stage_canceled');
  const canceledRowText = await page.getByTestId('task-actor-group').innerText();
  assert.match(canceledRowText, /已取消/, 'stage_canceled 必须显示为已取消');
  result.assertions.push('状态过滤含取消语义未回归（stage_canceled 显示并筛出「已取消」）');
  await page.getByLabel('状态', { exact: true }).selectOption('');
  await waitForSummary(/当前结果 500 条/);

  // —— 折叠：折叠后组内表格消失，再次展开恢复 ——
  await page.getByRole('button', { name: '折叠该发起人' }).first().click();
  const collapsedButton = page.getByRole('button', { name: '展开该发起人' }).first();
  await collapsedButton.waitFor({ timeout: 30_000 });
  assert.equal(await collapsedButton.getAttribute('aria-expanded'), 'false', '折叠后 aria-expanded 必须为 false');
  const firstGroupTables = await page.getByTestId('task-actor-group').first().locator('table').count();
  assert.equal(firstGroupTables, 0, '折叠后该组不渲染表格');
  await page.screenshot({ path: path.join(evidenceDirectory, '03-collapsed.png'), fullPage: true });
  result.evidence.push('03-collapsed.png');
  result.assertions.push('单组可折叠，折叠后组内任务表不再渲染');

  // —— 平铺切换：使用同一结果集与状态口径 ——
  await page.getByRole('button', { name: '平铺', exact: true }).click();
  await page.getByRole('button', { name: '平铺', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId('task-actor-group').count(), 0, '平铺视图不再渲染组');
  const flatSummary = await page.getByTestId('task-result-summary').innerText();
  assert.match(flatSummary, /当前结果 \d+ 条/, '平铺与分组使用同一结果口径');
  assert.doesNotMatch(flatSummary, /不是该成员全部历史任务数/, '平铺不需要组计数说明');
  result.assertions.push('可切回平铺视图，平铺与分组共用同一结果集与状态口径');
  await page.screenshot({ path: path.join(evidenceDirectory, '04-flat.png'), fullPage: true });
  result.evidence.push('04-flat.png');

  // —— 整页刷新：视图、筛选与尚存在组的折叠状态都要保留 ——
  await page.getByLabel('状态', { exact: true }).selectOption('deferred');
  await waitForSummary(/当前结果 1 条/);
  await page.getByRole('button', { name: '按发起人分组', exact: true }).click();
  await page.getByTestId('task-actor-group').first().waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '折叠该发起人' }).first().click();
  await page.getByRole('button', { name: '展开该发起人' }).first().waitFor({ timeout: 30_000 });
  const collapsedActorBeforeReload = await page.getByTestId('task-actor-group').first().getAttribute('data-actor-user-id');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 60_000 });
  await page.getByTestId('task-actor-group').first().waitFor({ timeout: 60_000 });
  await waitForSummary(/当前结果 1 条/);
  assert.equal(await page.getByRole('button', { name: '按发起人分组', exact: true }).getAttribute('aria-pressed'), 'true',
    '刷新后视图必须仍是分组');
  assert.equal(await page.getByLabel('状态', { exact: true }).inputValue(), 'deferred', '刷新后状态筛选必须保留');
  const groupAfterReload = await page.getByTestId('task-actor-group').first().getAttribute('data-actor-user-id');
  assert.equal(groupAfterReload, collapsedActorBeforeReload, '刷新后仍是同一成员组');
  assert.equal(await page.getByRole('button', { name: '展开该发起人' }).count(), 1,
    '刷新后尚存在的组的折叠状态必须保留');
  assert.equal(await page.getByTestId('task-actor-group').first().locator('table').count(), 0,
    '刷新后折叠组仍不渲染表格');
  result.assertions.push('整页刷新后保留当前视图、状态筛选与尚存在组的折叠状态');
  await page.screenshot({ path: path.join(evidenceDirectory, '05-after-reload.png'), fullPage: true });
  result.evidence.push('05-after-reload.png');

  // 复原到便于后续主题/窄屏截图的状态：清空状态筛选，并展开所有仍折叠的组。
  await page.getByLabel('状态', { exact: true }).selectOption('');
  await waitForSummary(/当前结果 500 条/);
  for (let guard = 0; guard < 10; guard += 1) {
    const collapsedNow = page.getByRole('button', { name: '展开该发起人' });
    if (await collapsedNow.count() === 0) break;
    await collapsedNow.first().click();
    await sleep(150);
  }
  assert.equal(await page.getByRole('button', { name: '展开该发起人' }).count(), 0, '所有组都应展开');
  await page.getByTestId('task-actor-group').first().locator('table').first().waitFor({ timeout: 60_000 });

  // —— 深浅主题 ——
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await page.waitForTimeout(150);
    const themeName = `06-grouped-${theme}.png`;
    await page.screenshot({ path: path.join(evidenceDirectory, themeName), fullPage: true });
    result.evidence.push(themeName);
    // 主题令牌必须真的生效：暗色下页面背景与文字色要和浅色不同。
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { background: style.backgroundColor, color: style.color };
    });
    result[`theme-${theme}`] = colors;
    if (theme === 'dark') {
      assert.notEqual(colors.background, result['theme-light'].background, '暗色主题背景必须与浅色不同');
    }
  }
  result.assertions.push('深浅主题下分组视图正常渲染且暗色令牌生效');

  // —— 窄屏 ——
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(150);
  await page.getByTestId('task-actor-group').first().waitFor({ timeout: 30_000 });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(narrowOverflow <= 1, `窄屏不得出现整页横向溢出，实际溢出 ${narrowOverflow}px`);
  const summaryVisible = await page.getByTestId('task-result-summary').isVisible();
  assert.equal(summaryVisible, true, '窄屏下结果口径提示仍可见');
  await page.screenshot({ path: path.join(evidenceDirectory, '07-narrow.png'), fullPage: true });
  result.evidence.push('07-narrow.png');
  result.assertions.push('390px 窄屏下无整页横向溢出，结果口径提示可见');

  // —— 复制排查信息 ——
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await page.setViewportSize({ width: 1280, height: 900 });
  const copyButton = page.getByRole('button', { name: '复制排查信息' }).first();
  await copyButton.click();
  await page.getByRole('button', { name: '已复制排查信息' }).first().waitFor({ timeout: 30_000 });
  result.assertions.push('复制排查信息仍可用');

  // —— 搜索空态 ——
  await page.getByPlaceholder('项目名、制作步骤、文件名、姓名、工号或任务编号').fill('绝对不存在的任务关键字zzz');
  await page.getByText('当前筛选没有团队任务。', { exact: true }).waitFor({ timeout: 30_000 });
  result.assertions.push('搜索空态提示正常');

  // —— 员工身份：篡改 actorUserId 被拒，且选项只有自己 ——
  // 必须用独立 browser context：同一 context 共享 cookie，会带着管理员会话直接跳走登录页。
  const employeeContext = await browser.newContext({ locale: 'zh-CN' });
  const employeePage = await employeeContext.newPage();
  employeePage.on('pageerror', (error) => result.pageErrors.push(error.message));
  await employeePage.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await employeePage.waitForLoadState('networkidle', { timeout: 120_000 });
  await employeePage.locator('input[autocomplete="username"]').fill(lowMember.employeeId);
  await employeePage.locator('input[autocomplete="current-password"]').fill(lowMember.password);
  await Promise.all([
    employeePage.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
    employeePage.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  await employeePage.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await employeePage.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 60_000 });
  await employeePage.getByTestId('task-actor-group').first().waitFor({ timeout: 60_000 });
  const employeeOptions = await employeePage.getByLabel('成员', { exact: true }).locator('option').allInnerTexts();
  assert.deepEqual(employeeOptions.filter((label) => !label.includes('全部成员')), ['低频成员（工号 0320）'],
    `员工只能看到自己的成员选项，实际：${JSON.stringify(employeeOptions)}`);
  const tampered = await employeePage.evaluate(async ({ actorUserId }) => {
    const response = await fetch(`/api/team/tasks?actorUserId=${encodeURIComponent(actorUserId)}`, { cache: 'no-store' });
    return { status: response.status, body: await response.text() };
  }, { actorUserId: seeded.sameIds[0] });
  assert.equal(tampered.status, 403, '员工篡改 actorUserId 查询他人必须被拒');
  assert.equal(tampered.body.includes(seeded.sameIds[0]), false, '拒绝响应不得回显他人 ID');
  result.assertions.push('员工只能看到自己的成员选项，篡改 actorUserId 查询他人被 403 拒绝');

  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理页面异常');
  result.assertions.push('两个真实会话浏览器无未处理 pageerror');
  await employeeContext.close();
  await context.close();
  result.result = 'passed';
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(serverOutput).slice(-2_000_000));
  fs.writeFileSync(resultPath, `${sanitize(JSON.stringify(result, null, 2))}\n`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(`team task grouping browser ${result.result}; evidence in ${evidenceDirectory}`);
}
