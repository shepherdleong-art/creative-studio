/** Real browser/API acceptance, isolated standalone and temporary data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';

const standalone = process.env.FORMULA_BROWSER_SERVER;
assert(standalone, '请指定隔离 FORMULA_BROWSER_SERVER');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-hints-browser-'));
const proofs = path.resolve('outputs/formula-replacement-hints-browser'); fs.mkdirSync(proofs, { recursive: true });
fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'running' }));
let server, browser, page;
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
  server = spawn(process.execPath, [standalone], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_FORMULA_MIXCUT: '1' } });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error('隔离服务提前退出');
    const response = await fetch(`${base}/api/batch-production/readiness`).catch(() => null);
    if (response?.ok && (await response.json()).formula?.available) return base;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离启动超时');
}
try {
  await start(); await stop();
  const db = new Database(path.join(root, 'data/workbench.db'));
  try {
    db.exec("UPDATE script_providers SET enabled=0; INSERT INTO providers (id,name,baseUrl,model,type) VALUES ('fixture','验收','http://127.0.0.1:1','fixture','openai-compatible'); INSERT INTO projects (id,name,providerId,model,prompt) VALUES ('hints','替换建议验收','fixture','fixture','');");
  } finally { db.close(); }
  let base = await start();
  const created = await fetch(`${base}/api/batch-production/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'hints', name: '旧建议导入', planningMode: 'formula' }) });
  assert.equal(created.status, 201); const batchId = (await created.json()).id;
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(15_000);
  const open = async () => page.goto(`${base}/projects/hints?tab=final-edit&mixcut=batch&batch=${batchId}`);
  await open();
  let panel = page.getByRole('region', { name: '替换建议参考', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByLabel('替换建议文件', { exact: true }).setInputFiles({ name: 'substitutions.json', mimeType: 'application/json',
    buffer: Buffer.from('{"S76":{"sub":"S1","orig_group":"高脚"},"P100":{"sub":"P1"}}') });
  await panel.getByRole('button', { name: '读取建议', exact: true }).click();
  await expect(panel).toContainText('预览 2 项');
  let accepted;
  await page.route('**/replacement-hints?*', async route => {
    if (route.request().method() !== 'POST' || !route.request().url().includes('action=save')) return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200); accepted = await response.json();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：导入回复丢失' }) });
  });
  await panel.getByRole('button', { name: '保存为候选参考', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('回复丢失');
  await page.unroute('**/replacement-hints?*');
  const retry = page.waitForResponse(response => response.url().includes('action=save') && response.request().method() === 'POST');
  await panel.getByRole('button', { name: '保存为候选参考', exact: true }).click();
  assert.equal((await (await retry).json()).acceptedId, accepted.acceptedId);
  await expect(panel).toContainText('已保存 2 项');
  await expect(panel).toContainText('原编号尚未定义');
  await page.close(); page = undefined; await stop(); base = await start();
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); await open();
  panel = page.getByRole('region', { name: '替换建议参考', exact: true });
  await expect(panel).toContainText('已保存 2 项');
  await expect(panel).toContainText('S76 → S1'); await expect(panel).toContainText('P100 → P1');
  await panel.screenshot({ path: path.join(proofs, 'hints-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await panel.screenshot({ path: path.join(proofs, 'hints-dark.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: '清除本批建议', exact: true }).click();
  await expect(panel).toContainText('未使用导入的替换建议');
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', preview: true, lostReplyRetry: true, restartRestored: true, cleared: true }, null, 2));
  console.log('替换建议浏览器：预览、真实保存重试、重启恢复、未定义提示及清除通过');
} catch (error) {
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'failed', message: String(error) }, null, 2));
  if (page) { await page.screenshot({ path: path.join(proofs, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(proofs, 'failure.txt'), await page.locator('body').innerText().catch(() => '页面不可读')); }
  throw error;
} finally {
  await browser?.close(); await stop();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
