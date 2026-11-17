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
  const second = secondAdd.view.packaging.stickers.find((item) => item.id !== first.id);
  assert.ok(Math.abs(second.centerXPct - 120 / frameBox.width * 100) < 1, `拖放 X 坐标错误：${second.centerXPct}`);
  assert.ok(Math.abs(second.centerYPct - 180 / frameBox.height * 100) < 1, `拖放 Y 坐标错误：${second.centerYPct}`);
  assert.equal(second.startFrame, Math.floor((first.startFrame + first.endFrame) / 2), '选中停在稳定中点后，新贴纸应从当前播放头添加');
  await eventually(async () => await overlay.locator('.packaging-sticker').count() === 2, '拖放后 overlay 必须出现第二张贴纸');
  await overlay.locator('[data-sticker-edit-ui]').waitFor();

  await eventually(async () => Number(await overlay.locator(`[data-sticker-id="${second.id}"]`).evaluate((element) => getComputedStyle(element).opacity)) === 1, '拖动前必须等到新贴纸处于稳定可见段');
  const moveFrameBox = await iframe.boundingBox();
  assert.ok(moveFrameBox);
  const moveStart = {
    x: moveFrameBox.x + second.centerXPct / 100 * moveFrameBox.width,
    y: moveFrameBox.y + second.centerYPct / 100 * moveFrameBox.height,
  };
  const moveEnd = { x: moveStart.x + 60, y: moveStart.y + 40 };
  const movedResult = await readPatch(async () => {
    await page.mouse.move(moveStart.x, moveStart.y);
    await page.mouse.down();
    await page.mouse.move(moveEnd.x, moveEnd.y, { steps: 8 });
    await page.mouse.up();
  });
  const moved = movedResult.view.packaging.stickers.find((item) => item.id === second.id);
  const expectedMoveX = (moveEnd.x - moveFrameBox.x) / moveFrameBox.width * 100;
  const expectedMoveY = (moveEnd.y - moveFrameBox.y) / moveFrameBox.height * 100;
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

  const stickerTrackToggle = page.locator('[aria-controls="mixcut-sticker-tracks"]');
  await stickerTrackToggle.click();
  assert.equal(await page.locator('[data-track="sticker"]').getAttribute('data-expanded'), 'false');
  assert.equal(await page.locator('[data-sticker-clip-id]').count(), 0, '收起轨道组后隐藏贴纸块但保留数据');
  await stickerTrackToggle.click();
  const timelineBlock = page.locator(`[data-sticker-clip-id="${second.id}"]`);
  await timelineBlock.waitFor();
  assert.equal(await page.locator('[data-sticker-clip-id]').count(), 2, '重叠贴纸必须分行显示');
  await eventually(async () => (await timelineBlock.innerText()).includes('好物来了'), '时间轴贴纸块必须显示中文素材名');
  assert.match(await page.locator(`[data-sticker-clip-id="${first.id}"]`).innerText(), /推荐/, '另一张贴纸也必须使用中文素材名');
  assert.equal(await timelineBlock.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(15, 118, 110)', '贴纸轨道必须使用固定青绿色');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.equal(await timelineBlock.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(45, 212, 191)', '深色模式必须使用对应贴纸轨道令牌');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.equal(await panel.getByText('当前贴纸', { exact: true }).count(), 0, '右栏不得再出现当前贴纸卡片');
  for (const label of ['中心 X', '中心 Y', '视觉宽度', '旋转', '素材风格']) {
    assert.equal(await panel.getByLabel(label, { exact: true }).count(), 0, `右栏不得再提供属性：${label}`);
  }
  assert.equal(await panel.getByRole('button', { name: '复制', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '删除', exact: true }).count(), 0);

  await page.getByRole('button', { name: '磁吸开', exact: true }).click();
  const beforeTimelineMove = afterCancel.packaging.stickers.find((item) => item.id === second.id);
  await timelineBlock.scrollIntoViewIfNeeded();
  let blockBox = await timelineBlock.boundingBox();
  assert.ok(blockBox);
  const timelineMovedResult = await readPatch(async () => {
    await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(blockBox.x + blockBox.width * 0.25 + 60, blockBox.y + blockBox.height / 2, { steps: 6 });
    await page.mouse.up();
  });
  const timelineMoved = timelineMovedResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.equal(timelineMoved.startFrame, beforeTimelineMove.startFrame + 24, '磁吸关闭时 60px 必须按 60px/s 移动 24 整帧');
  assert.equal(timelineMoved.endFrame, beforeTimelineMove.endFrame + 24);

  await page.getByRole('button', { name: '磁吸关', exact: true }).click();
  blockBox = await timelineBlock.boundingBox();
  assert.ok(blockBox);
  const timelineSnappedResult = await readPatch(async () => {
    await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(blockBox.x + blockBox.width * 0.25 - 113, blockBox.y + blockBox.height / 2, { steps: 6 });
    await page.getByTestId('sticker-time-snap-line').waitFor({ state: 'visible' });
    await page.mouse.up();
  });
  const timelineSnapped = timelineSnappedResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.equal(timelineSnapped.startFrame, first.startFrame, '磁吸开启后必须吸附到其他贴纸起点');
  assert.equal(timelineSnapped.endFrame, first.endFrame);

  await page.getByRole('button', { name: '磁吸开', exact: true }).click();
  const trimHandle = timelineBlock.locator('[aria-label="修剪贴纸结尾"]');
  const trimBox = await trimHandle.boundingBox();
  assert.ok(trimBox);
  const timelineTrimmedResult = await readPatch(async () => {
    await page.mouse.move(trimBox.x + trimBox.width / 2, trimBox.y + trimBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(trimBox.x + trimBox.width / 2 + 30, trimBox.y + trimBox.height / 2, { steps: 5 });
    await page.mouse.up();
  });
  const timelineTrimmed = timelineTrimmedResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.equal(timelineTrimmed.startFrame, timelineSnapped.startFrame, '修剪结尾不得改变起点');
  assert.equal(timelineTrimmed.endFrame, timelineSnapped.endFrame + 12, '修剪必须按整帧提交');

  const sourceTrack = timelineTrimmed.trackIndex;
  const targetTrack = sourceTrack === 0 ? 1 : 0;
  blockBox = await timelineBlock.boundingBox();
  assert.ok(blockBox);
  const reorderedResult = await readPatch(async () => {
    await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2 + (targetTrack - sourceTrack) * 28, { steps: 6 });
    await page.getByTestId('sticker-track-insert-line').waitFor({ state: 'visible' });
    await page.getByTestId('sticker-track-placeholder').waitFor({ state: 'visible' });
    assert.equal(await page.locator(`[data-sticker-lane="${targetTrack}"]`).getAttribute('data-drop-target'), 'true', '换轨必须高亮目标轨');
    await page.mouse.up();
  });
  const reordered = reorderedResult.view.packaging.stickers.find((item) => item.id === second.id);
  assert.equal(reordered.trackIndex, targetTrack, '上下拖动必须改变轨道层级');
  assert.equal(reordered.startFrame, timelineTrimmed.startFrame, '换轨不得改变开始帧');
  assert.equal(reordered.endFrame, timelineTrimmed.endFrame, '换轨不得改变时长');
  const reorderedFirst = reorderedResult.view.packaging.stickers.find((item) => item.id === first.id);
  await eventually(async () => {
    const secondZ = await overlay.locator(`[data-sticker-id="${second.id}"]`).evaluate((element) => Number(element.style.zIndex));
    const firstZ = await overlay.locator(`[data-sticker-id="${first.id}"]`).evaluate((element) => Number(element.style.zIndex));
    return secondZ === 1000 - reordered.trackIndex && firstZ === 1000 - reorderedFirst.trackIndex;
  }, 'overlay 层级必须与时间轴轨道顺序一致');

  await eventually(async () => await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), '换轨保存后撤销必须可用');
  const undoTrackResult = await readPatch(() => page.keyboard.press('Control+z'), false);
  assert.equal(undoTrackResult.request.type, 'restore_packaging_revision');
  assert.equal(undoTrackResult.view.packaging.stickers.find((item) => item.id === second.id).trackIndex, sourceTrack, '一次撤销必须恢复整个换轨操作');
  const redoTrackResult = await readPatch(() => page.keyboard.press('Control+Shift+z'), false);
  assert.equal(redoTrackResult.request.type, 'restore_packaging_revision');
  assert.equal(redoTrackResult.view.packaging.stickers.find((item) => item.id === second.id).trackIndex, targetTrack, '重做必须恢复换轨后的层级');

  const beforeTimelineCancel = redoTrackResult.view.packaging.stickers.find((item) => item.id === second.id);
  blockBox = await timelineBlock.boundingBox();
  assert.ok(blockBox);
  const timelineCancelRequests = [];
  const watchTimelineCancelRequests = (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === groupPath && (request.postData() || '').includes('"stickers"')) timelineCancelRequests.push(request);
  };
  page.on('request', watchTimelineCancelRequests);
  await page.mouse.move(blockBox.x + blockBox.width * 0.25, blockBox.y + blockBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(blockBox.x + blockBox.width * 0.25 + 60, blockBox.y + blockBox.height / 2 + (beforeTimelineCancel.trackIndex === 0 ? 28 : -28), { steps: 6 });
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await page.waitForTimeout(350);
  page.off('request', watchTimelineCancelRequests);
  assert.equal(timelineCancelRequests.length, 0, `右键取消时间轴拖拽不得产生保存请求：${timelineCancelRequests.map((request) => request.postData()).join('\n')}`);
  const afterTimelineCancel = await page.evaluate(async (groupId) => (await (await fetch(`/api/final-edit-groups/${groupId}`)).json()), fixture.groupId);
  assert.equal(afterTimelineCancel.revision, redoTrackResult.view.revision, '右键取消时间轴拖拽不得推进 revision');
  const cancelledTimelineSticker = afterTimelineCancel.packaging.stickers.find((item) => item.id === second.id);
  assert.deepEqual(
    { startFrame: cancelledTimelineSticker.startFrame, endFrame: cancelledTimelineSticker.endFrame, trackIndex: cancelledTimelineSticker.trackIndex },
    { startFrame: beforeTimelineCancel.startFrame, endFrame: beforeTimelineCancel.endFrame, trackIndex: beforeTimelineCancel.trackIndex },
    '右键取消必须同时恢复时间和层级',
  );
  const timelineContextMenuPrevented = await page.evaluate(() => {
    const synthetic = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.dispatchEvent(synthetic);
    return synthetic.defaultPrevented;
  });
  assert.equal(timelineContextMenuPrevented, true, '时间轴右键取消必须阻止浏览器原生菜单');

  const copyRequests = [];
  const watchCopyRequests = (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === groupPath) copyRequests.push(request);
  };
  page.on('request', watchCopyRequests);
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(350);
  page.off('request', watchCopyRequests);
  assert.equal(copyRequests.length, 0, 'Ctrl+D 不得再复制或产生保存请求');
  const afterCopyAttempt = await page.evaluate(async (groupId) => (await (await fetch(`/api/final-edit-groups/${groupId}`)).json()), fixture.groupId);
  assert.equal(afterCopyAttempt.packaging.stickers.length, 2);
  assert.equal(afterCopyAttempt.revision, afterTimelineCancel.revision);

  await overlay.locator('[data-sticker-delete]').waitFor();
  const deletedResult = await readPatch(() => overlay.locator('[data-sticker-delete]').click({ force: true }));
  assert.equal(deletedResult.view.packaging.stickers.length, 1, '预览调整框删除按钮必须删除当前贴纸');
  assert.equal(deletedResult.view.packaging.stickers[0].id, first.id);

  await eventually(async () => await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), '删除后撤销必须可用');
  const undoDeleteResult = await readPatch(() => page.keyboard.press('Control+z'), false);
  assert.equal(undoDeleteResult.view.packaging.stickers.length, 2, '一次撤销必须恢复被删除贴纸');
  const redoDeleteResult = await readPatch(() => page.keyboard.press('Control+Shift+z'), false);
  assert.equal(redoDeleteResult.view.packaging.stickers.length, 1, '重做必须再次删除当前贴纸');
  const restoredForAnimationResult = await readPatch(() => page.keyboard.press('Control+z'), false);
  assert.equal(restoredForAnimationResult.view.packaging.stickers.length, 2, '后续动效测试前恢复两张贴纸');

  const defaultAnimationTrigger = panel.getByRole('button', { name: /^预览动效 / }).first();
  await defaultAnimationTrigger.click();
  const animationDialog = page.getByRole('dialog', { name: '选择贴纸动效' });
  await animationDialog.waitFor();
  assert.equal(await animationDialog.locator('[data-animation-card]').count(), 6, '浮窗必须同时展示六张动效卡');
  assert.equal(Math.round((await animationDialog.boundingBox()).width), 206, '动效浮窗宽度必须为 206px');
  const demoStates = await animationDialog.locator('[data-animation-demo]').evaluateAll((images) => images.map((image) => ({
    src: image.getAttribute('src'),
    animationName: getComputedStyle(image).animationName,
    iterations: getComputedStyle(image).animationIterationCount,
  })));
  assert.ok(demoStates.every((state) => state.src === '/api/packaging/stickers/show/highlight.png'), '所有示例必须使用固定 show/highlight 原图');
  assert.ok(demoStates.filter((state) => state.animationName !== 'none').every((state) => state.iterations === 'infinite'), '五张动态示例必须同时循环');
  await page.getByRole('button', { name: '关闭动效选择' }).click();
  assert.equal(await animationDialog.count(), 0);
  assert.equal(await page.locator('[data-animation-demo]').count(), 0, '关闭浮窗必须卸载并停止示例动画');
  await defaultAnimationTrigger.click();
  await animationDialog.waitFor();
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await animationDialog.waitFor({ state: 'detached' }, '点击浮窗外部必须关闭');

  const defaultAnimationResult = await readPatch(async () => {
    await defaultAnimationTrigger.click();
    await animationDialog.getByRole('button', { name: '选择动效 上浮', exact: true }).click();
  }, false);
  assert.equal(defaultAnimationResult.view.packaging.stickerDefaults.animation, 'rise');
  assert.ok(defaultAnimationResult.view.packaging.stickers.every((item) => item.animation === 'follow-template'), '修改默认动效不得暗改已有贴纸');
  assert.equal(await animationDialog.count(), 0, '选择动效后浮窗必须关闭');

  const idsBeforeAnimationAdd = new Set(defaultAnimationResult.view.packaging.stickers.map((item) => item.id));
  const animationAddResult = await readPatch(() => panel.getByRole('button', { name: '添加贴纸 推荐', exact: true }).click());
  const animationAdded = animationAddResult.view.packaging.stickers.find((item) => !idsBeforeAnimationAdd.has(item.id));
  assert.equal(animationAdded.animation, 'rise', '新增贴纸必须复制当前统一动效');
  const animationAddDeleteResult = await readPatch(() => page.keyboard.press('Delete'));
  assert.equal(animationAddDeleteResult.view.packaging.stickers.length, 2);

  await timelineBlock.click({ position: { x: 20, y: 10 } });
  await panel.getByText(/动效 · 当前贴纸（/).waitFor();
  assert.equal(await panel.getByRole('button', { name: '取消选中', exact: true }).count(), 0, '不得提供额外的取消选中按钮');
  await overlay.locator('#root').click({ position: { x: 6, y: 6 }, force: true });
  await panel.getByText('动效 · 新贴纸默认', { exact: true }).waitFor();
  await timelineBlock.click({ position: { x: 20, y: 10 } });
  const selectedAnimationTrigger = panel.getByRole('button', { name: /^预览动效 / }).last();
  const singleAnimationResult = await readPatch(async () => {
    await selectedAnimationTrigger.click();
    await animationDialog.getByRole('button', { name: '选择动效 滑入', exact: true }).click();
  });
  assert.equal(singleAnimationResult.view.packaging.stickers.find((item) => item.id === second.id).animation, 'slide', '单张覆盖必须只修改当前贴纸');
  assert.equal(singleAnimationResult.view.packaging.stickers.find((item) => item.id === first.id).animation, 'follow-template');
  await eventually(async () => await page.getByRole('button', { name: '暂停', exact: true }).count() === 1, '选择单张动效后必须从起点播放一次实际效果');
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /重置这些覆盖/);
    await dialog.accept();
  });
  const applyAllButton = panel.getByRole('button', { name: '应用到全部贴纸', exact: true });
  assert.equal(await applyAllButton.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(0, 113, 227)', '应用全部必须是醒目的实心主按钮');
  const applyAllAnimationResult = await readPatch(() => applyAllButton.click());
  assert.ok(applyAllAnimationResult.view.packaging.stickers.every((item) => item.animation === 'slide'), '选中贴纸时，应用全部必须使用当前动效区的值');
  await eventually(async () => await page.getByRole('button', { name: '暂停', exact: true }).count() === 1, '应用全部后必须播放实际贴纸效果');
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  const individualAfterAllResult = await readPatch(async () => {
    await selectedAnimationTrigger.click();
    await animationDialog.getByRole('button', { name: '选择动效 缩放', exact: true }).click();
  });
  assert.equal(individualAfterAllResult.view.packaging.stickers.find((item) => item.id === second.id).animation, 'zoom', '应用全部后必须仍能覆盖单张动效');
  assert.equal(individualAfterAllResult.view.packaging.stickers.find((item) => item.id === first.id).animation, 'slide', '单张覆盖不得改动其他贴纸');
  await eventually(async () => {
    const frame = page.frames().find((item) => item.url().includes('packaging-preview') && item.url().includes('format=html'));
    if (!frame) return false;
    return frame.evaluate((id) => {
      const vars = window.compositionVariables || window.__hyperframes?.getVariables?.() || {};
      const sticker = (vars.stickers || []).find((item) => item.id === id);
      return sticker?.animation === 'zoom' && Boolean(window.__timelines?.overlay);
    }, second.id);
  }, '预览必须加载单张修改后的新时间线，而不是继续播放旧动效');
  await eventually(async () => await page.getByRole('button', { name: '暂停', exact: true }).count() === 1, '应用全部后的单张修改必须播放新动效');
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  const autoBodyFrames = individualAfterAllResult.view.variants.find((item) => item.id === fixture.variantId).timeline.bodyFrames;
  assert.ok(autoBodyFrames >= 144, '自动布置验收 fixture 正文必须至少 6 秒');
  const autoLayoutResult = await readPatch(() => panel.getByRole('button', { name: '一键基础布置', exact: true }).click());
  assert.equal(autoLayoutResult.view.packaging.stickers.length, 8, '首次自动布置必须新增 6 张并保留 2 张手动贴纸');
  const automatic = autoLayoutResult.view.packaging.stickers.filter((item) => item.origin.kind === 'auto');
  assert.equal(automatic.length, 6);
  const autoGroupId = automatic[0].origin.autoGroupId;
  assert.ok(automatic.every((item) => item.origin.autoGroupId === autoGroupId && item.origin.autoEdited === false));
  assert.ok(automatic.every((item) => item.animation === 'rise'), '自动实例必须继承生成时的统一动效');
  assert.ok(automatic.every((item) => item.startFrame >= 20 && item.endFrame <= 20 + autoBodyFrames));
  for (let index = 1; index < automatic.length; index += 1) assert.ok(automatic[index].startFrame >= automatic[index - 1].endFrame, '自动布置六张默认不得时间重叠');
  for (const manual of [first, second]) {
    const retained = autoLayoutResult.view.packaging.stickers.find((item) => item.id === manual.id);
    assert.equal(retained.origin.kind, 'manual');
    assert.equal(retained.centerXPct, applyAllAnimationResult.view.packaging.stickers.find((item) => item.id === manual.id).centerXPct);
  }
  await panel.getByRole('button', { name: '换一组基础贴纸', exact: true }).waitFor();
  await eventually(async () => await page.getByRole('button', { name: '撤销', exact: true }).isEnabled(), '自动布置后撤销必须可用');
  const undoAutoLayoutResult = await readPatch(() => page.keyboard.press('Control+z'), false);
  assert.equal(undoAutoLayoutResult.view.packaging.stickers.length, 2, '一次撤销必须恢复自动布置前的手动贴纸');
  const redoAutoLayoutResult = await readPatch(() => page.keyboard.press('Control+Shift+z'), false);
  assert.equal(redoAutoLayoutResult.view.packaging.stickers.length, 8, '一次重做必须恢复完整自动组合');

  const editedAuto = automatic[0];
  const editedAutoBlock = page.locator(`[data-sticker-clip-id="${editedAuto.id}"]`);
  await editedAutoBlock.click({ position: { x: 20, y: 10 } });
  const autoTrimHandle = editedAutoBlock.locator('[aria-label="修剪贴纸结尾"]');
  const autoTrimBox = await autoTrimHandle.boundingBox();
  assert.ok(autoTrimBox);
  const autoEditResult = await readPatch(async () => {
    await page.mouse.move(autoTrimBox.x + autoTrimBox.width / 2, autoTrimBox.y + autoTrimBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(autoTrimBox.x + autoTrimBox.width / 2 - 30, autoTrimBox.y + autoTrimBox.height / 2, { steps: 5 });
    await page.mouse.up();
  });
  assert.equal(autoEditResult.view.packaging.stickers.find((item) => item.id === editedAuto.id).origin.autoEdited, true, '编辑自动实例必须设置保护标记');
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /重置这些调整/);
    await dialog.accept();
  });
  const replacedAutoResult = await readPatch(() => panel.getByRole('button', { name: '换一组基础贴纸', exact: true }).click());
  assert.equal(replacedAutoResult.view.packaging.stickers.length, 8, '换一组不得叠加为 12 张');
  const replacedAutomatic = replacedAutoResult.view.packaging.stickers.filter((item) => item.origin.kind === 'auto');
  assert.equal(replacedAutomatic.length, 6);
  const replacedGroupId = replacedAutomatic[0].origin.autoGroupId;
  assert.notEqual(replacedGroupId, autoGroupId);
  assert.ok(replacedAutomatic.every((item) => item.origin.autoGroupId === replacedGroupId && item.origin.autoEdited === false));
  assert.equal(replacedAutomatic.some((item) => item.id === editedAuto.id), false, '换一组必须替换已编辑自动实例');
  assert.equal(replacedAutoResult.view.packaging.stickers.filter((item) => item.origin.kind === 'manual').length, 2, '换一组必须保留手动贴纸');
  const undoReplaceResult = await readPatch(() => page.keyboard.press('Control+z'), false);
  assert.equal(undoReplaceResult.view.packaging.stickers.find((item) => item.id === editedAuto.id).origin.autoEdited, true, '一次撤销必须恢复换一组前的已编辑组合');
  const redoReplaceResult = await readPatch(() => page.keyboard.press('Control+Shift+z'), false);
  assert.equal(redoReplaceResult.view.packaging.stickers.filter((item) => item.origin.kind === 'auto')[0].origin.autoGroupId, replacedGroupId);

  let afterAutoDeleteResult = redoReplaceResult;
  const replacedAutoIds = replacedAutomatic.map((item) => item.id);
  for (const stickerId of replacedAutoIds) {
    const autoBlock = page.locator(`[data-sticker-clip-id="${stickerId}"]`);
    await autoBlock.click({ position: { x: 20, y: 10 } });
    await eventually(async () => await autoBlock.getAttribute('data-selected') === 'true', '删除前必须等待选中与保存队列就绪');
    afterAutoDeleteResult = await readPatch(() => page.keyboard.press('Delete'));
  }
  assert.equal(afterAutoDeleteResult.view.packaging.stickers.length, 2, '删除全部自动实例后只保留手动贴纸');
  assert.equal(afterAutoDeleteResult.view.packaging.stickers.every((item) => item.origin.kind === 'manual'), true);
  await panel.getByRole('button', { name: '一键基础布置', exact: true }).waitFor();

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
  assert.equal(persisted.find((item) => item.id === second.id).centerXPct, beforeTimelineCancel.centerXPct);

  passed = true;
  console.log('贴纸编辑器真实 E2E 通过：素材目录、空间编辑、时间轴与历史、六卡动效浮窗、统一/单张/全部设置、自动 6 张与换一组、实际播放、包装开关与刷新恢复。');
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
