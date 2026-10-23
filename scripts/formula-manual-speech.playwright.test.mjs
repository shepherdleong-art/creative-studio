/** 无 ASR 服务的人工原声恢复：真实页面、临时数据、合成音视频。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { chromium, expect } from '@playwright/test';

const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-manual-speech-browser-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = '';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = '';
const proofs = path.resolve('outputs/formula-manual-speech-browser');
fs.mkdirSync(proofs, { recursive: true });
fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'running' }));
let server, browser, page, db;
const logs = [];
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离服务未退出')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}
async function start() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
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
  await start(); await stop();
  db = new Database(path.join(root, 'data/workbench.db')); db.pragma('foreign_keys=ON');
  db.exec("UPDATE script_providers SET enabled=0; UPDATE final_edit_tts_providers SET enabled=0,apiKey='',keyEnv='';");
  db.prepare("INSERT INTO providers (id,name,baseUrl,model,type) VALUES ('fixture','验收','http://127.0.0.1:1','fixture','openai-compatible')").run();
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES ('manual-ui','人工原声验收','fixture','fixture','','complex_product','MANUAL')").run();
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'manual-ui', '人工原声恢复', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'manual-ui', { sourcePath: source });
  registerFormulaAssetBinding(db, 'manual-ui', batchId, { assetId, sourcePath: 'VO1_原声.mp4' });
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 1, 2, 'VO1', '好擦洗。坐得稳。']]);
  const imported = await createFormulaImportSession(db, 'manual-ui', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'manual-ui', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  db.close(); db = undefined;
  let base = await start();
  const pageUrl = () => `${base}/projects/manual-ui?tab=final-edit&mixcut=batch&batch=${batchId}`;
  const workspaceUrl = () => `${base}/api/batch-production/batches/${batchId}/workspace?projectId=manual-ui`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(20_000);
  await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const settings = page.getByRole('region', { name: '生成设置', exact: true });
  await settings.getByRole('radio', { name: '只用真人原声', exact: true }).check();
  await settings.getByRole('radio', { name: '不加包装', exact: true }).check();
  await settings.getByRole('button', { name: '生成', exact: true }).click();
  const progress = page.getByRole('region', { name: '实拍制作进度', exact: true });
  await expect(progress).toContainText('未配置原声转写服务', { timeout: 30_000 });
  const failed = (await (await fetch(workspaceUrl())).json()).formulaGeneration;
  assert.equal(failed.needsAttention, 1);
  await page.getByRole('button', { name: '准备素材', exact: true }).click();
  await page.getByRole('button', { name: '修改输入', exact: true }).click();
  let panel = page.getByRole('region', { name: '人工核对原声', exact: true });
  await panel.getByLabel('人工核对的原片', { exact: true }).selectOption(assetId);
  const video = panel.getByLabel('人工台词原片预览', { exact: true });
  await video.evaluate(element => element.play());
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await video.evaluate(element => element.pause());
  await panel.getByRole('radio', { name: '人工填写台词和时间', exact: true }).check();
  await panel.getByLabel('台词片段 1', { exact: true }).fill('好擦洗。');
  await panel.getByLabel('片段 1 开始秒', { exact: true }).fill('0.25');
  await panel.getByLabel('片段 1 结束秒', { exact: true }).fill('3');
  await panel.getByRole('checkbox', { name: '我已试听，确认台词和时间与原片一致', exact: true }).check();
  await panel.getByRole('button', { name: '确认并保存原声记录', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('时间须在原片内');
  await panel.getByLabel('片段 1 结束秒', { exact: true }).fill('0.9');
  await panel.getByRole('button', { name: '添加台词片段', exact: true }).click();
  await panel.getByLabel('台词片段 2', { exact: true }).fill('坐得稳。');
  await panel.getByLabel('片段 2 开始秒', { exact: true }).fill('1.1');
  await panel.getByLabel('片段 2 结束秒', { exact: true }).fill('1.75');
  await panel.getByRole('checkbox', { name: '我已试听，确认台词和时间与原片一致', exact: true }).check();
  let accepted;
  await page.route('**/formula/manual-speech?*', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200); accepted = await response.json();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：人工台词保存回复丢失' }) });
  });
  await panel.getByRole('button', { name: '确认并保存原声记录', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('保存回复丢失');
  await page.unroute('**/formula/manual-speech?*');
  const saving = page.waitForResponse(response => response.url().includes('/formula/manual-speech?') && response.request().method() === 'PUT');
  await panel.getByRole('button', { name: '确认并保存原声记录', exact: true }).click();
  const saved = await (await saving).json(); assert.equal(saved.items[0].saved.id, accepted.items[0].saved.id);
  await expect(panel.getByRole('status')).toContainText('人工原声记录已保存');
  await page.close(); page = undefined; await stop(); base = await start();
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(20_000);
  await page.goto(pageUrl()); await page.getByRole('button', { name: '准备素材', exact: true }).click();
  panel = page.getByRole('region', { name: '人工核对原声', exact: true });
  await panel.getByLabel('人工核对的原片', { exact: true }).selectOption(assetId);
  await expect(panel.getByLabel('台词片段 2', { exact: true })).toHaveValue('坐得稳。');
  await expect(panel.getByLabel('片段 2 结束秒', { exact: true })).toHaveValue('1.75');
  await panel.screenshot({ path: path.join(proofs, 'manual-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await panel.screenshot({ path: path.join(proofs, 'manual-dark.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  await page.getByRole('region', { name: '生成设置', exact: true }).getByRole('button', { name: '生成', exact: true }).click();
  const finished = page.getByRole('region', { name: '实拍制作进度', exact: true });
  await expect(finished).toContainText('已就绪 1 条', { timeout: 60_000 });
  const ready = (await (await fetch(workspaceUrl())).json()).formulaGeneration;
  assert.notEqual(ready.requestId, failed.requestId); assert.equal(ready.needsAttention, 0);
  await finished.screenshot({ path: path.join(proofs, 'ready-dark.png'), animations: 'disabled' });
  await finished.getByRole('button', { name: '查看已就绪成片', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
  const { getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
  const { readFormulaSpeech } = await import('../lib/batch-production/formula/speech-store.ts');
  db = new Database(path.join(root, 'data/workbench.db'), { readonly: true });
  const output = getBatchOutputArrangementView(db, 'manual-ui', batchId, ready.items[0].planId);
  assert.equal(output.subtitleCues.map(cue => cue.text).join(''), '好擦洗。坐得稳。');
  const actualSpeech = readFormulaSpeech(db, 'manual-ui', batchId, ready.items[0].planId).sources[0].result;
  assert.equal(actualSpeech.manualVerification.revisionId, accepted.items[0].saved.id);
  assert.equal(actualSpeech.transcriptionIdentity, null);
  db.close(); db = undefined;
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', serviceUnavailable: true, rangeRejected: true,
    lostReplyRetry: true, restartRestored: true, manualOrigin: true, ready: 1, subtitles: ['好擦洗。', '坐得稳。'] }, null, 2));
  console.log('人工原声浏览器：无识别服务、时间越界拒绝、人工台词保存重试、重启恢复、实际字幕与审片通过');
} catch (error) {
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'failed', message: String(error) }, null, 2));
  if (page) { await page.screenshot({ path: path.join(proofs, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(proofs, 'failure.txt'), await page.locator('body').innerText().catch(() => '页面不可读')); }
  console.error(logs.join('').slice(-2000)); throw error;
} finally {
  await browser?.close(); await stop(); db?.close(); (await import('../lib/db.ts')).closeDb();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
