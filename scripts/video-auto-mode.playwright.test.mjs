// 票 05 验收：H3 / Wan 自动模式在**真实服务 + 真实登录 + 真实 Chromium**下的表现。
//
// 为什么必须起真服务：尾帧上传走 server 模式的受控传输（/api/team/uploads 分片 +
// CSRF + 鉴权），local 模式不具备这条链路，「上传中/已完成」的真实状态只能在
// server 模式复现。所以这里用真 `next dev` + 真 SQLite + 真 Chromium，不用 mock 替代。
//
// 边界（票里明确要求分开记录）：
//   · 本文件证明的是 **UI 双卡片布局、真实上传状态流转、请求层角色字段**；
//   · 上游 FileInfos Usage 与任务冻结字段由 mock 请求合同测试证明：
//     `scripts/openai-video-adapter.test.ts`（Usage 角色）与
//     `scripts/video-reference-job-create.test.ts`（冻结字段）；
//   · **不声称**付费真实任务的上游画面已验收。
//
// 端口：32xx，避开 3000/31xx。用完关服务、删临时数据根。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeExecutable = process.execPath;
const nextBinary = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const keep = process.argv.includes('--keep-evidence');

const evidenceDirectory = path.join(repoRoot, 'outputs', 'video-auto-mode-evidence');
fs.rmSync(evidenceDirectory, { recursive: true, force: true });
fs.mkdirSync(evidenceDirectory, { recursive: true });

const servers = [];
const result = {
  schemaVersion: 1,
  assertions: [],
  observed: {},
  evidence: [],
  pageErrors: [],
  realPaidProviderCalls: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (text) => String(text).replace(/(?:__Host-team_(?:session|csrf))=[^\s;]+/g, '[redacted-cookie]');

const CARD = '.video-motion-card';
const PAIR = '[data-testid="video-frame-pair"]';
const HINT = '[data-testid="video-auto-mode-hint"]';

async function portFree(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
}

async function pickPort() {
  for (let port = 3210; port <= 3298; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error('3210-3298 没有空闲端口');
}

function serverEnvironment(root, port, deploymentId) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: deploymentId,
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    CREATIVE_STUDIO_SERVER_RELEASE_ID: 'video-auto-mode-local',
  };
}

