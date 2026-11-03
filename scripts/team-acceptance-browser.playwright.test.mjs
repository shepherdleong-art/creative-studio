import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = process.env.TEAM_ACCEPTANCE_BASE_URL;
const employeeId = process.env.TEAM_ACCEPTANCE_EMPLOYEE_ID;
const password = process.env.TEAM_ACCEPTANCE_PASSWORD;
const evidenceDirectory = process.env.TEAM_ACCEPTANCE_BROWSER_EVIDENCE_DIR;
const resultPath = process.env.TEAM_ACCEPTANCE_BROWSER_RESULT_PATH;
if (!baseUrl || !employeeId || !password || !evidenceDirectory || !resultPath) {
  throw new Error('浏览器验收需要隔离 baseUrl、账号、证据目录和结果路径');
}
fs.mkdirSync(evidenceDirectory, { recursive: true });
process.env.CHROME_LOG_FILE = path.join(evidenceDirectory, 'chrome.log');
let browser;
const result = {
  schemaVersion: 1,
  assertions: [],
  evidence: [],
  pageErrors: [],
  realPaidProviderCalls: 0,
};
try {
  browser = await chromium.launch({ headless: true });
  result.browser = await browser.version();
  const context = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: false });
  const page = await context.newPage();
  page.on('pageerror', (error) => result.pageErrors.push(error.message));
  const loginResponse = await page.goto(`${baseUrl}/team/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(loginResponse?.ok(), true, '登录页必须由真实 HTTP 服务成功呈现');
  await page.waitForLoadState('networkidle', { timeout: 60_000 });
  await page.locator('input[autocomplete="username"]').fill(employeeId);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/team/login', { timeout: 60_000 }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
  const tasksResponse = await page.goto(`${baseUrl}/team/tasks`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(tasksResponse?.ok(), true);
  await page.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText('读取团队任务…', { exact: true }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => undefined);
  const observed = await page.evaluate(async () => {
    const [sessionResponse, projectsResponse] = await Promise.all([
      fetch('/api/team/auth/session', { cache: 'no-store' }),
      fetch('/api/projects', { cache: 'no-store' }),
    ]);
    const session = await sessionResponse.json();
    const projects = await projectsResponse.json();
    return {
      sessionStatus: sessionResponse.status,
      authenticated: session.authenticated,
      projectStatus: projectsResponse.status,
      projectCount: Array.isArray(projects) ? projects.length : null,
      projectCache: projectsResponse.headers.get('cache-control'),
    };
  });
  assert.equal(observed.sessionStatus, 200);
  assert.equal(observed.authenticated, true);
  assert.equal(observed.projectStatus, 200);
  assert.match(observed.projectCache ?? '', /no-store/);
  const screenshot = path.join(evidenceDirectory, 'browser-team-tasks.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  result.observed = observed;
  result.evidence.push('http/browser/browser-team-tasks.png');
  result.assertions.push(
    'Chromium 通过真实登录页建立独立会话并进入团队任务页',
    '浏览器内 session/projects API 均返回 200，项目响应禁止缓存',
  );
  assert.deepEqual(result.pageErrors, [], '浏览器不得出现未处理页面异常');
  result.assertions.push('浏览器无未处理 pageerror');
  result.result = 'passed';
  await context.close();
} catch (error) {
  result.result = 'failed';
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`team acceptance browser ${result.result}; evidence written without session cookies`);
}
