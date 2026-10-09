#!/usr/bin/env node
/**
 * 创作画布浏览器验收（验收清单 T3）。
 *
 * 用法：
 *   node scripts/creative-canvas.playwright.test.mjs --suite editor
 *   node scripts/creative-canvas.playwright.test.mjs --suite execution
 *   node scripts/creative-canvas.playwright.test.mjs --suite all
 *
 * 前置：先执行 `npm run build`（harness 直接启动 .next/standalone/server.js）。
 *
 * 长时间观察（performance 套件）在 macOS 上必须用 caffeinate 运行，否则后台进程会被
 * App Nap 冻结（心跳出现规律的 15 秒空洞），测到的是「进程被挂起」而不是产品表现：
 *   caffeinate -dimsu node scripts/creative-canvas.playwright.test.mjs --suite performance
 * harness 自身检测到心跳空洞时会把空洞单独记录，不当作产品停顿。
 *
 * 隔离约定（验收清单 §1）：
 * - 自建临时数据根、空闲回环端口与 fixture 执行器；
 * - 不调用 npm run dev／npm run start／.command，也不 source canvas-profile.sh；
 * - 不继承真实供应商凭据，不连接 3100／4100 上可能存在的实例。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { configuredCanvasImages } from '../lib/creative-canvas/adapters/configured-images.ts';
import { configuredCanvasVideos } from '../lib/creative-canvas/adapters/configured-videos.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { directSeedanceCapability } from '../lib/creative-canvas/adapters/seedance-capabilities.ts';
import { SEEDANCE_20, SEEDANCE_25 } from '../lib/video-providers/seedance-contract.ts';

const SUITES = ['interaction', 'editor', 'execution', 'recovery', 'export', 'performance', 'legacy', 'regression', 'seedance', 'all'];
const IMPLEMENTED_SUITES = ['interaction', 'editor', 'execution', 'recovery', 'export', 'performance', 'legacy', 'regression', 'seedance'];

const suiteArgIndex = process.argv.indexOf('--suite');
const suite = suiteArgIndex >= 0 ? process.argv[suiteArgIndex + 1] : 'all';
if (!suite || !SUITES.includes(suite)) {
  console.error(`用法：node scripts/creative-canvas.playwright.test.mjs --suite ${SUITES.join('|')}`);
  process.exit(2);
}
const requested = suite === 'all' ? SUITES.filter((name) => name !== 'all') : [suite];
const unimplemented = requested.filter((name) => !IMPLEMENTED_SUITES.includes(name));
if (unimplemented.length > 0) {
  console.error(`以下 suite 尚未实现，未执行（不视为通过）：${unimplemented.join('、')}`);
  console.error('已实现：editor、execution（P3）、recovery（P5）、export、performance、legacy（P6）、regression。');
  process.exit(2);
}

const repoRoot = process.cwd();
const standaloneServer = path.join(repoRoot, '.next', 'standalone', 'server.js');
if (!fs.existsSync(standaloneServer)) {
  console.error('缺少 .next/standalone/server.js：请先运行 npm run build。');
  process.exit(2);
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-ui-'));
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-ui-fixtures-'));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** 只保留运行必需的变量：真实供应商凭据不进测试子进程。 */
function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API_KEY|_KEY$|SECRET|COS_|TOKEN/i.test(key)) delete env[key];
  }
  return env;
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput = [];
let server = null;

function baseServerEnv(extra = {}) {
  return {
    ...sanitizedEnv(),
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    CREATIVE_STUDIO_DATA_ROOT: dataRoot,
    CREATIVE_STUDIO_CANVAS_ENABLE: '1',
    CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
    CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
    // 让任务有「确实在运行」的窗口，验证运行时仍可编辑
    CREATIVE_STUDIO_CANVAS_FIXTURE_DELAY_MS: '800',
    CREATIVE_STUDIO_CANVAS_FIXTURE_POLLS: '3',
    ...extra,
  };
}

async function stopServer() {
  if (!server) return;
  const current = server;
  server = null;
  current.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      current.kill('SIGKILL');
      resolve(undefined);
    }, 5_000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    // 有界等待：即使子进程没退出也不阻塞收尾
    setTimeout(resolve, 8_000);
  });
}

/**
 * 全局看门狗：性能套件要跑几分钟，任何一步卡住都必须能让进程退出并留下证据，
 * 不能像上一次那样挂住两小时。
 */
const WATCHDOG_MS = Number(process.env.CANVAS_SUITE_TIMEOUT_MS ?? String((Number(process.env.CANVAS_PERF_SECONDS ?? '300') + 600) * 1000));
const watchdog = setTimeout(() => {
  console.error(`看门狗触发：${Math.round(WATCHDOG_MS / 1000)} 秒内没有结束，强制退出。`);
  console.error(serverOutput.join('').split('\n').slice(-20).join('\n'));
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server && server.exitCode !== null) {
      throw new Error(`画布服务提前退出 exit=${server.exitCode}\n${serverOutput.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/canvas`);
      if (response.ok) return;
      if (response.status === 503) {
        throw new Error(`画布 API 不可用：${await response.text()}\n${serverOutput.join('')}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('画布 API')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`画布服务未在 30 秒内就绪\n${serverOutput.join('')}`);
}

async function startServer(extraEnv = {}) {
  // 先卸载上一套件的轮询页面，再重启 fixture，避免主动停服被误记成产品网络错误。
  if (page && !page.isClosed()) await page.goto('about:blank');
  await stopServer();
  server = spawn(process.execPath, [standaloneServer], {
    cwd: repoRoot,
    env: baseServerEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  await waitForServer();
}

// --- 页面辅助 ---------------------------------------------------------------

const runPosts = [];
const expectedHttpErrors = [];

function expectHttpError(url, method, status = 409, errorCode = 'conflict') {
  const expectation = {
    url,
    method,
    status,
    errorCode,
    matches: 0,
    bodyMatches: 0,
    consoleAllowance: 0,
  };
  expectedHttpErrors.push(expectation);
  return expectation;
}

async function assertExpectedHttpError(expectation, label) {
  for (let attempt = 0; attempt < 40 && (expectation.matches < 1 || expectation.bodyMatches < 1); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(expectation.matches, 1, `${label} 应精确命中一次 ${expectation.method} ${expectation.url} ${expectation.status}`);
  assert.equal(expectation.bodyMatches, 1, `${label} 响应应包含 error=${expectation.errorCode}`);
  const index = expectedHttpErrors.indexOf(expectation);
  if (index >= 0) expectedHttpErrors.splice(index, 1);
}

function trackRunRequests(page) {
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/canvas\/[^/]+\/runs$/.test(new URL(request.url()).pathname)) {
      runPosts.push(request.url());
    }
    if (request.method() === 'POST' && /\/api\/canvas\/[^/]+\/plan$/.test(new URL(request.url()).pathname)) {
      runPosts.push(request.url());
    }
  });
}

/** 选中节点：用 DOM 事件而不是 Playwright click —— 高负载下节点持续重渲染，
 * 可操作性／稳定性检查会一直等不到「稳定」，直接把用例拖到超时。 */
/**
 * 等节点出结果。媒体是按视口加载的（50 节点时视口外不请求），
 * 所以先等「当前结果身份」出现，再适配视图把媒体拉进视口。
 */
async function waitForResult(page, nodeId, mediaKind = 'image', timeout = 30_000) {
  await page.waitForSelector(
    `.react-flow__node[data-id="${nodeId}"] [data-canvas-result]`,
    { timeout },
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="fit-view"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // 结果大图已不在生成节点内：等物化素材节点把这份产物渲染出来
  const assetId = await nodeAttribute(page, nodeId, 'data-canvas-result');
  if (assetId) {
    await page.waitForSelector(
      `.react-flow__node:has([data-node-kind="material"]) ${mediaKind === 'video' ? 'video' : 'img'}[src*="${assetId}"]`,
      { timeout },
    );
  }
}

async function selectNode(page, nodeId) {
  await page.evaluate((id) => {
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!node) return;
    // 先把焦点从输入框移开：焦点在文本框时 Cmd+C/V 会被当成文本复制，
    // 画布的复制粘贴快捷键不会触发。
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (node instanceof HTMLElement) node.focus();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, nodeId);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function nodeIds(page, kind) {
  return page.$$eval(
    `.react-flow__node:has([data-node-kind="${kind}"])`,
    (elements) => elements.map((element) => element.getAttribute('data-id')),
  );
}

async function soleNodeId(page, kind) {
  const ids = await nodeIds(page, kind);
  assert.equal(ids.length, 1, `期望恰好一个 ${kind} 节点，实际 ${ids.length}`);
  return ids[0];
}

async function handleBox(page, nodeId, type) {
  const selector = `.react-flow__node[data-id="${nodeId}"] .react-flow__handle.${type}`;
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `找不到 ${nodeId} 的 ${type} 手柄`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function connect(page, sourceId, targetId) {
  const from = await handleBox(page, sourceId, 'source');
  const to = await handleBox(page, targetId, 'target');
  if (process.env.CANVAS_DEBUG === '1') {
    const nodeBoxes = await page.$$eval('.react-flow__node', (els) => els.map((e) => ({
      id: e.getAttribute('data-id'),
      box: e.getBoundingClientRect().toJSON(),
    })));
    console.log('[debug] connect', sourceId, from, '->', targetId, to, JSON.stringify(nodeBoxes));
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/** 从输出端拉线到空白处松手：用于验证落点菜单。 */
async function dragToEmpty(page, sourceId, offset = { x: 240, y: 160 }) {
  const from = await handleBox(page, sourceId, 'source');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + offset.x, from.y + offset.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function waitSaved(page) {
  // 先让自动保存的防抖窗口过去，再等「已保存」，避免读到还在内存里的草稿
  await page.waitForTimeout(750);
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="save-state"]');
    return element && element.textContent?.includes('已保存');
  }, null, { timeout: 15_000 });
}

async function addNode(page, kind) {
  const before = await nodeIds(page, kind);
  await page.click(`[data-testid="add-${kind}"]`);
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length > count,
    { selector: `.react-flow__node:has([data-node-kind="${kind}"])`, count: before.length },
  );
  // 新增节点后适配视图，保证手柄都在可点击范围内（也是界面上的真实操作）
  await page.click('[data-testid="fit-view"]');
  await page.waitForTimeout(350);
  const after = await nodeIds(page, kind);
  return after.find((id) => !before.includes(id));
}

async function createCanvas(page, name) {
  await page.goto(`${baseUrl}/canvas`);
  await page.fill('[data-testid="new-canvas-name"]', name);
  await page.click('[data-testid="create-canvas-button"]');
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 0);
  return new URL(page.url()).pathname.split('/').pop();
}

async function addMaterialWithImage(page, fixturePath) {
  const nodeId = await addNode(page, 'material');
  await page.setInputFiles(
    `.react-flow__node[data-id="${nodeId}"] [data-testid="material-file-input"]`,
    fixturePath,
    { force: true },
  );
  await page.waitForSelector(`.react-flow__node[data-id="${nodeId}"] img`, { timeout: 15_000 });
  return nodeId;
}

async function selectModel(page, nodeId, capabilityKey) {
  await page.selectOption(`.react-flow__node[data-id="${nodeId}"] [data-testid="model-select"]`, capabilityKey);
}

async function fillPrompt(page, nodeId, text) {
  const selector = `.react-flow__node[data-id="${nodeId}"] [data-testid="generation-prompt"]`;
  await page.fill(selector, text);
  await page.locator(selector).blur();
}

async function fillTextPrompt(page, nodeId, text) {
  const selector = `.react-flow__node[data-id="${nodeId}"] [data-testid="prompt-text"]`;
  await page.fill(selector, text);
  await page.locator(selector).blur();
}

async function nodeAttribute(page, nodeId, attribute) {
  const locator = page.locator(`.react-flow__node[data-id="${nodeId}"] [${attribute}]`).first();
  // 不等待：元素不存在时要立刻返回 null（调用方先用 waitForSelector 等结果出现）
  if (await locator.count() === 0) return null;
  return locator.getAttribute(attribute);
}

async function surfaceBox(page) {
  const box = await page.locator('[data-testid="canvas-surface"]').boundingBox();
  assert.ok(box, '找不到画布区域');
  return box;
}

async function readViewportTransform(page) {
  const style = await page.locator('.react-flow__viewport').getAttribute('style');
  assert.ok(style, '找不到 React Flow 视口样式');
  const match = style.match(/translate\(([-+\d.]+)px,\s*([-+\d.]+)px\)\s*scale\(([-+\d.]+)\)/);
  assert.ok(match, `无法解析视口变换：${style}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

function assertViewportClose(actual, expected, message) {
  assert.ok(Math.abs(actual.x - expected.x) < 1, `${message} x=${actual.x} expected=${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1, `${message} y=${actual.y} expected=${expected.y}`);
  assert.ok(Math.abs(actual.zoom - expected.zoom) < 0.01, `${message} zoom=${actual.zoom} expected=${expected.zoom}`);
}

async function dropFileOnCanvas(page, filePath, fileName, point) {
  const dataTransfer = await page.evaluateHandle(async ({ base64, name }) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const blob = await response.blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], name, { type: 'image/png' }));
    return transfer;
  }, { base64: fs.readFileSync(filePath).toString('base64'), name: fileName });
  const box = await surfaceBox(page);
  await page.dispatchEvent('[data-testid="canvas-surface"]', 'drop', {
    dataTransfer,
    clientX: box.x + (point?.x ?? 60),
    clientY: box.y + (point?.y ?? 60),
  });
  await page.waitForTimeout(400);
}

/**
 * 用真实 PATCH 接口给节点设定固定坐标后刷新页面。
 * 直接依赖界面拖拽做布局会让「谁盖在谁上面」变得不确定，拖拽本身另有独立用例。
 */
async function applyLayout(page, positions) {
  // 先把客户端未落盘的编辑保存掉，否则会按旧图重写并丢掉刚才的修改
  await waitSaved(page);
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  const result = await page.evaluate(async ({ id, layout }) => {
    const current = await (await fetch(`/api/canvas/${id}`)).json();
    const graph = current.canvas.graph;
    const missing = Object.keys(layout).filter((id) => !graph.nodes.some((node) => node.id === id));
    if (missing.length > 0) return { status: 0, body: { error: 'layout_nodes_missing', missing } };
    graph.nodes = graph.nodes.map((node) => (layout[node.id] ? { ...node, position: layout[node.id] } : node));
    const response = await fetch(`/api/canvas/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedGraphRevision: current.canvas.graphRevision, graph }),
    });
    return { status: response.status, body: await response.json() };
  }, { id: canvasId, layout: positions });
  assert.equal(result.status, 200, `布局保存失败：${JSON.stringify(result.body)}`);
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count,
    Object.keys(positions).length);
  await page.click('[data-testid="fit-view"]');
  await page.waitForTimeout(300);
}

