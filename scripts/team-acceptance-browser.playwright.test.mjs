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
  if (process.env.TEAM_ACCEPTANCE_ADMIN_ID && process.env.TEAM_ACCEPTANCE_ADMIN_PASSWORD) {
    async function api(target, pathname, method = 'GET', body) {
      return target.evaluate(async ({ pathname, method, body }) => {
        const csrf = await fetch('/api/team/auth/csrf').then((response) => response.json());
        const response = await fetch(pathname, {
          method, headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.csrfToken },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      }, { pathname, method, body });
    }
    const adminContext = await browser.newContext({ locale: 'zh-CN' });
    const adminPage = await adminContext.newPage();
    adminPage.on('pageerror', (error) => result.pageErrors.push(error.message));
    await adminPage.goto(`${baseUrl}/team/login`, { waitUntil: 'networkidle', timeout: 60_000 });
    await adminPage.locator('input[autocomplete="username"]').fill(process.env.TEAM_ACCEPTANCE_ADMIN_ID);
    await adminPage.locator('input[autocomplete="current-password"]').fill(process.env.TEAM_ACCEPTANCE_ADMIN_PASSWORD);
    await Promise.all([
      adminPage.waitForURL((url) => url.pathname !== '/team/login', { timeout: 60_000 }),
      adminPage.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
    // Two provider identities must be configurable into one pool using the actual UI.
    for (const suffix of ['A', 'B']) {
      const created = await api(adminPage, '/api/providers', 'POST', {
        name: `浏览器共享供应商${suffix}`, baseUrl: 'http://127.0.0.1:9',
        apiKey: `browser-fixture-${suffix}`, model: 'gpt-image-2', type: 'openai-compatible',
      });
      assert.equal(created.status, 200);
    }
    await adminPage.goto(`${baseUrl}/team/admin/pools`, { waitUntil: 'networkidle', timeout: 60_000 });
    for (const suffix of ['A', 'B']) {
      const row = adminPage.getByRole('row').filter({ hasText: `浏览器共享供应商${suffix}` });
      await row.getByRole('textbox').fill('media:browser-shared');
      await row.getByRole('spinbutton').fill('2');
      const saved = adminPage.waitForResponse((response) => response.url().endsWith('/api/team/pools') && response.request().method() === 'POST');
      await row.getByRole('button', { name: '保存该池' }).click();
      assert.equal((await saved).status(), 200, '第二个供应商应使用目标共享池的版本号');
      await row.getByText('已就绪', { exact: true }).waitFor();
      await row.getByRole('button', { name: '保存该池' }).waitFor({ state: 'visible' });
    }
    const poolState = await api(adminPage, '/api/team/pools');
    assert.equal(poolState.body.bindings.filter((item) => item.poolKey === 'media:browser-shared').length, 2);
    result.assertions.push('管理员在真实页面把两个供应商绑定同一共享池，刷新后持久化正确');

    const project = await api(page, '/api/projects', 'POST', {
      storeCode: 'B店', productCode: 'BROWSER-RECYCLE', productionType: '新品种草', editorName: '浏览器验收',
      providerId: process.env.TEAM_ACCEPTANCE_PROVIDER_ID, model: 'gpt-image-2', size: '1024x1024',
    });
    assert.equal(project.status, 200);
    assert.equal((await api(page, `/api/projects/${project.body.id}`, 'DELETE')).status, 200);
    await page.goto(`${baseUrl}/team/recycle-bin`, { waitUntil: 'networkidle', timeout: 60_000 });
    const deletedRow = page.getByRole('row').filter({ hasText: project.body.id });
    await deletedRow.getByRole('button', { name: '恢复', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '永久清理' }).count(), 0);
    await deletedRow.getByRole('button', { name: '恢复', exact: true }).click();
    await deletedRow.waitFor({ state: 'detached' });
    assert.equal((await api(page, `/api/projects/${project.body.id}`)).status, 200);
    assert.equal((await api(page, '/api/team/pools')).status, 403);
    result.assertions.push('员工真实页面恢复自己的项目，不能查看资源池或操作永久清理');

    const template = await api(adminPage, '/api/video-prompt-templates', 'POST', {
      name: '浏览器公共发布验收', prompt: '保持产品结构，镜头缓慢推进，展示真实产品细节。', description: '隔离验收',
    });
    assert.equal(template.status, 201, JSON.stringify(template.body));
    const templateId = template.body.template.id;
    assert.equal((await api(page, '/api/video-prompt-templates')).body.some((item) => item.id === templateId), false);
    await adminPage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'networkidle', timeout: 60_000 });
    await adminPage.getByLabel('资源类型', { exact: true }).selectOption('video_prompt_template');
    await adminPage.getByLabel('资源 ID', { exact: true }).fill(templateId);
    const published = adminPage.waitForResponse((response) => response.url().endsWith('/api/team/public-resources') && response.request().method() === 'POST');
    await adminPage.getByRole('button', { name: '发布为公共资源' }).click();
    assert.equal((await published).status(), 200);
    assert.equal((await api(page, '/api/video-prompt-templates')).body.some((item) => item.id === templateId), true);
    result.assertions.push('管理员从页面发布私人模板后员工才可读取，发布结果来自正式 API');

    for (const [route, heading] of [
      ['/team/admin/operations', '备份与维护'], ['/team/recycle-bin', '回收站'], ['/team/admin/pools', '资源池与共享预算'],
    ]) {
      const response = await adminPage.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
      assert.equal(response.status(), 200);
      await adminPage.getByRole('heading', { name: heading, exact: true }).waitFor();
      for (const theme of ['light', 'dark']) {
        await adminPage.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        const name = `${route.split('/').at(-1)}-${theme}.png`;
        await adminPage.screenshot({ path: path.join(evidenceDirectory, name), fullPage: true });
        result.evidence.push(`http/browser/${name}`);
      }
    }
    await adminContext.close();
  }
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
