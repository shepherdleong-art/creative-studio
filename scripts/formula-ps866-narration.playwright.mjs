/** Real-service acceptance, only after the user authorizes GPT table/script samples and Doubao narration.
 * node scripts/formula-ps866-narration.playwright.mjs --state <import state.json> --gateway-state <stack.json> [--render 2]
 * Uses the existing isolated PS866 batch. Does not approve, publish, or alter original media/production data.
 * Credentials and the actual gateway config/state are attached temporarily, then removed on exit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';

const args = process.argv.slice(2), arg = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const repository = fs.realpathSync(process.cwd());
const statePath = fs.realpathSync(arg('--state'));
const root = path.dirname(statePath);
assert(root.startsWith(path.join(repository, 'outputs', 'formula-ps866') + path.sep));
const imported = JSON.parse(fs.readFileSync(statePath, 'utf8'));
assert.equal(imported.root, root); assert.equal(imported.extractionMode, 'real_model');
assert.equal(imported.importedVideos, 257); assert.equal(imported.scriptRows, 300);
const { projectId, batchId } = imported;
const proof = path.join(root, 'narration'); fs.mkdirSync(proof, { recursive: true });
const summaryPath = path.join(proof, 'summary.json');
const priorSummary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
const renderCount = Number(arg('--render') ?? 2);
assert(Number.isInteger(renderCount) && renderCount >= 0 && renderCount <= 8);
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(repository, false, { info() {}, error() {} });
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
const originalDb = new Database(path.join(repository, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
const providers = [];
try {
  for (const [table, id] of [['script_providers', 'gpt'], ['final_edit_tts_providers', 'doubao-seed-tts-2']]) {
    const row = originalDb.prepare(`SELECT * FROM ${table} WHERE id=? AND enabled=1`).get(id);
    assert(row, `${id} 未启用`);
    const credential = row.apiKey?.trim() || (row.keyEnv && process.env[row.keyEnv]?.trim());
    assert(credential, `${id} 尚未配置`);
    providers.push({ table, credential, row: { ...row, apiKey: credential, keyEnv: '',
      baseUrl: row.baseUrl?.trim() || process.env[row.baseUrlEnv] || row.defaultBaseUrl,
      model: row.model?.trim() || process.env[row.modelEnv] || row.defaultModel, baseUrlEnv: '', modelEnv: '' } });
  }
} finally { originalDb.close(); }
const safe = value => providers.reduce((text, provider) => text.replaceAll(provider.credential, '[REDACTED]'), String(value));
let server, browser, page, db, base;
const logs = [], temporaryRuntimeFiles = [];
const summary = { status: 'running', projectId, batchId, originalMediaChanged: false, humanReview: 'pending', formallyPublished: false };
const save = () => fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离服务未退出')), 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}
async function start() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [standalone], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) throw new Error('隔离服务提前退出');
    const response = await fetch(`${base}/api/batch-production/readiness`).catch(() => null);
    if (response?.ok && (await response.json()).formula?.available) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离服务启动超时');
}
const endpoint = suffix => `${base}/api/batch-production/batches/${batchId}/${suffix}?projectId=${projectId}`;
const pageUrl = () => `${base}/projects/${projectId}?tab=final-edit&mixcut=batch&batch=${batchId}`;
async function workspace() { const result = await fetch(endpoint('workspace')); assert(result.ok); return result.json(); }
try {
  const gatewayState = fs.realpathSync(arg('--gateway-state'));
  assert(gatewayState.startsWith(path.join(repository, 'outputs', 'formula-ps866') + path.sep));
  const running = JSON.parse(fs.readFileSync(gatewayState, 'utf8'));
  assert.equal(new URL(providers[0].row.baseUrl).origin, `http://127.0.0.1:${running.proxyPort}`);
  process.kill(running.litellmPid, 0);
  assert((await fetch(`http://127.0.0.1:${running.proxyPort}/health/liveliness`, { signal: AbortSignal.timeout(5000) })).ok);
  fs.mkdirSync(path.join(root, 'storage', 'run'), { recursive: true });
  for (const [from, to] of [[path.join(repository, 'config.yaml'), path.join(root, 'config.yaml')],
    [gatewayState, path.join(root, 'storage', 'run', 'stack.json')]]) {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); temporaryRuntimeFiles.push(to);
  }
  db = new Database(path.join(root, 'data', 'workbench.db'));
  db.pragma('foreign_keys=ON');
  for (const { table, row } of providers) {
    db.prepare(`UPDATE ${table} SET enabled=0,apiKey=''`).run();
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name).filter(name => Object.hasOwn(row, name));
    db.prepare(`INSERT INTO ${table} (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${columns.filter(name => name !== 'id').map(name => `"${name}"=excluded."${name}"`).join(',')}`)
      .run(...columns.map(name => row[name]));
  }
  db.close(); db = undefined; await start();
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' }); page.setDefaultTimeout(30_000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(safe(error.message)));
  await page.goto(pageUrl()); await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  let view = await workspace();
  if (!view.formulaGeneration) {
    const settings = page.getByRole('region', { name: '生成设置', exact: true });
    await settings.getByRole('radio', { name: '统一配音', exact: true }).check();
    await settings.getByLabel('公式配音供应商', { exact: true }).selectOption('doubao-seed-tts-2');
    await settings.getByLabel('公式配音音色', { exact: true }).selectOption('zh_female_vv_uranus_bigtts');
    await settings.getByLabel('公式配音语速', { exact: true }).fill('1');
    await settings.getByRole('radio', { name: '不加音乐', exact: true }).check();
    const generated = page.waitForResponse(response => response.url().includes('/formula/generation?') && response.request().method() === 'POST');
    await settings.getByRole('button', { name: '生成', exact: true }).click();
    assert.equal((await generated).status(), 200);
  }
  if (args.includes('--refresh-captions') && view.formulaGeneration) {
    summary.captionRefresh = [];
    for (const item of view.formulaGeneration.items.filter(item => item.status === 'ready')) {
      const read = async () => (await fetch(endpoint(`outputs/${item.planId}/arrangement`))).json();
      let current = await read(); const before = current.subtitleCues;
      if (!before.length || Array.from(before[0].text).length > 2) continue;
      // Exercise the public restore action without changing any original text or audio.
      for (const command of [{ type: 'set_subtitle_cue_text', cueId: before[0].id, text: before[0].text },
        { type: 'restore_automatic_subtitles' }]) {
        const response = await fetch(endpoint(`outputs/${item.planId}/clips`), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...command, expectedOutputVersionId: current.outputVersionId, expectedEditRevision: current.editRevision }) });
        assert.equal(response.status, 200, await response.text()); current = await read();
      }
      assert.equal(current.subtitleCues.map(cue => cue.text).join(''), before.map(cue => cue.text).join(''));
      assert(current.subtitleCues.length < before.length);
      summary.captionRefresh.push({ scriptNumber: item.scriptNumber, before: before.length, after: current.subtitleCues.length }); save();
    }
  }
  let last = '';
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    view = await workspace(); const progress = view.formulaGeneration;
    assert(progress); assert.equal(progress.total, 8);
    summary.requestId = progress.requestId; summary.progress = progress; save();
    const compact = JSON.stringify({ ready: progress.ready, needsAttention: progress.needsAttention, pending: progress.pending,
      phases: [...new Set(progress.items.map(item => item.phase))] });
    if (compact !== last) { console.log(compact); last = compact; }
    if (!progress.pending) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(view.formulaGeneration.pending, 0, '真实服务制作尚未完成，保留原任务供恢复');
  await page.getByRole('region', { name: '实拍制作进度', exact: true }).screenshot({ path: path.join(proof, 'progress.png') });
  const savedSettings = await (await fetch(endpoint('formula/settings'))).json();
  assert.equal(savedSettings.saved.settings.production.audio.mode, 'narration');
  fs.writeFileSync(path.join(proof, 'settings.json'), JSON.stringify(savedSettings, null, 2));
  const before = view.formulaGeneration;
  await page.close(); page = undefined; await stop(); await start();
  view = await workspace(); assert.deepEqual(view.formulaGeneration, before); summary.restartRestored = true;
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' });
  await page.goto(pageUrl()); await page.getByRole('button', { name: '检查成片', exact: true }).click();
  if (args.includes('--refresh-captions')) {
    const position = page.getByRole('slider', { name: '播放位置', exact: true });
    await expect(position).toBeEnabled(); await position.press('Home');
    for (let frame = 0; frame < 48; frame++) await position.press('ArrowRight');
    const caption = page.getByRole('img', { name: /^字幕：/ }).last(); await expect(caption).toBeVisible();
    summary.browserCaption = await caption.getAttribute('aria-label');
    assert(Array.from(summary.browserCaption.replace(/^字幕：/, '')).length > 2);
    await expect.poll(() => page.locator('video').evaluateAll(videos => videos.some(video => video.readyState >= 2 && video.videoWidth > 0 && !video.seeking)),
      { timeout: 120_000 }).toBe(true);
    await expect(page.getByText('正在准备声音，播放位置暂时保持…', { exact: true })).toBeHidden({ timeout: 120_000 });
    summary.browserMedia = await page.locator('video').evaluateAll(videos => videos.map(video => ({ readyState: video.readyState,
      width: video.videoWidth, height: video.videoHeight, seeking: video.seeking, time: video.currentTime, error: video.error?.code ?? null })));
  }
  await page.screenshot({ path: path.join(proof, 'review-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  if (args.includes('--refresh-captions')) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const canvas = path.join(proof, 'caption-dark.png');
    await page.getByRole('img', { name: /^字幕：/ }).last().screenshot({ path: canvas, animations: 'disabled' });
    const pixels = await sharp(canvas).ensureAlpha().raw().toBuffer();
    let visible = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220 && pixels[i + 3] > 200) visible++;
    assert(visible > 10, '深色字幕须实际绘制，不能只验证 SVG 节点存在'); summary.darkSubtitlePixels = visible;
  }
  await page.screenshot({ path: path.join(proof, 'review-dark.png'), animations: 'disabled' });
  assert.deepEqual(pageErrors, []);
  await browser.close(); browser = undefined; page = undefined; await stop();
  db = new Database(path.join(root, 'data', 'workbench.db')); db.pragma('foreign_keys=ON');
  const { getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
  const { renderBatchOutputVersion } = await import('../lib/batch-production/batch-renderer.ts');
  const { resolveFfprobePath } = await import('../lib/ffmpeg.ts');
  summary.samples = [];
  for (const item of view.formulaGeneration.items.filter(item => item.status === 'ready')) {
    const arrangement = getBatchOutputArrangementView(db, projectId, batchId, item.planId);
    assert(arrangement.audioPlan.clips.length > 0);
    assert(arrangement.audioPlan.clips.every(clip => clip.kind === 'narration'));
    const sample = { scriptNumber: item.scriptNumber, planId: item.planId, outputVersionId: arrangement.outputVersionId,
      bodyDurationUs: arrangement.audioPlan.bodyDurationUs, subtitleCues: arrangement.subtitleCues, audioClips: arrangement.audioPlan.clips };
    const priorSample = priorSummary?.samples?.find(prior => prior.planId === sample.planId && prior.outputVersionId === sample.outputVersionId
      && JSON.stringify(prior.subtitleCues) === JSON.stringify(sample.subtitleCues) && JSON.stringify(prior.audioClips) === JSON.stringify(sample.audioClips));
    if (priorSample?.preview && fs.existsSync(priorSample.preview)) { sample.preview = priorSample.preview; sample.encodedFrames = priorSample.encodedFrames; }
    summary.samples.push(sample); save();
    fs.writeFileSync(path.join(proof, `script-${item.scriptNumber}-arrangement.json`), JSON.stringify(arrangement, null, 2));
    if (summary.samples.length > renderCount) continue;
    console.log(`渲染真实脚本 ${item.scriptNumber} 的待审样片`);
    const rendered = await renderBatchOutputVersion({ db, projectId, batchId,
      batchVersionId: view.formulaGeneration.batchVersionId, planId: item.planId, outputVersionId: arrangement.outputVersionId,
      signal: AbortSignal.timeout(10 * 60_000) });
    sample.preview = path.join(proof, `script-${item.scriptNumber}-preview.mp4`);
    const beforePreview = path.join(proof, `script-${item.scriptNumber}-before-caption-grouping.mp4`);
    if (args.includes('--refresh-captions') && fs.existsSync(sample.preview) && !fs.existsSync(beforePreview)) fs.copyFileSync(sample.preview, beforePreview);
    fs.copyFileSync(rendered.videoAbsolutePath, sample.preview);
    fs.copyFileSync(rendered.coverAbsolutePath, path.join(proof, `script-${item.scriptNumber}-cover.jpg`));
    const result = spawnSync(resolveFfprobePath(), ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', sample.preview],
      { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0); const streams = JSON.parse(result.stdout).streams;
    const video = streams.find(stream => stream.codec_type === 'video'), audio = streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.r_frame_rate, '24/1'); assert.equal(video.width, 1080); assert.equal(video.height, 1920);
    assert.equal(Number(video.nb_read_frames), Math.round(sample.bodyDurationUs * 24 / 1_000_000) + 20);
    assert(audio); sample.encodedFrames = Number(video.nb_read_frames); save();
  }
  summary.status = view.formulaGeneration.needsAttention ? 'needs_attention' : 'generated_pending_human_review';
  save(); console.log(JSON.stringify({ status: summary.status, ready: view.formulaGeneration.ready, needsAttention: view.formulaGeneration.needsAttention }));
} catch (error) {
  summary.status = 'needs_attention'; summary.error = safe(error instanceof Error ? error.message : error); save();
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(proof, 'attention.png') }).catch(() => {});
  console.error(summary.error); process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {}); await stop().catch(error => { console.error(safe(error.message)); process.exitCode = 1; }); db?.close();
  for (const filename of temporaryRuntimeFiles) fs.unlinkSync(filename);
  const cleanup = new Database(path.join(root, 'data', 'workbench.db'));
  try {
    cleanup.pragma('secure_delete=ON');
    for (const { table } of providers) cleanup.prepare(`UPDATE ${table} SET apiKey='',keyEnv=''`).run();
    cleanup.pragma('wal_checkpoint(TRUNCATE)');
    for (const { table } of providers) assert.equal(cleanup.prepare(`SELECT count(*) AS n FROM ${table} WHERE trim(apiKey)<>''`).get().n, 0);
    summary.remainingStoredCredentials = 0; save();
  } finally { cleanup.close(); }
  fs.writeFileSync(path.join(proof, 'server.log'), safe(logs.join('')));
}