async function startServer({ port, environment, label }) {
  const entry = { label, port, baseUrl: `http://127.0.0.1:${port}`, output: '', child: null };
  // 默认 Turbopack：加 --webpack 会因 sharp 可选依赖 @img/sharp-wasm32 缺失而 500。
  entry.child = spawn(
    nodeExecutable,
    [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: repoRoot, env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const capture = (chunk) => {
    entry.output += String(chunk);
    fs.appendFileSync(path.join(evidenceDirectory, `${label}-server.log`), redact(String(chunk)));
  };
  entry.child.stdout.on('data', capture);
  entry.child.stderr.on('data', capture);
  servers.push(entry);

  const deadline = Date.now() + 180_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (entry.child.exitCode !== null) {
      throw new Error(`${label} 服务提前退出 ${entry.child.exitCode}: ${redact(entry.output).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${entry.baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      lastStatus = response.status;
      if (response.status === 200) return entry;
    } catch { /* 启动等待 */ }
    await sleep(300);
  }
  throw new Error(`${label} 服务 readiness 超时，最后状态 ${lastStatus}: ${redact(entry.output).slice(-4000)}`);
}

async function stopServer(entry) {
  if (!entry?.child || entry.child.exitCode !== null) return;
  const child = entry.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  await Promise.race([exited, sleep(15_000)]);
}

async function stopAllServers() {
  for (const entry of [...servers].reverse()) await stopServer(entry);
}

/* ------------------ 账号、会话、夹具 ------------------ */

async function initAdmin(root, port) {
  const initialized = spawnSync(
    nodeExecutable,
    ['scripts/team-server/init-admin.mjs', '--employee-id', 'auto-admin', '--name', '自动模式管理员'],
    { cwd: repoRoot, env: serverEnvironment(root, port, 'video-auto-mode'), encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(initialized.status, 0, `首管理员初始化失败：${redact(initialized.stderr ?? '')}`);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
  assert.ok(credential, `未能解析一次性凭据：${redact(initialized.stdout ?? '')}`);
  return credential;
}

function cookiePair(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, '认证响应必须设置 cookie');
  return value.split(';', 1)[0];
}

async function apiCall(baseUrl, session, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (session) {
    headers.set('Cookie', session.cookies.join('; '));
    headers.set('Origin', baseUrl);
    if (options.method && options.method !== 'GET') headers.set('x-csrf-token', session.csrf);
  }
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  const { json, ...init } = options;
  return fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(120_000),
    ...init,
    headers,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}

async function login(baseUrl, employeeId, password) {
  const csrfResponse = await apiCall(baseUrl, null, '/api/team/auth/csrf');
  assert.equal(csrfResponse.status, 200);
  const csrfCookie = cookiePair(csrfResponse);
  const csrf = (await csrfResponse.json()).csrfToken;
  const loginResponse = await fetch(`${baseUrl}/api/team/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: csrfCookie, Origin: baseUrl, 'x-csrf-token': csrf },
    body: JSON.stringify({ employeeId, password }),
  });
  assert.equal(loginResponse.status, 200, redact(await loginResponse.clone().text()));
  return { employeeId, csrf, cookies: [csrfCookie, cookiePair(loginResponse)] };
}

async function changePassword(baseUrl, session, currentPassword, newPassword) {
  const response = await apiCall(baseUrl, session, '/api/team/auth/change-password', {
    method: 'POST', json: { currentPassword, newPassword },
  });
  assert.equal(response.status, 200, redact(await response.clone().text()));
}

async function createEmployee(baseUrl, adminSession, employeeId, displayName) {
  const response = await apiCall(baseUrl, adminSession, '/api/team/users', {
    method: 'POST', json: { employeeId, displayName, role: 'employee' },
  });
  assert.equal(response.status, 201, redact(await response.clone().text()));
  return response.json();
}

function seedFixture(environment, args) {
  const seeded = spawnSync(
    nodeExecutable,
    ['scripts/team-server/seed-auto-mode-fixture.mjs', ...args],
    { cwd: repoRoot, env: environment, encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(seeded.status, 0, `夹具播种失败：${redact(seeded.stderr ?? '')}`);
  const line = /FIXTURE_RESULT (.+)/.exec(seeded.stdout ?? '')?.[1];
  assert.ok(line, `夹具未输出结果：${redact(seeded.stdout ?? '')}`);
  return JSON.parse(line);
}

/* -------------- 浏览器：真登录、真上传、真渲染 -------------- */

async function loginThroughPage(browser, baseUrl, employeeId, password, label) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', (error) => result.pageErrors.push(`${label}: ${error.message}`));
  await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle', { timeout: 120_000 });
  await page.locator('input[autocomplete="username"]').fill(employeeId);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 120_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  return { context, page };
}

/** 夹具里固定写入的 canonical 供应商 ID。 */
const AUTO_PROVIDERS = {
  'minimax-h3': { id: 'company-minimax-h3' },
  'wan-3.0': { id: 'company-wan-3-0' },
};
const NON_AUTO_PROVIDER_ID = 'company-kling-3-0';

async function openVideoStep(page, baseUrl, projectId, shotSetId) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: `creative-studio:video-shot-set:${projectId}`, value: shotSetId });
  const navigation = await page.goto(`${baseUrl}/projects/${projectId}?tab=video`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  assert.equal(navigation?.ok(), true, '项目工作台必须由真实服务成功呈现');
  await page.waitForSelector(CARD, { timeout: 120_000 });
  return page;
}

async function cardFacts(page) {
  return page.evaluate(({ cardSelector, pairSelector, hintSelector }) => {
    const card = document.querySelector(cardSelector);
    if (!card) return { present: false };
    const pair = card.querySelector(pairSelector);
    const hint = card.querySelector(hintSelector);
    const tailTile = pair?.querySelector('.video-frame-tail, .video-frame-empty');
    const tailImage = pair?.querySelector('.video-frame-tail img');
    return {
      present: true,
      pairPresent: Boolean(pair),
      referenceEditorPresent: Boolean(card.querySelector('[data-testid="video-reference-editor"]')),
      hint: hint?.textContent?.trim() ?? null,
      providerValue: card.querySelector('select')?.value ?? null,
      tailTilePresent: Boolean(tailTile),
      tailTileRole: tailTile?.classList.contains('video-frame-tail') ? 'loaded'
        : tailTile?.classList.contains('video-frame-empty') ? 'empty' : null,
      tailBusy: Boolean(pair?.querySelector('.video-frame-busy')),
      tailImageSrc: tailImage?.currentSrc || tailImage?.src || null,
      tailTileText: tailTile?.textContent?.trim().slice(0, 60) ?? null,
    };
  }, { cardSelector: CARD, pairSelector: PAIR, hintSelector: HINT });
}

