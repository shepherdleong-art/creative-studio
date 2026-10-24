// Run: npm run build && node scripts/live-mixcut-batches.playwright.test.mjs
// Creates an isolated production server + data root. No existing database or media is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

assert.ok(fs.existsSync(path.resolve('.next/standalone/server.js')), '请先完成 npm run build，再运行批次浏览器验收');
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
    cwd: path.resolve('.next/standalone'),
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
  const batch = name => page.locator('[data-testid^="live-mixcut-batch-"]').filter({ hasText: name });
  const select = name => batch(name).locator('button').first();

  await page.getByRole('button', { name: '新建批次', exact: true }).click();
  await page.getByRole('textbox', { name: '新批次名称' }).fill('第二组方案');
  assert.equal(await page.getByRole('radio', { name: /复制当前批次/ }).isChecked(), true);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(select('第二组方案')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid^="live-mixcut-batch-"]')).toHaveCount(2);
  console.log('PASS 默认复制当前批次');

  await page.getByRole('button', { name: '新建批次', exact: true }).click();
  await page.getByRole('textbox', { name: '新批次名称' }).fill('空白方案');
  await page.getByRole('radio', { name: '空白批次', exact: true }).check();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(select('空白方案')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid^="live-mixcut-batch-"]')).toHaveCount(3);
  console.log('PASS 新建空白批次');

  await page.getByRole('searchbox', { name: '搜索批次' }).fill('第二组');
  await expect(page.locator('[data-testid^="live-mixcut-batch-"]')).toHaveCount(1);
  await select('第二组方案').click();
  await page.getByRole('searchbox', { name: '搜索批次' }).fill('');
  await expect(select('第二组方案')).toHaveAttribute('aria-pressed', 'true');
  await page.reload({ waitUntil: 'networkidle' });
  await expect(select('第二组方案')).toHaveAttribute('aria-pressed', 'true');
  console.log('PASS 搜索、切换与刷新记忆');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '归档批次 第二组方案', exact: true }).click({ force: true });
  await expect(select('空白方案')).toHaveAttribute('aria-pressed', 'true');
  await expect(batch('第二组方案')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '显示已归档' }).check();
  await expect(select('第二组方案')).toBeVisible();
  await page.getByRole('button', { name: '恢复批次 第二组方案', exact: true }).click();
  await expect(select('第二组方案')).toBeVisible();
  console.log('PASS 归档、显示与恢复');
  assert.deepEqual(errors, []);
  assert.deepEqual(invalidRequests, []);
  await page.screenshot({ path: '/tmp/live-mixcut-batches-acceptance.png', fullPage: true });
  console.log('live mixcut batches browser acceptance passed');
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