async function nodeBox(page, nodeId) {
  const box = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).first().boundingBox();
  assert.ok(box, `找不到节点 ${nodeId}`);
  return box;
}

/** 节点在画布坐标系里的位置（与缩放无关，直接反映保存的编辑定义）。 */
async function nodePosition(page, nodeId) {
  const value = await page.locator(`.react-flow__node[data-id="${nodeId}"] [data-node-position]`).first()
    .getAttribute('data-node-position');
  assert.ok(value, `找不到节点 ${nodeId} 的位置`);
  return value;
}

/** 按拖拽把手把节点移到指定位置（画布区域内的相对坐标）。 */
async function moveNode(page, nodeId, point) {
  const box = await surfaceBox(page);
  const handle = await page.locator(`.react-flow__node[data-id="${nodeId}"] [data-testid="node-drag-handle"]`).first().boundingBox();
  assert.ok(handle, `找不到 ${nodeId} 的拖拽把手`);
  const nodeBox = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).first().boundingBox();
  assert.ok(nodeBox);
  assert.ok(
    handle.y > box.y && handle.y + handle.height < box.y + box.height
    && handle.x > box.x && handle.x + handle.width < box.x + box.width,
    `${nodeId} 的拖拽把手不在画布可视区域内：handle=${JSON.stringify(handle)} surface=${JSON.stringify(box)}`,
  );
  const deltaX = box.x + point.x - nodeBox.x;
  const deltaY = box.y + point.y - nodeBox.y;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + deltaX, handle.y + handle.height / 2 + deltaY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

// --- 用例 -------------------------------------------------------------------

