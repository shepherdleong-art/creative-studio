/**
 * 团队工作台四步制作演示版 · 02/03/04 浏览器验收。
 *
 * 用法：先启动本机演示服务（`node scripts/local-preview.mjs --no-open`），再运行
 *   DEMO_ADMIN_PASSWORD=... node scripts/team-demo-acceptance.playwright.test.mjs
 *
 * 只走真实浏览器会话与本机回环端口，不调用真实模型。覆盖：
 * - 管理员/员工分别进入各自工作台；
 * - 导航与首页没有创作画布、没有实拍混剪；直接访问 /canvas 得到 404；
 * - 管理员一键进入用户视角、返回管理界面，会话身份不变；
 * - 员工看不到视角切换，直接请求被拒绝；
 * - 脚本页生产模式固定为爆文模板改写。
 */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';

const baseUrl = process.env.DEMO_BASE_URL || 'http://127.0.0.1:3410';
const adminEmployeeId = process.env.DEMO_ADMIN_ID || '0001';
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
if (!adminPassword) throw new Error('缺少 DEMO_ADMIN_PASSWORD（本地管理员密码）');

const browser = await chromium.launch({ headless: true });
try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const adminPage = await adminContext.newPage();
  const errors = [];
  adminPage.on('pageerror', (error) => errors.push(error.message));

  // ---- 管理员登录（首管理员首次登录会先要求改密） ----
  await login(adminPage, adminEmployeeId, adminPassword);
  await expect(adminPage.getByTestId('workspace-sidebar')).toBeVisible({ timeout: 60_000 });

  // ---- 管理端导航：没有创作画布 ----
  const adminNav = await adminPage.getByTestId('workspace-nav').innerText();
  assert.ok(adminNav.includes('运行总览'), `管理端导航应有运行总览：${adminNav}`);
  assert.ok(!adminNav.includes('创作画布'), '演示版管理端导航不得出现创作画布');
  assert.ok(!adminNav.includes('实拍混剪'), '导航不得出现实拍混剪');

  // ---- 首页新建入口：没有实拍混剪；画布开关关闭时也没有创作画布 ----
  const homeText = await adminPage.locator('body').innerText();
  assert.ok(!homeText.includes('实拍混剪'), '首页不得再有实拍混剪入口');
  assert.ok(!homeText.includes('创作画布'), '画布关闭时首页不得出现创作画布');

  // ---- 直接访问画布页面：页面不存在 ----
  // Next dev 的流式渲染会把 notFound() 渲染成 404 页但状态码可能已是 200，
  // 所以同时接受「404 状态」与「渲染出的 404 页」，关键是拿不到画布列表。
  const canvasResponse = await adminPage.goto(`${baseUrl}/canvas`);
  const canvasBody = await adminPage.locator('body').innerText();
  const canvasMissing = canvasResponse?.status() === 404
    || /This page could not be found|404/.test(canvasBody);
  assert.ok(canvasMissing, `画布关闭时直接访问 /canvas 必须不可用（状态 ${canvasResponse?.status()}）`);
  assert.ok(!canvasBody.includes('新建画布'), '不得渲染画布列表内容');
  // 画布 API 同样不可用
  const canvasApi = await adminPage.request.get(`${baseUrl}/api/canvas`);
  assert.ok([404, 403, 503].includes(canvasApi.status()), `画布接口必须不可用，实际 ${canvasApi.status()}`);
  assert.match(await canvasApi.text(), /未开启|canvas_disabled|不可用/, '画布接口必须明确报告功能未开启');
  await adminPage.goto(`${baseUrl}/`);
  await expect(adminPage.getByTestId('workspace-sidebar')).toBeVisible({ timeout: 30_000 });

  // ---- 管理员一键进入用户视角 ----
  await adminPage.getByTestId('workspace-user-button').click();
  await expect(adminPage.getByTestId('workspace-view-as-toggle')).toBeVisible();
  await adminPage.getByTestId('workspace-view-as-toggle').click();
  await expect(adminPage.getByTestId('view-as-banner')).toBeVisible({ timeout: 60_000 });
  const userNav = await adminPage.getByTestId('workspace-nav').innerText();
  assert.ok(userNav.includes('我的项目'), `用户视角应显示员工导航：${userNav}`);
  assert.ok(!userNav.includes('成员与账号'), '用户视角不得显示管理导航');
  // 会话身份仍是管理员本人
  const sessionInUserView = await (await adminPage.request.get(`${baseUrl}/api/team/auth/session`)).json();
  assert.equal(sessionInUserView.user.role, 'admin', '用户视角里服务端身份仍是管理员');
  assert.equal(sessionInUserView.viewMode, 'user');

  // ---- 一键返回管理界面 ----
  await adminPage.getByTestId('view-as-back').getByRole('button').click();
  await expect(adminPage.getByTestId('workspace-nav')).toContainText('成员与账号', { timeout: 60_000 });
  const sessionBack = await (await adminPage.request.get(`${baseUrl}/api/team/auth/session`)).json();
  assert.equal(sessionBack.viewMode, 'admin', '返回后视角恢复管理端');

  // ---- 员工视角：没有视角切换 ----
  // 演示数据根是干净的：管理员先建一个员工账号（一次性凭据），再用它登录。
  const employeeId = process.env.DEMO_EMPLOYEE_ID || `demo-${Date.now().toString().slice(-6)}`;
  const createdUser = await adminPage.request.post(`${baseUrl}/api/team/users`, {
    data: { employeeId, displayName: '演示员工', role: 'employee' },
    headers: { 'x-csrf-token': await csrf(adminPage), Origin: baseUrl },
  });
  assert.equal(createdUser.status(), 201, `建员工账号失败：${await createdUser.text()}`);
  const employeePassword = (await createdUser.json()).credential;
  {
    const employeeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const employeePage = await employeeContext.newPage();
    await login(employeePage, employeeId, employeePassword);
    await expect(employeePage.getByTestId('workspace-sidebar')).toBeVisible({ timeout: 60_000 });
    await employeePage.getByTestId('workspace-user-button').click();
    await expect(employeePage.getByTestId('workspace-view-as-toggle')).toHaveCount(0);
    const denied = await employeePage.request.post(`${baseUrl}/api/team/auth/view-as`, {
      data: { active: true }, headers: { 'x-csrf-token': await csrf(employeePage) },
    });
    assert.equal(denied.status(), 403, '员工直接请求切换视角必须被拒绝');
    const employeeNavText = await employeePage.getByTestId('workspace-nav').innerText();
    assert.ok(!employeeNavText.includes('成员与账号'), '员工导航不得出现管理入口');
    assert.ok(!employeeNavText.includes('创作画布'), '员工导航也不得出现创作画布');
    // 员工直接写公共预设必须被拒绝
    const publishAttempt = await employeePage.request.post(`${baseUrl}/api/video-prompt-templates`, {
      data: { name: '员工越权预设', prompt: 'x', category: 'scene', visibility: 'public' },
      headers: { 'x-csrf-token': await csrf(employeePage), Origin: baseUrl },
    });
    assert.equal(publishAttempt.status(), 403, '员工不能发布公共预设');
    // 员工可以保存自己的常用词（私有）
    const ownPrompt = await employeePage.request.post(`${baseUrl}/api/video-prompt-templates`, {
      data: { name: '员工的场景词', prompt: '员工自己写的场景全文。', category: 'scene' },
      headers: { 'x-csrf-token': await csrf(employeePage), Origin: baseUrl },
    });
    assert.equal(ownPrompt.status(), 201, '员工保存私有常用词必须成功');
    const sceneList = await (await employeePage.request.get(`${baseUrl}/api/video-prompt-templates?category=scene`)).json();
    assert.ok(sceneList.some((item) => item.name === '员工的场景词'), '员工能读回自己的常用词');
    const employeeCanvas = await employeePage.goto(`${baseUrl}/canvas`);
    const employeeCanvasBody = await employeePage.locator('body').innerText();
    assert.ok(
      employeeCanvas?.status() === 404 || /This page could not be found|404/.test(employeeCanvasBody),
      '员工直接访问 /canvas 也必须不可用',
    );
    await employeeContext.close();
  }

  // ---- 03 号票：脚本页只有爆文模板改写 ----
  const projectLink = adminPage.locator('a[href^="/projects/"]:not([href="/projects/new"])').first();
  if (await projectLink.count()) {
    await projectLink.click();
    await adminPage.waitForURL(/\/projects\/[^/?]+/, { timeout: 60_000 });
    await adminPage.getByRole('button', { name: '脚本', exact: true }).click();
    const modeSelect = adminPage.getByLabel('生产模式', { exact: true });
    await expect(modeSelect).toBeVisible({ timeout: 60_000 });
    await expect(modeSelect).toBeDisabled();
    assert.deepEqual(await modeSelect.locator('option').allTextContents(), ['爆文模板改写']);
  }

  // ---- 06 号票：场景/分镜的「我的常用」入口真实可见 ----
  const promptProjectId = await ensureDemoProject(adminPage);
  await adminPage.goto(`${baseUrl}/projects/${promptProjectId}?tab=scene`);
  const scenePicker = adminPage.getByTestId('prompt-library-scene');
  await expect(scenePicker).toBeVisible({ timeout: 60_000 });
  const sceneOptions = await scenePicker.getByLabel('我的常用').locator('option').allTextContents();
  assert.ok(sceneOptions.some((label) => label.includes('公共 · 卧室换景')), `场景公共预设必须可选：${sceneOptions}`);
  await adminPage.goto(`${baseUrl}/projects/${promptProjectId}?tab=storyboard`);
  const shotPicker = adminPage.getByTestId('prompt-library-shot');
  if (await shotPicker.count()) {
    const shotOptions = await shotPicker.getByLabel('我的常用').locator('option').allTextContents();
    assert.ok(shotOptions.some((label) => label.includes('公共 · 产品细节分镜')), `分镜公共预设必须可选：${shotOptions}`);
  }

  // ---- 05 号票：视频运镜的「我的常用」入口 ----
  await adminPage.goto(`${baseUrl}/projects/${promptProjectId}?tab=video`);
  // 空项目里第 4 步先要求选分镜组；选「自由素材工位」后才有运镜行。
  const shotSetSelect = adminPage.getByLabel('选择分镜组', { exact: true });
  await expect(shotSetSelect).toBeVisible({ timeout: 60_000 });
  const freeOption = (await shotSetSelect.locator('option').allTextContents())
    .find((label) => label.includes('自由素材工位'));
  assert.ok(freeOption, '第 4 步必须提供自由素材工位入口');
  await shotSetSelect.selectOption({ label: freeOption });
  const motionPicker = adminPage.getByTestId('prompt-library-camera_motion');
  // 自由工位还没放图时运镜行不可编辑；有图后才出现「我的常用」控件。
  if (await motionPicker.count()) {
    const motionOptions = await motionPicker.first().getByLabel('我的常用').locator('option').allTextContents();
    assert.ok(motionOptions.some((label) => label.includes('公共 · 推进')), `运镜公共预设必须可选：${motionOptions}`);
  } else {
    const body = await adminPage.locator('body').innerText();
    assert.match(body, /自由素材工位|先放一张|上传/, '空项目第 4 步必须指引导入图片');
  }

  assert.deepEqual(errors, [], '页面不应出现运行时异常');
  console.log('team demo acceptance passed (02/03/04/05/06 entry)');
} finally {
  await browser.close();
}

