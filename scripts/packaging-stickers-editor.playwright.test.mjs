// 运行：node scripts/packaging-stickers-editor.playwright.test.mjs
// 使用临时 CREATIVE_STUDIO_DATA_ROOT、真实 Next API 与真实项目 fixture；不读写开发数据库。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const fixturePath = 'scripts/final-edit-mixcut-real-project.fixture.ts';
const loaderPath = pathToFileURL(path.resolve('scripts/typescript-extension-loader.mjs')).href;
const chrome = path.resolve('packaging/runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-sticker-editor-'));
const testEnv = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: testDataRoot, NEXT_TELEMETRY_DISABLED: '1' };
let browser;
let server;
let passed = false;

async function getFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next dev 启动失败：${output}`);
    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });
      if (response.status < 500) return { child, baseUrl, output: () => output };
    } catch { /* 等待启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill('SIGTERM');
  throw new Error(`Next dev 启动超时：${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function eventually(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (lastError) throw lastError;
  assert.fail(message);
}

try {
  const seeded = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loaderPath, fixturePath], {
    cwd: process.cwd(), env: testEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(seeded.status, 0, `fixture 初始化失败：\n${seeded.stderr}\n${seeded.stdout}`);
  const fixture = JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1));
  server = await startServer();
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  await page.goto(`${server.baseUrl}/projects/${fixture.projectId}?tab=final-edit`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '确认本次混剪要用的素材' }).waitFor();
  await page.getByLabel('选择分镜组').selectOption(fixture.shotSetA);
  await page.locator(`[data-mixcut-shot-set-id="${fixture.shotSetA}"]`).waitFor();
  await page.getByRole('button', { name: /预览调整/ }).click();
  await page.locator('[data-track="video"]').waitFor();

  const readPatch = async (action, requireStickers = true) => {
    const groupPath = `/api/final-edit-groups/${fixture.groupId}`;
    const pending = page.waitForResponse((response) => {
      if (response.request().method() !== 'PATCH' || new URL(response.url()).pathname !== groupPath) return false;
      return !requireStickers || (response.request().postData() || '').includes('"stickers"');
    });
    await action();
    const response = await pending;
    assert.equal(response.status(), 200);
    const request = JSON.parse(response.request().postData() || '{}');
    const body = await response.json();
    return { request, view: body.view };
  };
  const overlay = page.frameLocator('iframe[data-packaging-overlay]');
  const panel = page.locator('#packaging-stickers-panel');
  const assetButtons = panel.getByRole('button', { name: /^添加贴纸 / });

  const packagingSwitch = page.getByRole('switch', { name: '启用视频包装' });
  let enabledView = await page.evaluate(async (groupId) => (await (await fetch(`/api/final-edit-groups/${groupId}`)).json()).packaging, fixture.groupId);
  if (!enabledView.enabled) enabledView = (await readPatch(() => packagingSwitch.click(), false)).view.packaging;
  assert.equal(enabledView.enabled, true);
  assert.equal((enabledView.stickers ?? []).length, 0, '旧项目必须保持空贴纸数组');
  await page.getByRole('tab', { name: '贴纸', exact: true }).click();
  await assetButtons.first().waitFor();
  assert.equal(await assetButtons.count(), 28, '默认只显示当前 comic 模板的 28 张素材');
  await panel.getByRole('button', { name: '全部风格', exact: true }).click();
  assert.equal(await assetButtons.count(), 115, '全部风格必须展示完整 115 张素材');
  await panel.getByRole('button', { name: '当前模板', exact: true }).click();
  assert.equal(await assetButtons.count(), 28);
  await panel.getByLabel('搜索贴纸名称').fill('好物来了');
  assert.equal(await assetButtons.count(), 1, '关键词必须筛选中文素材名');
  await panel.getByLabel('搜索贴纸名称').fill('');
  await panel.getByRole('button', { name: '手势', exact: true }).click();
  assert.equal(await assetButtons.count(), 6, '手势分类必须显示 6 张素材');
  await panel.getByRole('button', { name: '全部', exact: true }).click();

  const firstAdd = await readPatch(() => panel.getByRole('button', { name: '添加贴纸 推荐', exact: true }).click());
  assert.equal(firstAdd.request.variantId, fixture.variantId);
  assert.equal(firstAdd.request.type, 'set_packaging_config');
  assert.equal(firstAdd.view.packaging.stickers.length, 1);
  const first = firstAdd.view.packaging.stickers[0];
  assert.equal(first.startFrame, 20);
  assert.equal(first.endFrame, 68);
  assert.equal(first.centerXPct, 50);
  assert.equal(first.centerYPct, 50);
  assert.equal(first.visualWidthPct, 30);
  assert.equal(first.styleMode, 'follow-template');
  assert.equal(first.trackIndex, 0);
  await eventually(async () => await overlay.locator('.packaging-sticker').count() === 1, '点击添加后 overlay 必须出现一张贴纸');
  await overlay.locator('[data-sticker-edit-ui]').waitFor();

  const iframe = page.locator('iframe[data-packaging-overlay]');
  const frameBox = await iframe.boundingBox();
  assert.ok(frameBox);
  const secondAdd = await readPatch(() => panel.getByRole('button', { name: '添加贴纸 好物来了', exact: true }).dragTo(iframe, { targetPosition: { x: 120, y: 180 } }));
  assert.equal(secondAdd.view.packaging.stickers.length, 2, '拖放必须新增而不是替换当前贴纸');
  const second = secondAdd.view.packaging.stickers[1];
  assert.ok(Math.abs(second.centerXPct - 120 / frameBox.width * 100) < 1, `拖放 X 坐标错误：${second.centerXPct}`);
  assert.ok(Math.abs(second.centerYPct - 180 / frameBox.height * 100) < 1, `拖放 Y 坐标错误：${second.centerYPct}`);
  assert.equal(second.startFrame, 20);
  await eventually(async () => await overlay.locator('.packaging-sticker').count() === 2, '拖放后 overlay 必须出现第二张贴纸');
  await overlay.locator('[data-sticker-edit-ui]').waitFor();

  const moveStart = {
    x: frameBox.x + second.centerXPct / 100 * frameBox.width,
    y: frameBox.y + second.centerYPct / 100 * frameBox.height,
  };
  const moveEnd = { x: moveStart.x + 60, y: moveStart.y + 40 };
  const movedResult = await readPatch(async () => {
    await page.mouse.move(moveStart.x, moveStart.y);
    await page.mouse.down();
    await page.mouse.move(moveEnd.x, moveEnd.y, { steps: 8 });
    await page.mouse.up();
  });
  const moved = movedResult.view.packaging.stickers.find((item) => item.id === second.id);
  const expectedMoveX = (moveEnd.x - frameBox.x) / frameBox.width * 100;
  const expectedMoveY = (moveEnd.y - frameBox.y) / frameBox.height * 100;
  assert.ok(Math.abs(moved.centerXPct - expectedMoveX) < 2, `移动 X 未按预览提交：${moved.centerXPct} vs ${expectedMoveX}`);
  assert.ok(Math.abs(moved.centerYPct - expectedMoveY) < 2, `移动 Y 未按预览提交：${moved.centerYPct} vs ${expectedMoveY}`);

  await overlay.locator('[data-sticker-handle="scale"]').waitFor();
  const scaleBox = await overlay.locator('[data-sticker-handle="scale"]').boundingBox();
  assert.ok(scaleBox);
  const scaledResult = await readPatch(async () => {
    await page.mouse.move(scaleBox.x + scaleBox.width / 2, scaleBox.y + scaleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(scaleBox.x + scaleBox.width / 2 + 36, scaleBox.y + scaleBox.height / 2 + 24, { steps: 6 });
    await page.mouse.up();
  });
  const scaled = scaledResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.ok(scaled.visualWidthPct > moved.visualWidthPct, '角点拖动必须等比放大视觉宽度');

  await overlay.locator('[data-sticker-handle="rotate"]').waitFor();
  const rotateBox = await overlay.locator('[data-sticker-handle="rotate"]').boundingBox();
  assert.ok(rotateBox);
  const rotatedResult = await readPatch(async () => {
    await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rotateBox.x + rotateBox.width / 2 + 42, rotateBox.y + rotateBox.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
  });
  const rotated = rotatedResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.ok(Math.abs(rotated.rotationDeg) > 1, '顶部手柄必须改变旋转角度');
  await eventually(async () => {
    const transform = await overlay.locator(`[data-sticker-id="${second.id}"] .packaging-sticker-rotation`).getAttribute('style');
    return Boolean(transform?.includes(`rotate(${rotated.rotationDeg}deg)`));
  }, '旋转保存后必须等到最新 overlay 几何恢复');
  await overlay.locator('[data-sticker-edit-ui]').waitFor();

  const snapFrameBox = await iframe.boundingBox();
  assert.ok(snapFrameBox);
  const snapStart = {
    x: snapFrameBox.x + rotated.centerXPct / 100 * snapFrameBox.width,
    y: snapFrameBox.y + rotated.centerYPct / 100 * snapFrameBox.height,
  };
  const snappedResult = await readPatch(async () => {
    await page.mouse.move(snapStart.x, snapStart.y);
    await page.mouse.down();
    await page.mouse.move(snapFrameBox.x + snapFrameBox.width / 2 + 4, snapFrameBox.y + snapFrameBox.height / 2 + 4, { steps: 10 });
    await overlay.locator('[data-sticker-guide="x"]').waitFor({ state: 'visible' });
    await overlay.locator('[data-sticker-guide="y"]').waitFor({ state: 'visible' });
    await page.mouse.up();
  });
  const snapped = snappedResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.ok(Math.abs(snapped.centerXPct - 50) < 0.2, `画布中心 X 吸附失败：${snapped.centerXPct}`);
  assert.ok(Math.abs(snapped.centerYPct - 50) < 0.2, `画布中心 Y 吸附失败：${snapped.centerYPct}`);

  await overlay.locator('[data-sticker-edit-ui]').waitFor();
  const contextFrame = page.frames().find((frame) => frame.url().includes('packaging-preview') && frame.url().includes('format=html'));
  assert.ok(contextFrame);
  await contextFrame.evaluate(() => {
    window.__stickerContextMenuPrevented = false;
    document.addEventListener('contextmenu', (event) => { window.__stickerContextMenuPrevented = event.defaultPrevented; }, true);
  });
  const cancelFrameBox = await iframe.boundingBox();
  assert.ok(cancelFrameBox);
  const cancelRequests = [];
  const groupPath = `/api/final-edit-groups/${fixture.groupId}`;
  const watchCancelRequests = (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === groupPath && (request.postData() || '').includes('"stickers"')) cancelRequests.push(request);
  };
  page.on('request', watchCancelRequests);
  await page.mouse.move(cancelFrameBox.x + cancelFrameBox.width / 2, cancelFrameBox.y + cancelFrameBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelFrameBox.x + cancelFrameBox.width / 2 + 70, cancelFrameBox.y + cancelFrameBox.height / 2 + 50, { steps: 6 });
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await page.waitForTimeout(350);
  page.off('request', watchCancelRequests);
  assert.equal(cancelRequests.length, 0, '右键取消空间拖拽不得产生保存请求');
  const afterCancel = await page.evaluate(async (groupId) => (await (await fetch(`/api/final-edit-groups/${groupId}`)).json()), fixture.groupId);
  assert.equal(afterCancel.revision, snappedResult.view.revision, '右键取消不得推进 revision');
  const cancelled = afterCancel.packaging.stickers.find((item) => item.id === second.id);
  assert.equal(cancelled.centerXPct, snapped.centerXPct);
  assert.equal(cancelled.centerYPct, snapped.centerYPct);
  const contextMenuPrevented = await contextFrame.evaluate(() => {
    const synthetic = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.dispatchEvent(synthetic);
    return window.__stickerContextMenuPrevented || synthetic.defaultPrevented;
  });
  assert.equal(contextMenuPrevented, true, '右键取消必须同时阻止浏览器右键菜单');
  const restoredStyle = await overlay.locator(`[data-sticker-id="${second.id}"]`).evaluate((element) => ({ left: element.style.left, top: element.style.top }));
  assert.equal(parseFloat(restoredStyle.left), snapped.centerXPct);
  assert.equal(parseFloat(restoredStyle.top), snapped.centerYPct);

  const propertyResult = await readPatch(async () => {
    const input = panel.getByLabel('中心 X', { exact: true });
    await input.fill('63.5');
    await input.press('Enter');
  });
  assert.equal(propertyResult.view.packaging.stickers.find((item) => item.id === second.id).centerXPct, 63.5, '属性区数值必须一次提交');

  const disabledResult = await readPatch(() => page.getByRole('switch', { name: '启用视频包装' }).click(), false);
  assert.equal(disabledResult.view.packaging.enabled, false);
  assert.equal(disabledResult.view.packaging.stickers.length, 2, '关闭包装不得删除贴纸');
  await eventually(async () => await page.locator('iframe[data-packaging-overlay]').count() === 0, '关闭包装后必须卸载 overlay');
  const reenabledResult = await readPatch(() => page.getByRole('switch', { name: '启用视频包装' }).click(), false);
  assert.equal(reenabledResult.view.packaging.stickers.length, 2, '重新开启包装必须原样恢复贴纸');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '确认本次混剪要用的素材' }).waitFor();
  await page.getByLabel('选择分镜组').selectOption(fixture.shotSetA);
  await page.locator(`[data-mixcut-shot-set-id="${fixture.shotSetA}"]`).waitFor();
  await page.getByRole('button', { name: /预览调整/ }).click();
  await page.locator('[data-track="video"]').waitFor();
  await page.getByRole('tab', { name: '贴纸', exact: true }).click();
  await panel.getByText('2 张已放置', { exact: true }).waitFor();
  const persisted = await page.evaluate(async (groupId) => {
    const response = await fetch(`/api/final-edit-groups/${groupId}`);
    const group = await response.json();
    return group.packaging.stickers;
  }, fixture.groupId);
  assert.equal(persisted.length, 2, '刷新后必须从服务端恢复全部贴纸');
  assert.equal(persisted.find((item) => item.id === second.id).centerXPct, 63.5);

  passed = true;
  console.log('贴纸编辑器真实 E2E 通过：双页签、115 张目录、分类搜索、点击/拖放、空间编辑、属性提交、包装开关与刷新恢复。');
} catch (error) {
  if (server) console.error(server.output());
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server.child);
  if (passed) {
    try { fs.rmSync(testDataRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
    catch { console.warn(`Windows 文件锁未释放，临时测试目录保留：${testDataRoot}`); }
  } else console.error(`临时测试数据保留供排查：${testDataRoot}`);
}