async function interactionSuite(page) {
  // Capability-only fixture for switching to a taller parameter form; never submit a task.
  await page.route('**/api/canvas/models', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, models: [...value.models, directSeedanceCapability(SEEDANCE_25)] } });
  });
  const assertActionsVisible = async (node) => {
    const bounds = await node.evaluate((element) => {
      const card = element.querySelector('.sc-canvas-node').getBoundingClientRect();
      const wrapper = element.getBoundingClientRect();
      const body = element.querySelector('.sc-canvas-node-body').getBoundingClientRect();
      const action = element.querySelector('[data-testid="run-node"]').getBoundingClientRect();
      return { card: card.toJSON(), wrapper: wrapper.toJSON(), body: body.toJSON(), action: action.toJSON() };
    });
    for (const area of [bounds.card, bounds.wrapper, bounds.body]) {
      assert.ok(bounds.action.top >= area.top && bounds.action.bottom <= area.bottom + 1,
        `缩小后生成按钮必须直接可见，不能依赖滚动：${JSON.stringify(bounds)}`);
    }
  };
  const results = [];
  for (const kind of ['prompt', 'image-generation', 'video-generation']) {
    const canvasId = await createCanvas(page, `滚动与拉伸-${kind}`);
    const id = await addNode(page, kind);
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    if (kind !== 'prompt') await selectModel(page, id, kind === 'image-generation' ? 'fixture-image-edit' : 'fixture-video');
    await page.click('[data-testid="fit-view"]');
    await page.waitForTimeout(300);
    const input = node.locator('textarea');
    await input.fill(Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行：查看完整提示词内容`).join('\n'));
    await input.blur();
    await input.evaluate((element) => { element.scrollTop = 0; });
    const viewport = await readViewportTransform(page);
    await input.hover();
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(300);
    assert.ok(await input.evaluate((element) => element.scrollTop > 0), '双指滚动必须滚动文字');
    assertViewportClose(await readViewportTransform(page), viewport, '文字滚动不得缩放或平移画布');
    for (const end of [true, false]) {
      await input.evaluate((element, end) => { element.scrollTop = end ? element.scrollHeight : 0; }, end);
      await page.mouse.wheel(0, end ? 400 : -400);
      await page.waitForTimeout(250);
      assertViewportClose(await readViewportTransform(page), viewport, '滚到文字边界也不得误缩放');
    }
    // Select by the header, then use actual pointer drags (not synthetic dimensions).
    await node.locator('[data-testid="node-drag-handle"]').click();
    const before = await node.boundingBox();
    const textBefore = await input.boundingBox();
    const corner = await node.locator('.react-flow__resize-control.bottom.right.handle').boundingBox();
    assert.ok(corner);
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2 + 90, corner.y + corner.height / 2 + 110, { steps: 12 });
    await page.mouse.up();
    const after = await node.boundingBox();
    const textAfter = await input.boundingBox();
    assert.ok(after.width > before.width + 60 && after.height > before.height + 80, '四角必须同时改变宽高');
    assert.ok(textAfter.height > textBefore.height + 70, '增加的高度必须用于展示提示词');
    // Bottom edge adjusts height without changing width.
    const bottom = await node.locator('.react-flow__resize-control.bottom.line').boundingBox();
    await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2);
    await page.mouse.down();
    await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2 + 45, { steps: 8 });
    await page.mouse.up();
    const taller = await node.boundingBox();
    assert.ok(taller.height > after.height + 30);
    assert.ok(Math.abs(taller.width - after.width) < 2);
    await page.click('[data-testid="undo"]');
    const undone = await node.boundingBox();
    assert.ok(Math.abs(undone.height - after.height) < 2, '撤销恢复上一次高度');
    await page.click('[data-testid="redo"]');
    const redone = await node.boundingBox();
    assert.ok(Math.abs(redone.height - taller.height) < 2, '重做恢复拉伸高度');
    await waitSaved(page);
    const graph = (await (await page.request.get(`${baseUrl}/api/canvas/${canvasId}`)).json()).canvas.graph;
    const saved = graph.nodes.find((node) => node.id === id).size;
    assert.ok(saved?.height > 120);
    await page.reload();
    await node.waitFor();
    const restored = await node.boundingBox();
    assert.ok(Math.abs(restored.height - taller.height) < 2 && Math.abs(restored.width - taller.width) < 2, '刷新后恢复宽高');
    // Trackpad scrolling pans in both axes without changing zoom.
    const surface = await surfaceBox(page);
    const beforePan = await readViewportTransform(page);
    await page.mouse.move(surface.x + 20, surface.y + 20);
    await page.mouse.wheel(80, 120);
    await page.waitForTimeout(300);
    const afterPan = await readViewportTransform(page);
    assert.ok(afterPan.x < beforePan.x && afterPan.y < beforePan.y, '双指滑动应沿横纵两个方向平移');
    assert.equal(afterPan.zoom, beforePan.zoom, '双指滑动不应缩放');
    // Chromium exposes trackpad pinch as a Ctrl-modified wheel event.
    const beforeZoom = await readViewportTransform(page);
    await page.keyboard.down('Control');
    try {
      await page.mouse.wheel(0, 60);
    } finally {
      await page.keyboard.up('Control');
    }
    await page.waitForTimeout(300);
    assert.ok((await readViewportTransform(page)).zoom < beforeZoom.zoom, '双指捏合应继续缩放');
    // Shrinking a configured node must leave its actions directly visible.
    await page.click('[data-testid="fit-view"]');
    await page.waitForTimeout(300);
    await node.locator('[data-testid="node-drag-handle"]').click();
    const shrink = await node.locator('.react-flow__resize-control.bottom.line').boundingBox();
    await page.mouse.move(shrink.x + shrink.width / 2, shrink.y + shrink.height / 2);
    await page.mouse.down();
    await page.mouse.move(shrink.x + shrink.width / 2, shrink.y - 600, { steps: 12 });
    await page.mouse.up();
    if (kind !== 'prompt') {
      await assertActionsVisible(node);
      if (kind === 'video-generation') {
        await selectModel(page, id, 'external-jimeng-seedance-2-5');
        await page.waitForTimeout(100);
        await assertActionsVisible(node);
      }
      await waitSaved(page);
      await page.reload();
      await node.locator('[data-testid="run-node"]').waitFor();
      const restoredModel = kind === 'video-generation' ? 'external-jimeng-seedance-2-5' : 'fixture-image-edit';
      await node.locator(`[data-testid="model-select"] option[value="${restoredModel}"]`).waitFor({ state: 'attached' });
      await assertActionsVisible(node);
      await page.click('[data-testid="fit-view"]');
      await page.waitForTimeout(350);
      const screenshot = path.join(repoRoot, 'outputs', 'canvas-validation', `minimum-height-${kind}.png`);
      await page.screenshot({ path: screenshot });
    }
    results.push({ kind, saved });
  }
  // Material cards saved by the earlier free-height implementation must recover automatically.
  const portrait = path.join(fixtureDir, 'portrait.png');
  const landscape = path.join(fixtureDir, 'landscape.png');
  fs.writeFileSync(portrait, await sharp({ create: { width: 300, height: 400, channels: 3, background: '#8a6f4e' } }).png().toBuffer());
  fs.writeFileSync(landscape, await sharp({ create: { width: 400, height: 300, channels: 3, background: '#4e6f8a' } }).png().toBuffer());
  const materialCanvasId = await createCanvas(page, '素材卡片高度回归');
  const materialId = await addMaterialWithImage(page, portrait);
  await waitSaved(page);
  const current = (await (await page.request.get(`${baseUrl}/api/canvas/${materialCanvasId}`)).json()).canvas;
  current.graph.nodes[0].size = { width: 320, height: 1100 };
  current.graph.nodes[0].data.title = 'RQ5A-A1组合-普通床-LH163B1-超长素材标题';
  const patched = await page.request.patch(`${baseUrl}/api/canvas/${materialCanvasId}`, {
    data: { expectedGraphRevision: current.graphRevision, graph: current.graph },
  });
  assert.equal(patched.status(), 200);
  await page.reload();
  const material = page.locator(`.react-flow__node[data-id="${materialId}"]`);
  await material.locator('img').waitFor();
  await page.click('[data-testid="fit-view"]');
  await page.waitForTimeout(350);
  const assertMaterialFits = async () => {
    const metrics = await material.evaluate((node) => {
      const card = node.getBoundingClientRect();
      const button = node.querySelector('[data-testid="material-upload"]').getBoundingClientRect();
      const img = node.querySelector('img');
      return { gap: (card.bottom - button.bottom) / card.width, renderedRatio: img.clientHeight / img.clientWidth, mediaRatio: img.naturalHeight / img.naturalWidth };
    });
    assert.ok(metrics.gap < 0.08, `素材按钮下方不应有大块空白：${JSON.stringify(metrics)}`);
    assert.ok(Math.abs(metrics.renderedRatio - metrics.mediaRatio) < 0.02, '素材必须保持原始比例');
  };
  await assertMaterialFits();
  await material.locator('[data-testid="node-drag-handle"]').click();
  const beforeScale = await material.boundingBox();
  const bottom = await material.locator('.react-flow__resize-control.bottom.line').boundingBox();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2 + 70, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.ok((await material.boundingBox()).width > beforeScale.width + 20, '竖向拖动素材边缘应带动等比缩放');
  await assertMaterialFits();
  await material.locator('[data-testid="material-file-input"]').setInputFiles(landscape);
  await page.waitForFunction((id) => {
    const img = document.querySelector(`.react-flow__node[data-id="${id}"] img`);
    return img?.naturalWidth === 400 && img?.naturalHeight === 300;
  }, materialId);
  await assertMaterialFits();
  await waitSaved(page);
  const materialSaved = (await (await page.request.get(`${baseUrl}/api/canvas/${materialCanvasId}`)).json()).canvas.graph.nodes[0];
  assert.equal(materialSaved.size?.height, undefined, '素材保存不得重新写入固定高度');
  await page.reload();
  await material.locator('img').waitFor();
  await page.waitForFunction((id) => document.querySelector(`.react-flow__node[data-id="${id}"] img`)?.naturalWidth === 400, materialId);
  await assertMaterialFits();
  assert.equal(runPosts.length, 0, '交互操作不得提交生成请求');
  await page.click('[data-testid="fit-view"]');
  await page.waitForTimeout(350);
  const screenshot = path.join(repoRoot, 'outputs', 'canvas-validation', 'interaction.png');
  await page.screenshot({ path: screenshot });
  await page.unroute('**/api/canvas/models');
  return { results, scrollIsolated: true, edgeScrollIsolated: true, promptGrows: true, reloadPreservesSize: true, screenshot };
}

async function seedanceSuite(page) {
  const providerDb = new Database(':memory:');
  providerDb.exec(`CREATE TABLE providers (id TEXT, name TEXT, model TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER);
    CREATE TABLE video_providers (id TEXT, name TEXT, defaultModel TEXT, type TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER);`);
  for (const model of ['image2-medium', 'qiniuyun/gpt-image-2-medium', 'doubao-seedream-5-0-pro-image', 'nano-banana-3.0', 'nano-banana-3.1']) {
    providerDb.prepare(`INSERT INTO providers VALUES (?, ?, ?, 'gateway-task-image', 'http://127.0.0.1:1', 'test-key', 1)`).run(model, model, model);
  }
  for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628', 'doubao-seedance-2-0-fast-260128']) {
    providerDb.prepare(`INSERT INTO video_providers VALUES (?, ?, ?, 'openai-video', 'http://127.0.0.1:1', 'test-key', 1)`).run(model, model, model);
  }
  const companyImages = configuredCanvasImages(providerDb);
  const companyVideos = configuredCanvasVideos(providerDb);
  providerDb.close();
  let imageOptions = companyImages;
  // UI-only capabilities over the fixture server. No generation API is exercised here.
  await page.route('**/api/canvas/models', async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, models: [...value.models, directSeedanceCapability(SEEDANCE_20), directSeedanceCapability(SEEDANCE_25), ...imageOptions, ...companyVideos] } });
  });
  await createCanvas(page, 'Seedance 参数验收');
  const id = await addNode(page, 'video-generation');
  await selectModel(page, id, 'external-jimeng-seedance-2-5');
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  assert.equal(await node.getByLabel('生成声音', { exact: true }).isChecked(), true);
  const modes = await node.locator('[data-testid="mode-select"] option').allTextContents();
  assert.equal(modes.length, 6);
  assert.ok(modes.includes('全能参考') && modes.includes('视频延长'));
  await node.getByLabel('分辨率', { exact: true }).selectOption('720p');
  await node.getByLabel('生成阶段', { exact: true }).selectOption('draft');
  assert.equal(await node.getByLabel('分辨率', { exact: true }).inputValue(), '480p');
  assert.equal(await node.getByLabel('分辨率', { exact: true }).isDisabled(), true);
  await node.getByLabel('生成阶段', { exact: true }).selectOption('direct');
  assert.equal(await node.getByLabel('分辨率', { exact: true }).inputValue(), '720p');
  await node.getByLabel('生成阶段', { exact: true }).selectOption('draft');
  await selectModel(page, id, 'external-jimeng-seedance-2-0');
  assert.equal(await node.getByLabel('分辨率', { exact: true }).inputValue(), '720p');
  assert.equal(await node.getByLabel('生成阶段', { exact: true }).count(), 0);
  assert.match(await node.locator('[role="status"]').textContent(), /已切换为直接生成/);
  await node.getByLabel('分辨率', { exact: true }).selectOption('4k');
  await selectModel(page, id, 'external-jimeng-seedance-2-5');
  assert.equal(await node.getByLabel('分辨率', { exact: true }).inputValue(), '1080p');
  assert.match(await node.locator('[role="status"]').textContent(), /1080p/);
  for (const capability of companyVideos) {
    await selectModel(page, id, capability.key);
    const companyModes = await node.locator('[data-testid="mode-select"] option').allTextContents();
    assert.equal(companyModes.length, 6);
    assert.ok(companyModes.includes('全能参考') && companyModes.includes('智能编辑') && companyModes.includes('视频延长'));
    const resolutions = await node.getByLabel('分辨率', { exact: true }).locator('option').evaluateAll((options) => options.map((option) => option.value));
    assert.deepEqual(resolutions, capability.parameters.find((parameter) => parameter.key === 'resolution').options);
  }
  const imageId = await addNode(page, 'image-generation');
  const imageNode = page.locator(`.react-flow__node[data-id="${imageId}"]`);
  for (const capability of companyImages) {
    await selectModel(page, imageId, capability.key);
    assert.equal(await imageNode.locator('[data-testid="model-select"]').inputValue(), capability.key);
  }
  imageOptions = companyImages.slice(0, -1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction((key) => ![...document.querySelectorAll('[data-testid="model-select"] option')].some((option) => option.value === key && !option.textContent.includes('重新选择')), companyImages.at(-1).key);
  assert.match(await imageNode.locator('[data-testid="model-select"] option:checked').textContent(), /重新选择模型/);
  assert.equal(runPosts.length, 0);
  await waitSaved(page);
  const movPath = path.join(fixtureDir, '播放验证.mov');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=blue:size=640x640:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', movPath], { timeoutMs: 60_000 });
  const materialId = await addNode(page, 'material');
  const material = page.locator(`.react-flow__node[data-id="${materialId}"]`);
  await material.locator('[data-testid="material-file-input"]').setInputFiles(movPath);
  const video = material.locator('video');
  await video.waitFor();
  await video.evaluate(async (element) => { element.muted = true; await element.play(); });
  await page.waitForFunction((id) => { const video = document.querySelector(`.react-flow__node[data-id="${id}"] video`); return video?.readyState >= 2 && video.currentTime > 0.1; }, materialId);
  await video.evaluate((element) => element.pause());
  const download = await page.request.get(new URL(await material.locator('[data-testid="download-material"]').getAttribute('href'), baseUrl).href);
  assert.match(download.headers()['content-type'], /video\/quicktime/);
  assert.deepEqual(await download.body(), fs.readFileSync(movPath), '下载必须保留 MOV 原件字节');
  await waitSaved(page);
  await page.click('[data-testid="fit-view"]');
  const screenshot = path.join(repoRoot, 'outputs', 'canvas-validation', '2026-10-03-local-final', 'seedance-ui.png');
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  await page.unroute('**/api/canvas/models');
  return { sixModes: true, companySixModes: true, configuredImages: 5, refreshOnFocus: true, newAudioEnabled: true, draftResolutionLocked: true, directPreferenceRestored: true, modelSwitchExplained: true, movPlaybackProgress: true, originalMovDownloadPreserved: true, generationRequests: 0, screenshot };
}

async function editorSuite(page) {
  const pngA = path.join(fixtureDir, '沙发A.png');
  const pngB = path.join(fixtureDir, '沙发B.png');
  fs.writeFileSync(pngA, await sharp({ create: { width: 48, height: 32, channels: 3, background: '#8a6f4e' } }).png().toBuffer());
  fs.writeFileSync(pngB, await sharp({ create: { width: 48, height: 32, channels: 3, background: '#4e6f8a' } }).png().toBuffer());

  const evidenceCanvasId = await createCanvas(page, '沙发场景探索');
  runPosts.length = 0;

  // 1. 素材节点：拖入本地文件
  await dropFileOnCanvas(page, pngA, '沙发A.png', { x: 60, y: 60 });
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 1);
  const materialA = await soleNodeId(page, 'material');
  await page.waitForSelector(`.react-flow__node[data-id="${materialA}"] img`, { timeout: 15_000 });
  assert.ok(await nodeAttribute(page, materialA, 'data-canvas-result') === null);

  // 2. 提示词节点：填写文本
  const promptId = await addNode(page, 'prompt');
  await page.fill(`.react-flow__node[data-id="${promptId}"] [data-testid="prompt-text"]`, '暖色调、午后光线');
  await page.locator(`.react-flow__node[data-id="${promptId}"] [data-testid="prompt-text"]`).blur();

  // 3. 生成节点 + 模型 + 提示词
  const imageNodeId = await addNode(page, 'image-generation');
  await selectModel(page, imageNodeId, 'fixture-image-edit');
  await fillPrompt(page, imageNodeId, '把 @参考1 放到客厅');

  // 固定布局（走真实保存接口 + 刷新），避免节点互相遮挡导致手柄点不到
  await applyLayout(page, {
    [materialA]: { x: 0, y: 0 },
    [promptId]: { x: 0, y: 420 },
    [imageNodeId]: { x: 420, y: 0 },
  });

  // 4. 连线：素材 → 生成节点
  await connect(page, materialA, imageNodeId);
  await page.waitForSelector(`.react-flow__node[data-id="${imageNodeId}"] [data-testid="reference-list"]`);
  assert.equal(await page.locator('.react-flow__edge').count(), 1);
  assert.equal(
    await page.locator(`.react-flow__node[data-id="${imageNodeId}"] [data-reference]`).first().getAttribute('data-reference'),
    '1',
  );

  // 5. 编辑不发生成请求
  await waitSaved(page);
  assert.equal(runPosts.length, 0, `编辑阶段不应有生成请求：${runPosts.join(',')}`);

  // 6. 第二份参考与排序
  const materialB = await addMaterialWithImage(page, pngB);
  await applyLayout(page, {
    [materialA]: { x: 0, y: 0 },
    [promptId]: { x: 0, y: 420 },
    [imageNodeId]: { x: 420, y: 0 },
    [materialB]: { x: 0, y: 800 },
  });
  await connect(page, materialB, imageNodeId);
  await page.waitForFunction(
    (id) => document.querySelectorAll(`.react-flow__node[data-id="${id}"] [data-reference]`).length === 2,
    imageNodeId,
  );
  const firstRow = page.locator(`.react-flow__node[data-id="${imageNodeId}"] [data-reference]`).first();
  assert.equal(await firstRow.getAttribute('data-reference'), '1');
  await firstRow.getByRole('button', { name: '下移' }).click();
  await page.waitForFunction(
    (id) => document.querySelector(`.react-flow__node[data-id="${id}"] [data-reference]`)?.getAttribute('data-reference') === '2',
    imageNodeId,
  );

  // 7. 断线 → 槽位移除 → 提及未知编号给出提示
  await page.locator(`.react-flow__node[data-id="${imageNodeId}"] [data-testid="detach-ref-1"]`).click();
  await page.waitForSelector(`.react-flow__node[data-id="${imageNodeId}"] [data-reference="1"]`, { state: 'detached' });
  await fillPrompt(page, imageNodeId, '把 @参考1 放到客厅');
  await page.waitForSelector(`.react-flow__node[data-id="${imageNodeId}"] [data-testid="mention-unknown"]`);
  await waitSaved(page);
  assert.equal(runPosts.length, 0);

  // 8. 重新连接 → 分配新编号，旧编号不回收（@参考N 不会悄悄改指向）
  await connect(page, materialA, imageNodeId);
  await page.waitForSelector(`.react-flow__node[data-id="${imageNodeId}"] [data-reference="3"]`);

  // 9. 连线上的 × 只解除引用：节点与结果保留
  const edgeCountBefore = await page.locator('.react-flow__edge').count();
  await page.locator('[data-testid^="edge-delete-"]').first().click();
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__edge').length === count - 1, edgeCountBefore);
  assert.equal(await nodeIds(page, 'material').then((ids) => ids.length), 2);

  // 10. 撤销恢复连线
  await page.keyboard.press('Meta+z');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__edge').length === count, edgeCountBefore);

  // 11. 拉线到空白处弹菜单；Esc 取消
  await dragToEmpty(page, materialB);
  await page.waitForSelector('[data-testid="connection-menu"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="connection-menu"]', { state: 'detached' });

  // 12. 菜单创建并自动连接
  const nodesBefore = await page.locator('.react-flow__node').count();
  await dragToEmpty(page, materialB, { x: 260, y: 220 });
  await page.waitForSelector('[data-testid="connection-menu"]');
  await page.click('[data-testid="menu-image-generation"]');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count + 1, nodesBefore);
  const created = (await nodeIds(page, 'image-generation')).find((id) => id !== imageNodeId);
  assert.ok(created);
  assert.equal(await page.locator(`.react-flow__node[data-id="${created}"] [data-reference]`).count(), 1);

  // 13. 复制粘贴（无结果时也保留设置）
  // 用 DOM 事件选中节点：点节点中心可能落在提示词输入框上，Cmd+C 会变成复制文本
  await selectNode(page, imageNodeId);
  // 用「粘贴前后新增的节点 id」定位副本，不要靠排除法猜
  const beforePaste = await nodeIds(page, 'image-generation');
  await page.keyboard.press('Meta+c');
  await page.keyboard.press('Meta+v');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count + 1, nodesBefore + 1);
  const afterPaste = await nodeIds(page, 'image-generation');
  const pasted = afterPaste.find((id) => !beforePaste.includes(id));
  assert.ok(pasted, `粘贴后应出现新的生成节点：${afterPaste.join(',')}`);
  // 断言服务端已持久化的副本内容（比逐帧轮询 DOM 值稳定，也更能说明「副本拿到了设置」）
  const pastedPrompt = await page.evaluate(async ({ canvasId, nodeId }) => {
    const payload = await (await fetch(`/api/canvas/${canvasId}`)).json();
    return payload.canvas.graph.nodes.find((node) => node.id === nodeId)?.data?.prompt ?? null;
  }, { canvasId: new URL(page.url()).pathname.split('/').pop(), nodeId: pasted });
  assert.equal(pastedPrompt, '把 @参考1 放到客厅', '副本应保留复制时的提示词');

  // 13.5 拖动节点并撤销：在独立画布上验证，避免受前面累积历史的影响
  const dragCanvasId = await createCanvas(page, '拖拽撤销画布');
  const dragNodeId = await addNode(page, 'prompt');
  await applyLayout(page, { [dragNodeId]: { x: 120, y: 120 } });
  const positionBefore = await nodePosition(page, dragNodeId);
  const boxBefore = await nodeBox(page, dragNodeId);
  const surface = await surfaceBox(page);
  await moveNode(page, dragNodeId, {
    x: boxBefore.x - surface.x + 26,
    y: boxBefore.y - surface.y + 18,
  });
  const positionAfter = await nodePosition(page, dragNodeId);
  assert.notEqual(positionAfter, positionBefore, '拖动后画布坐标应发生变化');

  const historyDepth = async () => {
    const raw = await page.locator('[data-testid="undo"]').getAttribute('data-history');
    const [undoSteps, redoSteps] = String(raw).split('/').map(Number);
    return { undoSteps, redoSteps };
  };
  const before = await historyDepth();
  assert.equal(before.undoSteps, 1, '拖动应留下一个可撤销步骤');

  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  assert.equal(await nodePosition(page, dragNodeId), positionBefore, '撤销应回到拖动前的位置');
  assert.equal((await historyDepth()).redoSteps, 1, '撤销后应可以重做');

  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(400);
  assert.equal(await nodePosition(page, dragNodeId), positionAfter, '重做应回到拖动后的位置');

  // 回到主画布继续后面的断言
  await page.goto(`${baseUrl}/canvas/${evidenceCanvasId}`);
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count, nodesBefore + 2);
  void dragCanvasId;

  // 13.6 IME 组合输入：拼音组合过程不能被提前提交成字母
  // （回归：受控值经 StoreUpdater 被动 effect 回传滞后一拍，组合期间 React 受控恢复
  // 会用旧值回写 DOM，每敲一键拼音就被固化；组合守卫要求组合结束才提交）
  const imeCanvasId = await createCanvas(page, 'IME 组合输入');
  const imePromptId = await addNode(page, 'prompt');
  const imeGenId = await addNode(page, 'image-generation');
  const cdp = await page.context().newCDPSession(page);
  /** 用 CDP 模拟真实输入法：逐键更新组合文本，最后提交候选。 */
  const imeInput = async (selector, committedText) => {
    await page.click(selector);
    for (const step of ['n', 'ni', 'nih', 'niha', 'nihao']) {
      await cdp.send('Input.imeSetComposition', { text: step, selectionStart: step.length, selectionEnd: step.length });
      await page.waitForTimeout(40);
    }
    await cdp.send('Input.insertText', { text: committedText });
    await page.waitForTimeout(80);
  };
  await imeInput(`.react-flow__node[data-id="${imePromptId}"] [data-testid="prompt-text"]`, '你好');
  assert.equal(
    await page.locator(`.react-flow__node[data-id="${imePromptId}"] [data-testid="prompt-text"]`).inputValue(),
    '你好',
    '提示词文本域：IME 组合不应被拆成字母',
  );
  const imeTitle = page.locator(`.react-flow__node[data-id="${imePromptId}"] [data-testid="node-title"]`);
  await imeTitle.click();
  await imeTitle.dblclick();
  assert.equal(await page.locator('[data-testid="node-title-input"]').count(), 0, '单击或双击标题不得进入重命名');
  await imeTitle.click({ button: 'right' });
  await page.click('[data-testid="context-rename"]');
  const titleInput = page.locator('[data-testid="node-title-input"]');
  // Rename selects the existing title; explicitly move the caret to test appending Chinese.
  await titleInput.press('ArrowRight');
  await imeInput('[data-testid="node-title-input"]', '名称');
  assert.equal(
    await titleInput.inputValue(),
    '提示词名称',
    '节点标题：IME 组合不应被拆成字母',
  );
  await titleInput.press('Enter');
  assert.equal(await imeTitle.textContent(), '提示词名称');
  await imeTitle.click({ button: 'right' });
  await page.click('[data-testid="context-rename"]');
  await titleInput.fill('不应保存的名称');
  await titleInput.press('Escape');
  assert.equal(await imeTitle.textContent(), '提示词名称', 'Esc 取消不得保存草稿');
  await imeInput(`.react-flow__node[data-id="${imeGenId}"] [data-testid="generation-prompt"]`, '你好世界');
  assert.equal(
    await page.locator(`.react-flow__node[data-id="${imeGenId}"] [data-testid="generation-prompt"]`).inputValue(),
    '你好世界',
    '生成节点提示词：IME 组合不应被拆成字母',
  );
  // 提交发生在 compositionend：保存后服务端图里必须是完整中文，而不是拼音残片
  await waitSaved(page);
  const savedIme = await page.evaluate(async ({ canvasId, promptId, genId }) => {
    const payload = await (await fetch(`/api/canvas/${canvasId}`)).json();
    const nodes = payload.canvas.graph.nodes;
    return {
      text: nodes.find((node) => node.id === promptId)?.data?.text ?? null,
      title: nodes.find((node) => node.id === promptId)?.data?.title ?? null,
      prompt: nodes.find((node) => node.id === genId)?.data?.prompt ?? null,
    };
  }, { canvasId: imeCanvasId, promptId: imePromptId, genId: imeGenId });
  assert.deepEqual(savedIme, { text: '你好', title: '提示词名称', prompt: '你好世界' },
    `IME 提交后的持久化内容不对：${JSON.stringify(savedIme)}`);

  // 回到主画布继续后面的断言
  await page.goto(`${baseUrl}/canvas/${evidenceCanvasId}`);
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count, nodesBefore + 2);

  // 14. 没有历史版本入口
  const bodyText = await page.locator('body').innerText();
  assert.equal(/历史版本|版本切换|恢复上一版/.test(bodyText), false, '首版不应出现历史版本入口');

  await waitSaved(page);
  const finalEdgeCount = await page.locator('.react-flow__edge').count();

  // 15. 刷新后恢复节点、连线与文本
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count, nodesBefore + 2);
  // 连线与文本可能比节点晚一帧渲染，等它们出现再断言
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__edge').length === count, finalEdgeCount);
  await page.waitForFunction(
    (id) => document.querySelector(`.react-flow__node[data-id="${id}"] [data-testid="generation-prompt"]`)?.value === '把 @参考1 放到客厅',
    imageNodeId,
  );
  assert.equal(runPosts.length, 0, '整个编辑流程不应产生生成请求');
  return { canvasId: evidenceCanvasId };
}

async function executionSuite(page) {
  const pngPath = path.join(fixtureDir, '执行验证.png');
  fs.writeFileSync(pngPath, await sharp({ create: { width: 40, height: 40, channels: 3, background: '#2f6f4f' } }).png().toBuffer());

  await createCanvas(page, '执行验证画布');
  runPosts.length = 0;

  const materialId = await addMaterialWithImage(page, pngPath);

  const imageId = await addNode(page, 'image-generation');
  await selectModel(page, imageId, 'fixture-image-edit');
  await fillPrompt(page, imageId, '改场景');
  await connect(page, materialId, imageId);

  const videoId = await addNode(page, 'video-generation');
  await selectModel(page, videoId, 'fixture-video');
  await fillPrompt(page, videoId, '慢慢推进镜头');

  await applyLayout(page, {
    [materialId]: { x: 0, y: 0 },
    [imageId]: { x: 420, y: 0 },
    [videoId]: { x: 420, y: 480 },
  });
  await connect(page, materialId, imageId);
  await connect(page, materialId, videoId);

  await waitSaved(page);

  // 同时启动图片与视频任务
  await page.click(`.react-flow__node[data-id="${imageId}"] [data-testid="run-node"]`);
  await page.click(`.react-flow__node[data-id="${videoId}"] [data-testid="run-node"]`);
  await page.waitForFunction(
    ({ image, video }) => Boolean(
      document.querySelector(`.react-flow__node[data-id="${image}"] [data-canvas-status]`)
      && document.querySelector(`.react-flow__node[data-id="${video}"] [data-canvas-status]`),
    ),
    { image: imageId, video: videoId },
    { timeout: 15_000 },
  );

  // 任务运行时画布继续可编辑，且轮询不夺输入
  const promptSelector = `.react-flow__node[data-id="${imageId}"] [data-testid="generation-prompt"]`;
  await page.click(promptSelector);
  await page.keyboard.press('End');
  await page.keyboard.type('（运行中继续编辑）');
  const typedText = await page.inputValue(promptSelector);
  assert.ok(typedText.includes('运行中继续编辑'));
  await page.waitForTimeout(3_500);
  assert.equal(await page.inputValue(promptSelector), typedText, '任务轮询不得覆盖正在编辑的草稿');

  // 两个任务都要出结果
  await waitForResult(page, imageId, 'image');
  await waitForResult(page, videoId, 'video');
  const firstResult = await nodeAttribute(page, imageId, 'data-canvas-result');
  assert.ok(firstResult);
  assert.equal(runPosts.length, 2, `同时启动图片与视频应各产生一次运行请求：${runPosts.join(',')}`);

  // 复制时固定当前画面：粘贴前原节点再生成新结果，副本不受影响
  await selectNode(page, imageId);
  await page.keyboard.press('Meta+c');
  await page.click(`.react-flow__node[data-id="${imageId}"] [data-testid="run-node"]`);
  await page.waitForFunction(
    ({ id, previous }) => {
      const value = document.querySelector(`.react-flow__node[data-id="${id}"] [data-canvas-result]`)?.getAttribute('data-canvas-result');
      return Boolean(value) && value !== previous;
    },
    { id: imageId, previous: firstResult },
    { timeout: 30_000 },
  );
  const secondResult = await nodeAttribute(page, imageId, 'data-canvas-result');

  const nodesBeforePaste = await page.locator('.react-flow__node').count();
  await page.keyboard.press('Meta+v');
  await page.waitForFunction((count) => document.querySelectorAll('.react-flow__node').length === count + 1, nodesBeforePaste);
  const pasted = (await nodeIds(page, 'image-generation')).find((id) => id !== imageId);
  assert.ok(pasted);
  assert.equal(await nodeAttribute(page, pasted, 'data-canvas-result'), firstResult);
  assert.notEqual(firstResult, secondResult);
  // 副本不复制运行中的任务
  await page.waitForSelector(`.react-flow__node[data-id="${pasted}"] [data-canvas-status]`, { state: 'detached' });

  // 刷新后结果与编辑都在
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await waitForResult(page, imageId, 'image', 20_000);
  assert.equal(await nodeAttribute(page, imageId, 'data-canvas-result'), secondResult);

  // v2 并发多变体：×4 提交、运行中连击追加、候选列表与本地预览切换
  // 运行中节点随轮询持续重渲染，Playwright click 会等不到稳定，统一用 DOM 事件点击
  const domClick = async (selector) => {
    await page.evaluate((sel) => {
      document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, selector);
  };
  await domClick(`.react-flow__node[data-id="${imageId}"] [data-testid="variant-count"] button[aria-label="生成 4 个变体"]`);
  await domClick(`.react-flow__node[data-id="${imageId}"] [data-testid="run-node"]`);
  // 4 个变体并行运行：按钮变「追加变体」，徽章行显示 4 个变体
  await page.waitForFunction(
    (id) => document.querySelector(`.react-flow__node[data-id="${id}"] [data-testid="run-node"]`)?.textContent?.includes('追加变体'),
    imageId,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    (id) => document.querySelectorAll(`.react-flow__node[data-id="${id}"] [data-testid="variant-status-row"] span`).length === 4,
    imageId,
    { timeout: 15_000 },
  );
  // 运行中连击 run-node：v1 语义会报 node_busy，v2 应追加成功（不报错）
  runPosts.length = 0;
  await domClick(`.react-flow__node[data-id="${imageId}"] [data-testid="run-node"]`);
  await page.waitForFunction(
    (id) => !document.querySelector(`.react-flow__node[data-id="${id}"] [data-canvas-status]`),
    imageId,
    { timeout: 60_000 },
  );
  assert.equal(runPosts.length, 1, `运行中连击应成功追加一次运行请求：${runPosts.join(',')}`);

  // 多变体全部物化：图片历史 2 次（首次 + 再生成）+ 本次 4 + 追加 4 = 10 个产物，
  // 另有视频节点的 1 个产物也会飞出，共 11 个物化素材节点 + 1 个手动上传 = 12 个
  await page.waitForFunction(
    () => document.querySelectorAll('.react-flow__node:has([data-node-kind="material"])').length === 12,
    null,
    { timeout: 30_000 },
  );
  const mainBefore = await nodeAttribute(page, imageId, 'data-canvas-result');
  assert.ok(mainBefore);

  // 刷新后物化节点与主结果都在
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await waitForResult(page, imageId, 'image', 20_000);
  assert.equal(await nodeAttribute(page, imageId, 'data-canvas-result'), mainBefore);
  await page.waitForFunction(
    () => document.querySelectorAll('.react-flow__node:has([data-node-kind="material"])').length === 12,
    null,
    { timeout: 15_000 },
  );

  // 三态主题：切到深色与浅色后画布都仍然可用
  async function chooseTheme(label) {
    await page.click('button[aria-label="外观设置"]');
    await page.click(`[role="menuitemradio"]:has-text("${label}")`);
    await page.waitForTimeout(300);
  }
  const initialTheme = await page.getAttribute('html', 'data-theme');
  await chooseTheme('深色');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  assert.ok(await page.locator('.react-flow__node').count() > 0, '深色下画布仍应渲染节点');
  await chooseTheme('浅色');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.ok(await page.locator('.react-flow__node').count() > 0, '浅色下画布仍应渲染节点');
  await chooseTheme('跟随系统');
  assert.notEqual(await page.getAttribute('html', 'data-theme'), null);
  return { canvasId: new URL(page.url()).pathname.split('/').pop(), initialTheme };
}

/**
 * T5 recovery：用「首次下载失败」的 fixture 制造真实故障，
 * 在浏览器里走补下载路径，验证不重新生成、结果最终落到原节点。
 */
async function recoverySuite(page) {
  const pngPath = path.join(fixtureDir, '恢复验证.png');
  fs.writeFileSync(pngPath, await sharp({ create: { width: 36, height: 36, channels: 3, background: '#6b5b95' } }).png().toBuffer());

  await createCanvas(page, '恢复验证画布');
  runPosts.length = 0;

  const materialId = await addMaterialWithImage(page, pngPath);
  const imageId = await addNode(page, 'image-generation');
  await selectModel(page, imageId, 'fixture-image-edit');
  await fillPrompt(page, imageId, '改场景');
  await applyLayout(page, {
    [materialId]: { x: 0, y: 0 },
    [imageId]: { x: 420, y: 0 },
  });
  await connect(page, materialId, imageId);
  await waitSaved(page);

  await page.click(`.react-flow__node[data-id="${imageId}"] [data-testid="run-node"]`);
  // 首次下载失败：节点显示「下载失败」并给出补下载入口
  await page.waitForSelector(`.react-flow__node[data-id="${imageId}"] [data-canvas-status="download_failed"]`, { timeout: 30_000 });
  assert.equal(
    await page.locator(`.react-flow__node[data-id="${imageId}"] [data-testid="retry-download"]`).count(),
    1,
    '下载失败必须提供补下载入口',
  );
  assert.equal(await page.locator(`.react-flow__node[data-id="${imageId}"] [data-canvas-result]`).count(), 0);
  assert.equal(runPosts.length, 1, '失败与重试都不应新增生成请求');

  await page.click(`.react-flow__node[data-id="${imageId}"] [data-testid="retry-download"]`);
  await waitForResult(page, imageId, 'image');
  // 补下载走原任务：没有新的运行请求
  assert.equal(runPosts.length, 1, '补下载不得新增生成调用');

  // 刷新后结果仍在（本地产物已保存）
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await waitForResult(page, imageId, 'image', 20_000);
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  const logsResponse = await fetch(`${baseUrl}/api/canvas/${canvasId}/logs`);
  assert.equal(logsResponse.headers.get('cache-control'), 'no-store');
  const logs = await logsResponse.json();
  for (const text of ['进入队列', '准备素材', '向供应商提交', '查询生成进度', '产物下载失败', '生成完成']) {
    assert.ok(logs.some((log) => log.message.includes(text)), `缺少阶段日志：${text}`);
  }
  const taskId = logs.find((log) => log.level === 'error').jobId;
  await page.keyboard.press('ControlOrMeta+a');
  assert.ok(await page.locator('.react-flow__node.selected').count() > 0);
  const nodesBeforeLogReview = await page.locator('.react-flow__node').count();
  await page.click('[data-testid="toggle-logs"]');
  const drawer = page.getByRole('dialog', { name: '运行日志' });
  await drawer.getByText('生成完成', { exact: false }).waitFor();
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('.react-flow__node').count(), nodesBeforeLogReview, '日志查看时不响应画布删除快捷键');
  assert.ok(await drawer.getByText('产物下载失败', { exact: false }).count() > 0, '恢复后仍能查看原失败');
  await drawer.getByRole('button', { name: /^ERROR/ }).click();
  assert.equal(await drawer.getByText('生成完成', { exact: false }).count(), 0);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await drawer.getByTitle('复制错误日志', { exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /产物下载失败/);
  assert.ok(!copied.includes('生成完成'));
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.click('[data-testid="toggle-tasks"]');
  await page.click(`[data-testid="task-logs-${taskId}"]`);
  await drawer.getByText('生成完成', { exact: false }).waitFor();
  await page.screenshot({ path: '/tmp/canvas-task-logs.png' });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  const otherCanvasId = await createCanvas(page, '日志隔离验证');
  const scoped = await (await fetch(`${baseUrl}/api/canvas/${otherCanvasId}/logs?jobId=${taskId}`)).json();
  assert.deepEqual(scoped, [], '单任务查询保持画布隔离');
  return { canvasId, taskId, logCount: logs.length, logCopy: true, scopeIsolation: true };
}

/**
 * T6 export：单文件下载、图片放大、框选打包 ZIP。
 * 断言的是真实下载到的 ZIP 内容，不是界面文案。
 */
async function exportSuite(page) {
  const pngPath = path.join(fixtureDir, '导出验证.png');
  fs.writeFileSync(pngPath, await sharp({ create: { width: 44, height: 44, channels: 3, background: '#2f7f6f' } }).png().toBuffer());

  await createCanvas(page, '导出验证画布');
  const materialId = await addMaterialWithImage(page, pngPath);
  const imageId = await addNode(page, 'image-generation');
  await selectModel(page, imageId, 'fixture-image-edit');
  await fillPrompt(page, imageId, '改场景');
  await applyLayout(page, { [materialId]: { x: 0, y: 0 }, [imageId]: { x: 420, y: 0 } });
  await connect(page, materialId, imageId);
  await waitSaved(page);

  await page.click(`.react-flow__node[data-id="${imageId}"] [data-testid="run-node"]`);
  await waitForResult(page, imageId, 'image');

  // 单个成品下载：物化素材节点上的链接指向 ?download=1，响应带 attachment 与真实成品字节
  const resultAssetId = await nodeAttribute(page, imageId, 'data-canvas-result');
  const downloadHref = await page.getAttribute(
    `[data-testid="download-material"][href*="${resultAssetId}"]`,
    'href',
  );
  assert.ok(downloadHref?.includes('?download=1'), `下载链接应指向成品：${downloadHref}`);
  const single = await page.evaluate(async (href) => {
    const response = await fetch(href);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      contentDisposition: response.headers.get('content-disposition'),
      contentType: response.headers.get('content-type'),
      head: [...buffer.subarray(0, 4)],
      size: buffer.byteLength,
    };
  }, downloadHref);
  assert.equal(single.status, 200);
  assert.match(String(single.contentDisposition), /attachment/);
  assert.equal(single.contentType, 'image/png');
  assert.deepEqual(single.head, [0x89, 0x50, 0x4e, 0x47], '下载的应是真实 PNG 成品');
  assert.ok(single.size > 0);

  // 图片放大：物化素材节点上点击打开、点击关闭
  const zoomAssetId = await nodeAttribute(page, imageId, 'data-canvas-result');
  await page.click(`.react-flow__node:has([data-node-kind="material"]) img[src*="${zoomAssetId}"]`);
  await page.waitForSelector('[data-testid="material-lightbox"]');
  await page.click('[data-testid="material-lightbox"]');
  await page.waitForSelector('[data-testid="material-lightbox"]', { state: 'detached' });

  // 框选打包：选中节点 → 打包选中 → 拿到 ZIP
  await selectNode(page, imageId);
  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid="export-selection"]'),
  ]);
  const zipPath = await zip.path();
  const zipBytes = fs.readFileSync(zipPath);
  assert.deepEqual([...zipBytes.subarray(0, 2)].map((byte) => String.fromCharCode(byte)).join(''), 'PK', '导出应是 ZIP');
  const names = [];
  let offset = 0;
  while (offset < zipBytes.length - 4) {
    if (zipBytes.readUInt32LE(offset) === 0x04034b50) {
      const nameLength = zipBytes.readUInt16LE(offset + 26);
      const extraLength = zipBytes.readUInt16LE(offset + 28);
      names.push(zipBytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
      offset += 30 + nameLength + extraLength + zipBytes.readUInt32LE(offset + 18);
      continue;
    }
    offset += 1;
  }
  assert.ok(names.includes('manifest.json'), `ZIP 应包含 manifest.json：${names.join(',')}`);
  assert.equal(names.some((name) => name.endsWith('.png')), true, 'ZIP 应包含选中的成品');

  // 任务抽屉：说明失败原因与跨画布入口（这里只验证抽屉可用与节点定位）
  await page.click('[data-testid="toggle-tasks"]');
  await page.waitForSelector('[data-testid="task-drawer"]');
  assert.ok(await page.locator('[data-testid^="task-"]').count() > 0, '任务抽屉应列出任务');

  return { canvasId: new URL(page.url()).pathname.split('/').pop(), zipEntries: names.length };
}

/**
 * review 回归：覆盖保存期间编辑、跨页面 revision、视口持久化，以及过期运行请求。
 * 这些用例都走真实 standalone 服务与 Playwright 页面，不以源码匹配代替行为证据。
 */
async function regressionSuite(page) {
  const pngPath = path.join(fixtureDir, '回归素材.png');
  fs.writeFileSync(pngPath, await sharp({ create: { width: 40, height: 40, channels: 3, background: '#536d8a' } }).png().toBuffer());

  // 1. 首次 PATCH 延迟超过 debounce，期间的新编辑必须触发补保存。
  const delayedCanvasId = await createCanvas(page, '保存延迟回归');
  const delayedPromptId = await addNode(page, 'prompt');
  let delayedPatchSeen = false;
  let releaseDelayedPatch;
  const delayedPatch = new Promise((resolve) => { releaseDelayedPatch = resolve; });
  const delayedRoute = new RegExp(`/api/canvas/${delayedCanvasId}$`);
  await page.route(delayedRoute, async (route) => {
    const request = route.request();
    if (!delayedPatchSeen && request.method() === 'PATCH') {
      let body = {};
      try { body = JSON.parse(request.postData() ?? '{}'); } catch { body = {}; }
      if (body.graph) {
        delayedPatchSeen = true;
        await delayedPatch;
      }
    }
    await route.continue();
  });
  await fillTextPrompt(page, delayedPromptId, '第一版内容');
  for (let attempt = 0; attempt < 30 && !delayedPatchSeen; attempt += 1) await page.waitForTimeout(100);
  assert.equal(delayedPatchSeen, true, '应捕获到被延迟的首个图 PATCH');
  await fillTextPrompt(page, delayedPromptId, '延迟期间的新内容');
  releaseDelayedPatch();
  await waitSaved(page);
  await page.unroute(delayedRoute);
  const delayedSaved = await page.evaluate(async ({ id, nodeId }) => {
    const payload = await (await fetch(`/api/canvas/${id}`)).json();
    return payload.canvas.graph.nodes.find((node) => node.id === nodeId)?.data?.text ?? null;
  }, { id: delayedCanvasId, nodeId: delayedPromptId });
  assert.equal(delayedSaved, '延迟期间的新内容', '延迟 PATCH 放行后服务端应保存最新内容');
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction(({ id, text }) => (
    document.querySelector(`.react-flow__node[data-id="${id}"] [data-testid="prompt-text"]`)?.value === text
  ), { id: delayedPromptId, text: '延迟期间的新内容' });

  // 1.5. 分支预览后修改图定义，第一次确认只更新指纹与预览，不直接扩大任务范围。
  const branchCanvasId = await createCanvas(page, '分支预览重验回归');
  const branchMaterialId = await addMaterialWithImage(page, pngPath);
  const branchImageId = await addNode(page, 'image-generation');
  await selectModel(page, branchImageId, 'fixture-image-edit');
  await fillPrompt(page, branchImageId, '分支预览样本');
  await connect(page, branchMaterialId, branchImageId);
  await waitSaved(page);
  await page.click(`.react-flow__node[data-id="${branchImageId}"] [data-testid="run-branch"]`);
  await page.waitForSelector('[data-testid="branch-preview"]');
  const branchTasksBefore = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas.tasks.length, branchCanvasId);
  await page.click('[data-testid="add-prompt"]');
  await waitSaved(page);
  await page.click('[data-testid="confirm-branch"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="status-message"]')?.textContent?.includes('再次确认启动'),
    null,
    { timeout: 15_000 },
  );
  const branchTasksAfter = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas.tasks.length, branchCanvasId);
  assert.equal(branchTasksAfter, branchTasksBefore, '分支预览变更后首次确认不得直接创建任务');

  // 2. B 页面提交后，A 只收到运行投影轮询；A 的旧基准保存必须 409 且保留本地内容。
  const concurrentCanvasId = await createCanvas(page, '跨页面 revision 回归');
  const concurrentPromptId = await addNode(page, 'prompt');
  await fillTextPrompt(page, concurrentPromptId, 'A 初始内容');
  await waitSaved(page);
  const pageB = await page.context().newPage();
  try {
    await pageB.goto(`${baseUrl}/canvas/${concurrentCanvasId}`);
    await pageB.waitForSelector('[data-testid="canvas-editor"]');
    await pageB.waitForFunction((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`), concurrentPromptId);
    await fillTextPrompt(pageB, concurrentPromptId, 'B 已提交内容');
    await waitSaved(pageB);
    await page.waitForTimeout(2_000);
    const concurrentConflictExpectation = expectHttpError(
      `${baseUrl}/api/canvas/${concurrentCanvasId}`,
      'PATCH',
    );
    await fillTextPrompt(page, concurrentPromptId, 'A 本地草稿');
    await page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.textContent?.includes('保存冲突'), null, { timeout: 15_000 });
    await assertExpectedHttpError(concurrentConflictExpectation, '跨页面过期保存');
    assert.equal(
      await page.inputValue(`.react-flow__node[data-id="${concurrentPromptId}"] [data-testid="prompt-text"]`),
      'A 本地草稿',
      '409 后 A 页面必须保留本地草稿',
    );
    const concurrentServer = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas, concurrentCanvasId);
    assert.equal(
      concurrentServer.graph.nodes.find((node) => node.id === concurrentPromptId)?.data?.text,
      'B 已提交内容',
      'A 的过期图不得覆盖 B 的服务端内容',
    );
    await page.click('[data-testid="reload-canvas"]');
    await page.waitForFunction(
      ({ id, text }) => document.querySelector(`.react-flow__node[data-id="${id}"] [data-testid="prompt-text"]`)?.value === text,
      { id: concurrentPromptId, text: 'B 已提交内容' },
    );
    await fillTextPrompt(page, concurrentPromptId, 'A 重新加载后内容');
    await waitSaved(page);
    const reloadedServer = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas, concurrentCanvasId);
    assert.equal(
      reloadedServer.graph.nodes.find((node) => node.id === concurrentPromptId)?.data?.text,
      'A 重新加载后内容',
      '重新加载清除冲突后，新编辑应能再次保存',
    );
  } finally {
    await pageB.close();
  }

  // 3. 缩放和平移后的实际 React Flow transform 要保存，并在刷新后恢复。
  const viewportCanvasId = await createCanvas(page, '视口持久化回归');
  await addNode(page, 'prompt');
  await waitSaved(page);
  const surface = await surfaceBox(page);
  const center = { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2 };
  const viewportBefore = await readViewportTransform(page);
  await page.mouse.move(surface.x + 20, surface.y + 20);
  await page.keyboard.down('Control');
  try {
    await page.mouse.wheel(0, 60);
  } finally {
    await page.keyboard.up('Control');
  }
  await page.waitForTimeout(250);
  assert.ok((await readViewportTransform(page)).zoom < viewportBefore.zoom, '捏合应实际改变缩放比例');
  await page.mouse.wheel(80, 120);
  await page.waitForTimeout(250);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(center.x + 120, center.y + 80, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(1_000);
  const viewportAfter = await readViewportTransform(page);
  assert.notDeepEqual(viewportAfter, viewportBefore, '缩放／平移后 transform 应发生变化');
  const viewportServer = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas.viewport, viewportCanvasId);
  assertViewportClose(viewportServer, viewportAfter, '服务端视口应与页面最终 transform 一致');
  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  await page.waitForFunction(({ x, y, zoom }) => {
    const style = document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '';
    const match = style.match(/translate\(([-+\d.]+)px,\s*([-+\d.]+)px\)\s*scale\(([-+\d.]+)\)/);
    return Boolean(match)
      && Math.abs(Number(match[1]) - x) < 1
      && Math.abs(Number(match[2]) - y) < 1
      && Math.abs(Number(match[3]) - zoom) < 0.01;
  }, viewportServer, { timeout: 15_000 });

  // 小地图点击定位保留缩放，右键隐藏不弹出画布菜单，并可再次打开。
  const minimap = page.locator('.react-flow__minimap-svg');
  const destination = await minimap.evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    const point = svg.createSVGPoint();
    point.x = box.left + box.width * 0.8;
    point.y = box.top + box.height * 0.2;
    const flow = point.matrixTransform(svg.getScreenCTM().inverse());
    return { clientX: point.x, clientY: point.y, x: flow.x, y: flow.y };
  });
  const miniZoomBefore = (await readViewportTransform(page)).zoom;
  await page.mouse.click(destination.clientX, destination.clientY);
  await page.waitForTimeout(400);
  const located = await readViewportTransform(page);
  const flowBox = await page.locator('.react-flow').boundingBox();
  assert.ok(Math.abs((flowBox.width / 2 - located.x) / located.zoom - destination.x) < 2, '小地图点击应定位到对应横坐标');
  assert.ok(Math.abs((flowBox.height / 2 - located.y) / located.zoom - destination.y) < 2, '小地图点击应定位到对应纵坐标');
  assert.equal(located.zoom, miniZoomBefore, '点击小地图保持当前缩放');
  await page.waitForTimeout(750);
  const miniSaved = (await (await page.request.get(`${baseUrl}/api/canvas/${viewportCanvasId}`)).json()).canvas.viewport;
  assertViewportClose(miniSaved, located, '小地图跳转后的视口应保存');
  await minimap.click({ button: 'right' });
  assert.equal(await minimap.count(), 0, '右键隐藏小地图');
  assert.equal(await page.locator('[data-testid="context-menu"]').count(), 0, '小地图右键不应弹出画布菜单');
  await page.click('[data-testid="show-minimap"]');
  assert.equal(await minimap.count(), 1, '隐藏后可重新显示小地图');
  assertViewportClose(await readViewportTransform(page), located, '隐藏和显示不得改变视口');

  // 4. 过期 graph revision 启动必须 409，且事务不能创建任何任务。
  const staleCanvasId = await createCanvas(page, '过期运行回归');
  const staleMaterialId = await addMaterialWithImage(page, pngPath);
  const staleImageId = await addNode(page, 'image-generation');
  await selectModel(page, staleImageId, 'fixture-image-edit');
  await fillPrompt(page, staleImageId, '过期修订样本');
  await connect(page, staleMaterialId, staleImageId);
  await waitSaved(page);
  const staleState = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas, staleCanvasId);
  const staleRunExpectation = expectHttpError(
    `${baseUrl}/api/canvas/${staleCanvasId}/runs`,
    'POST',
  );
  const staleRun = await page.evaluate(async ({ id, targetNodeId, expectedGraphRevision }) => {
    const response = await fetch(`/api/canvas/${id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'single',
        targetNodeId,
        requestKey: `stale-${Date.now()}`,
        expectedGraphRevision,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    id: staleCanvasId,
    targetNodeId: staleImageId,
    expectedGraphRevision: Math.max(0, staleState.graphRevision - 1),
  });
  assert.equal(staleRun.status, 409, `过期运行应返回 409：${JSON.stringify(staleRun.body)}`);
  await assertExpectedHttpError(staleRunExpectation, '过期运行启动');
  const staleAfter = await page.evaluate(async (id) => (await (await fetch(`/api/canvas/${id}`)).json()).canvas, staleCanvasId);
  assert.equal(staleAfter.tasks.length, staleState.tasks.length, '过期运行不得增加任务数');

  return {
    delayedSave: delayedSaved,
    concurrentConflict: true,
    viewport: viewportServer,
    staleRunStatus: staleRun.status,
  };
}

/**
 * T6 performance：50 个节点（≥20 个媒体节点）+ 全局 10 个 fixture 任务下，
 * 连续拖动、缩放、输入、保存与切换，记录机器／浏览器／素材信息与观察结果。
 */
async function performanceSuite(page) {
  const perfSeconds = Number(process.env.CANVAS_PERF_SECONDS ?? '300');
  const pngPath = path.join(fixtureDir, '性能素材.png');
  fs.writeFileSync(pngPath, await sharp({ create: { width: 32, height: 32, channels: 3, background: '#7f6f2f' } }).png().toBuffer());

  await createCanvas(page, '性能验证画布');
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  const materialId = await addMaterialWithImage(page, pngPath);
  // 先把客户端草稿落盘，再按服务端图铺开性能样本
  await waitSaved(page);

  // 用真实 PATCH 接口铺开 50 个节点（25 个媒体节点 + 25 个生成节点），避免逐个人工点击
  const built = await page.evaluate(async ({ id, materialNodeId }) => {
    const current = await (await fetch(`/api/canvas/${id}`)).json();
    const graph = current.canvas.graph;
    const material = graph.nodes.find((node) => node.id === materialNodeId);
    const nodes = [...graph.nodes];
    const edges = [...graph.edges];
    for (let index = 1; index < 25; index += 1) {
      const materialId = `perf-m-${index}`;
      nodes.push({ ...material, id: materialId, position: { x: (index % 5) * 260, y: Math.floor(index / 5) * 220 }, data: { ...material.data, title: `素材${index}` } });
    }
    for (let index = 0; index < 25; index += 1) {
      const nodeId = `perf-g-${index}`;
      nodes.push({
        id: nodeId,
        kind: 'image-generation',
        position: { x: 1500 + (index % 5) * 340, y: Math.floor(index / 5) * 260 },
        data: {
          title: `生成${index}`,
          modelKey: 'fixture-image-edit',
          generationMode: 'image-to-image',
          prompt: '性能样本',
          parameters: {},
          references: [],
          referenceLabelCounter: 0,
        },
      });
      edges.push({ id: `perf-e-${index}`, source: index === 0 ? materialNodeId : `perf-m-${index % 25}`, target: nodeId });
    }
    const response = await fetch(`/api/canvas/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedGraphRevision: current.canvas.graphRevision, graph: { ...graph, nodes, edges } }),
    });
    const payload = await response.json();
    return { status: response.status, nodeCount: payload.canvas?.graph?.nodes?.length ?? 0, message: payload.message };
  }, { id: canvasId, materialNodeId: materialId });
  assert.equal(built.status, 200, `性能样本铺设失败：${built.message}`);
  assert.equal(built.nodeCount, 50, `应有 50 个节点，实际 ${built.nodeCount}`);

  // 启动 10 个 fixture 任务（v2 多变体压测：前 5 个节点 ×4、后 5 个 ×1 = 25 个任务，
  // 让长跑交互期间持续存在候选投影轮询与候选缩略图渲染开销）
  const started = await page.evaluate(async ({ id }) => {
    const current = await (await fetch(`/api/canvas/${id}`)).json();
    const expectedGraphRevision = current.canvas.graphRevision;
    let count = 0;
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`/api/canvas/${id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'single',
          targetNodeId: `perf-g-${index}`,
          ...(index < 5 ? { variantCount: 4 } : {}),
          requestKey: `perf-${index}-${Date.now()}`,
          expectedGraphRevision,
        }),
      });
      if (response.ok) count += 1;
    }
    return count;
  }, { id: canvasId });
  assert.equal(started, 10, '应能启动 10 个运行请求');

  await page.reload();
  await page.waitForSelector('[data-testid="canvas-editor"]');
  // 结果自动物化会在任务完成后追加素材节点：节点数只会从 50 往上涨
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 50, null, { timeout: 30_000 });

  const specs = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    mediaNodes: document.querySelectorAll('[data-node-kind="material"] img, [data-node-kind="material"] video').length,
  }));

  // 长时间交互：拖动、缩放、持续输入、保存、切换
  const deadline = Date.now() + perfSeconds * 1000;
  const textarea = `.react-flow__node[data-id="perf-g-0"] [data-testid="generation-prompt"]`;
  await page.click(textarea);
  await page.keyboard.press('End');
  let typed = 0;
  let longTasks = 0;
  await page.evaluate(() => {
    window.__canvasLongTasks = 0;
    try {
      const observer = new PerformanceObserver((list) => {
        window.__canvasLongTasks += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['longtask'] });
      window.__canvasLongTaskObserver = observer;
    } catch {
      window.__canvasLongTaskObserver = null;
    }
  });

  // 心跳：每 5 秒做一次页面往返，用来区分「渲染器主线程阻塞」与「CDP／浏览器进程卡住」。
  // 页面自己的 performance.now() 与 Node 侧往返耗时一起记下来。
  const heartbeats = [];
  let heartbeatStopped = false;
  let lastBeatAt = Date.now();
  const heartbeat = (async () => {
    while (!heartbeatStopped) {
      const now = Date.now();
      const gapMs = now - lastBeatAt;
      lastBeatAt = now;
      if (gapMs > 10_000 && heartbeats.length > 0) {
        console.log(`[perf] heartbeat gap ${gapMs}ms（进程或页面被挂起的迹象）`);
      }
      heartbeats.push({ gapMs, rttMs: 0, pageNow: null, heap: null, error: null });
      heartbeats.pop();
      const startedAt = Date.now();
      try {
        const pageNow = await Promise.race([
          page.evaluate(() => ({
            now: performance.now(),
            heap: performance.memory ? performance.memory.usedJSHeapSize : null,
          })),
          new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timeout')), 10_000)),
        ]);
        heartbeats.push({ gapMs, rttMs: Date.now() - startedAt, pageNow: pageNow.now, heap: pageNow.heap, error: null });
      } catch (error) {
        heartbeats.push({ gapMs, rttMs: Date.now() - startedAt, pageNow: null, heap: null, error: String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  })();

  const rounds = [];
  const stepTimings = {};
  /** 逐步计时：长时间停顿必须能定位到具体是哪个操作。 */
  const timed = async (label, action) => {
    const startedAt = Date.now();
    const value = await action();
    const elapsed = Date.now() - startedAt;
    stepTimings[label] = Math.max(stepTimings[label] ?? 0, elapsed);
    if (elapsed > 2_000) console.log(`[perf] slow step ${label}: ${elapsed}ms (round ${rounds.length})`);
    return value;
  };
  const loopStartedAt = Date.now();
  while (Date.now() < deadline) {
    const roundStart = Date.now();
    const roundStartMono = Number(process.hrtime.bigint() / 1_000_000n);
    if (rounds.length > 0 && rounds.length % 50 === 0) {
      console.log(`[perf] round=${rounds.length} elapsed=${Math.round((roundStart - loopStartedAt) / 1000)}s typed=${typed}`);
    }
    // 每轮先把焦点放回输入框（拖动别的节点会把焦点带走，这是正常交互）；
    // 用 JS 聚焦而不是点击，避免缩放后节点在视口外导致的定位失败。
    await timed('focus', () => page.$eval(textarea, (element) => {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }));
    // 持续输入（任务轮询期间不得丢字）
    await timed('type', async () => { await page.keyboard.type(`第${typed}段`); });
    typed += 1;
    // 拖动一个节点（先把视图适配回来，模拟用户真实的缩放／拖动混合操作）。
    // 用 DOM click 而不是 Playwright click：高负载下工具栏持续重渲染，
    // 可操作性检查会把每一轮拖成几十秒，观察窗口被吃光。
    await timed('fit-view', () => page.evaluate(() => {
      document.querySelector('[data-testid="fit-view"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    }));
    const handle = await timed('handle-box', () => page
      .locator('.react-flow__node[data-id="perf-g-1"] [data-testid="node-drag-handle"]')
      .first()
      .boundingBox());
    if (handle) {
      await timed('drag', async () => {
        await page.mouse.move(handle.x + 4, handle.y + 4);
        await page.mouse.down();
        await page.mouse.move(handle.x + 24, handle.y + 18, { steps: 6 });
        await page.mouse.up();
      });
    }
    // 缩放（真实用户不会每轮都缩放，按每 5 轮一次取样）
    if (rounds.length % 5 === 0) {
      await timed('zoom', async () => {
        await page.mouse.move(700, 500);
        await page.mouse.wheel(0, -120);
        await page.mouse.wheel(0, 120);
      });
    }
    // 人类节奏的停顿：观察窗口要覆盖 5 分钟的真实操作，而不是压测。
    // 注意用 Node 侧 sleep：page.waitForTimeout 是页面内定时器，headless 下会被浏览器
    // 节流（心跳显示页面一直有响应，循环却卡住 200 秒，就是这里被节流造成的）。
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 用单调时钟计算真实耗时：Date.now() 会把系统挂起的时间算进去
    const roundMs = Number(process.hrtime.bigint() / 1_000_000n) - roundStartMono;
    void roundStart;
    if (roundMs > 20_000) console.log(`[perf] slow round ${rounds.length}: ${roundMs}ms`);
    rounds.push(roundMs);
  }
  console.log(`[perf] loop done: rounds=${rounds.length} elapsed=${Math.round((Date.now() - loopStartedAt) / 1000)}s`);
  console.log(`[perf] step max: ${JSON.stringify(stepTimings)}`);
  heartbeatStopped = true;
  await heartbeat;
  const stalledHeartbeats = heartbeats.filter((entry) => entry.error !== null || entry.rttMs > 5_000);
  const maxHeartbeatRtt = heartbeats.reduce((max, entry) => Math.max(max, entry.rttMs), 0);
  const maxHeartbeatGap = heartbeats.reduce((max, entry) => Math.max(max, entry.gapMs ?? 0), 0);
  console.log(`[perf] 心跳间隔最长 ${maxHeartbeatGap}ms（正常应约 5000ms）`);
  if (stalledHeartbeats.length > 0) {
    console.log(`[perf] 心跳异常 ${stalledHeartbeats.length} 次（最长往返 ${maxHeartbeatRtt}ms）：${JSON.stringify(stalledHeartbeats.slice(0, 5))}`);
  } else {
    console.log(`[perf] 心跳正常：${heartbeats.length} 次，最长往返 ${maxHeartbeatRtt}ms`);
  }

  const typedValue = await page.inputValue(textarea);
  const missing = [];
  for (let index = 0; index < typed; index += 1) {
    if (!typedValue.includes(`第${index}段`)) missing.push(index);
  }
  assert.deepEqual(missing, [], `持续输入丢失了这些段落：${missing.join(',')}`);
  longTasks = await page.evaluate(() => window.__canvasLongTasks ?? 0);

  // 保存与切换
  await page.locator(textarea).blur();
  await waitSaved(page);
  // 自动物化会在初始 50 个节点之外新增素材；重载必须保留每个已保存节点。
  const savedNodeIds = await page.$$eval('.react-flow__node', (nodes) => nodes.map((node) => node.getAttribute('data-id')));
  assert.ok(savedNodeIds.length >= 50);
  await page.goto(`${baseUrl}/canvas`);
  await page.waitForSelector('[data-testid="canvas-list"]');
  await page.goto(`${baseUrl}/canvas/${canvasId}`);
  await page.waitForFunction((ids) => {
    const restored = new Set([...document.querySelectorAll('.react-flow__node')].map((node) => node.getAttribute('data-id')));
    return ids.every((id) => restored.has(id));
  }, savedNodeIds, { timeout: 30_000 });
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="generation-prompt"]')?.value?.includes(text) ?? false,
    `第${Math.max(0, typed - 1)}段`,
    { timeout: 20_000 },
  );

  // v2 多变体：25 个任务全部完成（前 5 节点各 4 候选 + 后 5 节点各 1，约 3 批慢任务）。
  // 注意在 Node 侧轮询 API：waitForFunction 的 raf 轮询里发 fetch 会形成请求风暴，
  // 把浏览器连接池打满、页面自己的 1.5s 轮询饿死，UI 就跟不上了。
  let candidatesReady = false;
  const candidatesDeadline = Date.now() + 300_000;
  let lastProgressLog = 0;
  while (Date.now() < candidatesDeadline) {
    try {
      const current = await (await fetch(`${baseUrl}/api/canvas/${canvasId}`)).json();
      const count = (current.canvas?.nodeCandidates ?? []).length;
      if (count >= 25) {
        candidatesReady = true;
        break;
      }
      if (Date.now() - lastProgressLog > 30_000) {
        lastProgressLog = Date.now();
        const phases = {};
        for (const task of current.canvas?.tasks ?? []) phases[task.phase] = (phases[task.phase] ?? 0) + 1;
        console.log(`[perf] 候选进度 ${count}/25，任务阶段 ${JSON.stringify(phases)}`);
      }
    } catch (error) {
      console.log(`[perf] 候选轮询失败：${String(error).slice(0, 160)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal(candidatesReady, true, '25 个任务未在时限内产出候选投影');
  // 产物物化：25 个初始素材节点之外，至少 5 个结果已飞出素材节点
  await page.waitForFunction(
    () => document.querySelectorAll('.react-flow__node:has([data-node-kind="material"])').length >= 30,
    null,
    { timeout: 20_000 },
  );

  const sortedRounds = [...rounds].sort((left, right) => left - right);
  const maxRoundMs = sortedRounds[sortedRounds.length - 1] ?? 0;
  // 长时间停顿必须让套件失败：否则「跑完了」会被误读成「性能没问题」。
  assert.ok(
    maxRoundMs < 60_000,
    `出现长时间停顿：单轮最长 ${Math.round(maxRoundMs / 1000)} 秒（轮次 ${rounds.length}）`,
  );
  return {
    canvasId,
    perfSeconds,
    specs,
    variantTasks: 25,
    rounds: rounds.length,
    medianRoundMs: sortedRounds[Math.floor(sortedRounds.length / 2)],
    maxRoundMs,
    longTasks,
    typedSegments: typed,
    stepMaxMs: stepTimings,
    heartbeat: {
      samples: heartbeats.length,
      maxRttMs: maxHeartbeatRtt,
      maxGapMs: maxHeartbeatGap,
      stalled: stalledHeartbeats.length,
      peakHeapMb: Math.round(
        heartbeats.reduce((max, entry) => Math.max(max, entry.heap ?? 0), 0) / 1024 / 1024,
      ),
    },
  };
}

/**
 * 旧工作台冒烟（验收清单 §3 末条）：受影响的页面入口、供应商设置与新建项目在
 * 画布改动之后仍然可用。只加载隔离数据根下的页面，不提交任何真实生成任务。
 */
async function legacySuite(page) {
  const visited = [];
  // 本套件自己收集页面错误：外层数组只在主流程里可见
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/ERR_INCOMPLETE_CHUNKED_ENCODING|net::ERR_ABORTED/.test(text)) return;
    pageErrors.push(`console: ${text}`);
  });
  for (const [pathname, anchor] of [
    ['/', 'h1'],
    ['/settings', 'h1'],
    ['/projects/new', 'h1'],
  ]) {
    const errorsBefore = pageErrors.length;
    await page.goto(`${baseUrl}${pathname}`);
    await page.waitForSelector(anchor, { timeout: 20_000 });
    // 等一次网络空闲，确保页面数据请求没有把页面打成错误态
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const heading = (await page.locator(anchor).first().innerText()).trim().slice(0, 40);
    assert.ok(heading.length > 0, `${pathname} 的标题为空`);
    assert.equal(
      pageErrors.length,
      errorsBefore,
      `${pathname} 加载期间出现未捕获错误：${pageErrors.slice(errorsBefore).join(' | ')}`,
    );
    visited.push({ pathname, heading });
  }
  return { visited };
}