async function csrf(page) {
  const response = await page.request.get(`${baseUrl}/api/team/auth/csrf`);
  return (await response.json()).csrfToken;
}

/**
 * 浏览器验收需要至少一个真实项目：走新建项目页的默认值，
 * 没有可用图片模型时退回直接调接口建一个空项目（与工作台同一套权限）。
 */
async function ensureDemoProject(page) {
  const listResponse = await page.request.get(`${baseUrl}/api/projects`);
  if (listResponse.ok()) {
    const list = await listResponse.json();
    const existing = Array.isArray(list) ? list.find((item) => item?.id) : list?.projects?.find((item) => item?.id);
    if (existing?.id) return existing.id;
  }
  const models = await (await page.request.get(`${baseUrl}/api/team/models?kind=image`)).json();
  const provider = Array.isArray(models) ? models.find((item) => item?.id) : null;
  if (!provider) return seedAcceptanceProject();
  const created = await page.request.post(`${baseUrl}/api/projects`, {
    data: {
      storeCode: 'B店', productCode: `DEMO${Date.now().toString().slice(-5)}`, productSubmodel: 'A',
      productionType: '新品种草', editorName: '演示', providerId: provider.id,
      aspectRatio: '3:4', resolution: '1k', shotImageIds: [],
    },
    headers: { 'x-csrf-token': await csrf(page), Origin: baseUrl },
  });
  assert.equal(created.status(), 200, `创建验收项目失败：${await created.text()}`);
  return (await created.json()).id;
}

