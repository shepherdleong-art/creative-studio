// 05 号票：团队用量「布局 + 二级页签 + 服务端分页」的页面级验收。
//
// 自带隔离环境：mkdtemp 数据根 + server 模式 + 随机回环端口 + 断外网守卫，
// 自己初始化首管理员、建一个员工、建一个项目，然后**只在隔离 SQLite 里**造
// 200 个管理员制作任务、60 个员工制作任务、90 条非统一模型尝试、60 条待映射尝试
// （全部已结算，金额可手工核对；不调用任何供应商）。
//
// 验证的行为（对应票 05 的验收条目）：
//   1. 摘要与明细分开请求：摘要无 section，明细带 section/page/pageSize；
//      翻页前后摘要请求数不变、图表/金额/成员合计不跳变；
//   2. 翻页只请求当前页签的当前页：切页签/类型回第 1 页，pageSize 变化回第 1 页；
//   3. 竞态：人为延迟第 2 页响应、马上点第 3 页，旧响应晚到也不覆盖新页；
//   4. 详情：共用 Dialog 的 wide 规格、长 ID 只在对话框里、Esc 关闭并归还焦点、
//      开关前后主表列宽不变、「备用通道，未提交」单列说明；
//   5. 角色：员工没有「通道调用/待映射」页签、网络里不出现被禁止的 section，
//      任务响应也没有管理员专用 channels 字段；
//   6. 空结果/末页禁用；单次失败保留错误与重试，不渲染假「0 条」；
//   7. CSV 链接不带 section/page；翻到末页再导出仍含完整筛选记录。
//
// 用法（先拿 browser-lane 锁）：
//   node scripts/team-usage-pagination.playwright.test.mjs
// 环境变量：
//   TEAM_USAGE_BROWSERS=chromium,webkit（默认 chromium；两个内核都要跑时手动开）
//   TEAM_USAGE_EVIDENCE_DIR=<证据目录>（默认 storage/test-evidence/team-usage-pagination）
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
const evidenceDirectory = process.env.TEAM_USAGE_EVIDENCE_DIR
  ?? path.join(repoRoot, 'storage', 'test-evidence', 'team-usage-pagination');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-usage-pagination-'));
const browsersToRun = (process.env.TEAM_USAGE_BROWSERS ?? 'chromium')
  .split(',').map((value) => value.trim()).filter(Boolean);
fs.mkdirSync(evidenceDirectory, { recursive: true });

const ADMIN_ID = 'usage-pagination-admin';
const ADMIN_PASSWORD = `Usage-admin-${randomBytes(9).toString('base64url')}`;
const EMPLOYEE_PASSWORD = `Usage-employee-${randomBytes(9).toString('base64url')}`;
const LONG_PROJECT_NAME = `界面验收超长项目名称-${'项目名称越长越考验主表列宽-'.repeat(6)}`;
const LONG_REMOTE_ID = `remote-usage-long-${'0123456789abcdef'.repeat(8)}`;
const LONG_TASK_ID = `business-task-${'very-long-identifier-'.repeat(7)}`;
const LONG_ERROR_CODE = `error_fixture_${'长错误码只在详情里换行-'.repeat(4)}`;

// 造数规模（与前端的断言一起构成「>50 条 / 多页」的证据，不是空态验收）。
const SEED = {
  admin: { tasks: 200, legacy: 60, unmapped: 40 },
  employee: { tasks: 60, legacy: 30, unmapped: 20 },
};
const TASK_COST_MINOR = 25;
const LEGACY_COST_MINOR = 10;
const UNMAPPED_COST_MINOR = 30;
const ADMIN_SELF_MINOR = SEED.admin.tasks * TASK_COST_MINOR
  + SEED.admin.legacy * LEGACY_COST_MINOR
  + SEED.admin.unmapped * UNMAPPED_COST_MINOR;
const ADMIN_SELF_ATTEMPTS = SEED.admin.tasks + SEED.admin.legacy + SEED.admin.unmapped;

const result = {
  schemaVersion: 1, assertions: [], evidence: [], pageErrors: [], browserRuns: [], requests: [],
};
const secrets = new Set();
let server = null;
let baseUrl = '';
let port = 0;
let fixtureProjectId = '';

/**
 * WebKit 会把文档跳转时被取消的请求报成 pageerror（05 号票踩过的同一个坑）；
 * 本测试在同一页上连续操作，只把这两类浏览器侧取消单独归档。
 */
