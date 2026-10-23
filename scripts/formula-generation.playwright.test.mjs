/** 第二步真实生成入口：临时数据库、合成原声、仅本机固定转写服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { chromium, expect } from '@playwright/test';

const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-generation-browser-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const proofs = path.resolve('outputs/formula-generation-browser');
fs.mkdirSync(proofs, { recursive: true });
let server, browser, page, db, sourceRequests = 0, releaseSpeech;
const speechGate = new Promise(resolve => { releaseSpeech = resolve; });
const logs = [];
const model = http.createServer(async (request, response) => {
  request.resume(); sourceRequests++;
  await speechGate;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ text: '好擦洗。', words: [{ word: '好擦洗', start: 0.125, end: 2.875 }] }));
});
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离服务未退出')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}
async function start() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [standalone], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' } });
  server.stdout.on('data', chunk => logs.push(String(chunk))); server.stderr.on('data', chunk => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error('隔离服务提前退出');
    const response = await fetch(`${base}/api/batch-production/readiness`).catch(() => null);
    if (response?.ok && (await response.json()).formula?.available) return base;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离服务启动超时');
}
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = `http://127.0.0.1:${model.address().port}`;
  process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
  await start(); await stop();
  db = new Database(path.join(root, 'data/workbench.db'));
  db.pragma('foreign_keys=ON');
  db.exec("UPDATE script_providers SET enabled=0; UPDATE final_edit_tts_providers SET enabled=0,apiKey='',keyEnv='';");
  db.prepare("INSERT INTO providers (id,name,baseUrl,model,type) VALUES ('fixture','验收','http://127.0.0.1:1','fixture','openai-compatible')").run();
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES ('formula-ui','公式生成入口验收','fixture','fixture','','complex_product','FORMULA')").run();
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'formula-ui', '一键制作验收', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'formula-ui', { sourcePath: source });
  registerFormulaAssetBinding(db, 'formula-ui', batchId, { assetId, sourcePath: 'VO1_口播.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [141, '抖音', 1, 3, 'VO1', '好擦洗。'], [142, '抖音', 1, 3, 'P100', '缺素材样本。']]);
  const imported = await createFormulaImportSession(db, 'formula-ui', batchId, { kind: 'scripts', filename: '两条.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'formula-ui', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  db.close(); db = undefined;
  let base = await start();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(20_000);
  const pageUrl = () => `${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${batchId}`;
  await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const settings = page.getByRole('region', { name: '生成设置', exact: true });
  await settings.getByLabel('脚本 141 份数', { exact: true }).fill('2');
  await settings.getByRole('radio', { name: '只用真人原声', exact: true }).check();
  await settings.getByRole('radio', { name: '不加包装', exact: true }).check();
  const generate = settings.getByRole('button', { name: '生成', exact: true });
  await expect(generate).toBeEnabled();
  let acceptedRequest;
  await page.route('**/formula/generation?*', async route => {
    const accepted = await route.fetch();
    assert.equal(accepted.status(), 200);
    acceptedRequest = await accepted.json();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：生成回复丢失，请重试' }) });
  });
  await generate.click();
  await expect(settings.getByRole('alert')).toContainText('生成回复丢失');
  await expect(settings.getByLabel('脚本 141 份数', { exact: true })).toHaveValue('2');
  await expect(generate).toBeEnabled();
  await page.unroute('**/formula/generation?*');
  const posted = page.waitForResponse(response => response.url().includes('/formula/generation?') && response.request().method() === 'POST');
  await generate.click();
  const generated = await posted;
  assert.equal(generated.status(), 200);
  const savedRequest = generated.request().postDataJSON();
  const receipt = await generated.json();
  assert.equal(receipt.requestId, acceptedRequest.requestId, '回复丢失后再次点击沿用已保存请求');
  assert.equal(receipt.outputCount, 3, '点击生成同时保存尚未手动保存的份数和声音设置');
  const progress = page.getByRole('region', { name: '实拍制作进度', exact: true });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('共 3 条');
  await expect.poll(() => sourceRequests).toBeGreaterThan(0);
  await progress.getByRole('button', { name: '暂停批次', exact: true }).click();
  await expect(progress.getByRole('heading', { name: '制作已暂停', exact: true })).toBeVisible();
  await expect(progress.getByRole('button', { name: '继续批次', exact: true })).toBeEnabled();
  await progress.getByRole('button', { name: '继续批次', exact: true }).click();
  await expect(progress.getByRole('heading', { name: '实拍制作进度', exact: true })).toBeVisible();
  await expect(progress.getByRole('button', { name: '暂停批次', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(proofs, 'running.png'), fullPage: true });
  await page.close(); page = undefined;
  await stop(); releaseSpeech(); base = await start();
  const workspaceUrl = () => `${base}/api/batch-production/batches/${batchId}/workspace?projectId=formula-ui`;
  await expect.poll(async () => (await (await fetch(workspaceUrl())).json()).formulaGeneration?.ready, { timeout: 60_000 }).toBe(2);
  const workspace = await (await fetch(workspaceUrl())).json();
  assert.equal(workspace.formulaGeneration.total, 3);
  assert.equal(workspace.formulaGeneration.needsAttention, 1, '缺素材的一条不会阻挡另外两份进入审片');
  assert.equal(workspace.formulaGeneration.finished, false);
  assert.equal(workspace.formulaGeneration.requestId, receipt.requestId, '重启沿用原请求和份次');
  const replay = await fetch(`${base}/api/batch-production/batches/${batchId}/formula/generation?projectId=formula-ui`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(savedRequest) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).requestId, receipt.requestId, '网络重试不建立第二批计划');
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(20_000);
  await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const restored = page.getByRole('region', { name: '实拍制作进度', exact: true });
  await expect(restored).toContainText('已就绪 2 条'); await expect(restored).toContainText('需处理 1 条');
  await expect(page.getByText('部分就绪', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /一键制作验收.*部分就绪/ })).toHaveCount(1);
  await expect(restored).toBeInViewport();
  await expect(restored).toContainText('P100');
  await expect(page.getByRole('button', { name: '修改已保存脚本', exact: true })).toBeDisabled();
  await expect(page.getByText('暂不能点击生成', { exact: false })).toHaveCount(0);
  await restored.screenshot({ path: path.join(proofs, 'progress-light.png') });
  await page.screenshot({ path: path.join(proofs, 'partial-light.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await restored.screenshot({ path: path.join(proofs, 'progress-dark.png') });
  await page.screenshot({ path: path.join(proofs, 'partial-dark.png'), fullPage: true });
  await restored.getByRole('button', { name: '查看已就绪成片', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: '选择成片 2', exact: true })).toBeEnabled();
  const { readFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
  const { listOutputPlans } = await import('../lib/batch-production/plans.ts');
  db = new Database(path.join(root, 'data/workbench.db'), { readonly: true });
  const original = readFormulaGenerationRequest(db, 'formula-ui', batchId, receipt.requestId);
  const originalPlans = listOutputPlans(db, original.batchVersionId);
  db.close(); db = undefined;
  await page.getByRole('button', { name: '准备素材', exact: true }).click();
  await expect(page.getByLabel('选择实拍视频', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  let openedRevision;
  await page.route('**/formula/input-revisions?*', async route => {
    const accepted = await route.fetch(); assert.equal(accepted.status(), 200);
    openedRevision = await accepted.json();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：打开修改的回复丢失，请重试' }) });
  });
  await page.getByRole('button', { name: '修改输入', exact: true }).click();
  await expect(page.getByRole('region', { name: '实拍公式混剪脚本表', exact: true }).getByRole('alert')).toContainText('打开修改的回复丢失');
  await page.unroute('**/formula/input-revisions?*');
  const openingResponse = page.waitForResponse(response => response.url().includes('/formula/input-revisions?') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '修改输入', exact: true }).click();
  assert.deepEqual(await (await openingResponse).json(), openedRevision, '打开修改回复丢失后重试仍是同一输入修订');
  await expect(page.getByText('正在修改下一轮制作的输入。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /一键制作验收.*准备下一轮/ })).toHaveCount(1);
  await expect(page.getByText('已锁定', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修改已保存脚本', exact: true })).toBeEnabled();
  assert.equal((await (await fetch(workspaceUrl())).json()).formulaGeneration.requestId, receipt.requestId, '打开修改不替换当前制作');
  await page.getByRole('button', { name: '准备素材', exact: true }).click();
  await expect(page.getByLabel('选择实拍视频', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const nextSettings = page.getByRole('region', { name: '生成设置', exact: true });
  await nextSettings.getByRole('button', { name: '修改脚本 142', exact: true }).click();
  const editor = page.getByRole('region', { name: '修改脚本行', exact: true });
  await editor.getByLabel('镜头顺序', { exact: true }).fill('VO1');
  await editor.getByLabel('脚本文案', { exact: true }).fill('好擦洗。');
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.close(); page = undefined; await stop(); base = await start();
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(20_000);
  await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  await expect(page.getByText('正在修改下一轮制作的输入。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /一键制作验收.*准备下一轮/ })).toHaveCount(1);
  await expect(page.getByText('已手工修改', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '确认导入 2 条', exact: true }).click();
  const revisedSettings = page.getByRole('region', { name: '生成设置', exact: true });
  await expect(revisedSettings.getByRole('button', { name: '修改脚本 142', exact: true })).toBeEnabled();
  await revisedSettings.getByLabel('脚本 141 份数', { exact: true }).fill('1');
  await revisedSettings.getByRole('radio', { name: '只用真人原声', exact: true }).check();
  await revisedSettings.getByRole('radio', { name: '不加包装', exact: true }).check();
  const beforeRegeneration = (await (await fetch(workspaceUrl())).json()).formulaGeneration;
  assert.equal(beforeRegeneration.requestId, receipt.requestId); assert.equal(beforeRegeneration.ready, 2);
  await page.getByRole('region', { name: '实拍制作进度', exact: true }).getByRole('button', { name: '查看已就绪成片', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  // Leaving the step discards unsaved controls; set the intended count again before Generate.
  await revisedSettings.getByLabel('脚本 141 份数', { exact: true }).fill('1');
  await page.screenshot({ path: path.join(proofs, 'input-revision-light.png'), fullPage: true, animations: 'disabled' });
  const regeneratingResponse = page.waitForResponse(response => response.url().includes('/formula/generation?') && response.request().method() === 'POST');
  await revisedSettings.getByRole('button', { name: '生成', exact: true }).click();
  const regeneration = await regeneratingResponse; assert.equal(regeneration.status(), 200);
  const newReceipt = await regeneration.json();
  assert.notEqual(newReceipt.requestId, receipt.requestId); assert.equal(newReceipt.outputCount, 2);
  await expect.poll(async () => (await (await fetch(workspaceUrl())).json()).formulaGeneration?.ready, { timeout: 60_000 }).toBe(2);
  const revisedProgress = (await (await fetch(workspaceUrl())).json()).formulaGeneration;
  assert.equal(revisedProgress.requestId, newReceipt.requestId); assert.equal(revisedProgress.needsAttention, 0);
  await expect(page.getByRole('region', { name: '实拍制作进度', exact: true })).toContainText('共 2 条');
  await expect(page.getByRole('region', { name: '实拍制作进度', exact: true })).toContainText('已就绪 2 条');
  await expect(page.getByRole('button', { name: '修改已保存脚本', exact: true })).toBeDisabled();
  await expect(page.getByText('正在修改下一轮制作的输入。', { exact: false })).toHaveCount(0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(proofs, 'regenerated-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('region', { name: '实拍制作进度', exact: true }).getByRole('button', { name: '查看已就绪成片', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: '选择成片 2', exact: true })).toBeEnabled();
  db = new Database(path.join(root, 'data/workbench.db'), { readonly: true });
  assert.deepEqual(readFormulaGenerationRequest(db, 'formula-ui', batchId, receipt.requestId), original, '新一轮成功后旧生成快照仍保留');
  assert.deepEqual(listOutputPlans(db, original.batchVersionId), originalPlans, '新一轮不覆盖旧成片计划和版本');
  db.close(); db = undefined;
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', total: 3, ready: 2, needsAttention: 1,
    recoveredSameRequest: true, pauseResume: true, inputRevision: { lostReplyRetry: true, restartDraft: true,
      oldOutputsVisibleWhileEditing: true, previousGenerationPreserved: true, newTotal: 2, newReady: 2, newNeedsAttention: 0 } }, null, 2));
  console.log('公式生成浏览器：生成与重启恢复、修改输入丢回复重试、修正脚本、草稿重启恢复、旧结果保留和新一轮成功通过');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(proofs, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(proofs, 'failure.txt'), await page.locator('body').innerText().catch(() => '页面不可读')); }
  console.error(logs.join('').slice(-2500)); throw error;
} finally {
  releaseSpeech(); await browser?.close(); await stop(); db?.close();
  await new Promise(resolve => model.close(resolve));
  (await import('../lib/db.ts')).closeDb();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