/** 截图前把当前卡片滚到可视区，证据图要能同时看到双卡片与提示。 */
async function captureCardScreenshot(page, file) {
  await page.evaluate((cardSelector) => {
    document.querySelector(cardSelector)?.scrollIntoView({ block: 'start' });
  }, CARD).catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidenceDirectory, file) });
  result.evidence.push(file);
}

async function selectProvider(page, providerId) {
  const select = page.locator(`${CARD} select`).first();
  await select.waitFor({ timeout: 60_000 });
  await select.selectOption(providerId);
  await page.waitForTimeout(300);
}

/** 等面板从「创建中」回到空闲：提交后 creatingRef 仍为 true 时上传会被直接忽略。 */
async function waitForPanelIdle(page) {
  await page.waitForFunction(() => {
    const target = document.querySelector('.video-create-action');
    if (!target) return false;
    const text = target.textContent ?? '';
    return !target.disabled && !/创建中|批量生成中/.test(text);
  }, undefined, { timeout: 120_000 });
  await page.waitForTimeout(200);
}

/** 用真实上传链路给当前行加尾帧：设值到 label 里的 file input。 */
async function uploadTailFrame(page, imagePath) {
  const input = page.locator(`${CARD} ${PAIR} label.video-frame-empty input[type=file]`);
  await input.waitFor({ timeout: 60_000 });
  const uploadTraffic = [];
  const record = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/team/uploads') || url.pathname === '/api/upload') {
      uploadTraffic.push(`${request.method()} ${url.pathname}`);
    }
  };
  page.on('request', record);
  // 提交后面板可能还在「创建中」，那时 onChange 会被静默忽略：等空闲并重试一次。
  for (let attempt = 0; attempt < 2 && uploadTraffic.length === 0; attempt += 1) {
    if (attempt > 0) await waitForPanelIdle(page);
    await input.setInputFiles(imagePath);
    for (let waited = 0; waited < 40 && uploadTraffic.length === 0; waited += 1) {
      await page.waitForTimeout(250);
    }
  }
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(({ cardSelector, pairSelector }) => {
      const card = document.querySelector(cardSelector);
      const pair = card?.querySelector(pairSelector);
      const fileInput = card?.querySelector('input[type=file]');
      return {
        tailImage: Boolean(pair?.querySelector('.video-frame-tail img')),
        warning: card?.querySelector('.video-tail-frame-warning')?.textContent?.trim() ?? null,
        busy: Boolean(pair?.querySelector('.video-frame-busy')),
        emptyText: pair?.querySelector('label.video-frame-empty')?.textContent?.trim().slice(0, 40) ?? null,
        fileInputs: card?.querySelectorAll('input[type=file]').length ?? 0,
        fileInputDisabled: fileInput?.disabled ?? null,
        files: fileInput?.files?.length ?? null,
        deploymentMode: document.documentElement.dataset.deploymentMode ?? null,
      };
    }, { cardSelector: CARD, pairSelector: PAIR });
    if (last.tailImage) {
      page.off('request', record);
      return last;
    }
    await page.waitForTimeout(250);
  }
  page.off('request', record);
  assert.fail(`尾帧上传未完成：uploadTraffic=${JSON.stringify(uploadTraffic)} state=${JSON.stringify(last)}`);
}

/** 捕获下一批 batch 提交的请求体，并本地返回成功（不建真实任务、不触碰供应商）。 */
async function captureNextBatchRequest(page) {
  const captured = { body: null };
  await page.route('**/api/shot-sets/*/video-jobs/batch', async (route) => {
    captured.body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, videoJobIds: ['captured'] }) });
  });
  return captured;
}

async function submitFromPanel(page) {
  const button = page.locator('.video-create-action').first();
  await button.waitFor({ timeout: 60_000 });
  await button.click();
}

