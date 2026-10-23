/**
 * 实拍公式入口与导入的真实浏览器验收：
 *   npm run build
 *   node scripts/formula-entry-import.playwright.test.mjs
 * 只启动 127.0.0.1 随机端口及临时数据根；模型 HTTP 使用本机测试服务，不调用外部模型或 /api/shutdown。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { chromium, expect } from '@playwright/test';
import { runFfmpeg } from '../lib/ffmpeg.ts';

// 当前工作台占用 .next 时，可使用另一个隔离构建的 standalone 入口。
const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
assert(fs.existsSync(standalone), '请先运行 npm run build');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-browser-'));
const proofs = path.resolve('outputs/formula-import-browser');
fs.mkdirSync(proofs, { recursive: true });
let server;
let browser;
let db;
let modelServer;
const output = [];
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离测试服务未退出')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}
async function startServer(enabled) {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [standalone], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_FORMULA_MIXCUT: enabled ? '1' : '0', HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' } });
  server.stdout.on('data', chunk => output.push(String(chunk)));
  server.stderr.on('data', chunk => output.push(String(chunk)));
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error('隔离服务提前退出');
    try {
      const response = await fetch(`${base}/api/batch-production/readiness`);
      if (response.ok) { const readiness = await response.json(); assert.equal(readiness.available, true); assert.equal(readiness.formula.available, enabled); return base; }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离服务启动超时');
}
try {
  let base = await startServer(true);
  db = new Database(path.join(root, 'data/workbench.db'));
  db.pragma('foreign_keys=ON');
  db.prepare('UPDATE script_providers SET enabled=0').run();
  db.prepare("UPDATE final_edit_tts_providers SET enabled=0,apiKey='',keyEnv=''").run();
  db.prepare("INSERT INTO providers (id,name,baseUrl,model,type) VALUES ('fixture','验收','http://127.0.0.1:1','fixture','openai-compatible')").run();
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES ('formula-ui','实拍入口验收','fixture','fixture','','complex_product','FORMULA')").run();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/projects/formula-ui?tab=final-edit&mixcut=batch`);
  await expect(page.getByRole('radio', { name: /^普通智能混剪/ })).toBeChecked();
  await expect(page.getByText('创建后不能更换剪辑方式；选错请另建批次。', { exact: true })).toBeVisible();
  const createPanel = page.getByRole('heading', { name: '新建批次', exact: true }).locator('..');
  await createPanel.getByText('实拍公式混剪', { exact: true }).click();
  await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeChecked();
  await page.getByRole('radio', { name: /^普通智能混剪/ }).check();
  await page.getByLabel('新批次名称').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: /^普通智能混剪/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: /^普通智能混剪/ })).toBeChecked();
  await createPanel.screenshot({ path: path.join(proofs, 'entry-form-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await createPanel.screenshot({ path: path.join(proofs, 'entry-form-dark.png') });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('请先输入新批次名称。')).toBeVisible();
  await page.getByRole('radio', { name: /^实拍公式混剪/ }).check();
  await page.getByLabel('新批次名称').fill('PS866 实拍首批');
  const createPattern = '**/api/batch-production/batches';
  let releaseCreate;
  const heldCreate = new Promise(resolve => { releaseCreate = resolve; });
  let failedCreateCount = 0;
  await page.route(createPattern, async route => {
    if (route.request().method() === 'POST') {
      failedCreateCount++;
      await heldCreate;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：临时创建失败' }) });
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '创建', exact: true }).click();
  try {
    await expect(page.getByRole('button', { name: '创建中…', exact: true })).toBeDisabled();
    await expect(page.getByLabel('新批次名称')).toBeDisabled();
    await expect(page.getByRole('radio', { name: /^普通智能混剪/ })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeDisabled();
    await page.getByRole('button', { name: '创建中…', exact: true }).dispatchEvent('click');
    await page.getByLabel('新批次名称').dispatchEvent('keydown', { key: 'Enter' });
  } finally { releaseCreate(); }
  await expect(page.getByText('验收：临时创建失败')).toBeVisible();
  await expect(page.getByLabel('新批次名称')).toHaveValue('PS866 实拍首批');
  await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeChecked();
  await expect(page.getByLabel('新批次名称')).toBeEnabled();
  await expect(page.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  assert.equal(failedCreateCount, 1, '提交期间点击或回车不能重复创建');
  await page.unroute(createPattern);
  // 已选实拍后，服务端才发现能力失效：保留选择并阻止继续按旧状态提交。
  const readinessPattern = '**/api/batch-production/readiness';
  await page.route(readinessPattern, async route => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ response, json: { ...state, formula: { available: false, message: '验收：实拍能力暂不可用' } } });
  });
  await page.route(createPattern, async route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：实拍能力暂不可用' }) }) : route.continue());
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeDisabled();
  await expect(page.getByLabel('新批次名称')).toHaveValue('PS866 实拍首批');
  await expect(page.getByRole('button', { name: '创建', exact: true })).toBeDisabled();
  await createPanel.screenshot({ path: path.join(proofs, 'entry-form-unavailable.png') });
  await page.getByRole('radio', { name: /^普通智能混剪/ }).check();
  await expect(page.getByRole('button', { name: '创建', exact: true })).toBeEnabled();
  await page.unroute(createPattern);
  await page.unroute(readinessPattern);
  await page.reload();
  await page.getByRole('radio', { name: /^实拍公式混剪/ }).check();
  await page.getByLabel('新批次名称').fill('PS866 实拍首批');
  let createCount = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/batch-production/batches') createCount++; });
  await page.getByLabel('新批次名称').press('Enter');
  await expect(page.getByRole('heading', { name: '导入实拍视频', exact: true })).toBeVisible();
  await expect(page.getByLabel('新批次名称')).toHaveValue('');
  await expect(page.getByRole('radio', { name: /^普通智能混剪/ })).toBeChecked();
  const batch = db.prepare("SELECT id,planningMode FROM batch_productions WHERE projectId='formula-ui'").get();
  assert.equal(batch.planningMode, 'formula');
  assert.equal(createCount, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_tasks').get().n, 0, '创建批次不能启动任务');
  await page.getByRole('radio', { name: /^实拍公式混剪/ }).check();
  await page.getByRole('radio', { name: /^普通智能混剪/ }).check();
  await expect(page.getByRole('heading', { name: '导入实拍视频', exact: true })).toBeVisible();

  // 只发送声明超限的请求头；不得真的分配或传送数百 MB 的测试数据。
  const oversizedResponse = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/batch-production/assets/import?projectId=formula-ui&formulaBatchId=${batch.id}`, {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=oversized-fixture', 'Content-Length': '600000000', Connection: 'close' },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('超限请求应在读取文件前返回')));
    request.on('error', reject);
    request.end();
  });
  assert.equal(oversizedResponse.status, 413, '超限应返回容量错误，不能误报表单格式错误');
  assert.match(oversizedResponse.body.message, /512.*分批/);
  const malformedResponse = await fetch(`${base}/api/batch-production/assets/import?projectId=formula-ui&formulaBatchId=${batch.id}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'invalid multipart',
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).error, 'invalid_form_data');

  const video = path.join(root, 'source.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  const buffer = fs.readFileSync(video);
  const uploads = ['G1_正面.mp4', 'G10_别名.mp4', 'GB9.preview.mp4', '定格布置.mp4'].map(name => ({ name, mimeType: 'video/mp4', buffer }));
  let uploadsCount = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/batch-production/assets/import') uploadsCount++; });
  await page.getByLabel('选择实拍视频').setInputFiles(uploads);
  await expect(page.getByText('本次导入 4 个，已存在 0 个，未完成 0 个。')).toBeVisible();
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_assets').get().n, 1, '同内容只存一份素材');
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_formula_asset_bindings').get().n, 4, '同内容不同编号不能丢绑定');
  await expect(page.getByText('已导入文件', { exact: true }).locator('..')).toContainText('4');
  await expect(page.getByLabel('选择实拍视频')).toBeEnabled();
  // 等资料回读结束后再选择同一批文件，与用户可操作的状态一致。
  await expect(page.getByText(/已登记 4 个文件来源/)).toBeVisible();
  const beforeRepeat = await page.getByLabel('选择实拍视频').evaluate(element => ({ value: element.value, fileCount: element.files.length, disabled: element.disabled }));
  await page.getByLabel('选择实拍视频').setInputFiles(uploads);
  try {
    await expect(page.getByText('本次导入 0 个，已存在 4 个，未完成 0 个。')).toBeVisible();
  } catch (error) {
    console.error(JSON.stringify({ beforeRepeat, afterRepeat: await page.getByLabel('选择实拍视频').evaluate(element => ({ value: element.value, fileCount: element.files.length, disabled: element.disabled })), uploadsCount, errors }));
    throw error;
  }
  assert.equal(uploadsCount, 1, '重新选择相同文件不能重复上传已确认内容');
  const unmappedRow = page.getByRole('row').filter({ hasText: '定格布置.mp4' });
  await unmappedRow.getByLabel('素材编号').fill('VO1');
  await unmappedRow.getByRole('button', { name: '保存', exact: true }).click();
  await expect(unmappedRow.getByLabel('素材编号')).toHaveValue('VO1');
  await expect.poll(() => db.prepare("SELECT logicalCode FROM batch_formula_asset_bindings WHERE sourceName='定格布置.mp4'").get().logicalCode).toBe('VO1');
  const materials = new ExcelJS.Workbook();
  materials.addWorksheet('素材').addRows([['逻辑编号', '画面描述'], ['G1', '产品正面'], ['S76', '3cm 金属脚']]);
  await page.getByLabel('选择素材命名表', { exact: true }).setInputFiles({ name: '素材.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await materials.xlsx.writeBuffer()) });
  await page.getByRole('button', { name: '确认导入 2 条', exact: true }).click();
  await expect(page.getByText('已保存：素材.xlsx · 2 条')).toBeVisible();
  const notesPanel = page.getByRole('region', { name: '素材内容整理', exact: true });
  const frontNote = notesPanel.getByRole('article').filter({ has: page.getByText('G1_正面.mp4', { exact: true }) });
  await frontNote.getByRole('button', { name: '修改说明', exact: true }).click();
  await notesPanel.getByLabel('素材内容说明', { exact: true }).fill('人工确认的正面展示');
  await notesPanel.getByLabel('素材类别', { exact: true }).fill('外观');
  await notesPanel.getByRole('button', { name: '保存素材说明', exact: true }).click();
  await expect(frontNote.getByText('人工确认的正面展示', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(proofs, 'materials-light.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: path.join(proofs, 'materials-dark.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  const alternative = path.join(root, 'alternative.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', alternative]);
  await page.getByLabel('选择实拍视频').setInputFiles({ name: 'G1_侧面.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(alternative) });
  await expect(page.getByText('本次导入 1 个，已存在 0 个，未完成 0 个。')).toBeVisible();
  const selectionPanel = page.getByRole('region', { name: '人工选片', exact: true });
  await expect(selectionPanel).toBeVisible();
  const rulesUrl = `${base}/api/batch-production/batches/${batch.id}/formula/selection-rules?projectId=formula-ui`;
  const choices = await (await page.request.get(rulesUrl)).json();
  const alternativeId = choices.materials.bindings.find(item => item.sourceName === 'G1_侧面.mp4').assetId;
  const rangesPanel = page.getByRole('region', { name: '可用区间', exact: true });
  await expect(rangesPanel).toBeVisible();
  await rangesPanel.getByLabel('标记可用区间的原片', { exact: true }).selectOption(alternativeId);
  await rangesPanel.getByLabel('片段 1 起点（秒）', { exact: true }).fill('0');
  await rangesPanel.getByLabel('片段 1 终点（秒）', { exact: true }).fill('0.75');
  await expect.poll(() => rangesPanel.getByLabel('区间原片预览').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
  await rangesPanel.getByRole('button', { name: '播放片段 1', exact: true }).click();
  await expect.poll(() => rangesPanel.getByLabel('区间原片预览').evaluate(video => video.currentTime)).toBeGreaterThan(0.5);
  await expect.poll(() => rangesPanel.getByLabel('区间原片预览').evaluate(video => video.paused)).toBe(true);
  assert.ok(await rangesPanel.getByLabel('区间原片预览').evaluate(video => video.currentTime <= 0.85), '区间试听应在选定终点附近停止');
  await expect(rangesPanel.getByRole('button', { name: '确认并保存区间', exact: true })).toBeDisabled();
  await rangesPanel.getByLabel('我已看过这些片段，确认画面可用且动作完整', { exact: true }).check();
  let releaseRulesRefresh, pendingRulesRefresh;
  const rulesRefreshGate = new Promise(resolve => { releaseRulesRefresh = resolve; });
  const holdRulesRefresh = route => {
    if (route.request().method() !== 'GET') return route.continue();
    pendingRulesRefresh = (async () => {
      const response = await route.fetch();
      await rulesRefreshGate;
      await route.fulfill({ response });
    })();
    return pendingRulesRefresh;
  };
  await page.route(rulesUrl, holdRulesRefresh);
  try {
    await rangesPanel.getByRole('button', { name: '确认并保存区间', exact: true }).click();
    await expect(rangesPanel.getByText('可用区间已保存，声音仍待核验。', { exact: true })).toBeVisible();
    await expect.poll(() => Boolean(pendingRulesRefresh)).toBe(true);
    await expect(selectionPanel.getByLabel('G1 主片', { exact: true })).toBeDisabled();
    await expect(selectionPanel.getByText('正在更新素材与可用区间…', { exact: true })).toBeVisible();
  } finally {
    releaseRulesRefresh();
    await pendingRulesRefresh;
    await page.unroute(rulesUrl, holdRulesRefresh);
  }
  await selectionPanel.getByLabel('G1 主片', { exact: true }).selectOption(alternativeId);
  await selectionPanel.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(selectionPanel.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(selectionPanel.getByLabel('G1 主片', { exact: true })).toHaveValue(alternativeId);
  const rangeOriginalId = choices.materials.bindings.find(item => item.sourceName === 'G1_正面.mp4').assetId;
  await rangesPanel.getByLabel('标记可用区间的原片', { exact: true }).selectOption(rangeOriginalId);
  await rangesPanel.getByLabel('片段 1 起点（秒）', { exact: true }).fill('0');
  await rangesPanel.getByLabel('片段 1 终点（秒）', { exact: true }).fill('1');
  await rangesPanel.getByLabel('片段 1 保留完整动作', { exact: true }).check();
  await rangesPanel.getByLabel('片段 1 动作开始（秒）', { exact: true }).fill('0.25');
  await rangesPanel.getByLabel('片段 1 动作结束（秒）', { exact: true }).fill('0.75');
  await rangesPanel.getByLabel('我已看过这些片段，确认画面可用且动作完整', { exact: true }).check();
  await rangesPanel.getByRole('button', { name: '确认并保存区间', exact: true }).click();
  await expect(rangesPanel.getByText('可用区间已保存，声音仍待核验。', { exact: true })).toBeVisible();
  await selectionPanel.getByLabel('G1 主片', { exact: true }).selectOption('__rotation');
  await selectionPanel.getByLabel('G1 轮换候选 G1_侧面.mp4', { exact: true }).check();
  await selectionPanel.getByLabel('G1 轮换候选 G1_正面.mp4', { exact: true }).check();
  await selectionPanel.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(selectionPanel.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(selectionPanel.getByLabel('G1 主片', { exact: true })).toHaveValue('__rotation');
  await expect(selectionPanel.getByLabel('G1 轮换候选 G1_侧面.mp4', { exact: true })).toBeChecked();
  await expect(selectionPanel.getByLabel('G1 轮换候选 G1_正面.mp4', { exact: true })).toBeChecked();
  await rangesPanel.getByLabel('标记可用区间的原片', { exact: true }).selectOption(rangeOriginalId);
  await expect(rangesPanel.getByLabel('片段 1 动作结束（秒）', { exact: true })).toHaveValue('0.75');
  await rangesPanel.screenshot({ path: path.join(proofs, 'ranges-light.png'), animations: 'disabled' });
  await selectionPanel.screenshot({ path: path.join(proofs, 'rotation-light.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await rangesPanel.screenshot({ path: path.join(proofs, 'ranges-dark.png'), animations: 'disabled' });
  await selectionPanel.screenshot({ path: path.join(proofs, 'rotation-dark.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await rangesPanel.getByLabel('标记可用区间的原片', { exact: true }).selectOption(alternativeId);
  await rangesPanel.getByLabel('片段 1 终点（秒）', { exact: true }).fill('0.625');
  await rangesPanel.getByLabel('我已看过这些片段，确认画面可用且动作完整', { exact: true }).check();
  const rangesPattern = '**/formula/ranges?*';
  await page.route(rangesPattern, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：区间暂时无法保存' }) }) : route.continue());
  await rangesPanel.getByRole('button', { name: '确认并保存区间', exact: true }).click();
  await expect(rangesPanel.getByRole('alert')).toContainText('验收：区间暂时无法保存');
  await expect(rangesPanel.getByLabel('片段 1 终点（秒）', { exact: true })).toHaveValue('0.625');
  await page.unroute(rangesPattern);
  await rangesPanel.getByRole('button', { name: '确认并保存区间', exact: true }).click();
  await expect(rangesPanel.getByText('可用区间已保存，声音仍待核验。', { exact: true })).toBeVisible();
  await expect(selectionPanel.getByText('区间已改，请取消后重新勾选', { exact: true })).toBeVisible();
  await expect(selectionPanel.getByRole('button', { name: '保存人工选片', exact: true })).toBeDisabled();
  await selectionPanel.getByLabel('G1 轮换候选 G1_侧面.mp4', { exact: true }).uncheck();
  await selectionPanel.getByLabel('G1 轮换候选 G1_侧面.mp4', { exact: true }).check();
  await selectionPanel.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(selectionPanel.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /脚本与口播/ }).click();
  const scripts = new ExcelJS.Workbook();
  const sheet = scripts.addWorksheet('脚本');
  sheet.addRow(['序号', '平台', '镜头数', '预估时长(s)', '画面分镜（逻辑镜号组合）', '脚本文案']);
  for (let i = 1; i <= 300; i++) sheet.addRow([i, '抖音', 3, 16, 'G1 VO1 G10', `测试文案 ${i}`]);
  await page.getByLabel('选择脚本表', { exact: true }).setInputFiles({ name: '300条.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await scripts.xlsx.writeBuffer()) });
  await page.getByRole('button', { name: '确认导入 300 条', exact: true }).click();
  await expect(page.getByText('已保存：300条.xlsx · 300 条')).toBeVisible();
  const originalAssetId = choices.materials.bindings.find(item => item.sourceName === 'G10_别名.mp4').assetId;
  const slotValue = JSON.stringify(['G10', originalAssetId]);
  await selectionPanel.getByLabel('选择要指定镜头的脚本', { exact: true }).selectOption('1:2');
  await selectionPanel.getByLabel('脚本 1 第 1 个镜头素材', { exact: true }).selectOption(slotValue);
  await expect(selectionPanel.getByText('人工指定：G1 → G10，会保留替换记录供审片核对。', { exact: true })).toBeVisible();
  const rulesPattern = '**/formula/selection-rules?*';
  await page.route(rulesPattern, async route => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：人工选片暂时无法保存' }) });
    return route.continue();
  });
  await selectionPanel.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(selectionPanel.getByRole('alert')).toContainText('验收：人工选片暂时无法保存');
  await expect(selectionPanel.getByLabel('脚本 1 第 1 个镜头素材', { exact: true })).toHaveValue(slotValue);
  await page.unroute(rulesPattern);
  await selectionPanel.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(selectionPanel.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await selectionPanel.getByRole('button', { name: '预览第 1 个镜头', exact: true }).click();
  await expect.poll(() => selectionPanel.getByLabel('人工选片原片预览').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
  await selectionPanel.getByLabel('人工选片原片预览').evaluate(video => video.play());
  await expect.poll(() => selectionPanel.getByLabel('人工选片原片预览').evaluate(video => video.currentTime)).toBeGreaterThan(0.1);
  await selectionPanel.getByLabel('人工选片原片预览').evaluate(video => video.pause());
  await selectionPanel.screenshot({ path: path.join(proofs, 'manual-selection-light.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await selectionPanel.screenshot({ path: path.join(proofs, 'manual-selection-dark.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  const savedChoices = await (await page.request.get(rulesUrl)).json();
  assert.equal(savedChoices.saved.rules.primary.length, 0);
  assert.equal(savedChoices.saved.rules.rotation[0].candidates.length, 2);
  assert.equal(savedChoices.saved.rules.overrides[0].slotIndex, 0);
  assert.equal(savedChoices.saved.rules.overrides[0].sourceLogicalCode, 'G10');
  const obsoleteSave = await page.request.put(rulesUrl, { data: { expectedInputRevision: choices.inputRevision, expectedRulesRevision: 0,
    scriptsSessionId: null, rules: { primary: [], overrides: [] } } });
  assert.equal(obsoleteSave.status(), 409, '旧页面不能覆盖新选择');
  assert.equal((await page.request.get(rulesUrl.replace('projectId=formula-ui', 'projectId=other-project'))).status(), 404);
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await selectionPanel.getByLabel('选择要指定镜头的脚本', { exact: true }).selectOption('1:2');
  await expect(selectionPanel.getByLabel('脚本 1 第 1 个镜头素材', { exact: true })).toHaveValue(slotValue);
  const generationSettings = page.getByRole('region', { name: '生成设置', exact: true });
  const productionSettings = generationSettings.getByRole('region', { name: '声音和包装设置', exact: true });
  await expect(productionSettings).toBeVisible();
  await expect(productionSettings.getByRole('radio', { name: '原声优先，其余配音', exact: true })).toBeChecked();
  await expect(productionSettings.getByRole('radio', { name: '整批统一包装', exact: true })).toBeChecked();
  await expect(generationSettings.getByRole('radio', { name: '不加音乐', exact: true })).toBeChecked();
  await generationSettings.getByRole('button', { name: '取消全选', exact: true }).click();
  await generationSettings.getByLabel('查找脚本', { exact: true }).fill('12');
  await generationSettings.getByLabel('选择脚本 12', { exact: true }).check();
  await generationSettings.getByLabel('脚本 12 份数', { exact: true }).fill('2');
  await generationSettings.getByLabel('查找脚本', { exact: true }).fill('141');
  await generationSettings.getByLabel('选择脚本 141', { exact: true }).check();
  await generationSettings.getByLabel('查找脚本', { exact: true }).fill('');
  await expect(generationSettings.getByText('已选 2 条脚本，共 3 份', { exact: true })).toBeVisible();
  await generationSettings.getByRole('radio', { name: '自动分配', exact: true }).check();
  await expect(generationSettings.getByText('曲库为空，请添加音乐或改为不加音乐。', { exact: true })).toBeVisible();
  await expect(generationSettings.getByRole('button', { name: '保存生成设置', exact: true })).toBeDisabled();
  await generationSettings.getByRole('radio', { name: '手动选音乐', exact: true }).check();
  await expect(generationSettings.getByText('请至少选择一首音乐，或改为不加音乐。', { exact: true })).toBeVisible();
  await generationSettings.getByRole('radio', { name: '不加音乐', exact: true }).check();
  await productionSettings.getByRole('radio', { name: '只用真人原声', exact: true }).check();
  await expect(productionSettings.getByLabel('公式配音供应商')).toHaveCount(0);
  await productionSettings.getByRole('radio', { name: '随机分配包装', exact: true }).check();
  await productionSettings.getByRole('checkbox', { name: 'f2 手账拼贴', exact: true }).check();
  const timingSettings = generationSettings.getByRole('group', { name: '成片时长', exact: true });
  await expect(timingSettings.getByLabel('时长规则', { exact: true })).toHaveValue('reference');
  await expect(timingSettings.getByLabel('目标秒数', { exact: true })).toHaveValue('');
  await timingSettings.getByLabel('目标秒数', { exact: true }).fill('-1');
  await expect(generationSettings.getByRole('button', { name: '保存生成设置', exact: true })).toBeDisabled();
  await timingSettings.getByLabel('目标秒数', { exact: true }).fill('18.5');
  await timingSettings.getByLabel('时长规则', { exact: true }).selectOption('strict_max');
  await timingSettings.getByLabel('计时范围', { exact: true }).selectOption('body');
  await timingSettings.getByLabel('原声前后保留毫秒', { exact: true }).fill('200');
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(generationSettings.getByText('已选 2 条脚本，共 3 份', { exact: true })).toBeVisible();
  await expect(generationSettings.getByRole('radio', { name: '不加音乐', exact: true })).toBeChecked();
  await expect(timingSettings.getByLabel('时长规则', { exact: true })).toHaveValue('strict_max');
  await expect(timingSettings.getByLabel('目标秒数', { exact: true })).toHaveValue('18.5');
  await expect(timingSettings.getByLabel('计时范围', { exact: true })).toHaveValue('body');
  await expect(timingSettings.getByLabel('原声前后保留毫秒', { exact: true })).toHaveValue('200');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await timingSettings.screenshot({ path: path.join(proofs, `timing-${theme}.png`), animations: 'disabled' });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect(productionSettings.getByRole('radio', { name: '只用真人原声', exact: true })).toBeChecked();
  await expect(productionSettings.getByRole('radio', { name: '随机分配包装', exact: true })).toBeChecked();
  await expect(productionSettings.getByRole('checkbox', { name: 'f2 手账拼贴', exact: true })).toBeChecked();
  await generationSettings.getByLabel('查找脚本', { exact: true }).fill('12');
  await expect(generationSettings.getByLabel('脚本 12 份数', { exact: true })).toHaveValue('2');
  await generationSettings.getByLabel('查找脚本', { exact: true }).fill('');
  const bgmDirectory = path.join(root, 'storage', 'bgm');
  const bgmPath = path.join(bgmDirectory, '验收音乐.wav');
  const musicUpload = path.join(root, '验收音乐.wav');
  const brokenMusicUpload = path.join(root, '损坏音乐.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-y', musicUpload]);
  const bgmBytes = fs.readFileSync(musicUpload);
  fs.writeFileSync(brokenMusicUpload, 'not an audio file');
  await generationSettings.getByRole('radio', { name: '手动选音乐', exact: true }).check();
  const addMusic = generationSettings.getByRole('button', { name: '添加音乐', exact: true });
  await expect(addMusic).toBeVisible();
  async function chooseMusicFiles(files) {
    const chooser = page.waitForEvent('filechooser');
    await addMusic.click();
    await (await chooser).setFiles(files);
  }
  await chooseMusicFiles([musicUpload, brokenMusicUpload]);
  await expect(generationSettings.getByRole('status')).toContainText('已添加 1 首，已复用 0 首，失败 1 首');
  await expect(generationSettings.getByRole('alert')).toContainText('损坏音乐.wav');
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).not.toBeChecked();
  await expect(generationSettings.getByText('已选 2 条脚本，共 3 份', { exact: true })).toBeVisible();
  assert.deepEqual(fs.readFileSync(bgmPath), bgmBytes, '上传后保存真实音乐副本');
  await generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true }).check();
  await chooseMusicFiles([musicUpload]);
  await expect(generationSettings.getByRole('status')).toContainText('已添加 0 首，已复用 1 首，失败 0 首');
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toBeChecked();
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toHaveCount(1);
  await chooseMusicFiles([brokenMusicUpload]);
  await expect(generationSettings.getByRole('status')).toContainText('已添加 0 首，已复用 0 首，失败 1 首');
  await expect(generationSettings.getByRole('alert')).toContainText('损坏音乐.wav');
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toBeChecked();
  await page.route('**/api/final-edit-bgm', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收模拟：暂时无法添加音乐' }) }));
  await chooseMusicFiles([musicUpload]);
  await expect(generationSettings.getByRole('alert')).toContainText('验收模拟：暂时无法添加音乐');
  await expect(generationSettings.getByText('已选 2 条脚本，共 3 份', { exact: true })).toBeVisible();
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toBeChecked();
  await page.unroute('**/api/final-edit-bgm');
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await generationSettings.getByLabel('查找脚本', { exact: true }).fill('141');
  await page.setViewportSize({ width: 1440, height: 1400 });
  await generationSettings.screenshot({ path: path.join(proofs, 'settings-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await generationSettings.screenshot({ path: path.join(proofs, 'settings-dark.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toBeChecked();
  fs.unlinkSync(bgmPath);
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByRole('alert')).toContainText('音乐文件缺失');
  await expect(generationSettings.getByRole('radio', { name: '手动选音乐', exact: true })).toBeChecked();
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toBeChecked();
  await generationSettings.getByRole('button', { name: '重新扫描曲库', exact: true }).click();
  await expect(generationSettings.getByText('有已选音乐不在当前曲库，请重新选择或改为不加音乐。', { exact: true })).toBeVisible();
  await expect(generationSettings.getByRole('radio', { name: '手动选音乐', exact: true })).toBeChecked();
  await generationSettings.getByRole('radio', { name: '不加音乐', exact: true }).check();
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  fs.writeFileSync(bgmPath, bgmBytes);
  await generationSettings.getByRole('radio', { name: '自动分配', exact: true }).check();
  await generationSettings.getByRole('button', { name: '重新扫描曲库', exact: true }).click();
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-c:a', 'pcm_s16le', '-y', bgmPath]);
  await generationSettings.getByRole('button', { name: '重新扫描曲库', exact: true }).click();
  await generationSettings.getByRole('radio', { name: '手动选音乐', exact: true }).check();
  await expect(generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true })).toHaveCount(1);
  await generationSettings.getByLabel('选择音乐 验收音乐.wav', { exact: true }).check();
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await generationSettings.getByRole('radio', { name: '不加音乐', exact: true }).check();
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  // 设置使用真实目录与保存 API，但不会调用 TTS 或产生制作任务。
  db.prepare("UPDATE final_edit_tts_providers SET enabled=1,apiKey='fixture-voice-secret',keyEnv='' WHERE id='vapi-qwen3-tts'").run();
  const { defaultTextStyle } = await import('../lib/media-core/cover-domain.ts');
  const { OUTPUT_PRESETS } = await import('../lib/media-core/cover-types.ts');
  const stylesByPreset = Object.fromEntries(Object.entries(OUTPUT_PRESETS).map(([id, dimensions]) => [id, {
    primary: defaultTextStyle('coverPrimary', dimensions.width), secondary: defaultTextStyle('coverSecondary', dimensions.width),
    framing: { scale: 1.3, offsetX: 0.1, offsetY: 0 },
  }]));
  const coverFixtures = [];
  for (const name of ['公式验收封面 A', '公式验收封面 B']) {
    const response = await fetch(`${base}/api/final-edit/title-presets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, version: 2, stylesByPreset }) });
    assert.equal(response.status, 201);
    coverFixtures.push(await response.json());
  }
  await generationSettings.getByRole('button', { name: '重新读取设置', exact: true }).click();
  await productionSettings.getByRole('radio', { name: '原声优先，其余配音', exact: true }).check();
  await productionSettings.getByLabel('公式配音供应商').selectOption('vapi-qwen3-tts');
  await productionSettings.getByLabel('公式配音音色').selectOption('Ethan');
  await productionSettings.getByLabel('公式配音语速').fill('1.3');
  await productionSettings.getByLabel('输出画幅', { exact: true }).selectOption('16x9');
  await productionSettings.getByRole('radio', { name: '整批统一包装', exact: true }).check();
  await productionSettings.getByRole('radio', { name: 'f3 极简高级', exact: true }).check();
  await productionSettings.getByRole('radio', { name: '随机分配封面预设', exact: true }).check();
  await expect(generationSettings.getByRole('button', { name: '保存生成设置', exact: true })).toBeDisabled();
  await productionSettings.getByRole('checkbox', { name: '公式验收封面 A', exact: true }).check();
  await productionSettings.getByRole('checkbox', { name: '公式验收封面 B', exact: true }).check();
  await expect(productionSettings.getByText('开启包装时，封面预设只应用画面构图；封面文字由包装模板显示，不叠加预设标题样式。', { exact: true })).toBeVisible();
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  const productionResponse = await (await fetch(`${base}/api/batch-production/batches/${batch.id}/formula/settings?projectId=formula-ui`)).json();
  assert.equal(productionResponse.saved.settings.production.audio.tts.voice, 'Ethan');
  assert.equal(productionResponse.saved.settings.production.audio.tts.speed, 1.3);
  assert.deepEqual(productionResponse.saved.settings.production.cover.presetIds, coverFixtures.map(item => item.id).sort());
  assert(!JSON.stringify(productionResponse).includes('fixture-voice-secret'));
  await productionSettings.screenshot({ path: path.join(proofs, 'production-settings-light.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await productionSettings.screenshot({ path: path.join(proofs, 'production-settings-dark.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(productionSettings.getByLabel('公式配音音色')).toHaveValue('Ethan');
  await expect(productionSettings.getByLabel('公式配音语速')).toHaveValue('1.3');
  await expect(productionSettings.getByLabel('输出画幅', { exact: true })).toHaveValue('16x9');
  await expect(productionSettings.getByRole('checkbox', { name: '公式验收封面 B', exact: true })).toBeChecked();
  await expect(generationSettings.getByText('已选 2 条脚本，共 3 份', { exact: true })).toBeVisible();
  const settingsPattern = '**/formula/settings?*';
  await page.route(settingsPattern, async route => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：生成设置暂时无法保存' }) });
    await route.continue();
  });
  await productionSettings.getByLabel('公式配音语速').fill('1.4');
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByRole('alert')).toContainText('验收：生成设置暂时无法保存');
  await expect(productionSettings.getByLabel('公式配音语速')).toHaveValue('1.4');
  await page.unroute(settingsPattern);
  const deletedCover = await fetch(`${base}/api/final-edit/title-presets/${coverFixtures[1].id}`, { method: 'DELETE' });
  assert.equal(deletedCover.status, 204);
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByRole('alert')).toContainText('封面预设已删除或样式不可用');
  await expect(productionSettings.getByLabel('公式配音语速')).toHaveValue('1.4');
  await productionSettings.getByRole('radio', { name: '整批统一封面预设', exact: true }).check();
  await productionSettings.getByRole('radio', { name: '公式验收封面 A', exact: true }).check();
  await productionSettings.getByRole('radio', { name: '不加包装', exact: true }).check();
  await productionSettings.getByRole('radio', { name: '统一配音', exact: true }).check();
  await generationSettings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  await expect(generationSettings.getByText('设置已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(productionSettings.getByRole('radio', { name: '统一配音', exact: true })).toBeChecked();
  await expect(productionSettings.getByRole('radio', { name: '不加包装', exact: true })).toBeChecked();
  await expect(productionSettings.getByRole('radio', { name: '整批统一封面预设', exact: true })).toBeChecked();
  await expect(productionSettings.getByLabel('公式配音语速')).toHaveValue('1.4');
  await page.getByRole('button', { name: '修改脚本 1', exact: true }).click();
  const scriptEditor = page.getByRole('region', { name: '修改脚本行', exact: true });
  await scriptEditor.getByLabel('平台', { exact: true }).fill('小红书');
  await scriptEditor.getByLabel('目标时长（秒）', { exact: true }).fill('24');
  await scriptEditor.getByLabel('镜头顺序', { exact: true }).fill('G10 VO1 G10');
  await scriptEditor.getByLabel('脚本文案', { exact: true }).fill('在页面修改的脚本文案。');
  await scriptEditor.getByText('查看 Excel 原文与修改记录', { exact: true }).click();
  await expect(scriptEditor.getByText('测试文案 1', { exact: true })).toBeVisible();
  const scriptEditPattern = '**/formula/imports?*';
  await page.route(scriptEditPattern, async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.action === 'edit_script') {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: '验收：其他页面已更新预览' }) });
    }
    await route.continue();
  });
  await scriptEditor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByText('验收：其他页面已更新预览', { exact: true })).toBeVisible();
  await expect(scriptEditor.getByLabel('脚本文案', { exact: true })).toHaveValue('在页面修改的脚本文案。');
  await page.unroute(scriptEditPattern);
  await scriptEditor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByText('在页面修改的脚本文案。', { exact: true })).toBeVisible();
  const beforeConfirm = await (await page.request.get(`${base}/api/batch-production/batches/${batch.id}/formula/imports?projectId=formula-ui`)).json();
  assert.equal(beforeConfirm.scripts.rows[0].bodyText, '测试文案 1', '修改预览不提前覆盖已确认资料');
  await page.getByRole('button', { name: '修改脚本 1', exact: true }).click();
  await scriptEditor.getByText('查看 Excel 原文与修改记录', { exact: true }).click();
  await expect(scriptEditor.getByText('已保存 1 次手工修改', { exact: true })).toBeVisible();
  await expect(scriptEditor.getByText('修改前：测试文案 1', { exact: true })).toBeAttached();
  await page.setViewportSize({ width: 1440, height: 1400 });
  await scriptEditor.screenshot({ path: path.join(proofs, 'script-editor-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await scriptEditor.screenshot({ path: path.join(proofs, 'script-editor-dark.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await scriptEditor.getByRole('button', { name: '取消修改', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(page.getByText('在页面修改的脚本文案。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认导入 300 条', exact: true }).click();
  const afterConfirm = await (await page.request.get(`${base}/api/batch-production/batches/${batch.id}/formula/imports?projectId=formula-ui`)).json();
  assert.equal(afterConfirm.scripts.rows[0].bodyText, '在页面修改的脚本文案。');
  assert.equal(afterConfirm.scripts.rows[0].original['脚本文案'], '测试文案 1');
  assert.deepEqual(afterConfirm.scripts.rows[0].codes, ['G10', 'VO1', 'G10']);
  assert.equal(afterConfirm.scripts.rows[0].platform, '小红书');
  assert.equal(afterConfirm.scripts.rows[0].targetDurationSec, 24);
  await expect(selectionPanel.getByRole('button', { name: '保存人工选片', exact: true })).toBeDisabled();
  await expect(selectionPanel.getByText(/脚本已更新，旧的单镜头指定需要重新核对/)).toBeVisible();
  await selectionPanel.getByRole('button', { name: '清除旧的单镜头指定', exact: true }).click();
  await selectionPanel.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(selectionPanel.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();
  assert.equal((await (await page.request.get(rulesUrl)).json()).saved.rules.overrides.length, 0);
  await expect(generationSettings.getByText('脚本已更新，请按当前脚本重新选择并保存设置。', { exact: true })).toBeVisible();
  await expect(page.getByText('已导入脚本', { exact: true }).locator('..')).toContainText('300');
  await page.getByRole('button', { name: '查看全部 300 条', exact: true }).click();
  await expect(page.getByRole('cell', { name: '300', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '导入实拍视频', exact: true })).toBeVisible();
  assert.equal(new URL(page.url()).searchParams.get('batch'), batch.id);
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(page.getByText('已保存：300条.xlsx · 300 条')).toBeVisible();
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_tasks').get().n, 0, '仅导入不能启动制作任务');

  // 自定义列名：无模型时可手动选择列，刷新仍保留；随后走真实模型适配器连接本机假服务。
  const customBook = new ExcelJS.Workbook();
  const customSheet = customBook.addWorksheet('自定义列');
  customSheet.addRow(['投放测试表']);
  customSheet.addRow(['编号', '渠道', '镜头数量', '秒数', '素材顺序', '旁白']);
  customSheet.addRow([701, '抖音', 3, 16, 'G1 VO1 G1', '第一句原文，不可改写。']);
  customSheet.addRow([702, '淘宝', 2, 18, 'G10 VO1', '第二句原文。']);
  await page.getByLabel('选择脚本表', { exact: true }).setInputFiles({ name: '自定义列.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await customBook.xlsx.writeBuffer()) });
  await expect(page.getByRole('button', { name: '用 AI 识别表头', exact: true })).toBeDisabled();
  await page.getByLabel('自定义列 表头行', { exact: true }).selectOption('2');
  const columns = { '序号': 1, '平台': 2, '镜头数': 3, '预估时长(s)': 4, '画面分镜(逻辑镜号组合)': 5, '脚本文案': 6 };
  for (const [field, column] of Object.entries(columns)) await page.getByLabel(`自定义列 ${field}对应列`, { exact: true }).selectOption(String(column));
  await page.screenshot({ path: path.join(proofs, 'columns-mapping.png'), fullPage: true });
  await page.getByRole('button', { name: '保存列对应并重新预览', exact: true }).click();
  await expect(page.getByText('第一句原文，不可改写。', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(page.getByRole('button', { name: '确认导入 2 条', exact: true })).toBeEnabled();

  let modelCalls = 0;
  let materialCalls = 0;
  const modelBodies = [];
  modelServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    let content;
    if (input.kind === 'material_names') {
      materialCalls++;
      content = { items: materialCalls === 1 ? [] : input.items.map(item => ({ bindingId: item.bindingId, content: {
        description: `根据命名：${item.filename}`, category: '', sellingPoints: [], actions: [], speech: 'unknown',
        evidence: [{ field: 'description', source: 'filename', quote: item.filename }], conflicts: [],
      } })) };
    } else {
      modelBodies.push(body);
      modelCalls++;
      content = modelCalls === 1 ? { mapping: [] } : { mapping: [{ sheetId: customSheet.id, headerRow: 2, columns }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'local-fixture', choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 80 } }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  db.prepare(`INSERT INTO script_providers (id,name,type,apiStyle,baseUrl,apiKey,model,enabled,maxTokens,executionScope)
    VALUES ('formula-model-fixture','本机识别验收','openai-compatible','openai-compatible',?,'fixture-key','fixture-model',1,4096,'external')`)
    .run(`http://127.0.0.1:${modelServer.address().port}/v1`);
  await page.reload();
  await expect(notesPanel.getByRole('status')).toContainText('本次整理未全部完成');
  assert.equal(materialCalls, 1);
  await notesPanel.getByRole('button', { name: '整理未完成项（3）', exact: true }).click();
  await expect(notesPanel.getByRole('status')).toContainText('本次整理完成');
  await expect(notesPanel.getByText('根据命名：G10_别名.mp4', { exact: true })).toBeVisible();
  await expect(frontNote.getByText('人工确认的正面展示', { exact: true })).toBeVisible();
  assert.equal(materialCalls, 2);
  await notesPanel.screenshot({ path: path.join(proofs, 'material-notes-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await notesPanel.screenshot({ path: path.join(proofs, 'material-notes-dark.png') });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await page.getByRole('button', { name: '用 AI 识别表头', exact: true }).click();
  await expect(page.getByRole('region', { name: '实拍公式混剪脚本表', exact: true }).getByRole('alert')).toContainText('AI 未能确定');
  await expect(page.getByRole('button', { name: '确认导入 2 条', exact: true })).toBeEnabled();
  assert.equal(materialCalls, 2, '刷新不应重新请求已保存的素材说明');
  await page.getByRole('button', { name: '重新用 AI 识别', exact: true }).click();
  await expect(page.getByText(/已由 本机识别验收 识别列对应/)).toBeVisible();
  await expect(page.getByText('G1 → VO1 → G1', { exact: true })).toBeVisible();
  assert.equal(modelCalls, 2);
  assert.equal(modelBodies[1].temperature, 1);
  const modelInput = JSON.parse(modelBodies[1].messages.find(message => message.role === 'user').content);
  assert.equal(modelInput.sheet.name, '自定义列');
  assert.equal(modelInput.sheet.samples.length, 4);
  await expect(page.getByRole('button', { name: '重新用 AI 识别', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(proofs, 'columns-light.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: path.join(proofs, 'columns-dark.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /脚本与口播/ }).click();
  await expect(page.getByText(/已由 本机识别验收 识别列对应/)).toBeVisible();
  await page.getByRole('button', { name: '确认导入 2 条', exact: true }).click();
  await expect(page.getByText('已保存：自定义列.xlsx · 2 条')).toBeVisible();
  customSheet.getCell('F4').value = '再次导入，自动识别。';
  await page.getByLabel('选择脚本表', { exact: true }).setInputFiles({ name: '自动识别.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await customBook.xlsx.writeBuffer()) });
  await expect.poll(() => modelCalls).toBe(3);
  await expect(page.getByText('再次导入，自动识别。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认导入 2 条', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '修改脚本 702', exact: true }).click();
  await scriptEditor.getByLabel('镜头数', { exact: true }).fill('3');
  await scriptEditor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认导入 1 条', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '修正第 4 行', exact: true }).click();
  await scriptEditor.getByLabel('镜头数', { exact: true }).fill('2');
  await scriptEditor.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('button', { name: '确认导入 2 条', exact: true }).click();
  await expect(page.getByText('已保存：自动识别.xlsx · 2 条')).toBeVisible();
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_tasks').get().n, 0);

  // 另一批次验证真实分批上传：第一批已保存，第二批停在网络边界，停止后只补剩余文件。
  db.prepare('UPDATE script_providers SET enabled=0').run();
  const resumeBatchResponse = await fetch(`${base}/api/batch-production/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'formula-ui', name: '中断补传验收', planningMode: 'formula' }) });
  assert.equal(resumeBatchResponse.status, 201);
  const resumeBatch = await resumeBatchResponse.json();
  await page.goto(`${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${resumeBatch.id}`);
  await expect(page.getByLabel('选择实拍视频')).toBeEnabled();
  const resumeUploads = Array.from({ length: 21 }, (_, index) => ({ name: `P${index + 200}_补传验收.mp4`, mimeType: 'video/mp4', buffer }));
  const uploadPattern = `**/api/batch-production/assets/import?projectId=formula-ui&formulaBatchId=${resumeBatch.id}`;
  let batchUploadRequests = 0;
  let heldUpload;
  await page.route(uploadPattern, async route => {
    batchUploadRequests++;
    if (batchUploadRequests === 2) { heldUpload = route; return; }
    await route.continue();
  });
  await page.getByLabel('选择实拍视频').setInputFiles(resumeUploads);
  await expect.poll(() => batchUploadRequests, { timeout: 30_000 }).toBe(2);
  await page.getByRole('button', { name: '停止本次导入', exact: true }).click();
  await heldUpload.abort().catch(() => {});
  await page.unroute(uploadPattern);
  await expect(page.getByText('本次导入 20 个，已存在 0 个，未完成 1 个。', { exact: true })).toBeVisible();
  await expect(page.getByText(/已登记 20 个文件来源/)).toBeVisible();
  const retryResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().includes(`/assets/import?projectId=formula-ui&formulaBatchId=${resumeBatch.id}`));
  await page.getByRole('button', { name: '重试未完成文件', exact: true }).click();
  const retryReceipt = await (await retryResponse).json();
  assert.equal(retryReceipt.receipts.length, 1, '只上传并登记未完成的一个文件');
  await expect(page.getByText('本次导入 1 个，已存在 0 个，未完成 0 个。', { exact: true })).toBeVisible();
  await expect(page.getByText(/已登记 21 个文件来源/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('选择实拍视频')).toBeEnabled();
  await page.getByLabel('选择实拍视频').setInputFiles(resumeUploads);
  await expect(page.getByText('本次导入 0 个，已存在 21 个，未完成 0 个。', { exact: true })).toBeVisible();
  // 文件已保存但成功回执丢失：重试必须先核对现有内容，不能重复登记来源。
  let lostResponseUploads = 0;
  await page.route(uploadPattern, async route => {
    lostResponseUploads++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    if (lostResponseUploads === 1) await route.abort('connectionfailed');
    else await route.fulfill({ response });
  });
  await page.getByLabel('选择实拍视频').setInputFiles({ name: 'P221_回执丢失.mp4', mimeType: 'video/mp4', buffer });
  await expect(page.getByText('本次导入 0 个，已存在 0 个，未完成 1 个。', { exact: true })).toBeVisible();
  await expect(page.getByText(/已登记 22 个文件来源/)).toBeVisible();
  await page.getByRole('button', { name: '重试未完成文件', exact: true }).click();
  await expect(page.getByText('本次导入 0 个，已存在 1 个，未完成 0 个。', { exact: true })).toBeVisible();
  assert.equal(lostResponseUploads, 1, '回执丢失后重试应识别已保存来源，不再次上传');
  await expect(page.getByText(/已登记 22 个文件来源/)).toBeVisible();
  await page.unroute(uploadPattern);
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_tasks').get().n, 0, '分批停止、补传及刷新不启动制作');

  await stopServer();
  base = await startServer(false);
  const blocked = await fetch(`${base}/api/batch-production/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'formula-ui', name: '拒绝创建', planningMode: 'formula' }) });
  assert.equal(blocked.status, 503);
  const ordinary = await fetch(`${base}/api/batch-production/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'formula-ui', name: '普通仍可创建' }) });
  assert.equal(ordinary.status, 201);
  await page.goto(`${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${batch.id}`);
  await expect(page.getByRole('radio', { name: /^实拍公式混剪/ })).toBeDisabled();
  await expect(page.getByText(/此批次仍保留为实拍公式混剪/)).toBeVisible();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('formula-entry-import browser: 区间/保护动作/批准轮换/重新确认、人工主片/单镜头指定/真实预览、新建/视频停止补传/超限/300 行、声音包装/脚本修订/AI、刷新保存与关闭能力隔离通过');
} catch (error) {
  console.error(output.join('').slice(-5000));
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  if (modelServer) await new Promise(resolve => modelServer.close(resolve));
  db?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
