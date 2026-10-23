import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';

const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
const longSubtitle = process.argv.includes('--long-subtitle');
const caption = longSubtitle
  ? '选沙发先量好客厅的实际尺寸，再看坐深与靠背是否适合家人的习惯。平时喜欢坐着阅读，可以试试扶手的高度；喜欢躺着休息，也要确认腿部能够放松。最后再比较面料的清洁方式，让每天的使用都更省心。'
  : '坐得稳。';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-external-browser-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root; process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const proofs = path.resolve(longSubtitle ? 'outputs/formula-long-subtitle-browser' : 'outputs/formula-external-narration-browser'); fs.mkdirSync(proofs, { recursive: true });
let server, browser, db; const logs = [];
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
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES ('formula-ui','外部配音验收','fixture','fixture','','complex_product','PS866')").run();
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const video = path.join(root, 'G1.mp4'), voice = path.join(root, '配音.wav'), subtitles = path.join(root, '字幕.srt');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', voice]);
  fs.writeFileSync(subtitles, `1\n00:00:00,125 --> 00:00:01,875\n${caption}\n`);
  const batchId = createBatchProduction(db, 'formula-ui', '外部配音浏览器验收', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'formula-ui', { sourcePath: video });
  registerFormulaAssetBinding(db, 'formula-ui', batchId, { assetId, sourcePath: 'G1_静物.mp4' });
  const book = new ExcelJS.Workbook(); book.addWorksheet('脚本').addRows([
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [141, '抖音', 1, 3, 'G1', caption]]);
  const imported = await createFormulaImportSession(db, 'formula-ui', batchId, { kind: 'scripts', filename: '脚本.xlsx', bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: 1 });
  confirmFormulaImportSession(db, 'formula-ui', batchId, imported.id, { expectedRevision: 1, excludedKeys: [] });
  db.close(); db = undefined;
  let base = await start(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(20_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const pageUrl = () => `${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${batchId}`;
  await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  const settings = page.getByRole('region', { name: '生成设置', exact: true });
  await settings.getByRole('radio', { name: '统一配音', exact: true }).check();
  await settings.getByRole('radio', { name: '不加音乐', exact: true }).check();
  await settings.getByRole('radio', { name: '不加包装', exact: true }).check();
  await settings.getByRole('button', { name: '保存生成设置', exact: true }).click();
  const panel = page.getByRole('region', { name: '外部配音与字幕', exact: true });
  await expect(panel.getByLabel('外部配音音频', { exact: true })).toBeEnabled();
  await panel.getByLabel('外部配音音频', { exact: true }).setInputFiles(voice);
  await panel.getByLabel('外部配音 SRT', { exact: true }).setInputFiles(subtitles);
  const confirmation = panel.getByRole('checkbox');
  await expect(confirmation).toBeDisabled();
  await panel.getByLabel('待导入配音试听', { exact: true }).evaluate(async media => { await media.play(); });
  await expect(confirmation).toBeEnabled();
  await panel.getByLabel('待导入配音试听', { exact: true }).evaluate(media => media.pause());
  await confirmation.check();
  await panel.getByLabel('外部配音 SRT', { exact: true }).setInputFiles(subtitles); await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await panel.screenshot({ path: path.join(proofs, 'external-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await panel.screenshot({ path: path.join(proofs, 'external-dark.png') });
  // Chromium's intercepted postData omits disk-backed file bytes. Keep the real browser upload;
  // lose only the response delivered to the application after the server has saved it.
  await page.evaluate(() => {
    const actual = window.fetch.bind(window);
    window.restoreUploadFetch = () => { window.fetch = actual; };
    window.fetch = async (input, init) => {
      const response = await actual(input, init);
      if (String(input).includes('/formula/external-narration?') && init?.method === 'PUT' && response.ok && !window.externalUploadReceipt) {
        window.externalUploadReceipt = await response.clone().json();
        return new Response(JSON.stringify({ message: '验收：保存回复丢失' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
  });
  await panel.getByRole('button', { name: '保存这条脚本的外部配音', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('回复丢失');
  await expect(panel.getByLabel('外部配音音频', { exact: true })).toBeDisabled();
  const receipt = await page.evaluate(() => { window.restoreUploadFetch(); return window.externalUploadReceipt; });
  await panel.getByRole('button', { name: '原样重试保存', exact: true }).click();
  await expect(panel.getByText(/外部配音和字幕已保存/)).toBeVisible();
  const api = () => `${base}/api/batch-production/batches/${batchId}/formula/external-narration?projectId=formula-ui`;
  const saved = await (await fetch(api())).json(); assert.equal(saved.inputRevision, 3); assert.equal(saved.items[0].saved.id, receipt.items[0].saved.id);
  assert(!JSON.stringify(saved).includes('relativePath'), '浏览器不能得到本地存储路径');
  const media = await fetch(`${api()}&narrationId=${saved.items[0].saved.id}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(media.status, 206); assert.equal(Buffer.from(await media.arrayBuffer()).toString(), 'RIFF');
  assert.equal((await fetch(`${api()}&narrationId=other-record`)).status, 404);
  await settings.getByRole('button', { name: '生成', exact: true }).click();
  const workspaceUrl = () => `${base}/api/batch-production/batches/${batchId}/workspace?projectId=formula-ui`;
  await expect.poll(async () => (await (await fetch(workspaceUrl())).json()).formulaGeneration?.ready, { timeout: 60_000 }).toBe(1);
  await stop(); base = await start(); await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  await expect(panel.getByLabel('已保存外部配音试听', { exact: true })).toBeVisible();
  assert.equal((await (await fetch(api())).json()).items[0].saved.id, saved.items[0].saved.id);
  assert.equal((await (await fetch(workspaceUrl())).json()).formulaGeneration.ready, 1);
  if (longSubtitle) {
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    const position = page.getByRole('slider', { name: '播放位置', exact: true });
    await expect(position).toBeEnabled();
    await position.press('Home');
    for (let frame = 0; frame < 36; frame++) await position.press('ArrowRight');
    const subtitle = page.getByRole('img', { name: `字幕：${caption}`, exact: true });
    await expect(subtitle).toBeVisible();
    const layout = await subtitle.evaluate(svg => ({
      width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height,
      lines: [...svg.querySelectorAll('text[fill="#ffffff"]')].map(element => {
        const bounds = element.getBBox(); return { text: element.textContent, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
    }));
    assert(layout.lines.length > 1, '长字幕预览须换行');
    assert.equal(layout.lines.map(line => line.text).join(''), caption, '预览不丢字、不改原文');
    for (const line of layout.lines) {
      assert(line.x >= layout.width * 0.08 && line.x + line.width <= layout.width * 0.92, '预览文字落在安全宽度内');
      assert(line.y >= 0 && line.y + line.height <= layout.height, '预览文字没有越过画面上下边界');
    }
    fs.writeFileSync(path.join(proofs, 'subtitle-layout.json'), JSON.stringify(layout, null, 2));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(proofs, 'subtitle-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expect(subtitle).toBeVisible();
    await expect(subtitle.locator('text[fill="#ffffff"]')).toHaveCount(layout.lines.length);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    fs.writeFileSync(path.join(proofs, 'dark-subtitle-state.json'), JSON.stringify(await subtitle.evaluate(svg => ({
      label: svg.getAttribute('aria-label'), html: svg.innerHTML,
      ancestry: [svg, svg.parentElement, svg.parentElement?.parentElement].filter(Boolean).map(element => {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.getAttribute('class'), bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
          opacity: style.opacity, visibility: style.visibility, display: style.display, filter: style.filter, mixBlendMode: style.mixBlendMode,
          fillOpacity: style.fillOpacity, colorScheme: style.colorScheme, zIndex: style.zIndex, overflow: style.overflow };
      }),
      text: [...svg.querySelectorAll('text')].map(element => ({ text: element.textContent, fill: getComputedStyle(element).fill,
        opacity: getComputedStyle(element).opacity, display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility })),
    })), null, 2));
    const canvasImage = await subtitle.screenshot({ path: path.join(proofs, 'subtitle-dark-canvas.png'), animations: 'disabled' });
    const raster = await sharp(canvasImage).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let visibleTextPixels = 0;
    for (let y = Math.floor(raster.info.height * 0.5); y < raster.info.height; y++) for (let x = 0; x < raster.info.width; x++) {
      const offset = (y * raster.info.width + x) * raster.info.channels;
      if (raster.data[offset] > 200 && raster.data[offset + 1] > 200 && raster.data[offset + 2] > 200) visibleTextPixels++;
    }
    assert(visibleTextPixels > 100, '深色主题实际绘制出字幕，不能只检查 SVG 节点存在');
    fs.writeFileSync(path.join(proofs, 'dark-subtitle-pixels.json'), JSON.stringify({ visibleTextPixels }));
    await page.screenshot({ path: path.join(proofs, 'subtitle-dark.png') });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', importId: saved.items[0].saved.id,
    inputRevision: 3, stereo: true, confirmationReset: true, lostResponseReplay: true, controlledRangeMedia: true, providerFreeReady: true, restart: true,
    ...(longSubtitle ? { longSubtitleAllTextVisible: true, previewBoundsChecked: true } : {}) }, null, 2));
  console.log('external narration browser passed');
} catch (error) { fs.writeFileSync(path.join(proofs, 'server.log'), logs.join('')); throw error; }
finally {
  await browser?.close(); await stop(); db?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