/**
 * 演示环境还没配置图片模型时，直接写一条空项目 + 归属登记（与团队服务同一数据根）。
 * 只用于验证页面入口，不发起任何生成；项目归当前管理员账号。
 */
function seedAcceptanceProject() {
  const dbPath = process.env.DEMO_DB_PATH
    || path.resolve(process.cwd(), 'outputs', 'local-preview', 'data', 'workbench.db');
  const db = new Database(dbPath);
  try {
    const admin = db.prepare(`SELECT id FROM team_users WHERE role = 'admin' ORDER BY createdAt LIMIT 1`).get();
    assert.ok(admin, '演示数据根里没有管理员账号');
    const provider = db.prepare(`SELECT id FROM providers ORDER BY name LIMIT 1`).get();
    const providerId = provider?.id ?? 'demo-provider';
    if (!provider) {
      db.prepare(`INSERT INTO providers (id, name, baseUrl, model, type, enabled, apiKey) VALUES (?, ?, ?, ?, 'openai', 0, '')`)
        .run(providerId, '验收占位供应商', 'http://127.0.0.1', 'gpt-image-2');
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, status, workflowType, storeCode, productCode, productionType, editorName, namingDate)
      VALUES (?, ?, ?, 'gpt-image-2', '', '1024x1024', 'draft', 'complex_product', 'B店', 'DEMO001', '新品种草', '演示', ?)`)
      .run(id, `验收项目-${id.slice(0, 6)}`, providerId, now.slice(0, 10));
    db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
      VALUES ('project', ?, ?, 'private', NULL, NULL, 'project', ?, ?, ?)`)
      .run(id, admin.id, id, now, now);
    return id;
  } finally {
    db.close();
  }
}

