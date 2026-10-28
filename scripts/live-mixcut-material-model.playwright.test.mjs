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
const buildRoot = process.env.CREATIVE_STUDIO_TEST_BUILD_ROOT || process.cwd();

assert.ok(fs.existsSync(path.resolve(buildRoot, '.next/standalone/server.js')), '请先完成 npm run build，再运行批次浏览器验收');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-mixcut-material-model-browser-'));
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


  const models = [{ id: 'first-model', name: '默认测试模型', model: 'first' }, { id: 'chosen-model', name: '指定测试模型', model: 'chosen' }];
  let imported = false;
  const calls = [];
  let releaseRequest;
  let run = null;
  const binding = { id: 'binding-fixture', assetId: 'asset-fixture', sourceName: 'G1_沙发.mp4', sourcePath: 'G1_沙发.mp4',
    logicalCode: 'G1', contentFingerprint: 'a'.repeat(64), available: true, excludedReason: null };
  const item = { bindingId: binding.id, sourceName: binding.sourceName, logicalCode: 'G1', excluded: false,
    available: true, profile: null, stale: false, inputFingerprint: 'fixture',
    source: { filename: binding.sourceName, table: null } };
  const notes = () => ({ revision: 1, items: imported ? [item] : [], run, aiProviders: models });
  await page.route('**/formula/materials?*', route => route.fulfill({ json: { revision: 1, bindings: imported ? [binding] : [], codes: [] } }));
  await page.route('**/assets/import?*', route => {
    imported = true;
    return route.fulfill({ json: { receipts: [{ index: 0, bindingId: binding.id }], errors: [] } });
  });
  await page.route('**/formula/material-notes?*', async route => {
    if (route.request().method() === 'POST') {
      calls.push(route.request().postDataJSON().providerId);
      run = { id: `run-${calls.length}`, state: 'running', providerName: '指定测试模型', model: 'chosen', total: 1, succeeded: 0, skipped: 0, errors: [], message: null };
      await new Promise(resolve => { releaseRequest = resolve; });
      await route.fulfill({ json: notes() }).catch(() => {});
    } else await route.fulfill({ json: notes() });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '准备素材', exact: true }).click();
  const model = page.getByRole('combobox', { name: '素材整理模型', exact: true });
  const visibleBeforeImport = await model.isVisible();
  if (visibleBeforeImport) {
    await expect(model).toHaveValue('');
    await model.selectOption('chosen-model');
  }
  await page.getByLabel('选择实拍视频', { exact: true }).setInputFiles({ name: binding.sourceName, mimeType: 'video/mp4', buffer: Buffer.from('mock upload; no real video or provider') });
  await expect(page.getByText('本次导入 1 个，已存在 0 个，未完成 0 个。', { exact: true })).toBeVisible();
  // 等待一次 effect/poll 周期，记录没有点击开始时的实际 POST 数量。
  await page.waitForTimeout(2200);
  console.log(JSON.stringify({ visibleBeforeImport, callsAfterImport: calls }));
  assert.deepEqual(calls, [], '导入视频不得自动调用任何模型');
  assert.equal(visibleBeforeImport, true, '空批次导入前就能选择素材整理模型');
  await expect(model).toHaveValue('chosen-model');
  await page.getByRole('button', { name: /开始整理|整理未完成项/ }).click();
  await expect.poll(() => calls.length).toBe(1);
  assert.deepEqual(calls, ['chosen-model'], '只使用用户选定的模型');
  await expect(model).toBeDisabled();
  // 服务端取消结果由 mock 返回；实际 AbortSignal 的持久化由 live-mixcut-material-bindings.test.ts 覆盖。
  run = { ...run, state: 'cancelled', message: '本次整理已停止，已保存结果保留' };
  await page.getByRole('button', { name: '停止本次整理', exact: true }).click();
  releaseRequest();
  await expect(model).toBeEnabled();
  await model.selectOption('first-model');
  await page.waitForTimeout(2200);
  assert.equal(calls.length, 1, '停止或更换模型不自动重启');
  // 即使上一轮完成但仍有待整理项，刷新也不能自动续跑。
  run = { ...run, state: 'completed', message: null };
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '准备素材', exact: true }).click();
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('');
  await expect(page.getByRole('button', { name: /开始整理/ })).toBeDisabled();
  await page.waitForTimeout(2200);
  assert.equal(calls.length, 1, '刷新不自动续跑未完成素材');
  await model.selectOption('first-model');
  await page.getByRole('button', { name: /开始整理|整理未完成项/ }).click();
  await expect.poll(() => calls.length).toBe(2);
  assert.deepEqual(calls, ['chosen-model', 'first-model']);
  run = { ...run, state: 'completed' };
  releaseRequest();
  await expect(model).toBeEnabled();
  assert.deepEqual(errors, []);
  assert.deepEqual(invalidRequests, []);
  console.log('PASS 视频导入前选模型；导入不调用；显式开始使用所选模型；停止/换模型/刷新均不自动启动');
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