/** 等一次被捕获的提交出现，并把面板等回空闲。 */
async function waitForCapturedSubmit(page, captured, label) {
  for (let waited = 0; waited < 120 && !captured.body; waited += 1) await page.waitForTimeout(250);
  assert.ok(captured.body, `${label}: 必须捕获到批量提交请求`);
  await waitForPanelIdle(page);
  return captured.body;
}

function assertRoleFields(requestBody, expected, label) {
  assert.ok(requestBody, `${label}: 必须捕获到请求体`);
  const items = requestBody.items ?? [];
  assert.equal(items.length > 0, true, `${label}: 请求必须带条目`);
  for (const item of items) {
    assert.equal(item.modeIntent, 'auto', `${label}: 自动模式必须带 modeIntent=auto`);
    assert.equal(item.generationMode, expected.generationMode, `${label}: generationMode`);
    assert.equal(item.autoTailState, expected.autoTailState, `${label}: autoTailState`);
    if (expected.tailImageIdPresent) assert.ok(item.tailImageId, `${label}: 尾帧 id 必须进请求`);
    else assert.equal(item.tailImageId, null, `${label}: 不得携带尾帧 id`);
    assert.deepEqual(item.referenceAssetIds, [], `${label}: 自动模式不携带显式参考素材`);
  }
  return items;
}

/* ------------------------------ 主流程 ------------------------------ */