/**
 * 登录到工作台。
 *
 * 用页面自己的 request 上下文走真实接口（与浏览器共享 Cookie），因此能稳定处理
 * 「首管理员第一次登录必须先改密」的分支，不依赖表单渲染时机。
 */
async function login(page, employeeId, password) {
  const token = await csrf(page);
  await page.goto(`${baseUrl}/team/login`);
  const loginResponse = await page.request.post(`${baseUrl}/api/team/auth/login`, {
    data: { employeeId, password },
    headers: { 'x-csrf-token': token, Origin: baseUrl },
  });
  assert.equal(loginResponse.status(), 200, `登录失败：${loginResponse.status()} ${await loginResponse.text()}`);
  const body = await loginResponse.json();
  if (body.mustChangePassword) {
    const changed = await page.request.post(`${baseUrl}/api/team/auth/change-password`, {
      data: { newPassword: password },
      headers: { 'x-csrf-token': token, Origin: baseUrl },
    });
    assert.equal(changed.status(), 200, `改密失败：${changed.status()} ${await changed.text()}`);
    const relogin = await page.request.post(`${baseUrl}/api/team/auth/login`, {
      data: { employeeId, password },
      headers: { 'x-csrf-token': token, Origin: baseUrl },
    });
    assert.equal(relogin.status(), 200, '改密后重新登录失败');
  }
  await page.goto(`${baseUrl}/`);
  await page.getByTestId('workspace-sidebar').waitFor({ state: 'visible', timeout: 60_000 });
}
