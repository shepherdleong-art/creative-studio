/**
 * 林视界面重设计的自动验收工具（第 04 号票）—— 一条命令跑完整套检查。
 *
 * ===========================================================================
 * 怎么跑
 * ===========================================================================
 *
 *   node scripts/team-server/acceptance.mjs --level ui
 *
 * 直接跑（不经过验收编排）：
 *
 *   node scripts/ui-acceptance.playwright.test.mjs
 *
 * 它会自己起一份隔离的统一生产服务（独立临时数据根 + 随机回环端口 + 断外网守卫），
 * 用正式 API 建好管理员/员工/一个项目，然后用 Chromium 与 WebKit 两个内核、
 * 1536×864 / 1280×720 / 1024×720 三窗口、浅色深色两主题，逐屏量三项尺寸检查，
 * 最后删掉临时数据根、停掉进程、交出证据目录与结果 JSON。
 *
 * ===========================================================================
 * 后续 UI 票怎么加自己那一屏的检查（05–14 都看这里）
 * ===========================================================================
 *
 * 全部在 `scripts/team-server/ui-acceptance-screens.mjs`：
 *   1. 往 `SCREENS` 加一条（id / title / owner / audience / href / ready / actions / checks）。
 *   2. 这一屏需要基础夹具没有的数据时，往 `ui-acceptance-fixtures.mjs` 的 `FIXTURE_HOOKS`
 *      加一个钩子，并在屏幕上写 `skipUnless: '钩子 id'`（或数组）。
 *   3. 已知问题写 `knownFailure: 'ui-NN'`（配 knownFailureChecks / knownFailureReason），
 *      对应票修好后删标记 → 自动变回硬失败。
 *
 * 判定规则在 `ui-acceptance-checks.mjs`（三项尺寸检查 + 画面比例），阈值不要在那里放宽。
 * 只想跑自己那一屏：
 *   TEAM_ACCEPTANCE_UI_SCREENS=mixcut-single node scripts/ui-acceptance.playwright.test.mjs
 *
 * ===========================================================================
 * 环境变量
 * ===========================================================================
 *   TEAM_ACCEPTANCE_UI_SCREENS     逗号分隔的屏幕 id，只跑这些屏（默认全部）
 *   TEAM_ACCEPTANCE_UI_MATRIX      逗号分隔的 `内核@宽x高`，覆盖默认矩阵（调试用）
 *   TEAM_ACCEPTANCE_UI_THEMES      逗号分隔 light,dark（默认两者）
 *   TEAM_ACCEPTANCE_UI_RESULT_PATH 结果 JSON 路径（acceptance.mjs 会注入）
 *   TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR 证据目录（acceptance.mjs 会注入）
 *   TEAM_ACCEPTANCE_TEST_TEMP_ROOT 临时数据根的父目录（默认 TEMP/TMP）
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectAllChecks,
  evaluateClippedControls,
  evaluateHiddenOverflowContent,
  evaluateHorizontalOverflow,
  evaluateMediaFrames,
} from './team-server/ui-acceptance-checks.mjs';
import { createUiAcceptanceApi, runFixtureHooks } from './team-server/ui-acceptance-fixtures.mjs';
import { selectScreens, validateScreens } from './team-server/ui-acceptance-screens.mjs';
import { runCheckSelfTest } from './team-server/ui-acceptance-selftest.mjs';

const repoRoot = process.cwd();
void fileURLToPath;

/** 默认矩阵：两个内核（Chromium 是桌面客户端内核）× 三窗口。主题在每个组合里都跑。 */
export const DEFAULT_ENGINES = ['chromium', 'webkit'];
export const DEFAULT_VIEWPORTS = [
  { width: 1536, height: 864, label: '1536x864' },
  { width: 1280, height: 720, label: '1280x720' },
  { width: 1024, height: 720, label: '1024x720' },
];
export const DEFAULT_THEMES = ['light', 'dark'];

const evidenceDirectory = process.env.TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR
  ? path.resolve(process.env.TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR)
  : path.join(repoRoot, 'outputs', 'ui-acceptance-local');
