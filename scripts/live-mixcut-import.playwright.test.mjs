// Run: npm run build && node scripts/live-mixcut-import.playwright.test.mjs
// 可用 CREATIVE_STUDIO_TEST_BUILD_ROOT 指向隔离构建，避免替换运行中的桌面产物。
// Creates an isolated production server + data root. No existing database or media is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
const buildRoot = process.env.CREATIVE_STUDIO_TEST_BUILD_ROOT || process.cwd();

assert.ok(fs.existsSync(path.resolve(buildRoot, '.next/standalone/server.js')), '请先完成 npm run build，再运行批次浏览器验收');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-mixcut-batches-browser-'));
const socket = net.createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const address = socket.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise(resolve => socket.close(resolve));
let server;
let browser;
try {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(buildRoot, '.next/standalone'),
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE: '1', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  for (;;) {
    if (server.exitCode !== null) throw new Error(`验收服务退出：${server.exitCode}`);
    try { if ((await fetch(`${origin}/live-mixcut`)).ok) break; } catch { /* 等待编译 */ }
    if (Date.now() > deadline) throw new Error('验收服务启动超时');
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const invalidRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/batches//')) invalidRequests.push(request.url()); });
  await page.goto(`${origin}/live-mixcut`, { waitUntil: 'networkidle' });
  await page.getByTestId('new-live-mixcut-store').selectOption('K店');
  await page.getByTestId('new-live-mixcut-product-code').fill('XQ9A');
  await page.getByTestId('new-live-mixcut-editor').fill('验收');
  await page.getByTestId('create-live-mixcut-button').click();
  await page.waitForURL(/\/live-mixcut\/[^/]+$/);
  await page.getByText('批次列表', { exact: true }).waitFor();

  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const models = [{ id: 'luna-test', name: 'Luna 测试', model: 'luna' }, { id: 'gemini-test', name: 'Gemini 测试', model: 'gemini' }];
  let draft = null;
  let aiCalls = [];
  let cancelCalls = 0;
  let releaseOld;
  const oldFinished = new Promise(resolve => { releaseOld = resolve; });
  await page.route('**/formula/imports?*', async route => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET') {
      const response = await route.fetch();
      const value = await response.json();
      await route.fulfill({ response, json: { ...value, aiProviders: models, drafts: draft ? [draft] : value.drafts } });
    } else if (method === 'POST') {
      const response = await route.fetch(); draft = await response.json();
      await route.fulfill({ response, json: draft });
    } else if (method === 'PATCH') {
      const body = request.postDataJSON();
      if (body.action === 'cancel_ai') {
        cancelCalls++;
        draft = { ...draft, draftRevision: draft.draftRevision + 1, extraction: { ...draft.extraction, state: 'failed', message: '已停止识别' } };
        await route.fulfill({ json: draft });
      } else if (body.action === 'ai') {
        aiCalls.push(body.providerId);
        draft = { ...draft, draftRevision: draft.draftRevision + 1, extraction: { state: 'running', providerId: body.providerId,
          providerName: models.find(model => model.id === body.providerId).name, model: body.providerId, completedSheets: 0, totalSheets: 1 } };
        if (aiCalls.length === 1) {
          const stale = { ...draft, extraction: { ...draft.extraction, state: 'completed' } };
          await oldFinished;
          await route.fulfill({ json: stale }).catch(() => {});
        } else {
          draft = { ...draft, draftRevision: draft.draftRevision + 1, extraction: { ...draft.extraction, state: 'completed' } };
          await route.fulfill({ json: draft });
        }
      } else await route.continue();
    } else await route.continue();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const model = page.getByRole('combobox', { name: '表格识别模型', exact: true });
  await expect(model).toBeVisible();
  await expect(model).toBeEnabled();
  await model.selectOption('luna-test');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [1, '抖音', 1, 10, 'G1', '测试原文'],
  ]);
  await page.getByLabel('选择脚本表', { exact: true }).setInputFiles({ name: 'fixture.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  await page.getByText(/待确认：fixture.xlsx/).waitFor();
  assert.equal(aiCalls.length, 0, '导入不能偷偷调用默认模型');
  await expect(model).toHaveValue('luna-test');
  await page.getByRole('button', { name: '用 AI 识别表头', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止识别', exact: true })).toBeVisible();
  await expect(model).toBeEnabled();
  await model.selectOption('gemini-test');
  await expect.poll(() => cancelCalls).toBe(1);
  await expect(page.getByRole('button', { name: '重新用 AI 识别', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重新用 AI 识别', exact: true }).click();
  await expect(page.getByText(/已由 Gemini 测试 识别列对应/)).toBeVisible();
  releaseOld();
  await expect(model).toHaveValue('gemini-test');
  await expect(page.getByText(/已由 Gemini 测试 识别列对应/)).toBeVisible();
  await expect(page.getByRole('button', { name: '确认导入 1 条' })).toBeEnabled();
  assert.deepEqual(aiCalls, ['luna-test', 'gemini-test']);
  assert.deepEqual(errors, []);
  console.log('PASS 导入前选择模型；导入不自动调用；识别中切换即停止；旧结果不能覆盖新模型');
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3_000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