const CANCELLED_REQUEST_PATTERNS = [
  /^[^:]+: \/127\.0\.0\.1:\d+\/(?:api|__nextjs_)[^\s]* due to access control checks\.$/,
  /^[^:]+: TypeError: Load failed$/,
];
function recordPageError(label) {
  return (error) => {
    const message = `${label}: ${error.message}`;
    if (CANCELLED_REQUEST_PATTERNS.some((pattern) => pattern.test(message))) return;
    result.pageErrors.push(message);
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
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-usage-pagination-ui',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'usage-pagination-ui',
    CREATIVE_STUDIO_CANVAS_ENABLE: '0',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
  };
}
function startServer() {
  // dev 模式下 Turbopack 在机器繁忙时会因 PostCSS 工作进程超时 panic 崩溃（实测）。
  // TEAM_USAGE_PRODUCTION=1 改用已构建的 standalone（先 npm run build），验证更快更稳。
  const production = process.env.TEAM_USAGE_PRODUCTION === '1';
  const standalone = path.join(repoRoot, '.next', 'standalone');
  const nextBinary = fileURLToPath(import.meta.resolve('next/dist/bin/next'));
  const serverArgs = production
    ? [path.join(standalone, 'server.js')]
    : [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)];
  server = spawn(process.execPath, serverArgs, {
    cwd: production ? standalone : repoRoot,
    env: {
      ...environment(),
      ...(production ? { NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1' } : {}),
    },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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

/** 登录页真登录（浏览器会话）。 */
async function loginViaUi(page, employeeId, password) {
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  await page.waitForLoadState('networkidle', { timeout: 600_000 });
  await page.locator('input[autocomplete="username"]').fill(employeeId);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname !== '/team/login') {
      await page.waitForLoadState('domcontentloaded', { timeout: 300_000 }).catch(() => undefined);
      return;
    }
    await sleep(200);
  }
  const body = await page.locator('body').innerText().catch(() => '');
  throw new Error(`登录后没有离开登录页：${sanitize(body).slice(0, 400)}`);
}

// ── 造数：只在隔离 SQLite 写领域表（不触发供应商，不碰真实数据根） ────────────
const PERIOD = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
const MONTH_START = Date.parse(`${PERIOD}-01T00:00:00+08:00`);
const SEED_BASE = Math.max(Date.now() - 60_000, MONTH_START + 6 * 60 * 60 * 1000);
const at = (position) => new Date(SEED_BASE - position * 60_000).toISOString();

async function seedIsolatedDatabase({ adminUserId, employeeUserId }) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  const insertTask = db.prepare(`INSERT INTO execution_media_tasks (
    id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
    inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
    status, currentChannelKey, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'image2', 'rules-2026-11-11',
    ?, '{}', '{}', 'project_scene', ?, '{}', 'succeeded', ?, ?, ?)`);
  const insertChannel = db.prepare(`INSERT INTO execution_media_channels (
    id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
    state, executionRevision, operationId, remoteId, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'providers', ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
  const insertOperation = db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq,
    createdAt, updatedAt, mediaTaskId, channelKey
  ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', 'r1', ?, 1, ?, '{}', 'image.submit',
    ?, '[]', ?, 'succeeded', NULL, ?, ?, ?, ?, ?)`);
  const insertAttempt = db.prepare(`INSERT INTO execution_attempts (
    id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
    providerSnapshotJson, pricingSnapshotJson, submissionState, terminalState,
    instanceId, fence, leaseOwner, leaseUntil, remoteId, receiptJson,
    intentJournalSeq, receiptJournalSeq, errorCode, policyVersion, accountingPeriod,
    currency, reservedMinor, actualMinor, costState, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, NULL, 'terminal', 'succeeded', 'usage-pagination-ui', 1,
    'fixture', '2099-01-01T00:00:00.000Z', ?, NULL, 1, NULL, NULL, 1, ?, 'CNY', ?, ?, 'settled', ?, ?)`);
  let readySeq = 900001;
  let attemptSeq = 0;
  const insertSettledAttempt = (id, operationId, actorId, createdAt, minor, remoteId) => {
    insertAttempt.run(
      id, operationId, `permit-${id}`, actorId,
      JSON.stringify({ model: 'image2-medium', unifiedModel: 'image2' }),
      remoteId, PERIOD, minor, minor, createdAt, createdAt,
    );
  };
  try {
    db.transaction(() => {
      // 一个超长项目名：主表列宽不能因为项目名变长而变化（长文本进详情对话框）。
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(LONG_PROJECT_NAME, fixtureProjectId);

      // 统一制作任务：一条任务 = 一个父任务 + 一条真实通道调用。
      for (const [actorId, spec, prefix] of [
        [adminUserId, SEED.admin, 'mta'],
        [employeeUserId, SEED.employee, 'mte'],
      ]) {
        for (let position = 1; position <= spec.tasks; position += 1) {
          const createdAt = at(position);
          const mediaTaskId = `media-task-${prefix}-${String(position).padStart(3, '0')}`;
          const operationId = `op-${prefix}-${String(position).padStart(3, '0')}`;
          const isShowcase = prefix === 'mta' && position === 1;
          insertTask.run(
            mediaTaskId, `media:${mediaTaskId}`, actorId, fixtureProjectId, operationId,
            `hash-${mediaTaskId}`, fixtureProjectId, 'tencent', createdAt, createdAt,
          );
          insertChannel.run(
            `${mediaTaskId}:tencent`, mediaTaskId, 'tencent', 'company-gateway-image2-medium',
            'image2-medium', 0, 'succeeded', operationId,
            isShowcase ? LONG_REMOTE_ID : `remote-${mediaTaskId}`,
            createdAt, createdAt,
          );
          insertOperation.run(
            operationId, `key-${operationId}`, actorId, fixtureProjectId, operationId,
            `business-${operationId}`, `hash-${operationId}`,
            JSON.stringify({
              providerId: 'company-gateway-image2-medium', name: '腾讯通道',
              model: 'image2-medium', requestModel: 'image2-medium', unifiedModel: 'image2',
            }),
            '{"kind":"priced"}', (readySeq += 1), createdAt, createdAt, mediaTaskId, 'tencent',
          );
          attemptSeq += 1;
          insertSettledAttempt(
            `attempt-${prefix}-${String(position).padStart(3, '0')}`, operationId, actorId,
            createdAt, TASK_COST_MINOR,
            isShowcase ? LONG_REMOTE_ID : `remote-${mediaTaskId}`,
          );
        }
      }
      readySeq += 1000;
      // 备用通道（候选、未提交）：详情里必须单列「备用通道，未提交」，且不增加通道调用数。
      insertChannel.run(
        'media-task-mta-001:qiniu', 'media-task-mta-001', 'qiniu',
        'fixture-qiniu', 'image2-medium', 1, 'candidate', null, null,
        at(1), at(1),
      );
      // 长错误码与长业务任务 ID：只进详情对话框，主表不渲染它们。
      db.prepare('UPDATE execution_attempts SET errorCode = ? WHERE id = ?').run(LONG_ERROR_CODE, 'attempt-mta-001');
      db.prepare('UPDATE execution_media_tasks SET taskId = ? WHERE id = ?').run(LONG_TASK_ID, 'media-task-mta-001');

      // 非统一模型尝试：既没有 mediaTaskId，也没有统一模型身份。
      for (const [actorId, spec, prefix] of [
        [adminUserId, SEED.admin, 'lga'],
        [employeeUserId, SEED.employee, 'lge'],
      ]) {
        for (let position = 1; position <= spec.legacy; position += 1) {
          const createdAt = at(position);
          const operationId = `op-${prefix}-${String(position).padStart(3, '0')}`;
          insertOperation.run(
            operationId, `key-${operationId}`, actorId, fixtureProjectId, `legacy-task-${prefix}-${position}`,
            `business-${operationId}`, `hash-${operationId}`,
            JSON.stringify({ model: 'kimi-k2', name: '旧文本模型' }),
            '{"kind":"priced"}', (readySeq += 1), createdAt, createdAt, null, null,
          );
          attemptSeq += 1;
          insertAttempt.run(
            `attempt-${prefix}-${String(position).padStart(3, '0')}`, operationId, `permit-${prefix}-${position}`,
            actorId, JSON.stringify({ model: 'kimi-k2' }), `remote-${prefix}-${position}`,
            PERIOD, LEGACY_COST_MINOR, LEGACY_COST_MINOR, createdAt, createdAt,
          );
        }
      }
      readySeq += 1000;
      // 待映射：声称有制作任务关联（mediaTaskId），但父任务行不存在。
      for (const [actorId, spec, prefix] of [
        [adminUserId, SEED.admin, 'uma'],
        [employeeUserId, SEED.employee, 'ume'],
      ]) {
        for (let position = 1; position <= spec.unmapped; position += 1) {
          const createdAt = at(position);
          const operationId = `op-${prefix}-${String(position).padStart(3, '0')}`;
          insertOperation.run(
            operationId, `key-${operationId}`, actorId, fixtureProjectId, `orphan-task-${prefix}-${position}`,
            `business-${operationId}`, `hash-${operationId}`,
            JSON.stringify({ model: 'image2-medium', unifiedModel: 'image2' }),
            '{"kind":"priced"}', (readySeq += 1), createdAt, createdAt,
            `missing-media-task-${prefix}-${position}`, 'qiniu',
          );
          attemptSeq += 1;
          insertAttempt.run(
            `attempt-${prefix}-${String(position).padStart(3, '0')}`, operationId, `permit-${prefix}-${position}`,
            actorId, JSON.stringify({ model: 'image2-medium', unifiedModel: 'image2' }), `remote-${prefix}-${position}`,
            PERIOD, UNMAPPED_COST_MINOR, UNMAPPED_COST_MINOR, createdAt, createdAt,
          );
        }
      }
      assert.ok(attemptSeq === ADMIN_SELF_ATTEMPTS + SEED.employee.tasks
        + SEED.employee.legacy + SEED.employee.unmapped, '造数条数必须与断言里的期望一致');
      const counts = {
        tasks: db.prepare('SELECT COUNT(*) FROM execution_media_tasks').pluck().get(),
        attempts: db.prepare('SELECT COUNT(*) FROM execution_attempts').pluck().get(),
      };
      assert.equal(counts.tasks, SEED.admin.tasks + SEED.employee.tasks, '制作任务条数不符合造数期望');
      assert.equal(counts.attempts, ADMIN_SELF_ATTEMPTS + SEED.employee.tasks + SEED.employee.legacy + SEED.employee.unmapped,
        '尝试条数不符合造数期望');
    })();
  } finally {
    db.close();
  }
}

// ── 浏览器侧工具 ──────────────────────────────────────────────────────────────
const waitForRows = (page, testId, count) => page.waitForFunction(
  ({ testId, count }) => document.querySelectorAll(`[data-testid="${testId}"]`).length === count,
  { testId, count },
  { timeout: 90_000 },
);
/** 等某一行真的换了：列表在两页之间保留旧数据，只等「行数」会在旧页上立刻通过。 */
const waitForFirstRow = (page, testId, attribute, value) => page.waitForFunction(
  ({ testId, attribute, value }) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute(attribute) === value,
  { testId, attribute, value },
  { timeout: 90_000 },
);
const waitForTotal = (page, text) => page.waitForFunction(
  (expected) => document.querySelector('[data-testid="pagination-total"]')?.textContent?.trim() === expected,
  text,
  { timeout: 90_000 },
);
/** 等一条具体的用量接口响应（页签切换、范围切换时比等 DOM 更可靠）。 */
const waitForUsage = (page, matcher) => page.waitForResponse((response) => {
  const url = new URL(response.url());
  if (url.pathname !== '/api/team/usage') return false;
  return matcher(url.searchParams);
}, { timeout: 90_000 });
async function rowIds(page, testId) {
  return page.evaluate((id) => Array.from(document.querySelectorAll(`[data-testid="${id}"]`))
    .map((row) => row.getAttribute('data-media-task-id') ?? row.getAttribute('data-attempt-id')), testId);
}
async function pagerText(page) {
  const pager = page.getByTestId('pagination').first();
  return {
    total: await pager.getByTestId('pagination-total').innerText(),
    status: await pager.getByTestId('pagination-status').innerText(),
  };
}
async function chartText(page) {
  return (await page.getByRole('region', { name: '模型消耗排行与趋势' }).innerText()).replace(/\s+/g, ' ').trim();
}
async function headerWidths(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="usage-detail-list"] table thead th'))
    .map((cell) => Math.round(cell.getBoundingClientRect().width)));
}
const usageRequests = (page) => {
  const seen = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/team/usage') seen.push(url.searchParams);
  });
  return seen;
};
const usageResponses = (page) => {
  const seen = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname !== '/api/team/usage') return;
    void response.json().then((body) => seen.push({ section: url.searchParams.get('section'), params: url.searchParams, body })).catch(() => undefined);
  });
  return seen;
};
const summaryRequestCount = (seen) => seen.filter((params) => !params.get('section') || params.get('section') === 'summary').length;
const sectionRequests = (seen, section) => seen.filter((params) => params.get('section') === section);