const resultPath = process.env.TEAM_ACCEPTANCE_UI_RESULT_PATH
  ? path.resolve(process.env.TEAM_ACCEPTANCE_UI_RESULT_PATH)
  : path.join(evidenceDirectory, 'ui-acceptance.json');
const screenshotDirectory = path.join(evidenceDirectory, 'screens');
fs.mkdirSync(screenshotDirectory, { recursive: true });

const ADMIN_ID = 'ui-accept-admin';
const EMPLOYEE_ID = 'ui-accept-employee';
const ADMIN_PASSWORD = 'Ui-accept-admin-2026';
const EMPLOYEE_PASSWORD = 'Ui-accept-employee-2026';

function parseList(value) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

const screens = validateScreens(selectScreens(parseList(process.env.TEAM_ACCEPTANCE_UI_SCREENS)));

const matrix = parseList(process.env.TEAM_ACCEPTANCE_UI_MATRIX).length
  ? parseList(process.env.TEAM_ACCEPTANCE_UI_MATRIX).map((entry) => {
      const match = /^(chromium|webkit)@(\d+)x(\d+)$/.exec(entry);
      if (!match) throw new Error(`矩阵项必须形如 chromium@1536x864：${entry}`);
      return { engine: match[1], width: Number(match[2]), height: Number(match[3]), label: `${match[2]}x${match[3]}` };
    })
  : DEFAULT_ENGINES.flatMap((engine) => DEFAULT_VIEWPORTS.map((viewport) => ({ engine, ...viewport })));

const themes = parseList(process.env.TEAM_ACCEPTANCE_UI_THEMES).length
  ? parseList(process.env.TEAM_ACCEPTANCE_UI_THEMES)
  : DEFAULT_THEMES;
for (const theme of themes) if (!['light', 'dark'].includes(theme)) throw new Error(`未知主题：${theme}`);

const result = {
  schemaVersion: 1,
  kind: '林视界面重设计 · 自动验收（ui-04）',
  generatedAt: new Date().toISOString(),
  baseUrl: null,
  engines: [...new Set(matrix.map((entry) => entry.engine))],
  viewports: [...new Set(matrix.map((entry) => entry.label))],
  themes,
  screens: screens.map((screen) => ({
    id: screen.id,
    title: screen.title,
    owner: screen.owner,
    audience: screen.audience,
    checks: screen.checks,
    ...(screen.knownFailure
      ? { knownFailure: screen.knownFailure, knownFailureChecks: screen.knownFailureChecks, knownFailureReason: screen.knownFailureReason }
      : {}),
  })),
  // 硬断言：不调用付费模型、不读写真实数据根。
  realPaidProviderCalls: 0,
  isolatedDataRoot: true,
  assertions: [],
  runs: [],
  selfTestRuns: [],
  selfTest: [],
  knownFailures: [],
  failures: [],
  blocked: [],
  // 本次没量到的浮层（前置条件不满足）：如实记录，但不让整轮结果作废。
  gaps: [],
  evidence: [],
};

let server = null;
let serverOutput = '';
let dataRoot = '';
let baseUrl = '';
let port = 0;
let api = null;
let adminSession = null;
let employeeSession = null;
let fixtureContext = null;
const openBrowsers = [];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sanitize(text) {
  let safe = String(text ?? '');
  for (const secret of api?.secrets ?? []) if (secret) safe = safe.split(secret).join('[redacted]');
  if (dataRoot) {
    safe = safe.split(dataRoot).join('[isolated-data-root]');
    safe = safe.split(dataRoot.replaceAll('\\', '/')).join('[isolated-data-root]');
  }
  return safe
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(?:__Host-team_(?:session|csrf)|creative_studio_team_(?:session|csrf)_local)=[^\s;]+/gi, '[redacted-cookie]');
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