async function runBrowserAcceptance(browser, root, port) {
  const environment = serverEnvironment(root, port, 'video-auto-mode');
  const adminCredential = await initAdmin(root, port);
  const server = await startServer({ port, environment, label: 'server' });
  const baseUrl = server.baseUrl;
  result.observed.server = { baseUrl, port };

  const admin = await login(baseUrl, 'auto-admin', adminCredential);
  const adminPassword = 'Auto-admin-pass-2026';
  await changePassword(baseUrl, admin, adminCredential, adminPassword);
  const employee = await createEmployee(baseUrl, admin, 'auto-owner', '自动模式员工');
  const employeeSession = await login(baseUrl, 'auto-owner', employee.credential);
  const employeePassword = 'Auto-owner-pass-2026';
  await changePassword(baseUrl, employeeSession, employee.credential, employeePassword);
  result.assertions.push('真实 HTTP 建立管理员 + 视频工位所属员工的独立会话');

  const fixture = seedFixture(environment, ['--mode', 'server', '--owner', employee.user.id]);
  result.observed.fixture = { projectId: fixture.projectId, shotSetId: fixture.shotSetId, shotIds: fixture.shotIds };
  result.assertions.push('隔离数据根里存在分镜组 + 两个分镜 + 公司 H3 / Wan / 可灵 3.0 供应商（无任何真实 Key）');

  // 尾帧图：用仓库内的真实 PNG 作为上传素材（浏览器真的会上传它）。
  const tailUploadPath = path.join(evidenceDirectory, 'tail-frame-upload.png');
  fs.copyFileSync(path.join(repoRoot, 'public', 'icons', 'app-icon-512.png'), tailUploadPath);

  const owner = await loginThroughPage(browser, baseUrl, 'auto-owner', employeePassword, 'owner');
  const page = owner.page;

  // ── 1) H3：默认单图草稿必须是双卡片 + 单图提示 ──
  await openVideoStep(page, baseUrl, fixture.projectId, fixture.shotSetId);
  await selectProvider(page, AUTO_PROVIDERS['minimax-h3'].id);
  let facts = await cardFacts(page);
  assert.equal(facts.providerValue, AUTO_PROVIDERS['minimax-h3'].id, '必须选中公司 MiniMax H3');
  assert.equal(facts.pairPresent, true, 'H3 单图草稿也必须显示「首图＋添加尾帧」双卡片');
  assert.equal(facts.referenceEditorPresent, false, 'H3 自动模式不得退回只显示参考图的编辑器');
  assert.equal(facts.tailTilePresent, true, 'H3 必须常显添加尾帧卡');
  assert.equal(facts.tailTileRole, 'empty', '未加尾帧时尾帧卡必须是空态（可点击/拖入）');
  assert.match(facts.hint ?? '', /按单图参考生成/, 'H3 单图草稿必须提示按单图参考生成');
  await captureCardScreenshot(page, 'h3-single.png');
  result.observed.h3Single = facts;
  result.assertions.push('H3 单图草稿：双卡片布局 + 空尾帧卡 + 「按单图参考生成」提示');

  // ── 2) H3 单图提交：请求必须是 reference-to-video + autoTailState=none ──
  let captured = await captureNextBatchRequest(page);
  await page.locator(`${CARD} textarea`).first().fill('单图运镜');
  await submitFromPanel(page);
  let items = assertRoleFields(await waitForCapturedSubmit(page, captured, 'H3 单图'), {
    generationMode: 'reference-to-video', autoTailState: 'none', tailImageIdPresent: false,
  }, 'H3 单图');
  assert.equal(items[0].providerId, AUTO_PROVIDERS['minimax-h3'].id);
  await page.unroute('**/api/shot-sets/*/video-jobs/batch');
  result.assertions.push('H3 单图提交：请求 generationMode=reference-to-video、modeIntent=auto、autoTailState=none、无尾帧 id');

  // ── 3) H3 上传尾帧：真实上传链路 + 状态回到 ready + 提示切到首尾帧 ──
  await uploadTailFrame(page, tailUploadPath);
  facts = await cardFacts(page);
  assert.equal(facts.tailTileRole, 'loaded', '上传成功后尾帧卡必须变成已加载态');
  assert.equal(facts.tailBusy, false, '上传完成后不得残留上传中遮罩');
  assert.ok(facts.tailImageSrc, '尾帧必须真的渲染出图片');
  assert.match(facts.hint ?? '', /按首尾帧生成/, '有有效尾帧后必须提示按首尾帧生成');
  await captureCardScreenshot(page, 'h3-with-tail.png');
  result.observed.h3WithTail = facts;
  result.assertions.push('H3 真实上传尾帧：尾帧卡加载成功、上传态结束、提示切到「按首尾帧生成」');

  // ── 4) H3 双图提交：请求必须是 image-to-video + 真实尾帧 id ──
  captured = await captureNextBatchRequest(page);
  await submitFromPanel(page);
  items = assertRoleFields(await waitForCapturedSubmit(page, captured, 'H3 首尾帧'), {
    generationMode: 'image-to-video', autoTailState: 'ready', tailImageIdPresent: true,
  }, 'H3 首尾帧');
  await page.unroute('**/api/shot-sets/*/video-jobs/batch');
  result.observed.h3WithTailRequest = {
    generationMode: items[0].generationMode,
    autoTailState: items[0].autoTailState,
    hasTailImageId: Boolean(items[0].tailImageId),
  };
  result.assertions.push('H3 首尾帧提交：请求 generationMode=image-to-video、autoTailState=ready、携带真实尾帧 id');

  // ── 5) H3 移除尾帧：恢复单图，提示也跟着回去 ──
  // 尾帧图本身是 HoverZoomImage（覆盖整格、自带 pointer 事件），真实用户是悬停后
  // 点操作层；这里 force 点同一个按钮，避免与悬停放大层抢命中。
  await page.locator(`${CARD} ${PAIR} .video-frame-remove`).click({ force: true });
  await page.waitForFunction(({ cardSelector, pairSelector }) => {
    const pair = document.querySelector(cardSelector)?.querySelector(pairSelector);
    return Boolean(pair?.querySelector('label.video-frame-empty'));
  }, { cardSelector: CARD, pairSelector: PAIR }, { timeout: 120_000 });
  facts = await cardFacts(page);
  assert.equal(facts.tailTileRole, 'empty', '移除成功后尾帧卡必须恢复添加态');
  assert.match(facts.hint ?? '', /按单图参考生成/, '移除尾帧后必须恢复「按单图参考生成」');
  captured = await captureNextBatchRequest(page);
  await submitFromPanel(page);
  assertRoleFields(await waitForCapturedSubmit(page, captured, 'H3 移除尾帧后'), {
    generationMode: 'reference-to-video', autoTailState: 'none', tailImageIdPresent: false,
  }, 'H3 移除尾帧后');
  await page.unroute('**/api/shot-sets/*/video-jobs/batch');
  await captureCardScreenshot(page, 'h3-removed.png');
  result.assertions.push('H3 明确移除尾帧：尾帧卡恢复添加态、提示恢复单图、请求回到 reference-to-video');

  // ── 6) Wan：切到 Wan 后同样是双卡片 + 单图提示（两模型都验） ──
  await selectProvider(page, AUTO_PROVIDERS['wan-3.0'].id);
  facts = await cardFacts(page);
  assert.equal(facts.providerValue, AUTO_PROVIDERS['wan-3.0'].id, '必须能切到公司 Wan 3.0');
  assert.equal(facts.pairPresent, true, 'Wan 单图草稿也必须显示双卡片');
  assert.equal(facts.referenceEditorPresent, false, 'Wan 自动模式不得退回参考图编辑器');
  assert.match(facts.hint ?? '', /按单图参考生成/, 'Wan 单图草稿必须提示按单图参考生成');
  await uploadTailFrame(page, tailUploadPath);
  facts = await cardFacts(page);
  assert.equal(facts.tailTileRole, 'loaded', 'Wan 上传尾帧后必须是已加载态');
  assert.match(facts.hint ?? '', /按首尾帧生成/, 'Wan 有尾帧后必须提示按首尾帧生成');
  captured = await captureNextBatchRequest(page);
  await submitFromPanel(page);
  items = assertRoleFields(await waitForCapturedSubmit(page, captured, 'Wan 首尾帧'), {
    generationMode: 'image-to-video', autoTailState: 'ready', tailImageIdPresent: true,
  }, 'Wan 首尾帧');
  assert.equal(items[0].providerId, AUTO_PROVIDERS['wan-3.0'].id);
  await page.unroute('**/api/shot-sets/*/video-jobs/batch');
  await captureCardScreenshot(page, 'wan-with-tail.png');
  result.observed.wanWithTail = facts;
  result.assertions.push('Wan：切模型后双卡片、真实上传尾帧、提示与请求都切到首尾帧（两模型各自验证三种提交）');

  // ── 7) 非自动模式对照：可灵 3.0 不出自动模式提示，保持既有首尾帧行为 ──
  await selectProvider(page, NON_AUTO_PROVIDER_ID);
  facts = await cardFacts(page);
  assert.equal(facts.providerValue, NON_AUTO_PROVIDER_ID);
  assert.equal(facts.hint, null, '非 H3/Wan 模型不得出现自动模式提示');
  captured = await captureNextBatchRequest(page);
  await submitFromPanel(page);
  const controlItems = (await waitForCapturedSubmit(page, captured, '可灵对照')).items ?? [];
  assert.ok(controlItems.length > 0, '可灵对照行必须能提交');
  assert.equal(controlItems[0].modeIntent, undefined, '非自动模式请求不得带自动意图标记（既有合同不变）');
  assert.equal(controlItems[0].generationMode, 'image-to-video', '可灵仍按既有首尾帧行为');
  await page.unroute('**/api/shot-sets/*/video-jobs/batch');
  await page.screenshot({ path: path.join(evidenceDirectory, 'kling-control.png') });
  result.evidence.push('kling-control.png');
  result.assertions.push('可灵 3.0 对照：无自动模式提示、请求不带 modeIntent、仍按既有首尾帧行为');

  await owner.context.close();

  // ── 8) 服务端拒绝伪造/矛盾的自动模式请求（真实 HTTP，不产生付费 POST） ──
  const contradict = await apiCall(baseUrl, employeeSession, `/api/shot-sets/${fixture.shotSetId}/video-jobs/batch`, {
    method: 'POST',
    json: {
      shotId: fixture.shotIds[0],
      items: [{
        prompt: '伪造首尾帧', providerId: AUTO_PROVIDERS['minimax-h3'].id, durationSec: 5,
        generationMode: 'image-to-video', modeIntent: 'auto', autoTailState: 'ready', tailImageId: null,
        referenceAssetIds: [], templateId: null, multiShot: null,
      }],
    },
  });
  const contradictBody = await contradict.json();
  assert.equal(contradict.status, 400, `声明首尾帧但没有尾帧必须 400：${JSON.stringify(contradictBody)}`);
  assert.match(String(contradictBody.error ?? ''), /没有找到有效尾帧/);

  const pendingDraft = await apiCall(baseUrl, employeeSession, `/api/shot-sets/${fixture.shotSetId}/video-jobs/batch`, {
    method: 'POST',
    json: {
      shotId: fixture.shotIds[0],
      items: [{
        prompt: '尾帧上传中', providerId: AUTO_PROVIDERS['minimax-h3'].id, durationSec: 5,
        generationMode: 'reference-to-video', modeIntent: 'auto', autoTailState: 'pending', tailImageId: null,
        referenceAssetIds: [], templateId: null, multiShot: null,
      }],
    },
  });
  const pendingBody = await pendingDraft.json();
  assert.equal(pendingDraft.status, 400, `尾帧上传中不得按单图提交：${JSON.stringify(pendingBody)}`);
  assert.match(String(pendingBody.error ?? ''), /尾帧正在上传或移除/);

  const fakeIntent = await apiCall(baseUrl, employeeSession, `/api/shot-sets/${fixture.shotSetId}/video-jobs/batch`, {
    method: 'POST',
    json: {
      shotId: fixture.shotIds[0],
      items: [{
        prompt: '自动意图指向别的模型', providerId: NON_AUTO_PROVIDER_ID, durationSec: 5,
        generationMode: 'image-to-video', modeIntent: 'auto', autoTailState: 'none',
        referenceAssetIds: [], templateId: null, multiShot: null,
      }],
    },
  });
  const fakeIntentBody = await fakeIntent.json();
  assert.equal(fakeIntent.status, 400, `自动意图指向非 H3/Wan 必须 400：${JSON.stringify(fakeIntentBody)}`);
  assert.match(String(fakeIntentBody.error ?? ''), /自动模式只适用于/);

  const explicitContract = await apiCall(baseUrl, employeeSession, `/api/shot-sets/${fixture.shotSetId}/video-jobs/batch`, {
    method: 'POST',
    json: {
      shotId: fixture.shotIds[1],
      items: [{
        // 显式合同（无 modeIntent）保持既有行为：调用方声明的模式不被自动规则改写。
        prompt: '显式参考合同', providerId: AUTO_PROVIDERS['minimax-h3'].id, durationSec: 5,
        generationMode: 'reference-to-video', referenceAssetIds: [], templateId: null, multiShot: null,
      }],
    },
  });
  const explicitBody = explicitContract.status === 200 ? null : await explicitContract.json();
  result.observed.serverRejections = {
    contradiction: { status: contradict.status, error: contradictBody.error },
    pendingTail: { status: pendingDraft.status, error: pendingBody.error },
    autoIntentOnOtherModel: { status: fakeIntent.status, error: fakeIntentBody.error },
    explicitIntentStatus: explicitContract.status,
    explicitIntentError: explicitBody?.error ?? null,
  };
  assert.equal(explicitContract.status, 200, `显式合同不得被自动模式规则拦下：${JSON.stringify(explicitBody)}`);
  result.assertions.push(
    `服务端拒绝伪造自动模式请求：声明首尾帧无尾帧 ${contradict.status}、尾帧上传中按单图 ${pendingDraft.status}、`
    + `自动意图指向非 H3/Wan ${fakeIntent.status}；显式合同（无 modeIntent）仍 ${explicitContract.status}（既有合同不被全局改写）`,
  );

  await stopServer(server);
}