// --- 执行 -------------------------------------------------------------------

let browser;
let page;
let failure = null;
let pageDump = null;
try {
  await startServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  trackRunRequests(page);
  page.on('response', (response) => {
    const request = response.request();
    const expectation = expectedHttpErrors.find((candidate) => (
      candidate.url === response.url()
      && candidate.method === request.method()
      && candidate.status === response.status()
    ));
    if (!expectation) return;
    expectation.matches += 1;
    expectation.consoleAllowance += 1;
    void response.json().then((payload) => {
      if (payload && typeof payload === 'object' && payload.error === expectation.errorCode) {
        expectation.bodyMatches += 1;
      }
    }).catch(() => undefined);
  });
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // 触发下载（window.location.href → 附件响应）会中止在途请求，
    // 浏览器把这类中止记为资源错误，属于下载流程的正常噪声。
    if (/ERR_INCOMPLETE_CHUNKED_ENCODING|net::ERR_ABORTED/.test(text)) return;
    if (/\b409\b|Conflict/i.test(text)) {
      const expectation = expectedHttpErrors.find((candidate) => candidate.consoleAllowance > 0);
      if (expectation) {
        expectation.consoleAllowance -= 1;
        return;
      }
    }
    browserErrors.push(`console: ${text}`);
  });

  const evidence = {};
  for (const name of requested) {
    runPosts.length = 0;
    if (name === 'interaction') evidence.interaction = await interactionSuite(page);
    if (name === 'seedance') evidence.seedance = await seedanceSuite(page);
    if (name === 'editor') evidence.editor = await editorSuite(page);
    if (name === 'execution') evidence.execution = await executionSuite(page);
    if (name === 'recovery') {
      // 这一套件需要「首次下载失败」的故障注入，单独用一份服务实例
      await startServer({ CREATIVE_STUDIO_CANVAS_FIXTURE_DOWNLOAD_FAIL_ONCE: '1' });
      evidence.recovery = await recoverySuite(page);
    }
    if (name === 'export') {
      await startServer();
      evidence.export = await exportSuite(page);
    }
    if (name === 'legacy') {
      await startServer();
      evidence.legacy = await legacySuite(page);
    }
    if (name === 'regression') {
      await startServer();
      evidence.regression = await regressionSuite(page);
    }
    if (name === 'performance') {
      // 性能观察需要任务长时间在跑：把 fixture 放慢
      await startServer({
        CREATIVE_STUDIO_CANVAS_FIXTURE_DELAY_MS: '2000',
        CREATIVE_STUDIO_CANVAS_FIXTURE_POLLS: '20',
      });
      evidence.performance = await performanceSuite(page);
    }
    assert.deepEqual(browserErrors, [], `页面出现未捕获错误：${browserErrors.join('\n')}`);
    console.log(`suite ${name}：通过`);
  }
  console.log(JSON.stringify({ dataRoot, port, evidence }, null, 2));
} catch (error) {
  failure = error;
  if (page) {
    try {
      pageDump = await page.evaluate(async () => {
        const canvasId = location.pathname.split('/').pop();
        let serverGraph = null;
        try {
          const payload = await (await fetch(`/api/canvas/${canvasId}`)).json();
          serverGraph = {
            revision: payload.canvas.graphRevision,
            nodes: payload.canvas.graph.nodes.length,
            edges: payload.canvas.graph.edges.length,
            rawEdges: payload.canvas.graph.edges,
          };
        } catch (error) {
          serverGraph = { error: String(error) };
        }
        return {
        url: location.pathname,
        statusMessage: document.querySelector('[data-testid="status-message"]')?.textContent ?? null,
        saveState: document.querySelector('[data-testid="save-state"]')?.textContent ?? null,
        edges: document.querySelectorAll('.react-flow__edge').length,
        references: [...document.querySelectorAll('[data-reference]')].map((element) => ({
          label: element.getAttribute('data-reference'),
          detached: element.getAttribute('data-detached'),
          source: element.querySelector('[data-testid^="detach-ref-"]')?.getAttribute('data-testid') ?? null,
        })),
        serverGraph,
        nodes: [...document.querySelectorAll('.react-flow__node')].map((element) => ({
          id: element.getAttribute('data-id'),
          kind: element.querySelector('[data-node-kind]')?.getAttribute('data-node-kind') ?? null,
          result: element.querySelector('[data-canvas-result]')?.getAttribute('data-canvas-result') ?? null,
          status: element.querySelector('[data-canvas-status]')?.getAttribute('data-canvas-status') ?? null,
        })),
      };
      });
    } catch (dumpError) {
      pageDump = { error: String(dumpError) };
    }
  }
} finally {
  if (browser) {
    // 浏览器关闭同样要有界：Playwright 在负载高时可能延迟返回
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
  await stopServer();
  clearTimeout(watchdog);
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

if (failure) {
  console.error('创作画布浏览器验收失败：');
  console.error(failure);
  if (pageDump) {
    console.error('--- 页面诊断 ---');
    console.error(JSON.stringify(pageDump, null, 2));
  }
  console.error('--- 服务输出（尾部）---');
  console.error(serverOutput.join('').split('\n').slice(-40).join('\n'));
  process.exit(1);
}
console.log('creative-canvas.playwright.test.mjs 通过');