/** 人为延迟 / 失败注入：只作用于 /api/team/usage 的明细请求。 */
function installUsageRoutes(page, controls) {
  void page.route((url) => url.pathname === '/api/team/usage', async (route) => {
    const url = new URL(route.request().url());
    const section = url.searchParams.get('section');
    const requestedPage = url.searchParams.get('page');
    if (section && controls.failSection === section) {
      controls.failSection = null;
      await route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture_failure', message: '模拟读取明细失败' }),
      }).catch(() => undefined);
      return;
    }
    if (section === 'tasks' && requestedPage === '2' && controls.delayPage2Ms > 0) {
      await sleep(controls.delayPage2Ms);
    }
    try { await route.continue(); } catch { /* 页面已取消这个请求 */ }
  });
}

async function runAdminChecks(page, credentials) {
  const requests = usageRequests(page);
  const responses = usageResponses(page);
  const controls = { failSection: null, delayPage2Ms: 0 };
  installUsageRoutes(page, controls);

  await page.goto(`${baseUrl}/usage`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  await page.getByRole('tab', { name: '制作任务' }).waitFor({ timeout: 300_000 });
  await page.getByRole('tab', { name: '通道调用' }).waitFor({ timeout: 120_000 });
  await page.getByRole('tab', { name: '其他记录' }).waitFor({ timeout: 120_000 });
  await waitForRows(page, 'usage-task-row', 25);
  result.assertions.push('管理员默认「制作任务」页签，每页 25 条');

  // 1. 摘要与明细分开请求。
  assert.ok(summaryRequestCount(requests) >= 1, `必须请求摘要（无 section），实际 ${JSON.stringify(requests.map((p) => p.toString()))}`);
  const firstPage = sectionRequests(requests, 'tasks').find((params) => params.get('page') === '1');
  assert.ok(firstPage, '必须请求 section=tasks&page=1');
  assert.equal(firstPage.get('pageSize'), '25', '明细请求必须带 pageSize=25');
  assert.ok(!requests.some((params) => params.get('section') === 'legacy' || params.get('section') === 'unmapped'
    || params.get('section') === 'channels'), '未切换页签前不得请求其它明细列表（隐藏页签不预加载）');
  result.assertions.push('首次进入：摘要（无 section）+ section=tasks&page=1&pageSize=25，隐藏页签没有预加载');

  const chartBefore = await chartText(page);
  const pagerBefore = await pagerText(page);
  assert.match(pagerBefore.total, new RegExp(`^共 ${SEED.admin.tasks} 个制作任务$`), '总数必须来自分页元数据的完整范围');
  assert.match(pagerBefore.status, /^第 1 \/ 8 页$/);
  assert.match(chartBefore, new RegExp(`${SEED.admin.tasks} 个制作任务`), '图表标题的制作任务数必须来自摘要');
  // 金额期望值来自造数常量（200×25 + 60×10 + 40×30 分），不是拿实现算一遍。
  const expectedMoney = `¥${(ADMIN_SELF_MINOR / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  assert.ok(chartBefore.includes(expectedMoney), `摘要金额必须等于造数总额 ${expectedMoney}，实际「${chartBefore}」`);
  // 超过 7 页收起中间页码：8 页时只渲染首尾与当前附近的页码。
  const pageButtons = await page.getByTestId('pagination').first().getByTestId('pagination-page').count();
  assert.ok(pageButtons <= 6, `8 页时页码按钮必须收起中间页码（最多 6 个 + 省略号），实际 ${pageButtons}`);
  assert.ok(await page.getByTestId('pagination').first().getByText('…', { exact: true }).count() > 0, '收起中间页码必须显示省略号');
  const summaryRequestsAfterLoad = summaryRequestCount(requests);

  // 2. 翻页只加载指定列表，金额/图表/成员合计不跳变。
  await page.getByTestId('pagination').first().getByTestId('pagination-next').click();
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-026');
  assert.equal((await rowIds(page, 'usage-task-row')).length, 25, '第 2 页仍是 25 条');
  assert.equal(sectionRequests(requests, 'tasks').filter((params) => params.get('page') === '2').length >= 1, true, '翻页必须请求 section=tasks&page=2');
  assert.equal(summaryRequestCount(requests), summaryRequestsAfterLoad, '翻页不得重新请求摘要');
  assert.equal(await chartText(page), chartBefore, '翻页后图表与金额不得跳变');
  assert.match((await pagerText(page)).status, /^第 2 \/ 8 页$/);
  result.assertions.push('翻页只请求 section=tasks&page=2；摘要请求数不变，图表/金额/总数不跳变');

  // 3. pageSize=50 → 回第 1 页；跳页；末页禁用。
  await page.getByTestId('pagination').first().getByTestId('pagination-size').selectOption('50');
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-001');
  await waitForRows(page, 'usage-task-row', 50);
  const pageSize50 = sectionRequests(requests, 'tasks').filter((params) => params.get('pageSize') === '50');
  assert.ok(pageSize50.some((params) => params.get('page') === '1'), '改 pageSize 必须回第 1 页并带 pageSize=50');
  assert.match((await pagerText(page)).status, /^第 1 \/ 4 页$/);

  const pager = page.getByTestId('pagination').first();
  await pager.getByTestId('pagination-jump').fill('3');
  await pager.getByTestId('pagination-jump-submit').click();
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-101');
  assert.equal((await rowIds(page, 'usage-task-row')).length, 50, '第 3 页是第 101–150 条');
  await pager.getByTestId('pagination-jump').fill('4');
  await pager.getByTestId('pagination-jump-submit').click();
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-151');
  assert.equal(await pager.getByTestId('pagination-next').isDisabled(), true, '末页必须禁用下一页');
  assert.equal(await pager.getByTestId('pagination-prev').isDisabled(), false);
  result.assertions.push('pageSize 25→50 回第 1 页；输入页码跳转；末页禁用下一页；超过 7 页收起中间页码');

  // 4. 竞态：第 2 页响应被延迟，马上点第 3 页，旧响应晚到不得覆盖新页。
  controls.delayPage2Ms = 1500;
  const stalePageRequest = page.waitForRequest((req) => {
    const url = new URL(req.url());
    return url.pathname === '/api/team/usage'
      && url.searchParams.get('section') === 'tasks'
      && url.searchParams.get('page') === '2';
  }, { timeout: 30_000 });
  await pager.getByTestId('pagination-jump').fill('2');
  await pager.getByTestId('pagination-jump-submit').click();
  await stalePageRequest;
  await pager.getByTestId('pagination-jump').fill('3');
  await pager.getByTestId('pagination-jump-submit').click();
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-101');
  await sleep(2500);
  controls.delayPage2Ms = 0;
  const afterRaceIds = await rowIds(page, 'usage-task-row');
  assert.equal(afterRaceIds[0], 'media-task-mta-101', `旧的第 2 页响应晚到后仍应停在第 3 页，实际第一条 ${afterRaceIds[0]}`);
  assert.match((await pagerText(page)).status, /^第 3 \/ 4 页$/);
  result.assertions.push('请求竞态：延迟的第 2 页响应晚到不覆盖第 3 页');

  // 5. 切页签 / 其他记录类型：回第 1 页、保留业务筛选、只加载一个列表。
  const channelsFirst = waitForUsage(page, (params) => params.get('section') === 'channels' && params.get('page') === '1');
  await page.getByRole('tab', { name: '通道调用' }).click();
  await channelsFirst;
  await waitForFirstRow(page, 'usage-attempt-row', 'data-attempt-id', 'attempt-mta-001');
  const channelPage = sectionRequests(requests, 'channels')[0];
  assert.ok(channelPage, '切到通道调用必须请求 section=channels');
  assert.equal(channelPage.get('page'), '1', '切页签必须回第 1 页');
  await waitForTotal(page, `共 ${SEED.admin.tasks} 条记录`);
  const channelsPage2 = waitForUsage(page, (params) => params.get('section') === 'channels' && params.get('page') === '2');
  await page.getByTestId('pagination').first().getByTestId('pagination-next').click();
  await channelsPage2;
  await waitForFirstRow(page, 'usage-attempt-row', 'data-attempt-id', 'attempt-mta-051');
  assert.ok(sectionRequests(requests, 'channels').some((params) => params.get('page') === '2'), '通道调用也必须服务端分页');

  const legacyFirst = waitForUsage(page, (params) => params.get('section') === 'legacy' && params.get('page') === '1');
  await page.getByRole('tab', { name: '其他记录' }).click();
  await legacyFirst;
  await waitForFirstRow(page, 'usage-attempt-row', 'data-attempt-id', 'attempt-lga-001');
  await waitForTotal(page, `共 ${SEED.admin.legacy} 条记录`);
  assert.equal(sectionRequests(requests, 'unmapped').length, 0, '默认不得预加载待映射记录');
  const otherGroup = page.getByRole('group', { name: '其他记录类型' });
  const unmappedFirst = waitForUsage(page, (params) => params.get('section') === 'unmapped' && params.get('page') === '1');
  await otherGroup.getByRole('button', { name: '待映射记录' }).click();
  await unmappedFirst;
  await waitForFirstRow(page, 'usage-attempt-row', 'data-attempt-id', 'attempt-uma-001');
  await waitForTotal(page, `共 ${SEED.admin.unmapped} 条记录`);
  result.assertions.push('页签互斥：通道调用/其他记录（默认非统一模型，可切待映射）各自分页，切换回第 1 页');

  // 6. 详情对话框：wide 规格、长文本只在对话框、Esc 关闭归还焦点、列宽不变。
  const tasksBack = waitForUsage(page, (params) => params.get('section') === 'tasks' && params.get('page') === '1');
  await page.getByRole('tab', { name: '制作任务' }).click();
  await tasksBack;
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-001');
  await waitForRows(page, 'usage-task-row', 50);
  const widthsBefore = await headerWidths(page);
  const trigger = page.getByTestId('usage-task-row').first().getByTestId('usage-detail-open');
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 30_000 });
  assert.match((await dialog.getAttribute('class')) ?? '', /dialog-sheet-wide/, '详情必须使用共用 Dialog 的 wide 规格');
  await dialog.getByText('制作任务详情', { exact: true }).waitFor();
  const standby = dialog.getByTestId('usage-standby-channel');
  await standby.waitFor({ timeout: 30_000 });
  assert.match(await standby.innerText(), /备用通道，未提交：当前没有向这条通道提交，也不会产生额外费用。/);
  assert.equal(await dialog.getByText(LONG_REMOTE_ID, { exact: false }).count() > 0, true, '长远端 ID 必须完整显示在对话框里');
  assert.equal(await dialog.getByText(LONG_ERROR_CODE, { exact: false }).count() > 0, true, '长错误码必须完整显示在对话框里');
  assert.equal(await dialog.getByText(LONG_TASK_ID, { exact: false }).count() > 0, true, '长业务任务 ID 必须完整显示在对话框里');
  assert.equal(await page.getByTestId('usage-detail-list').getByText(LONG_REMOTE_ID, { exact: false }).count(), 0, '主表不得出现长远端 ID');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  await sleep(200);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  assert.equal(focused, 'usage-detail-open', `Esc 关闭详情后焦点必须回到「查看详情」，实际 ${focused}`);
  assert.deepEqual(await headerWidths(page), widthsBefore, '开关详情前后主表列宽不得变化');
  const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.equal(noHorizontalOverflow, true, `长项目名/长远端 ID 不得让整页横向滚动（scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)}）`);
  result.assertions.push('详情对话框：wide、长 ID 只在对话框、备用未提交单列、Esc 归还焦点、列宽与整页宽度不变');

  // 7. 空结果：不渲染假数据，翻页按钮禁用。
  await page.getByLabel('结果筛选').selectOption('failed');
  await page.getByTestId('usage-detail-list').getByText('当前范围没有统一模型制作任务', { exact: true }).waitFor({ timeout: 60_000 });
  assert.match((await pagerText(page)).total, /^共 0 个制作任务$/);
  assert.equal(await page.getByTestId('pagination').first().getByTestId('pagination-next').isDisabled(), true, '空结果必须禁用下一页');
  assert.equal(await page.getByTestId('pagination').first().getByTestId('pagination-prev').isDisabled(), true, '空结果必须禁用上一页');
  await page.getByLabel('结果筛选').selectOption('');
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-001');
  await waitForRows(page, 'usage-task-row', 50);
  result.assertions.push('空结果显示「共 0 条」并禁用翻页，不渲染假数据');

  // 8. 单次失败保留错误与重试入口。
  controls.failSection = 'tasks';
  await page.getByLabel('模型筛选').selectOption({ index: 1 });
  const listError = page.getByTestId('usage-list-error');
  await listError.waitFor({ timeout: 60_000 });
  assert.match(await listError.innerText(), /模拟读取明细失败/);
  assert.equal(await page.getByTestId('usage-detail-list').getByText('当前范围没有统一模型制作任务', { exact: true }).count(), 0, '失败时不得渲染假「0 条」');
  const retryResponse = waitForUsage(page, (params) => params.get('section') === 'tasks');
  await listError.getByRole('button', { name: '重试读取明细' }).click();
  await retryResponse;
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-001');
  await waitForRows(page, 'usage-task-row', 50);
  await listError.waitFor({ state: 'detached', timeout: 60_000 });
  await page.getByLabel('模型筛选').selectOption('');
  await waitForRows(page, 'usage-task-row', 50);
  result.assertions.push('单次失败保留错误与重试入口，重试后恢复，不渲染假「0 条」');

  // 9. CSV：翻到末页再导出仍含完整筛选记录；链接不带 section/page/pageSize。
  const lastPager = page.getByTestId('pagination').first();
  await lastPager.getByTestId('pagination-jump').fill('4');
  await lastPager.getByTestId('pagination-jump-submit').click();
  await waitForFirstRow(page, 'usage-task-row', 'data-media-task-id', 'media-task-mta-151');
  const href = await page.getByTestId('usage-export').getAttribute('href');
  assert.ok(href, '管理员必须能看到导出 CSV 入口');
  assert.match(href, /\/api\/team\/usage\/export\?/, 'CSV 导出必须沿用独立导出接口');
  assert.doesNotMatch(href, /section=|page=|pageSize=/, 'CSV 导出链接不得带 section/page/pageSize');
  assert.match(href, /period=month/, 'CSV 必须带业务筛选（period）');
  assert.match(href, /scope=self/, 'CSV 必须带业务范围（scope）');
  const csv = await page.evaluate(async (target) => (await fetch(target, { credentials: 'same-origin' })).text(), href);
  const csvLines = csv.split('\r\n').filter((line) => line.length > 0);
  assert.equal(csvLines.length, ADMIN_SELF_ATTEMPTS + 1, `末页导出的 CSV 必须是完整筛选记录（${ADMIN_SELF_ATTEMPTS} 条 + 表头），实际 ${csvLines.length}`);
  result.assertions.push(`翻到末页再导出仍含完整筛选记录（${ADMIN_SELF_ATTEMPTS} 条 + 表头），链接不含 section/page`);

  // 10. 管理员范围切换：全团队 vs 仅看自己。
  const teamScope = waitForUsage(page, (params) => params.get('scope') === 'team' && params.get('section') === 'tasks');
  await page.getByRole('tablist', { name: '用量统计范围' }).getByRole('tab', { name: '全团队' }).click();
  await teamScope;
  await waitForTotal(page, `共 ${SEED.admin.tasks + SEED.employee.tasks} 个制作任务`);
  assert.ok(requests.some((params) => params.get('scope') === 'team'), '切到全团队必须带 scope=team');
  const selfScope = waitForUsage(page, (params) => params.get('scope') === 'self' && params.get('section') === 'tasks');
  await page.getByRole('tablist', { name: '用量统计范围' }).getByRole('tab', { name: '仅看自己' }).click();
  await selfScope;
  await waitForTotal(page, `共 ${SEED.admin.tasks} 个制作任务`);
  result.assertions.push(`管理员范围切换正确（全团队 ${SEED.admin.tasks + SEED.employee.tasks} → 仅看自己 ${SEED.admin.tasks}）`);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
      try { localStorage.setItem('creative-studio-theme', value); } catch { /* 无偏好也继续 */ }
    }, theme);
    await sleep(200);
    const file = `usage-admin-${theme}.png`;
    await page.screenshot({ path: path.join(evidenceDirectory, file), fullPage: true });
    result.evidence.push(file);
  }
  // 员工专用字段边界：管理员响应里可以有 channels；员工响应里不能有（下面单独验）。
  assert.ok(responses.some((entry) => entry.section === 'tasks' && Array.isArray(entry.body?.items)
    && entry.body.items.some((item) => Array.isArray(item.channels))), '管理员任务明细必须带通道尝试（用于详情）');
  void credentials;
}

async function runEmployeeChecks(page) {
  const requests = usageRequests(page);
  const responses = usageResponses(page);
  installUsageRoutes(page, { failSection: null, delayPage2Ms: 0 });

  await page.goto(`${baseUrl}/usage`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  await page.getByRole('tab', { name: '制作任务' }).waitFor({ timeout: 300_000 });
  await waitForRows(page, 'usage-task-row', 25);
  assert.equal(await page.getByRole('tab', { name: '通道调用' }).count(), 0, '员工不得看到「通道调用」页签');
  assert.equal(await page.getByRole('tablist', { name: '用量统计范围' }).count(), 0, '员工不得看到范围切换');
  assert.equal(await page.getByTestId('usage-export').count(), 0, '员工不得看到导出 CSV（服务端 403）');
  assert.match((await pagerText(page)).total, new RegExp(`^共 ${SEED.employee.tasks} 个制作任务$`), '员工只统计本人任务');

  await page.getByRole('tab', { name: '其他记录' }).click();
  await waitForRows(page, 'usage-attempt-row', 25);
  assert.equal(await page.getByRole('group', { name: '其他记录类型' }).count(), 0, '员工不得看到「待映射记录」切换');
  const employeeOther = await pagerText(page);
  const legacyDebug = responses.filter((entry) => entry.section === 'legacy')
    .map((entry) => ({ total: entry.body?.pagination?.total, ids: (entry.body?.items ?? []).slice(0, 3).map((item) => item.attemptId) }));
  assert.match(employeeOther.total, new RegExp(`^共 ${SEED.employee.legacy} 条记录$`),
    `员工其他记录只包含非统一模型尝试，实际「${employeeOther.total}」；legacy 响应 ${JSON.stringify(legacyDebug)}；首行 ${(await rowIds(page, 'usage-attempt-row'))[0]}`);

  const forbidden = requests.filter((params) => ['channels', 'unmapped'].includes(params.get('section') ?? ''));
  assert.deepEqual(forbidden.map((params) => params.toString()), [], '员工页面绝不能请求被禁止的 section');
  // 等任务响应真的被捕获（response.json() 是异步的），再断言里面没有 channels 字段。
  const responseDeadline = Date.now() + 30_000;
  while (!responses.some((entry) => entry.section === 'tasks') && Date.now() < responseDeadline) await sleep(200);
  const taskResponses = responses.filter((entry) => entry.section === 'tasks');
  assert.ok(taskResponses.length > 0, '必须捕获到员工的 section=tasks 响应');
  for (const entry of taskResponses) {
    for (const item of entry.body?.items ?? []) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'channels'), false, '员工的任务响应里不得有管理员专用 channels 字段');
    }
  }
  result.assertions.push('员工：无通道调用/待映射页签，不请求被禁止的 section，任务响应不含 channels 字段');

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
      try { localStorage.setItem('creative-studio-theme', value); } catch { /* 无偏好也继续 */ }
    }, theme);
    await sleep(200);
    const file = `usage-employee-${theme}.png`;
    await page.screenshot({ path: path.join(evidenceDirectory, file), fullPage: true });
    result.evidence.push(file);
  }
}

async function runBrowser(name, launcher, credentials) {
  const run = { browser: name, version: null, assertions: [], result: 'passed' };
  const browser = await launcher.launch({ headless: true });
  try {
    run.version = await browser.version();
    result.assertions.push(`${name} ${run.version} 实际启动`);

    const adminContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
    try {
      const page = await adminContext.newPage();
      page.on('pageerror', recordPageError(`admin/${name}`));
      await loginViaUi(page, ADMIN_ID, ADMIN_PASSWORD);
      await runAdminChecks(page, credentials);
      run.assertions.push('管理员：页签/分页/竞态/详情/CSV/范围全部通过');
    } finally {
      await adminContext.close();
    }

    const employeeContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 864 } });
    try {
      const page = await employeeContext.newPage();
      page.on('pageerror', recordPageError(`employee/${name}`));
      await loginViaUi(page, credentials.employee.id, EMPLOYEE_PASSWORD);
      await runEmployeeChecks(page);
      run.assertions.push('员工：字段边界与页签边界全部通过');
    } finally {
      await employeeContext.close();
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
    'scripts/team-server/init-admin.mjs', '--employee-id', ADMIN_ID, '--name', '用量管理员',
  ], { cwd: repoRoot, env: environment(), encoding: 'utf8', timeout: 180_000, windowsHide: true });
  assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${sanitize(initialized.stderr ?? '')}`);
  const adminCredential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
  assert.ok(adminCredential, '必须拿到一次性凭据');
  secrets.add(adminCredential);
  secrets.add(ADMIN_PASSWORD);

  let adminSession = await login(ADMIN_ID, adminCredential);
  adminSession = await changePassword(adminSession, adminCredential, ADMIN_PASSWORD);

  const employeeIdShort = 'usage-0102';
  secrets.add(EMPLOYEE_PASSWORD);
  const createdEmployee = await jsonRequest(adminSession, '/api/team/users', {
    method: 'POST', json: { employeeId: employeeIdShort, displayName: '用量员工', role: 'employee' },
  }, 201);
  secrets.add(createdEmployee.body.credential);
  let employeeSession = await login(employeeIdShort, createdEmployee.body.credential);
  employeeSession = await changePassword(employeeSession, createdEmployee.body.credential, EMPLOYEE_PASSWORD);

  const provider = await jsonRequest(adminSession, '/api/providers', {
    method: 'POST',
    json: {
      name: '用量分页 fixture 供应商', baseUrl: 'http://127.0.0.1:9',
      apiKey: 'usage-pagination-fixture-key', model: 'gpt-image-2', type: 'openai-compatible',
    },
  }, 200);
  const project = await jsonRequest(employeeSession, '/api/projects', {
    method: 'POST',
    json: {
      storeCode: 'B店', productCode: 'USAGE-PAGE', productSubmodel: '', productionType: 'AI种草',
      editorName: '用量分页验收', providerId: provider.body.id, model: 'gpt-image-2', size: '1024x1024',
    },
  }, 200);
  fixtureProjectId = project.body.id;
  assert.ok(fixtureProjectId, '项目必须创建成功');

  const { default: Database } = await import('better-sqlite3');
  const peek = new Database(path.join(root, 'data', 'workbench.db'), { readonly: true });
  const adminUserId = peek.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get(ADMIN_ID);
  const employeeUserId = peek.prepare('SELECT id FROM team_users WHERE employeeId = ?').pluck().get(employeeIdShort);
  peek.close();
  assert.ok(adminUserId && employeeUserId, '必须拿到管理员与员工的用户 id');
  await seedIsolatedDatabase({ adminUserId, employeeUserId });
  result.assertions.push(`隔离 SQLite 造数：${SEED.admin.tasks} 个管理员制作任务 / ${SEED.employee.tasks} 个员工制作任务 / `
    + `${SEED.admin.legacy + SEED.employee.legacy} 条非统一模型 / ${SEED.admin.unmapped + SEED.employee.unmapped} 条待映射（全部已结算，未调用供应商）`);

  const credentials = { admin: { id: ADMIN_ID }, employee: { id: employeeIdShort }, adminUserId, employeeUserId };
  const launchers = { chromium, webkit };
  for (const name of browsersToRun) {
    assert.ok(launchers[name]?.launch, `Playwright 没有 ${name} 内核`);
    result.browserRuns.push(await runBrowser(name, launchers[name], credentials));
  }
  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理的页面异常');
  result.assertions.push(`${browsersToRun.join('/')} 内核都没有未处理的 pageerror`);

  const failed = result.browserRuns.filter((run) => run.result !== 'passed');
  assert.deepEqual(failed, [], `浏览器验收失败：${JSON.stringify(failed)}`);
  result.result = 'passed';
  result.assertions.push('团队用量布局/页签/分页页面级验收通过');
  console.log(`team usage pagination ${result.result}; evidence written without session cookies`);
} catch (error) {
  result.result = 'failed';
  result.error = sanitize(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  console.error(`team usage pagination failed: ${result.error}`);
} finally {
  await stopServer();
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
