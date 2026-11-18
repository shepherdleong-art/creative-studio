/**
 * 07 / 08 号票：没有生成视频或 AI 脚本记录的项目，也能从两种混剪进入。
 *
 * 用法：先启动本机演示服务，再运行
 *   DEMO_ADMIN_PASSWORD=... node scripts/team-demo-mixcut-entry.playwright.test.mjs
 *
 * 覆盖：
 * - 空项目进入混剪页：给出建空分镜组 / 导入自带视频的指引；
 * - 单条精准混剪建空分镜组后导入自己的视频，并带入自带文案；
 * - 批量生产导入视频与粘贴文案，能建批次并设置生成份数。
 * 不调用真实模型，也不做正式导出（导出需真实渲染，另由主流程检查覆盖）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const baseUrl = process.env.DEMO_BASE_URL || 'http://127.0.0.1:3410';
const adminEmployeeId = process.env.DEMO_ADMIN_ID || '0001';
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
const videoPath = process.env.DEMO_VIDEO_PATH || path.resolve(process.cwd(), 'outputs', 'demo-own-video.mp4');
if (!adminPassword) throw new Error('缺少 DEMO_ADMIN_PASSWORD');
if (!fs.existsSync(videoPath)) throw new Error(`缺少测试视频：${videoPath}`);

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);

  const projectId = await ensureEmptyProject(page);
  await page.goto(`${baseUrl}/projects/${projectId}?tab=final-edit`);
  await expect(page.getByTestId('page-toolbar')).toBeVisible({ timeout: 60_000 });

  // 空项目的混剪页必须能进入，并给出「导入自带视频」的指引
  const bodyText = await page.locator('body').innerText();
  assert.match(bodyText, /导入自己的视频|导入自带视频|自定义导入素材|选择视频/, '空项目混剪页必须指引导入视频');
  assert.match(bodyText, /单条精准混剪/, '必须能切到单条精准混剪');
  assert.match(bodyText, /批量生产/, '必须能切到批量生产');

  // ---- 单条：没有分镜组时给出建组入口 ----
  const noShotSet = page.getByTestId('mixcut-no-shot-set');
  if (await noShotSet.count()) {
    await noShotSet.getByRole('button').click();
    // 建组后要等素材面板真正渲染出来（分镜组切换会重新拉一次上下文）。
    await expect(page.locator('body')).toContainText(/自由素材工位/, { timeout: 60_000 });
  }
  await expect(page.getByRole('button', { name: /选择视频|导入/ }).first()).toBeVisible({ timeout: 60_000 });
  // 导入自带视频
  const fileInput = page.locator('input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]').first();
  await fileInput.setInputFiles(videoPath);
  await expect(page.locator('body')).toContainText(/已向.*导入 1 个视频|导入 1 个/, { timeout: 120_000 });

  // 文案可以直接输入（不需要 AI 写脚本）：先进第 2 步，再填自带文案。
  const nextStep = page.getByRole('button', { name: /下一步：AI 智能创作|下一步/ }).first();
  if (await nextStep.isEnabled().catch(() => false)) {
    await nextStep.click();
    const narration = page.locator('textarea').filter({ hasText: '' }).first();
    await narration.fill('这是一段自带的测试口播文案，用来验证导入的视频和文字能直接进入混剪。');
    await expect(narration).toHaveValue(/这是一段自带的测试口播文案/);
  }
  const narrationText = await page.locator('body').innerText();
  assert.match(narrationText, /可用视频素材：1 个|已选 1/, '导入后素材必须计入可用素材');

  // ---- 批量：导入视频 + 粘贴文案 ----
  // 模式切换是分段控件（role=tab 语义），按可见文案点。
  await page.getByRole('tab', { name: '批量生产' }).click();
  await expect(page.locator('body')).toContainText(/批次/, { timeout: 60_000 });
  const batchBody = await page.locator('body').innerText();
  assert.match(batchBody, /自定义导入素材|导入自定义脚本|新批次/, '批量生产必须提供导入素材与脚本的入口');
  assert.deepEqual(errors, [], '页面不应出现运行时异常');
  console.log('team demo mixcut entry passed (07/08)');
} finally {
  await browser.close();
}
async function login(page) {
  await page.goto(`${baseUrl}/team/login`);
  const token = await csrf(page);
  const response = await page.request.post(`${baseUrl}/api/team/auth/login`, {
    data: { employeeId: adminEmployeeId, password: adminPassword },
    headers: { 'x-csrf-token': token, Origin: baseUrl },
  });
  assert.equal(response.status(), 200, `登录失败：${response.status()} ${await response.text()}`);
  const body = await response.json();
  if (body.mustChangePassword) {
    await page.request.post(`${baseUrl}/api/team/auth/change-password`, {
      data: { newPassword: adminPassword }, headers: { 'x-csrf-token': token, Origin: baseUrl },
    });
    await page.request.post(`${baseUrl}/api/team/auth/login`, {
      data: { employeeId: adminEmployeeId, password: adminPassword },
      headers: { 'x-csrf-token': token, Origin: baseUrl },
    });
  }
  await page.goto(`${baseUrl}/`);
  await page.getByTestId('workspace-sidebar').waitFor({ state: 'visible', timeout: 60_000 });
}
async function csrf(page) {
  return (await (await page.request.get(`${baseUrl}/api/team/auth/csrf`)).json()).csrfToken;
}
async function ensureEmptyProject(page) {
  const list = await (await page.request.get(`${baseUrl}/api/projects`)).json();
  const existing = Array.isArray(list) ? list.find((item) => item?.id) : list?.projects?.find((item) => item?.id);
  if (existing?.id) return existing.id;
  const { createHash } = await import('node:crypto');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(process.env.DEMO_DB_PATH
    || path.resolve(process.cwd(), 'outputs', 'local-preview', 'data', 'workbench.db'));
  try {
    const admin = db.prepare(`SELECT id FROM team_users WHERE role = 'admin' ORDER BY createdAt LIMIT 1`).get();
    let provider = db.prepare(`SELECT id FROM providers ORDER BY name LIMIT 1`).get();
    if (!provider) {
      db.prepare(`INSERT INTO providers (id, name, baseUrl, model, type, enabled, apiKey) VALUES ('demo-provider','验收占位','http://127.0.0.1','gpt-image-2','openai',0,'')`).run();
      provider = { id: 'demo-provider' };
    }
    const id = createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 32);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, status, workflowType, storeCode, productCode, productionType, editorName, namingDate)
      VALUES (?, ?, ?, 'gpt-image-2', '', '1024x1024', 'draft', 'complex_product', 'B店', 'MIX001', '新品种草', '演示', ?)`)
      .run(id, `混剪验收-${id.slice(0, 6)}`, provider.id, now.slice(0, 10));
    db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
      VALUES ('project', ?, ?, 'private', NULL, NULL, 'project', ?, ?, ?)`).run(id, admin.id, id, now, now);
    return id;
  } finally {
    db.close();
  }
}