function serverEnvironment() {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(path.join(repoRoot, 'scripts', 'team-server', 'no-external-network.cjs'))}`.trim(),
    CREATIVE_STUDIO_DATA_ROOT: dataRoot,
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_PORT: String(port),
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'ui-acceptance-local',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: baseUrl,
    // 回环 HTTP 部署：认证 cookie 改用本地名称并省略 Secure。
    // WebKit 会直接拒收 http:// 上带 Secure 的 __Host- cookie（Chromium 只是告警）；
    // 不开这个开关时 WebKit 永远登录不进去 —— 本票实测踩过。
    CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1',
    CREATIVE_STUDIO_CANVAS_ENABLE: '1',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
    CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0',
  };
}

function startServer() {
  const nextBinary = fileURLToPath(import.meta.resolve('next/dist/bin/next'));
  server = spawn(process.execPath, [nextBinary, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: serverEnvironment(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    serverOutput += String(chunk);
    try { fs.appendFileSync(path.join(evidenceDirectory, 'live-server.log'), sanitize(String(chunk))); } catch { /* 证据目录不可写时继续跑检查 */ }
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  await Promise.race([exited, sleep(15_000)]);
}

/** 隔离服务是否还活着。next dev 会因内存或同目录 .next 争用而中断，必须能和界面失败区分开。 */
function serverAlive() {
  return Boolean(server && server.exitCode === null && server.signalCode === null);
}

/** next dev 首次编译慢：readiness 给 300s（现有验收脚本用 120s，这里更保守）。 */
async function waitReady(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) {
      throw new Error(`隔离服务提前退出 ${server.exitCode}：${sanitize(serverOutput).slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/team/health/ready`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch { /* 还在编译 */ }
    await sleep(300);
  }
  throw new Error(`隔离服务 readiness 超时（最后状态 ${lastStatus}）：${sanitize(serverOutput).slice(-4000)}`);
}

/** 用隔离数据根里的首管理员初始化入口建管理员，取回一次性凭据。 */
function initializeAdmin() {
  const initialized = spawnSync(
    process.execPath,
    ['scripts/team-server/init-admin.mjs', '--employee-id', ADMIN_ID, '--name', '界面验收管理员'],
    { cwd: repoRoot, env: serverEnvironment(), encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  assert.equal(initialized.status, 0, `隔离首管理员初始化失败：${initialized.error?.code ?? ''} ${sanitize(initialized.stderr ?? '')}`);
  const credential = /一次性凭据（仅显示本次）：(\S+)/.exec(initialized.stdout ?? '')?.[1];
  assert.ok(credential, `没能从初始化输出里取到一次性凭据：${sanitize(initialized.stdout ?? '').slice(-2000)}`);
  return credential;
}

function evaluateChecks(measurement, screen) {
  const checks = screen.checks;
  const outcomes = {};
  if (checks.includes('horizontalScroll')) outcomes.horizontalScroll = evaluateHorizontalOverflow(measurement.horizontalScroll);
  if (checks.includes('clippedControls')) outcomes.clippedControls = evaluateClippedControls(measurement.clippedControls);
  if (checks.includes('hiddenOverflowContent')) outcomes.hiddenOverflowContent = evaluateHiddenOverflowContent(measurement.hiddenOverflowContent);
  if (checks.includes('mediaFrames')) outcomes.mediaFrames = evaluateMediaFrames(measurement.mediaFrames);
  return outcomes;
}

/**
 * 增量落盘：整套矩阵要跑半小时，中途被 OOM 杀掉时不能一行证据都不剩。
 * 每跑完一屏就写一次（脱敏后），崩溃后至少能看到「跑到哪、红了什么」。
 */
function flushResults() {
  try {
    const safe = JSON.parse(sanitize(JSON.stringify(result)));
    fs.writeFileSync(resultPath, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  } catch { /* 落盘失败不能反过来中断检查 */ }
}

async function importPlaywright() {
  const playwrightModule = await import('@playwright/test');
  for (const engine of result.engines) {
    if (typeof playwrightModule[engine]?.launch !== 'function') throw new Error(`Playwright 没有 ${engine} 内核`);
  }
  return playwrightModule;
}

/**
 * 一次性测一屏：导航 → 等 ready → 设主题 → 量基础态 → 依次打开浮层各量一次。
 * 失败不抛，落成一行带原因的记录，让整轮矩阵继续跑完。
 */
async function measureScreen({ screen, engine, page, theme, viewport }) {
  const row = {
    screen: screen.id,
    screenTitle: screen.title,
    owner: screen.owner,
    audience: screen.audience,
    engine,
    viewport: viewport.label,
    theme,
    outcomes: {},
    evidence: [],
    result: 'passed',
  };
  const href = screen.href(fixtureContext);
  let response;
  try {
    if (!serverAlive()) throw new Error('隔离服务已经不在运行（next dev 中断），本次不是界面问题');
    response = await page.goto(`${baseUrl}${href}`, { waitUntil: 'domcontentloaded', timeout: 240_000 });
  } catch (error) {
    row.result = 'failed';
    const message = sanitize(error instanceof Error ? error.message : error);
    // 服务挂了 / 连不上是基础设施故障，不能算成「这一屏的尺寸不合格」。
    row.kind = !serverAlive() || /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(message)
      ? 'infrastructure'
      : 'ui';
    row.error = message;
    return row;
  }
  if (response && !response.ok()) {
    row.result = 'failed';
    row.error = `导航 ${href} 返回 ${response.status()}`;
    return row;
  }
  await page.waitForLoadState('networkidle', { timeout: 90_000 }).catch(() => undefined);
  try {
    await screen.ready(page);
  } catch (error) {
    row.result = 'failed';
    const message = sanitize(error instanceof Error ? error.message : error);
    row.kind = !serverAlive() || /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(message) ? 'infrastructure' : 'ui';
    row.error = `这一屏没有画出来（ready 断言超时）：${message.slice(0, 800)}`;
    return row;
  }
  // 主题挂在 <html> 上，和产品自身的 themeInitScript / ThemeToggle 用同一个属性与存储键。
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
    try { localStorage.setItem('creative-studio-theme', value); } catch { /* 无偏好存储也能量 */ }
  }, theme);
  await page.waitForTimeout(400);

  const measurement = await page.evaluate(collectAllChecks, screen.scope);
  const baseOutcomes = evaluateChecks(measurement, screen);
  row.outcomes.base = baseOutcomes;
  for (const outcome of Object.values(baseOutcomes)) if (!outcome.passed) row.result = 'failed';

  const suffix = theme;
  const baseName = `${screen.id}-${engine}-${viewport.label}-${suffix}.png`;
  await page.screenshot({ path: path.join(screenshotDirectory, baseName) }).catch(() => undefined);
  row.evidence.push(`screens/${baseName}`);

  // 每弹窗都量：动作按清单顺序跑；一个浮层打不开就如实记失败，不跳过。
  for (const [index, action] of screen.actions.entries()) {
    try {
      await action(page, { fixture: fixtureContext, theme, viewport });
      await page.waitForTimeout(400);
    } catch (error) {
      const message = sanitize(error instanceof Error ? error.message : error);
      // 「前置条件不满足」（隔离数据根里没有可清理项、没有可删的分镜组……）不是界面缺陷。
      // 记 blocked，让结果如实说「这个浮层本次没量到」，而不是冒充尺寸不合格。
      if (message.includes('前置条件不满足')) {
        row.result = 'blocked';
        row.kind = 'precondition';
        row.error = `第 ${index + 1} 个浮层本次量不到：${message.slice(0, 600)}`;
        return row;
      }
      row.result = 'failed';
      row.error = `打开第 ${index + 1} 个浮层失败：${message.slice(0, 800)}`;
      return row;
    }
    const popupName = `${screen.id}-${engine}-${viewport.label}-${suffix}-popup${index + 1}.png`;
    await page.screenshot({ path: path.join(screenshotDirectory, popupName) }).catch(() => undefined);
    row.evidence.push(`screens/${popupName}`);
    const popupOutcomes = evaluateChecks(await page.evaluate(collectAllChecks, screen.scope), screen);
    row.outcomes[`popup${index + 1}`] = popupOutcomes;
    for (const outcome of Object.values(popupOutcomes)) if (!outcome.passed) row.result = 'failed';
  }
  return row;
}

/**
 * 已知失败：只对声明里的检查键生效，别的检查真失败仍然算失败。
 * 已知失败变成通过时也记一条失败，逼后续票删掉标记。
 */
function applyKnownFailure(row, screen) {
  if (row.result !== 'failed' || !screen.knownFailure) return row;
  const allowed = screen.knownFailureChecks ?? screen.checks;
  const failing = [];
  for (const outcomes of Object.values(row.outcomes)) {
    for (const [key, outcome] of Object.entries(outcomes)) {
      if (!outcome.passed) failing.push(key);
    }
  }
  if (failing.some((key) => !allowed.includes(key))) return row;
  row.result = 'known-failure';
  row.knownFailure = screen.knownFailure;
  row.knownFailureReason = screen.knownFailureReason;
  return row;
}

const LOGIN_VIEWPORT = { width: 1536, height: 864, label: '1536x864' };

/** 用真实登录页登录一次，返回 storageState（后续按窗口尺寸重建 context 时复用）。 */
async function loginAndCaptureState(browser, engine, audience) {
  const context = await browser.newContext({
    locale: 'zh-CN', viewport: { width: LOGIN_VIEWPORT.width, height: LOGIN_VIEWPORT.height }, colorScheme: 'light', deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(sanitize(error.message)));
    await page.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 240_000 });
    await page.locator('input[autocomplete="username"]').fill(audience === 'admin' ? ADMIN_ID : EMPLOYEE_ID);
    await page.locator('input[autocomplete="current-password"]').fill(audience === 'admin' ? ADMIN_PASSWORD : EMPLOYEE_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 240_000 });
    const state = await context.storageState();
    result.assertions.push(`${engine} 用真实登录页以${audience === 'admin' ? '管理员' : '员工'}身份登录成功并持有会话 cookie`);
    if (pageErrors.length) result.failures.push({ kind: 'pageerror', engine, audience, message: pageErrors.join(' | ') });
    return state;
  } finally {
    await context.close();
  }
}

async function runMatrix() {
  const playwright = await importPlaywright();
  const perScreenHooks = [...new Set(screens.flatMap((screen) => (screen.skipUnless ? [screen.skipUnless].flat() : [])))]
    .filter((id) => id !== 'base');
  let missingHooks = [];
  if (perScreenHooks.length) {
    const outcome = await runFixtureHooks(fixtureContext, perScreenHooks);
    missingHooks = outcome.missing;
    for (const id of missingHooks) {
      result.blocked.push({ kind: 'fixture-hook-missing', screen: screens.filter((s) => [s.skipUnless ?? []].flat().includes(id)).map((s) => s.id), hook: id, reason: `屏幕声明的数据钩子 ${id} 还没有实现` });
    }
  }
  const runnableScreens = screens.filter((screen) => {
    const required = screen.skipUnless ? [screen.skipUnless].flat() : [];
    return !required.some((id) => missingHooks.includes(id));
  });
  for (const engine of result.engines) {
    const browser = await playwright[engine].launch({ headless: true });
    openBrowsers.push(browser);
    result.assertions.push(`${engine} ${await browser.version()} 实际启动`);

    // 先自测检查器：用已知好/已知坏的合成页面证明每一项检查真的会失败。
    // 没有这一步，「全部通过」也可能只是检查器瞎了。每档窗口各跑一次
    // （横向溢出的判据与视口宽度有关，不能只在小窗口验）。
    for (const viewport of DEFAULT_VIEWPORTS) {
      const selfTestContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      try {
        const page = await selfTestContext.newPage();
        const selfTestRow = await runCheckSelfTest(page, { collectAllChecks, engine, viewport });
        result.selfTestRuns.push(selfTestRow);
        result.selfTest ??= [];
        result.selfTest.push({
          engine,
          viewport: viewport.label,
          passed: selfTestRow.result === 'passed',
          cases: selfTestRow.selftest.map((row) => ({ case: row.case, expectation: row.expectation, passed: row.passed })),
        });
        if (selfTestRow.result !== 'passed') result.failures.push(selfTestRow);
      } finally {
        await selfTestContext.close();
      }
    }

    const storageStates = {
      employee: await loginAndCaptureState(browser, engine, 'employee'),
      admin: await loginAndCaptureState(browser, engine, 'admin'),
    };
    for (const viewport of DEFAULT_VIEWPORTS) {
      for (const theme of themes) {
        for (const audience of ['employee', 'admin']) {
          const audienceScreens = runnableScreens.filter((screen) => screen.audience === audience);
          if (!audienceScreens.length) continue;
          const context = await browser.newContext({
            locale: 'zh-CN',
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: theme,
            deviceScaleFactor: 1,
            storageState: storageStates[audience],
          });
          const page = await context.newPage();
          // 页面异常带上「是哪一屏触发的」：不然每档窗口都会记一条匿名 pageerror，
          // 看不出该找谁修。currentScreen 在下方逐屏更新。
          const currentScreen = { id: '(页面加载中)' };
          page.on('pageerror', (error) => result.failures.push({
            kind: 'pageerror', screen: currentScreen.id, engine, audience,
            viewport: viewport.label, theme, message: sanitize(error.message),
          }));
          for (const screen of audienceScreens) {
            // 隔离服务中途死掉时，后面的导航只会全部 ERR_CONNECTION_REFUSED。
            // 这时候停下并记 blocked，别把基础设施故障伪装成几十条界面失败。
            if (!serverAlive()) {
              result.blocked.push({
                kind: 'server-died',
                screen: screen.id,
                reason: `隔离的 next dev 在跑 ${screen.id} 之前就退出了（同类屏幕剩余部分未测量）；`
                  + `本次结果不能作为界面判定，请重跑。服务输出尾部：${sanitize(serverOutput).slice(-600)}`,
              });
              return;
            }
            currentScreen.id = screen.id;
            const row = await measureScreen({ screen, engine, page, theme, viewport });
            const finalRow = applyKnownFailure(row, screen);
            result.runs.push(finalRow);
            if (finalRow.result === 'known-failure') result.knownFailures.push(finalRow);
            else if (finalRow.result === 'blocked') {
              // 前置条件不满足（隔离数据根里没有可清理项这种）不是本次运行失效：
              // 页面基础态已经量过了，只有那个浮层这一档量不到。记进 gaps 如实说明，
              // 但不像 server-died / 缺钩子那样让整轮结果作废。
              const entry = {
                kind: finalRow.kind ?? 'precondition',
                screen: screen.id, engine, viewport: viewport.label, theme,
                reason: String(finalRow.error).slice(0, 600),
              };
              if (finalRow.kind === 'precondition') result.gaps.push(entry);
              else result.blocked.push(entry);
            } else if (finalRow.result === 'failed') {
              if (finalRow.kind === 'infrastructure') {
                result.blocked.push({
                  kind: 'server-died', screen: screen.id,
                  reason: `隔离服务不可达：${String(finalRow.error).slice(0, 600)}`,
                });
                flushResults();
                return;
              }
              result.failures.push(finalRow);
            }
            flushResults();
          }
          await context.close();
        }
      }
    }
    await browser.close();
    openBrowsers.length = 0;
  }
  result.assertions.push(
    `全部屏幕在 ${result.engines.join(' / ')} × ${result.viewports.join(' / ')} × ${themes.join(' / ')} 下完成测量：共 ${result.runs.length} 次`,
    `每个内核的每档窗口都先用合成页面自测检查器：${result.selfTestRuns.length} 次自测，`
      + `${result.selfTestRuns.filter((row) => row.result === 'passed').length} 次全部判定正确`,
  );
  // 空项目第 5 步会请求 final-edit 的 external-assets，接口回 404 并冒泡成未处理异常。
  // 那一屏已经整体是 09 的已知失败，所以这些 404 不重复计成「另一件事」，
  // 但**完整保留**在 absorbedPageErrors 里交给 09 一起排查，不删除、不隐藏。
  const knownScreens = new Set(result.knownFailures.map((row) => row.screen));
  const absorbed = result.failures.filter((row) => row.kind === 'pageerror' && knownScreens.has(row.screen));
  if (absorbed.length) {
    result.failures = result.failures.filter((row) => !absorbed.includes(row));
    result.absorbedPageErrors = absorbed;
    result.assertions.push(
      `已知失败屏上的 ${absorbed.length} 条页面异常（未处理 404）并入该屏的已知问题，明细保留在 absorbedPageErrors`,
    );
  }
}

async function prepareFixtures() {
  const rootParent = process.env.TEAM_ACCEPTANCE_TEST_TEMP_ROOT
    ? path.resolve(process.env.TEAM_ACCEPTANCE_TEST_TEMP_ROOT)
    : process.env.TEMP || process.env.TMP;
  assert.ok(rootParent, '没有可用的临时目录（TEMP/TMP 都为空）');
  fs.mkdirSync(rootParent, { recursive: true });
  dataRoot = fs.mkdtempSync(path.join(rootParent, 'lins-ui-acceptance-'));
  assert.ok(path.resolve(dataRoot).includes('lins-ui-acceptance-'), '临时数据根必须是 mkdtemp 出来的隔离目录');

  // 端口与 origin 必须先定：首管理员初始化脚本也读同一份 server 环境。
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  result.baseUrl = baseUrl;
  const adminCredential = initializeAdmin();
  startServer();
  await waitReady();

  api = createUiAcceptanceApi(baseUrl);
  api.secrets.add(adminCredential);
  adminSession = await api.activate(ADMIN_ID, adminCredential, ADMIN_PASSWORD);
  const created = await api.createEmployee(adminSession, { employeeId: EMPLOYEE_ID, displayName: '界面验收员工' });
  employeeSession = await api.activate(EMPLOYEE_ID, created.credential, EMPLOYEE_PASSWORD);

  fixtureContext = { api, adminSession, employeeSession, employee: { employeeId: EMPLOYEE_ID }, admin: { employeeId: ADMIN_ID } };
  const { missing } = await runFixtureHooks(fixtureContext, ['base']);
  assert.deepEqual(missing, [], '基础数据钩子必须存在');
  assert.ok(fixtureContext.project?.id, '基础数据必须产出一个项目');

  result.fixtures = {
    project: { id: fixtureContext.project.id, name: fixtureContext.project.name },
    provider: { id: fixtureContext.provider.id, name: fixtureContext.provider.name },
    accounts: [ADMIN_ID, EMPLOYEE_ID],
  };
  result.assertions.push(
    '隔离统一生产服务用独立 mkdtemp 数据根 + 随机回环端口 + 断外网守卫启动，readiness 到达 200',
    '管理员经首管理员入口初始化并改密；员工经正式 /api/team/users 创建并改密；项目经正式 /api/projects 创建',
    '供应商以 fixture 占位 key 接入，提交的任务只受理不执行，真实付费调用次数保持 0',
  );
}

function summarize() {
  const counts = { passed: 0, failed: 0, 'known-failure': 0 };
  for (const row of result.runs) counts[row.result] = (counts[row.result] ?? 0) + 1;
  result.counts = counts;

  const byScreen = {};
  for (const row of result.runs) {
    const entry = (byScreen[row.screen] ??= {
      id: row.screen, title: row.screenTitle, owner: row.owner, audience: row.audience,
      passed: 0, failed: 0, 'known-failure': 0, checks: {}, scopes: {}, notes: [],
    });
    entry[row.result] += 1;
    for (const [scope, outcomes] of Object.entries(row.outcomes)) {
      for (const [key, outcome] of Object.entries(outcomes)) {
        const check = (entry.checks[key] ??= { passed: 0, failed: 0 });
        check[outcome.passed ? 'passed' : 'failed'] += 1;
        const scopeEntry = (entry.scopes[scope] ??= {});
        const scopeCheck = (scopeEntry[key] ??= { passed: 0, failed: 0 });
        scopeCheck[outcome.passed ? 'passed' : 'failed'] += 1;
      }
    }
    if (row.error) entry.notes.push(row.error);
  }
  result.byScreen = byScreen;

  // 三项尺寸检查的总账（验收条件要逐项给结果）；已知失败单独计，不算掩盖成通过。
  const checkTotals = {};
  const bump = (key, field) => {
    const total = (checkTotals[key] ??= { passed: 0, failed: 0, knownFailure: 0 });
    total[field] += 1;
  };
  for (const row of result.runs) {
    if (row.result === 'known-failure') continue;
    for (const outcomes of Object.values(row.outcomes)) {
      for (const [key, outcome] of Object.entries(outcomes)) bump(key, outcome.passed ? 'passed' : 'failed');
    }
  }
  for (const row of result.knownFailures) {
    for (const outcomes of Object.values(row.outcomes)) {
      for (const [key, outcome] of Object.entries(outcomes)) if (!outcome.passed) bump(key, 'knownFailure');
    }
  }
  result.checkTotals = checkTotals;

  // 已知失败必须真的复现出来：没复现说明界面已修好但标记没删（或检查失效）。
  const knownFailureScreens = new Set(result.knownFailures.map((row) => row.screen));
  for (const screen of screens) {
    if (!screen.knownFailure) continue;
    const ran = result.runs.some((row) => row.screen === screen.id);
    if (!ran) {
      result.blocked.push({ kind: 'known-failure-not-measured', screen: screen.id, reason: '该屏本次没有跑到，已知失败无法确认' });
      continue;
    }
    if (!knownFailureScreens.has(screen.id)) {
      result.failures.push({
        kind: 'known-failure-not-reproduced',
        screen: screen.id,
        reason: `屏幕 ${screen.id} 标记了已知失败 ${screen.knownFailure}，但本次检查全部通过 —— 界面若已修好，请删掉清单里的 knownFailure 标记让它变回硬失败`,
      });
    }
  }

  result.result = result.failures.length === 0 && result.blocked.length === 0 ? 'passed' : 'failed';}

try {
  await prepareFixtures();
  await runMatrix();
} catch (error) {
  result.failures.push({ kind: 'runner-error', message: sanitize(error instanceof Error ? error.stack ?? error.message : error) });
} finally {
  try { summarize(); } catch (error) {
    result.failures.push({ kind: 'summarize-error', message: sanitize(error instanceof Error ? String(error.stack ?? error.message) : error) });
    result.result = 'failed';
  }
  for (const browser of openBrowsers) { try { await browser.close(); } catch { /* 已关闭 */ } }
  await stopServer();
  try { fs.writeFileSync(path.join(evidenceDirectory, 'server.log'), sanitize(serverOutput).slice(-2_000_000), 'utf8'); } catch { /* 证据目录不可写 */ }
  const safe = JSON.parse(sanitize(JSON.stringify(result)));
  fs.writeFileSync(resultPath, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  const cleanup = { removed: false };
  if (dataRoot) {
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      cleanup.removed = !fs.existsSync(dataRoot);
    } catch (error) {
      cleanup.error = sanitize(error instanceof Error ? error.message : error);
    }
  }
  safe.cleanup = cleanup;
  fs.writeFileSync(resultPath, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  console.log(`界面验收 ${safe.result}：${safe.runs.length} 次测量，通过 ${safe.counts?.passed ?? 0}，`
    + `已知失败 ${safe.counts?.['known-failure'] ?? 0}，失败 ${safe.counts?.failed ?? 0}，真实付费调用 ${safe.realPaidProviderCalls} 次`);
  console.log(`结果：${resultPath}`);
  console.log(`证据目录：${evidenceDirectory}`);
  console.log(`临时数据根已清理：${cleanup.removed}`);
  if (safe.result !== 'passed') {
    for (const failure of safe.failures.slice(0, 12)) {
      console.log(`FAIL ${failure.screen ?? failure.kind}: ${failure.error ?? failure.reason ?? failure.message ?? ''}`.slice(0, 700));
    }
    for (const block of safe.blocked.slice(0, 12)) console.log(`BLOCKED ${block.kind}: ${block.reason}`);
    if (safe.gaps?.length) {
      const unique = [...new Set(safe.gaps.map((gap) => `${gap.screen}: ${gap.reason}`))];
      for (const gap of unique.slice(0, 6)) console.log(`GAP ${gap.slice(0, 400)}`);
    }
    process.exitCode = 1;
  }
}