/* ------------------------------ 主入口 ------------------------------ */

let browser;
const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-auto-mode-server-'));
try {
  // ffmpeg/sharp 在本环境写不进 %TEMP%，把 TMP 指到仓库内目录（见共享简报）。
  const scratchTemp = path.join(repoRoot, 'outputs', 'video-auto-mode-tmp');
  fs.mkdirSync(scratchTemp, { recursive: true });
  process.env.TEMP = scratchTemp;
  process.env.TMP = scratchTemp;

  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();

  const port = await pickPort();
  await runBrowserAcceptance(browser, serverRoot, port);

  result.pageErrors = result.pageErrors.filter((entry) => !/Failed to load resource/.test(entry));
  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理页面异常');
  result.assertions.push('浏览器无未处理 pageerror');
  result.paidCallNote = '上游真实付费调用 0；本文件只证明 UI/上传状态/请求层字段，上游 FileInfos Usage 与画面另以 mock 合同测试记录';
  result.result = 'passed';
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS: H3/Wan 自动模式在真实会话下双卡片、上传状态与请求字段均符合规格 §6（端口 ${port}）`);
  console.log(`证据目录：${evidenceDirectory}`);
  for (const line of result.assertions) console.log(`  - ${line}`);
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  fs.writeFileSync(path.join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.error(`FAIL: ${redact(result.error)}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopAllServers();
  fs.rmSync(path.join(repoRoot, 'outputs', 'video-auto-mode-tmp'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (!keep) fs.rmSync(serverRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
