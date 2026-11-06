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
  const context = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: false, permissions: ['clipboard-read', 'clipboard-write'] });
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
  const taskFixture = JSON.parse(process.env.TEAM_ACCEPTANCE_TASK_FIXTURE ?? 'null');
  if (taskFixture) {
    await page.getByText(taskFixture.syntheticHistoryOnly ? '第 2 条文案 · 润色' : '详情页素材分析', { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.getByText(taskFixture.syntheticHistoryOnly ? '历史脚本模型-fixture-A' : taskFixture.model, { exact: false }).first().waitFor();
    await page.getByText(taskFixture.syntheticHistoryOnly ? '历史脚本供应商（fixture）' : taskFixture.providerName, { exact: false }).first().waitFor();
    assert.equal(await page.getByText(taskFixture.employee.taskId, { exact: true }).count(), 0, '完整 UUID 不得直接出现在正常任务阅读入口');
    await page.getByRole('button', { name: '复制排查信息', exact: true }).first().click();
    await page.getByRole('button', { name: '已复制排查信息', exact: true }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    for (const expected of [taskFixture.employee.taskId, taskFixture.syntheticHistoryOnly ? 'script-studio-generate:plan:2:polish:1' : 'script-studio-vision', taskFixture.syntheticHistoryOnly ? '历史脚本模型-fixture-A' : taskFixture.model]) assert.ok(copied.includes(expected), `排查信息应保留 ${expected}`);
    await page.locator('details').filter({ hasText: '编号与版本' }).first().locator('summary').click();
    await page.getByText(taskFixture.employee.taskId, { exact: false }).first().waitFor();
    await page.getByLabel('查找任务', { exact: true }).fill('不存在的任务-search');
    await page.getByText('当前筛选没有团队任务。', { exact: true }).waitFor();
    await page.getByLabel('查找任务', { exact: true }).fill('');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await page.screenshot({ path: path.join(evidenceDirectory, `tasks-${theme}.png`), fullPage: true });
      result.evidence.push(`http/browser/tasks-${theme}.png`);
    }
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/team/tasks' && response.status() === 200, { timeout: 60_000 }),
      page.goto(`${baseUrl}/`, { waitUntil: 'networkidle', timeout: 60_000 }),
    ]);
    await page.getByText(taskFixture.syntheticHistoryOnly ? '第 2 条文案 · 润色' : '详情页素材分析', { exact: false }).first().waitFor();
    await page.getByText(taskFixture.syntheticHistoryOnly ? '历史脚本模型-fixture-A' : taskFixture.model, { exact: false }).first().waitFor();
    assert.equal(await page.getByText(taskFixture.employee.taskId, { exact: true }).count(), 0);
    const historyApi = await page.evaluate(async () => {
      const response = await fetch('/api/team/tasks', { cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(historyApi.status, 200);
    assert.ok(historyApi.body.items.some((item) => item.model === (taskFixture.syntheticHistoryOnly ? '历史脚本模型-fixture-A' : taskFixture.model) && item.providerName === (taskFixture.syntheticHistoryOnly ? '历史脚本供应商（fixture）' : taskFixture.providerName)));
    if (taskFixture.currentProviderModel) assert.equal(historyApi.body.items.some((item) => item.model === taskFixture.currentProviderModel), false, '修改当前配置不得改变历史任务模型');
    assert.equal(historyApi.body.items.some((item) => item.model === '其他成员模型-fixture-B'), false, '员工只能看到自己的历史任务');
    const serialized = JSON.stringify(historyApi.body);
    for (const forbidden of ['must-not-leak', 'providerSnapshot', 'inputSnapshot', 'apiKey', 'baseUrl']) assert.equal(serialized.includes(forbidden), false);
    await page.screenshot({ path: path.join(evidenceDirectory, 'dashboard-task-display.png'), fullPage: true });
    result.evidence.push('http/browser/dashboard-task-display.png');
    result.assertions.push('首页/任务页共享中文步骤与历史供应商模型；员工隔离、安全投影、搜索、复制详情和浅深主题通过');
  }
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

    if (taskFixture?.syntheticHistoryOnly) {
      await adminPage.goto(`${baseUrl}/team/tasks`, { waitUntil: 'networkidle' });
      await adminPage.getByText('其他成员模型-fixture-B', { exact: false }).first().waitFor();
      await adminPage.getByText('历史脚本模型-fixture-A', { exact: false }).first().waitFor();
      const memberFilter = adminPage.getByLabel('发起人', { exact: true });
      const filtered = adminPage.waitForResponse((response) => response.url().includes('/api/team/tasks?') && response.url().includes('actorUserId=') && response.status() === 200);
      await memberFilter.selectOption({ label: '逻辑用户 2（accept-02）' });
      await filtered;
      await adminPage.getByText('其他成员模型-fixture-B', { exact: false }).first().waitFor({ state: 'detached', timeout: 30_000 });
      await adminPage.getByRole('region', { name: /逻辑用户 1/ }).waitFor({ state: 'detached', timeout: 30_000 });
      const employeeGroup = adminPage.getByRole('region', { name: /逻辑用户 2/ });
      await employeeGroup.getByRole('button', { name: '折叠', exact: true }).click();
      await employeeGroup.getByRole('button', { name: '展开', exact: true }).waitFor();
      assert.equal(await adminPage.getByText('历史脚本模型-fixture-A', { exact: false }).first().isVisible(), false);
      const refreshed = adminPage.waitForResponse((response) => response.url().includes('/api/team/tasks?') && response.url().includes('actorUserId=') && response.status() === 200);
      await adminPage.getByRole('button', { name: '刷新', exact: true }).click();
      await refreshed;
      await adminPage.getByText('读取团队任务…', { exact: true }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => undefined);
      assert.equal(await adminPage.getByText('历史脚本模型-fixture-A', { exact: false }).first().isVisible(), false, '刷新保留筛选与折叠状态');
      await adminPage.getByRole('button', { name: '平铺', exact: true }).click();
      await adminPage.getByText('历史脚本模型-fixture-A', { exact: false }).first().waitFor();
      result.assertions.push('管理员保留按发起人分组/折叠、服务端成员筛选、平铺与刷新状态');
    }

    if (process.env.TEAM_ACCEPTANCE_TASK_HISTORY !== '1') {
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
    assert.equal(await adminPage.getByLabel('资源 ID', { exact: true }).count(), 0, '正常发布流程不能要求手填资源 ID');
    const templateCandidate = adminPage.getByRole('listitem').filter({ hasText: '浏览器公共发布验收' });
    await templateCandidate.getByText('待发布', { exact: true }).waitFor();
    await templateCandidate.getByText('保持产品结构，镜头缓慢推进，展示真实产品细节。', { exact: true }).waitFor();
    const published = adminPage.waitForResponse((response) => response.url().endsWith('/api/team/public-resources') && response.request().method() === 'POST');
    await templateCandidate.getByRole('button', { name: '发布给团队', exact: true }).click();
    assert.equal((await published).status(), 200);
    assert.equal((await api(page, '/api/video-prompt-templates')).body.some((item) => item.id === templateId), true);
    result.assertions.push('管理员从页面发布私人模板后员工才可读取，发布结果来自正式 API');
    }

    const versionedFixtureDirectory = process.env.TEAM_ACCEPTANCE_VERSIONED_FIXTURE_DIR;
    assert.ok(versionedFixtureDirectory, '三类资源页面验收必须有隔离 XLSX 夹具');
    await adminPage.goto(`${baseUrl}/settings?section=script-knowledge`, { waitUntil: 'networkidle', timeout: 60_000 });
    const catalogCard = (kind) => adminPage.locator('.card').filter({ has: adminPage.getByRole('heading', { name: kind === 'strategy' ? '产品策略知识库' : '脚本模板库', exact: true }) });
    for (const kind of ['strategy', 'template']) {
      const card = catalogCard(kind);
      await card.locator('input[type="file"]').setInputFiles(path.join(versionedFixtureDirectory, `browser-${kind}.xlsx`));
      await card.getByText('团队当前 v1', { exact: true }).waitFor({ timeout: 60_000 });
    }
    const viralCard = adminPage.locator('.card').filter({ has: adminPage.getByRole('heading', { name: '爆文模板库', exact: true }) });
    await viralCard.locator('input[type="file"]').setInputFiles(path.join(versionedFixtureDirectory, 'browser-viral.xlsx'));
    await viralCard.getByRole('button', { name: '确认保存为模板库版本', exact: true }).click();
    await viralCard.getByText('团队当前 v1', { exact: true }).waitFor({ timeout: 60_000 });
    assert.equal((await api(page, '/api/script-studio/catalogs')).body.catalogs.every((catalog) => catalog.current === null), true, '设置上传不能直接让员工提前读取');
    assert.equal((await api(page, '/api/script-studio/viral-templates/entries')).body.entries.length, 0);
    await adminPage.goto(`${baseUrl}/team/admin/resources`, { waitUntil: 'networkidle', timeout: 60_000 });
    const versionedPublished = [];
    for (const [kind, typeLabel] of [['strategy', '产品策略知识库'], ['template', '脚本模板库'], ['viral', '爆文模板']]) {
      const candidate = adminPage.getByRole('listitem').filter({ hasText: `browser-${kind}.xlsx` });
      await candidate.getByText(typeLabel, { exact: true }).waitFor();
      await candidate.getByText('待发布', { exact: true }).waitFor();
      await candidate.getByText(kind === 'template' ? '3 条' : '1 条', { exact: false }).first().waitFor();
      await candidate.getByRole('button', { name: '发布给团队', exact: true }).click();
      await candidate.getByText('团队当前版本', { exact: true }).waitFor({ timeout: 30_000 });
      versionedPublished.push(candidate);
    }
    const teamCatalogs = (await api(page, '/api/script-studio/catalogs')).body.catalogs;
    for (const kind of ['strategy', 'template']) {
      const catalog = teamCatalogs.find((item) => item.kind === kind);
      assert.ok(catalog.current, `${kind} 发布后员工读取团队当前版本`);
      assert.equal(catalog.current.sourceFilename, `browser-${kind}.xlsx`);
      const detail = await api(page, `/api/script-studio/catalogs/${catalog.id}/revisions/${catalog.current.id}`);
      assert.equal(detail.status, 200);
      if (kind === 'strategy') assert.equal(detail.body.revision.strategyEntries[0].canonicalName, '浏览器产品');
      else assert.equal(detail.body.revision.frameworkTemplates[0].name, '01 浏览器框架');
    }
    const teamEntries = await api(page, '/api/script-studio/viral-templates/entries');
    assert.equal(teamEntries.body.entries[0].name, '浏览器爆文');
    assert.equal((await api(page, '/api/script-studio/viral-templates')).body.library.id !== '', true);
    assert.equal((await api(page, '/api/script-studio/viral-templates/current', 'PUT', { revisionId: teamEntries.body.entries[0].revisionId })).status, 403);
    for (const kind of ['strategy', 'template', 'viral']) {
      const importPath = kind === 'viral' ? '/api/script-studio/viral-templates/import' : `/api/script-studio/catalogs/${kind}/import`;
      const response = await page.evaluate(async (pathname) => {
        const csrf = await fetch('/api/team/auth/csrf').then((res) => res.json());
        const form = new FormData();
        form.append('file', new File([new Uint8Array([80, 75, 3, 4])], 'forbidden.xlsx'));
        const res = await fetch(pathname, { method: 'POST', headers: { 'x-csrf-token': csrf.csrfToken }, body: form });
        return res.status;
      }, importPath);
      assert.equal(response, 403, `员工不能在页面会话中导入 ${kind}`);
    }
    result.assertions.push('三类真实 XLSX 经设置上传／爆文预览→统一候选预览→完整发布，员工搜索／详情读取实际条目且不能导入或切换');

    for (const [route, heading] of [
      ['/team/admin/operations', '备份与维护'], ['/team/recycle-bin', '回收站'], ['/team/admin/pools', '资源池与共享预算'],
      ['/team/admin/resources', '公共资源发布'],
    ]) {
      const response = await adminPage.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
  try {
    const activePages = browser?.contexts().flatMap((item) => item.pages()) ?? [];
    result.failurePages = await Promise.all(activePages.map(async (item) => ({ url: item.url(), text: (await item.locator('body').innerText()).slice(0, 8000) })));
    for (const [index, item] of activePages.entries()) {
      const failurePath = path.join(evidenceDirectory, `failure-${index}.png`);
      await item.screenshot({ path: failurePath, fullPage: true });
      result.evidence.push(`http/browser/failure-${index}.png`);
    }
  } catch (captureError) { result.captureError = String(captureError); }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`team acceptance browser ${result.result}; evidence written without session cookies`);
}
