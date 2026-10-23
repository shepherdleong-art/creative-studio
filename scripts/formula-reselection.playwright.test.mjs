/**
 * 公式选片记录与逐条重选：真实页面/API/后台任务，隔离数据根及随机本机端口。
 * 先构建，再执行 node scripts/formula-reselection.playwright.test.mjs；
 * 可用 FORMULA_BROWSER_SERVER 指向隔离 standalone/server.js。
 * 首次生成用公共领域入口准备夹具（完整生成按钮尚未交付）；重选从实际页面发起。
 * 替换模型使用本机固定响应，视频为 FFmpeg 合成颜色，不证明真实内容/声音或成片制作已完成。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { chromium, expect } from '@playwright/test';

const standalone = process.env.FORMULA_BROWSER_SERVER || path.resolve('.next/standalone/server.js');
const packagingOnly = process.argv.includes('--packaging-only');
const publishOnly = process.argv.includes('--publish-only');
const executionOnly = process.argv.includes('--execution-only') || publishOnly;
assert(fs.existsSync(standalone), '请先构建验收版本');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-reselection-browser-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const proofs = path.resolve(publishOnly ? 'outputs/formula-publish-browser' : executionOnly ? 'outputs/formula-execution-browser' : packagingOnly ? 'outputs/formula-packaging-browser' : 'outputs/formula-reselection-browser');
fs.mkdirSync(proofs, { recursive: true });
let server, browser, db, page;
const output = [];
const pendingApi = new Map();
const failedApi = [];
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离服务未退出')), 10_000);
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
  server = spawn(process.execPath, [standalone], { cwd: process.cwd(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port),
      CREATIVE_STUDIO_FORMULA_MIXCUT: enabled ? '1' : '0', NODE_ENV: 'production' } });
  server.stdout.on('data', chunk => output.push(String(chunk)));
  server.stderr.on('data', chunk => output.push(String(chunk)));
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error('隔离服务提前退出');
    try {
      const response = await fetch(`${base}/api/batch-production/readiness`);
      if (response.ok) {
        const state = await response.json();
        assert.equal(state.available, true); assert.equal(state.formula.available, enabled);
        return base;
      }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离服务启动超时');
}
try {
  await startServer(true);
  await stopServer(); // 公共领域入口准备初次选片夹具时，不与应用 worker 抢任务。
  db = new Database(path.join(root, 'data/workbench.db'));
  db.pragma('foreign_keys=ON');
  db.exec("UPDATE script_providers SET enabled=0; UPDATE final_edit_tts_providers SET enabled=0,apiKey='',keyEnv='';");
  db.prepare("INSERT INTO providers (id,name,baseUrl,model,type) VALUES ('fixture','验收','http://127.0.0.1:1','fixture','openai-compatible')").run();
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES ('formula-ui','逐条选片验收','fixture','fixture','','complex_product','FORMULA')").run();
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding, getFormulaMaterialIndex } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
  const { createFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
  const { readFormulaSelectionHistory } = await import('../lib/batch-production/formula/reselection.ts');
  const { createFormulaStageExecutor } = await import('../lib/batch-production/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/batch-production/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { computeFingerprintFromFile } = await import('../lib/batch-production/fingerprint.ts');
  const musicPath = path.join(root, 'storage', 'bgm', 'formula-tone.wav');
  fs.mkdirSync(path.dirname(musicPath), { recursive: true });
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=8', '-c:a', 'pcm_s16le', '-y', musicPath]);
  db.prepare(`INSERT INTO final_edit_bgm_tracks (id,relativePath,fileFingerprint,durationUs,format,status,scannedAt)
    VALUES ('formula-music','bgm/formula-tone.wav',?,8000000,'wav','ready',datetime('now'))`).run(await computeFingerprintFromFile(musicPath));
  const batchId = createBatchProduction(db, 'formula-ui', '单条重选验收', undefined, { planningMode: 'formula' });
  const assets = [];
  for (const [index, color] of ['red', 'blue'].entries()) {
    const video = path.join(root, `${color}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=160x160:r=24:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
    const assetId = await registerManagedCopy(db, 'formula-ui', { sourcePath: video });
    registerFormulaAssetBinding(db, 'formula-ui', batchId, { assetId, sourcePath: `S${25 + index}_清洁展示.mp4` });
    assets.push(assetId);
  }
  async function importBook(kind, rows, targetBatchId = batchId) {
    const book = new ExcelJS.Workbook(); book.addWorksheet(kind === 'materials' ? '素材' : '脚本').addRows(rows);
    const expectedRevision = getFormulaMaterialIndex(db, 'formula-ui', targetBatchId).revision;
    const session = await createFormulaImportSession(db, 'formula-ui', targetBatchId, { kind, filename: `${kind}.xlsx`,
      bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision });
    confirmFormulaImportSession(db, 'formula-ui', targetBatchId, session.id, { expectedRevision, excludedKeys: [] });
    return session;
  }
  await importBook('materials', [
    ['逻辑编号', '画面描述', '核心卖点', '景别'],
    ['S29', '布料沾污后用湿布轻擦', '抗污易清洁', '特写'],
    ['S25', '用纸擦掉表面污渍', '污渍一擦即净', '中景'],
    ['S26', '展示清洁后的布料', '展示清洁效果', '特写'],
  ]);
  const scripts = await importBook('scripts', [
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'S29 S25', '不怕弄脏，擦一擦就干净'],
    [141, '抖音', 1, 16, 'S25', '直接使用已有素材'],
  ]);
  const revision = getFormulaMaterialIndex(db, 'formula-ui', batchId).revision;
  const settings = await saveFormulaSettings(db, 'formula-ui', batchId, { expectedInputRevision: revision, expectedSettingsRevision: 0,
    scriptsSessionId: scripts.id, settings: { selections: [{ key: '1:2', copies: 2 }, { key: '1:3', copies: 1 }], bgm: { mode: 'none', trackIds: [] } } });
  const request = await createFormulaGenerationRequest(db, 'formula-ui', batchId, { requestKey: 'browser-fixture', settingsId: settings.saved.id, expectedInputRevision: revision });
  const model = { id: 'local-fixture', name: '本机固定响应', model: 'fixture-model', async complete() {
    return { matches: [{ logicalCode: 'S25', basis: 'selling_point', preservesIntent: true,
      reason: '两份资料都描述污渍容易擦除', differences: ['湿布变为纸擦拭', '特写变为中景'],
      evidence: [{ originalField: '核心卖点', originalQuote: '抗污易清洁', replacementField: '核心卖点', replacementQuote: '污渍一擦即净' }] }] };
  } };
  assert.equal(await runPendingOnce({ db, workerId: 'browser-seed', executors: [createFormulaStageExecutor(async () => model)], log: () => {} }), 9);
  const [first, sibling] = request.outputs;
  const original = readFormulaSelectionHistory(db, 'formula-ui', batchId, first.planId);
  const siblingOriginal = readFormulaSelectionHistory(db, 'formula-ui', batchId, sibling.planId);
  // 实际配音试听夹具：通过公共生成/worker 生成一秒测试音频，外部网络响应模拟。
  process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
  process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
  db.exec("UPDATE final_edit_tts_providers SET enabled=1,baseUrl='https://voice.example',apiKey='fixture',keyEnv='' WHERE id='vapi-qwen3-tts'");
  const voiceBatch = createBatchProduction(db, 'formula-ui', '配音试听验收', undefined, { planningMode: 'formula' });
  registerFormulaAssetBinding(db, 'formula-ui', voiceBatch, { assetId: assets[0], sourcePath: 'G1_静物.mp4' });
  const voiceScripts = await importBook('scripts', [
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [12, '抖音', 1, 16, 'G1', '坐得稳。'],
  ], voiceBatch);
  const { defaultFormulaProductionSettings } = await import('../lib/batch-production/formula/production-settings.ts');
  const voiceProduction = defaultFormulaProductionSettings();
  voiceProduction.packaging = { mode: 'none', templateIds: [] }; // Keep PCM comparisons independent of the packaging runtime.
  if (packagingOnly) {
    const { defaultTextStyle } = await import('../lib/media-core/cover-domain.ts');
    const { OUTPUT_PRESETS } = await import('../lib/media-core/cover-types.ts');
    const preset = { version: 2, stylesByPreset: Object.fromEntries(Object.entries(OUTPUT_PRESETS).map(([id, dimensions]) => [id, {
      primary: { ...defaultTextStyle('coverPrimary', dimensions.width), color: '#123456' },
      secondary: defaultTextStyle('coverSecondary', dimensions.width), framing: { scale: 1.4, offsetX: 0.2, offsetY: -0.1 },
    }])) };
    db.prepare('INSERT INTO final_edit_title_presets (id,name,stylesByPresetJson,createdAt,updatedAt) VALUES (?,?,?,?,?)')
      .run('formula-cover', '偏右构图', JSON.stringify(preset), new Date().toISOString(), new Date().toISOString());
    db.prepare('UPDATE projects SET productName=?,sellingPointsJson=? WHERE id=?').run('实拍椅', '[{"title":"坐得稳"}]', 'formula-ui');
    voiceProduction.packaging = { mode: 'uniform', templateIds: ['overlay-minimal'] };
    voiceProduction.cover = { mode: 'uniform', presetIds: ['formula-cover'] };
  }
  voiceProduction.audio = { mode: 'narration', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  const voiceSettings = await saveFormulaSettings(db, 'formula-ui', voiceBatch, { expectedInputRevision: 2, expectedSettingsRevision: 0,
    scriptsSessionId: voiceScripts.id, settings: { selections: [{ key: '1:2', copies: packagingOnly ? 2 : 1 }], bgm: { mode: 'none', trackIds: [] }, production: voiceProduction } });
  const voiceRequest = await createFormulaGenerationRequest(db, 'formula-ui', voiceBatch, { requestKey: 'voice-browser', settingsId: voiceSettings.saved.id, expectedInputRevision: 2 });
  if (packagingOnly) db.prepare('UPDATE projects SET productName=?,sellingPointsJson=? WHERE id=?')
    .run('后来改名', '[{"title":"后来卖点"}]', 'formula-ui');
  const fixtureVoice = path.join(root, 'fixture-voice.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*440*t)':s=48000:d=1", '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', fixtureVoice]);
  const actualFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => String(url).endsWith('/audio/speech')
      ? Response.json({ output: { audio: { data: fs.readFileSync(fixtureVoice).toString('base64') } } })
      : Response.json({ words: [{ word: '坐得稳', start: 0.1, end: 0.9 }] });
    await runPendingOnce({ db, workerId: 'voice-fixture', executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
  } finally { globalThis.fetch = actualFetch; }
  assert.equal(readFormulaSelectionHistory(db, 'formula-ui', voiceBatch, voiceRequest.outputs[0].planId).current.narration.status, 'ready');
  // 混合声音夹具：原片 5–7 秒接到正文 0–2 秒，余下一秒是实际生成的配音文件。
  const mixedBatch = createBatchProduction(db, 'formula-ui', '原声配音连续预览', undefined, { planningMode: 'formula' });
  const sourceVideo = path.join(root, 'original-tone.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=160x160:r=24:d=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', sourceVideo]);
  const sourceAsset = await registerManagedCopy(db, 'formula-ui', { sourcePath: sourceVideo });
  registerFormulaAssetBinding(db, 'formula-ui', mixedBatch, { assetId: sourceAsset, sourcePath: 'VO1_原声.mp4' });
  registerFormulaAssetBinding(db, 'formula-ui', mixedBatch, { assetId: assets[0], sourcePath: 'G1_静物.mp4' });
  const mixedScripts = await importBook('scripts', [
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'], [141, '抖音', 2, 3, 'VO1 G1', '好擦洗。坐得稳。'],
  ], mixedBatch);
  const mixedProduction = { ...voiceProduction, audio: { ...voiceProduction.audio, mode: 'mixed' } };
  const mixedSettings = await saveFormulaSettings(db, 'formula-ui', mixedBatch, { expectedInputRevision: 3, expectedSettingsRevision: 0,
    scriptsSessionId: mixedScripts.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production: mixedProduction,
      timing: { mode: 'fixed', scope: 'body', overrideDurationSec: 3, speechMarginMs: 125 } } });
  const mixedRequest = await createFormulaGenerationRequest(db, 'formula-ui', mixedBatch, { requestKey: 'mixed-browser', settingsId: mixedSettings.saved.id, expectedInputRevision: 3 });
  try {
    globalThis.fetch = async (url, init) => String(url).endsWith('/audio/speech')
      ? Response.json({ output: { audio: { data: fs.readFileSync(fixtureVoice).toString('base64') } } })
      : init?.body?.has('prompt') ? Response.json({ words: [{ word: '坐得稳', start: 0.1, end: 0.9 }] })
      : Response.json({ text: '好擦洗。', words: [{ word: '好擦洗', start: 5.125, end: 6.875 }] });
    await runPendingOnce({ db, workerId: 'mixed-fixture', log: () => {}, executors: [createFormulaStageExecutor(async () => ({
      id: 'fixture', name: '文案映射夹具', model: 'fixture', async complete(input) {
        const prompt = JSON.parse(input.userPrompt);
        return { blocks: [{ text: '好擦洗。', kind: 'source', slotId: prompt.sources[0].slotId },
          { text: '坐得稳。', kind: 'tts', slotIds: prompt.narrationWindows[0] }] };
      },
    })), createBatchRenderExecutor()] });
  } finally { globalThis.fetch = actualFetch; }
  const mixedHistory = readFormulaSelectionHistory(db, 'formula-ui', mixedBatch, mixedRequest.outputs[0].planId);
  assert.equal(mixedHistory.current.timeline.result?.status, 'planned');
  assert.equal(mixedHistory.current.timeline.result.audio[0].sourceInUs, 5_000_000);
  assert.equal(mixedHistory.current.timeline.result.audio[0].sourceOutUs, 7_000_000);
  let failedExecutionTask;
  if (executionOnly) {
    const { getBatchOutputArrangementView, applyBatchOutputClipEdit } = await import('../lib/batch-production/output-arrangement.ts');
    const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
    const { resolveVerifiedProjectAssetMedia } = await import('../lib/batch-production/project-asset-media.ts');
    const planId = voiceRequest.outputs[0].planId;
    assert.equal(getBatchWorkspace(db, 'formula-ui', voiceBatch).cards[0].approvable, true);
    const current = getBatchOutputArrangementView(db, 'formula-ui', voiceBatch, planId);
    applyBatchOutputClipEdit(db, 'formula-ui', voiceBatch, planId, { type: 'set_narration_gain', gainDb: -6,
      expectedEditRevision: current.editRevision, expectedOutputVersionId: current.outputVersionId });
    const managed = await resolveVerifiedProjectAssetMedia(db, 'formula-ui', assets[0]);
    fs.renameSync(managed.filePath, `${managed.filePath}.missing`);
    try {
      await runPendingOnce({ db, workerId: 'execution-failure', executors: [createFormulaStageExecutor(), createBatchRenderExecutor()], log: () => {} });
      const card = getBatchWorkspace(db, 'formula-ui', voiceBatch).cards[0];
      assert.equal(card.status, 'retryable_failed');
      failedExecutionTask = card.executionTask.id;
    } finally { fs.renameSync(`${managed.filePath}.missing`, managed.filePath); }
  }
  let base = await startServer(true);
  const previewResponse = await fetch(`${base}/api/batch-production/batches/${voiceBatch}/formula/outputs/${voiceRequest.outputs[0].planId}/preview?projectId=formula-ui`);
  assert.equal(previewResponse.status, 200, '审片预览应读取已保存的完整画面/声音安排');
  const previewView = await previewResponse.json();
  assert.equal(previewView.preview.audioTimeline.bodyDurationUs, 1_000_000);
  const endpoint = planId => `${base}/api/batch-production/batches/${batchId}/formula/outputs/${planId}/selection?projectId=formula-ui`;
  async function history(planId = first.planId) { const response = await fetch(endpoint(planId)); assert.equal(response.status, 200); return response.json(); }
  const workspaceResponse = await fetch(`${base}/api/batch-production/batches/${batchId}/workspace?projectId=formula-ui`);
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json();
  assert.deepEqual(workspace.cards.map(card => card.formula.replacementCount), [1, 1, 0]);
  assert(workspace.cards.every(card => !card.approvable && !card.exportEligible), '只有选片结果不能冒充可审核成片');
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(30_000);
  page.on('request', request => {
    if (request.url().includes('/api/batch-production/')) pendingApi.set(request, { method: request.method(), url: request.url(), startedAt: Date.now() });
  });
  page.on('requestfinished', request => pendingApi.delete(request));
  page.on('requestfailed', request => {
    if (pendingApi.has(request)) failedApi.push({ ...pendingApi.get(request), error: request.failure()?.errorText });
    pendingApi.delete(request);
  });
  // Observe the real Web Audio destination; no component state or private nodes.
  await page.addInitScript(() => {
    window.__audioCapture = { enabled: false, frames: [] };
    const destinations = new WeakMap();
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      if (!(destination instanceof AudioDestinationNode)) return Reflect.apply(connect, this, [destination, ...args]);
      let input = destinations.get(destination);
      if (!input) {
        const context = destination.context;
        input = context.createGain();
        destinations.set(destination, input);
        Reflect.apply(connect, input, [destination]);
        const capture = context.createScriptProcessor(1024, 2, 2), silent = context.createGain();
        silent.gain.value = 0;
        Reflect.apply(connect, input, [capture]); Reflect.apply(connect, capture, [silent]); Reflect.apply(connect, silent, [destination]);
        capture.onaudioprocess = event => {
          if (!window.__audioCapture.enabled) return;
          window.__audioCapture.frames.push({ rate: context.sampleRate, time: event.playbackTime,
            body: Number(document.querySelector('input[aria-label="播放位置"]')?.value ?? 0) - 20 / 24,
            samples: Array.from(event.inputBuffer.getChannelData(0)),
            rightSamples: Array.from(event.inputBuffer.getChannelData(1)) });
        };
      }
      Reflect.apply(connect, this, [input, ...args]);
      return destination;
    };
  });
  page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  if (executionOnly) {
    const voiceUrl = `${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${voiceBatch}`;
    await page.goto(voiceUrl);
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试检查', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByText('检查失败', { exact: true })).toBeVisible();
    await expect(page.getByText(/制作检查失败：/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeDisabled();
    await page.screenshot({ path: path.join(proofs, 'failed.png'), fullPage: true });
    const retried = page.waitForResponse(response => response.url().includes(`/tasks/${failedExecutionTask}/retry`) && response.request().method() === 'POST');
    await retry.click();
    assert.equal((await retried).status(), 200);
    await expect(retry).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText('制作检查通过，可以预览并确认成片')).toBeVisible();
    await page.getByRole('button', { name: '确认这条', exact: true }).click();
    await expect(page.getByRole('button', { name: '已确认 1', exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; localStorage.setItem('creative-studio-theme', 'dark'); });
    await page.screenshot({ path: path.join(proofs, 'ready-dark.png'), fullPage: true });
    let publishedMediaPath, packagePath, packageManifest;
    if (publishOnly) {
      await page.getByRole('button', { name: '导出成片', exact: true }).click();
      await page.getByRole('button', { name: '全选可导出（1）', exact: true }).click();
      await page.getByRole('button', { name: '正式导出选中项（1）', exact: true }).click();
      const videoLink = page.getByRole('link', { name: '下载当前正式版视频', exact: true });
      await expect(videoLink).toBeVisible({ timeout: 60_000 });
      const videoHref = await videoLink.getAttribute('href');
      publishedMediaPath = videoHref;
      const video = await fetch(new URL(videoHref, base), { headers: { Range: 'bytes=0-31' } });
      assert.equal(video.status, 206);
      assert.match(video.headers.get('content-type'), /video\/mp4/);
      assert.match(decodeURIComponent(video.headers.get('content-disposition') || ''), /-脚本12-第01份-无包装\.mp4/);
      assert.equal((await video.arrayBuffer()).byteLength, 32);
      const coverLink = page.getByRole('link', { name: '下载当前正式版封面', exact: true });
      const cover = await fetch(new URL(await coverLink.getAttribute('href'), base));
      assert.equal(cover.status, 200);
      assert.match(cover.headers.get('content-type'), /image\/jpeg/);
      assert.match(decodeURIComponent(cover.headers.get('content-disposition') || ''), /-脚本12-第01份-无包装-封面\.jpg/);
      assert((await cover.arrayBuffer()).byteLength > 0);
      await page.getByRole('button', { name: '全选可导出（1）', exact: true }).click();
      const createPackage = page.getByRole('button', { name: '创建导出包（1）', exact: true });
      await expect(createPackage).toBeEnabled();
      let acceptedPackageId;
      const packagePattern = '**/formula/packages?*';
      await page.route(packagePattern, async route => {
        if (route.request().method() !== 'POST' || acceptedPackageId) return route.continue();
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 200);
        acceptedPackageId = (await accepted.json()).id;
        await route.abort('failed'); // Backend saved the package, but the browser lost the response.
      });
      await createPackage.click();
      await expect(page.getByRole('alert').filter({ hasText: '打包结果暂未收到' })).toBeVisible();
      const [packageCreated] = await Promise.all([
        page.waitForResponse(response => response.url().includes('/formula/packages?') && response.request().method() === 'POST'),
        createPackage.click(),
      ]);
      assert.equal(packageCreated.status(), 200);
      const packageSaved = await packageCreated.json();
      assert.equal(packageSaved.count, 1);
      assert.equal(packageSaved.id, acceptedPackageId, '回复丢失后重试仍是同一个导出包');
      await page.unroute(packagePattern);
      const zipLink = page.getByRole('link', { name: '下载 ZIP', exact: true });
      await expect(zipLink).toBeVisible();
      packagePath = await zipLink.getAttribute('href');
      const [downloaded] = await Promise.all([page.waitForEvent('download'), zipLink.click()]);
      assert.match(downloaded.suggestedFilename(), /^实拍成片-.*\.zip$/);
      const { default: JSZip } = await import('jszip');
      const archive = await JSZip.loadAsync(fs.readFileSync(await downloaded.path()));
      packageManifest = await archive.file('清单.json').async('string');
      const manifest = JSON.parse(packageManifest);
      assert.equal(manifest.items[0].scriptNumber, '12');
      assert.equal(manifest.items[0].copyIndex, 1);
      assert.ok(archive.file(manifest.items[0].video.filename));
      assert.ok(archive.file(manifest.items[0].coverFile.filename));
      assert.ok(archive.file('清单.csv'));
      await page.screenshot({ path: path.join(proofs, 'published-dark.png'), fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; localStorage.setItem('creative-studio-theme', 'light'); });
      await expect(page.getByRole('region', { name: '成片导出包' })).toBeVisible();
      await page.screenshot({ path: path.join(proofs, 'package-light.png'), fullPage: true, animations: 'disabled' });
      await page.reload();
      await page.getByRole('button', { name: '导出成片', exact: true }).click();
      await expect(videoLink).toHaveAttribute('href', videoHref);
      await expect(zipLink).toHaveAttribute('href', packagePath);
    }
    await stopServer();
    base = await startServer(false);
    const unavailable = await fetch(`${base}/api/batch-production/batches/${voiceBatch}/workspace?projectId=formula-ui`);
    assert.equal(unavailable.status, 200);
    assert.equal((await unavailable.json()).cards[0].approvable, false, '能力关闭后服务端不再返回可确认状态');
    if (publishedMediaPath) assert.equal((await fetch(new URL(publishedMediaPath, base), { headers: { Range: 'bytes=0-31' } })).status, 206,
      '关闭公式能力仍可读取已经发布的正式文件');
    if (packagePath) {
      const { default: JSZip } = await import('jszip');
      const oldPackage = await fetch(new URL(packagePath, base));
      assert.equal(oldPackage.status, 200);
      const archive = await JSZip.loadAsync(await oldPackage.arrayBuffer());
      assert.equal(await archive.file('清单.json').async('string'), packageManifest, '关闭功能后下载同一冻结包');
    }
    await page.goto(`${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${voiceBatch}`);
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    await expect(page.getByRole('button', { name: '确认这条', exact: true })).toHaveCount(0);
    if (packagePath) {
      await page.getByRole('button', { name: '导出成片', exact: true }).click();
      await expect(page.getByRole('link', { name: '下载 ZIP', exact: true })).toHaveAttribute('href', packagePath);
    }
    assert.deepEqual(errors, []);
    if (publishOnly) fs.writeFileSync(path.join(proofs, 'package-summary.json'), JSON.stringify({ status: 'passed',
      actualBrowserDownload: true, lostReplyRetrySamePackage: true, refreshRestored: true, featureOffHistory: true,
      manifestItems: JSON.parse(packageManifest).items.length, themes: ['dark', 'light'] }, null, 2));
    console.log(publishOnly ? '公式发布浏览器：检查重试、实际确认、正式导出、视频/封面及 ZIP 实际下载、刷新和关闭能力后历史访问通过'
      : '公式制作检查浏览器：真实失败原因、禁用确认、重试原任务、恢复就绪及刷新通过');
  } else if (packagingOnly) {
    const voiceUrl = `${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${voiceBatch}`;
    const arrangementUrl = `${base}/api/batch-production/batches/${voiceBatch}/outputs/${voiceRequest.outputs[0].planId}/arrangement?projectId=formula-ui`;
    const readArrangement = async () => { const response = await fetch(arrangementUrl); assert.equal(response.status, 200); return response.json(); };
    const initial = await readArrangement();
    const otherArrangementUrl = `${base}/api/batch-production/batches/${voiceBatch}/outputs/${voiceRequest.outputs[1].planId}/arrangement?projectId=formula-ui`;
    const readOther = async () => { const response = await fetch(otherArrangementUrl); assert.equal(response.status, 200); return response.json(); };
    const otherInitial = await readOther();
    // The second output starts with an explicitly unlocked manual template, so the batch action must really change it.
    for (const command of [{ type: 'set_packaging', config: { ...otherInitial.packaging, template: 'overlay-poster' } },
      { type: 'set_presentation_lock', target: 'packaging', locked: false }]) {
      const current = await readOther();
      const response = await fetch(otherArrangementUrl.replace('/arrangement?', '/clips?'), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command,
          expectedEditRevision: current.editRevision, expectedOutputVersionId: current.outputVersionId }) });
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(initial.packaging.template, 'overlay-minimal');
    assert.deepEqual(initial.coverFraming, { scale: 1.4, offsetX: 0.2, offsetY: -0.1 });
    let releaseOther;
    const otherGate = new Promise(resolve => { releaseOther = resolve; });
    let heldOther = false;
    const otherPattern = `**/outputs/${voiceRequest.outputs[1].planId}/arrangement?*`;
    await page.route(otherPattern, async route => {
      if (!heldOther) { heldOther = true; await otherGate; }
      await route.continue();
    });
    await page.goto(voiceUrl);
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    await expect(page.getByRole('button', { name: '正在读取本批成片…', exact: true })).toBeDisabled();
    releaseOther();
    const inspector = page.getByRole('complementary', { name: '成片属性' });
    await inspector.getByRole('button', { name: '包装', exact: true }).click();
    await expect(inspector.getByRole('switch', { name: '启用视频包装' })).toBeChecked();
    await expect(inspector.getByRole('radio', { name: 'f3 极简高级' })).toBeChecked();
    await inspector.getByRole('button', { name: '跳到封面', exact: true }).click();
    const overlay = page.getByRole('region', { name: '成片实时预览' }).frameLocator('iframe[title="包装版式编辑"]');
    await expect(overlay.locator('[data-point-id="cover:title"]')).toHaveText('实拍椅');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: path.join(proofs, `packaging-${theme}.png`), fullPage: true });
    }
    const firstClipsPattern = `**/outputs/${voiceRequest.outputs[0].planId}/clips?*`;
    await page.route(firstClipsPattern, route => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ message: '验收：锁定暂时保存失败' }) }));
    let saveError = '';
    page.once('dialog', async dialog => { saveError = dialog.message(); await dialog.accept(); });
    await inspector.getByRole('checkbox', { name: '锁定封面', exact: true }).check();
    await expect.poll(() => saveError).toBe('验收：锁定暂时保存失败');
    await expect(inspector.getByRole('checkbox', { name: '锁定封面', exact: true })).not.toBeChecked();
    assert.equal((await readArrangement()).presentationLocks.cover, false, '保存失败不能显示为已锁定');
    await page.unroute(firstClipsPattern);
    await inspector.getByRole('radio', { name: 'f2 手账拼贴' }).click();
    await expect.poll(async () => (await readArrangement()).packaging.template).toBe('overlay-journal');
    await expect(inspector.getByRole('checkbox', { name: '锁定包装', exact: true })).toBeChecked();
    await inspector.getByRole('checkbox', { name: '锁定封面', exact: true }).check();
    await expect.poll(async () => (await readArrangement()).presentationLocks.cover).toBe(true);
    const locked = await readArrangement();
    const batchReassign = page.getByRole('button', { name: /本批重新分配未锁定项/ });
    await expect(batchReassign).toHaveText('本批重新分配未锁定项（1 条）');
    await batchReassign.click();
    await expect.poll(async () => (await readOther()).packaging.template).toBe('overlay-minimal');
    await expect(page.getByRole('status').filter({ hasText: '已处理 1 条' })).toBeVisible();
    assert.deepEqual(await readArrangement(), locked, '整批重分配不能改已锁定的成片');
    await inspector.getByRole('checkbox', { name: '锁定包装', exact: true }).uncheck();
    await expect(batchReassign).toHaveText('本批重新分配未锁定项（2 条）');
    await batchReassign.click();
    await expect.poll(async () => (await readArrangement()).packaging.template).toBe('overlay-minimal');
    await expect(page.getByRole('status').filter({ hasText: '已处理 2 条' })).toBeVisible();
    await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
    await expect.poll(async () => (await readArrangement()).packaging.template).toBe('overlay-journal');
    await expect(inspector.getByRole('radio', { name: 'f2 手账拼贴' })).toBeChecked();
    assert.deepEqual((await readArrangement()).presentationLocks, { packaging: false, cover: true });
    assert.deepEqual((await readArrangement()).audioPlan, initial.audioPlan);
    await page.screenshot({ path: path.join(proofs, 'presentation-locks-reassigned.png'), fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    await inspector.getByRole('button', { name: '包装', exact: true }).click();
    await expect(inspector.getByRole('radio', { name: 'f2 手账拼贴' })).toBeChecked();
    await expect(inspector.getByRole('checkbox', { name: '锁定包装', exact: true })).not.toBeChecked();
    await expect(inspector.getByRole('checkbox', { name: '锁定封面', exact: true })).toBeChecked();
    assert.deepEqual((await readArrangement()).packaging.pointCues, initial.packaging.pointCues, '换模板和刷新不重抽花字时序或标识');
    await inspector.getByRole('button', { name: '恢复默认文案', exact: true }).click();
    await expect.poll(async () => (await readArrangement()).packaging.varsOverrides.title).toBe('实拍椅');
    await inspector.getByRole('button', { name: '封面', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/9:16.*包装文字/)).toBeVisible();
    await expect(dialog.getByLabel('缩放', { exact: true })).toHaveValue('1.4');
    await expect(dialog.frameLocator('iframe').locator('[data-point-id="cover:title"]')).toHaveText('实拍椅');
    await dialog.screenshot({ path: path.join(proofs, 'cover-frozen-preset.png') });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await inspector.getByRole('button', { name: '包装', exact: true }).click();
    await inspector.getByRole('switch', { name: '启用视频包装' }).click();
    await expect.poll(async () => (await readArrangement()).packaging.enabled).toBe(false);
    const disabled = await readArrangement();
    assert.deepEqual(disabled.coverFraming, initial.coverFraming, '关闭包装仍保留预设构图');
    assert.equal(disabled.coverTitle.styles.primary.color, '#123456');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ initial: { packaging: initial.packaging, framing: initial.coverFraming },
      edited: { packaging: disabled.packaging, framing: disabled.coverFraming }, pageErrors: errors }, null, 2));
    console.log('公式包装浏览器：独立锁定、手改保护、整批重分配、撤销与刷新，冻结预设、双主题、换模板和关闭包装通过');
  } else {
  await page.goto(`${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${batchId}`);
  await page.getByRole('button', { name: /检查成片/ }).click();
  const panel = page.getByRole('region', { name: '公式选片记录' });
  await expect(panel.getByText('镜头 1 · S29 → S25', { exact: true })).toBeVisible();
  await expect(panel.getByText('自动替换 · 待审', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('原声检查结果').getByText('原片没有音轨。', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('原声检查结果').getByText('原片检查已完成，仍需完成这条成片的配音与声音编排。', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('原声与配音分配').getByText('不怕弄脏，擦一擦就干净', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('原声与配音分配').getByText('文案用途已保存，实际配音和时间编排仍待完成。', { exact: true })).toBeVisible();
  await expect(page.getByText('时长待确定', { exact: true })).toHaveCount(3);
  await expect(page.getByText('画面或声音需要处理，请查看右侧的选片、声音和时长记录。', { exact: true })).toBeVisible();
  await panel.getByText('查看资料依据', { exact: true }).click();
  await expect(panel.getByText('原资料：抗污易清洁', { exact: true })).toBeVisible();
  await expect(panel.getByText('替代资料：污渍一擦即净', { exact: true })).toBeVisible();
  await expect(panel.getByText('湿布变为纸擦拭', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '有替换 2', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看选片 / 重新选择', exact: true })).toHaveCount(2);
  await expect(page.getByText('时长 5.0s', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '查看原片 1', exact: true }).click();
  const video = panel.locator('video');
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate(element => element.play());
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await panel.getByRole('button', { name: '关闭原片预览', exact: true }).click();
  await page.screenshot({ path: path.join(proofs, 'selection-light.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(proofs, 'selection-dark.png'), fullPage: true });

  const choice = `S26:${assets[1]}`;
  await panel.getByLabel('镜头 1 选片').selectOption(choice);
  const routePattern = `**/formula/outputs/${first.planId}/selection?*`;
  let posts = 0;
  await page.route(routePattern, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    if (posts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：临时重选失败' }) });
    await new Promise(resolve => setTimeout(resolve, 250));
    return route.continue();
  });
  const submit = panel.getByRole('button', { name: '按这些选择重选本条', exact: true });
  await submit.click();
  await expect(panel.getByRole('alert')).toHaveText('验收：临时重选失败');
  await expect(panel.getByLabel('镜头 1 选片')).toHaveValue(choice);
  assert.equal((await history()).current.revision, 1);
  await submit.dblclick();
  await expect.poll(async () => (await history()).current.result?.slots[0].sourceLogicalCode).toBe('S26');
  assert.equal(posts, 2, '重试时快速双击只能提交一次');
  await page.unroute(routePattern);
  const updated = await history();
  assert.equal(updated.current.revision, 2);
  assert.deepEqual(updated.history[1].result, original.current.result);
  assert.deepEqual((await history(sibling.planId)).current, siblingOriginal.current);
  await expect(panel.getByText('镜头 1 · S29 → S26', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('原声检查结果').getByText('原片检查已完成，仍需完成这条成片的配音与声音编排。', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('原声检查结果').getByText('原片没有音轨。', { exact: true })).toHaveCount(2);
  await panel.getByRole('button', { name: '重新读取（放弃未保存选择）' }).click();
  await expect(panel.getByText('镜头 1 · S29 → S26', { exact: true })).toBeVisible();
  await panel.getByLabel('选片历史').selectOption(original.current.id);
  await expect(panel.getByText('正在查看历史记录，不影响当前选片。')).toBeVisible();
  await expect(panel.getByText('镜头 1 · S29 → S25', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('镜头 1 选片')).toHaveCount(0);
  await panel.getByLabel('选片历史').selectOption(updated.current.id);
  await page.reload();
  await page.getByRole('button', { name: /检查成片/ }).click();
  await expect(panel.getByText('镜头 1 · S29 → S26', { exact: true })).toBeVisible();
  assert.equal((await history()).history.length, 2);

  // 两个页面同时编辑：另一个页面先保存，本页收到冲突后仍保留用户选择。
  await panel.getByLabel('镜头 1 选片').selectOption(`S25:${assets[0]}`);
  await page.route(routePattern, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const elsewhere = await fetch(endpoint(first.planId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      requestKey: 'other-window', expectedStageId: updated.current.id, expectedOutputVersionId: null, expectedEditRevision: 0,
      overrides: updated.current.overrides,
    }) });
    assert.equal(elsewhere.status, 200);
    return route.continue();
  });
  await submit.click();
  await expect(panel.getByRole('alert')).toContainText('这条成片已更新');
  await expect(panel.getByLabel('镜头 1 选片')).toHaveValue(`S25:${assets[0]}`);
  await page.unroute(routePattern);
  await expect.poll(async () => (await history()).current.result?.slots[0].sourceLogicalCode).toBe('S26');
  assert.equal((await history()).history.length, 3, '旧页面冲突不应再创建一次修订');
  await panel.getByRole('button', { name: '重新读取（放弃未保存选择）' }).click();
  await expect(panel.getByLabel('镜头 1 选片')).toHaveValue(choice);
  await expect.poll(async () => (await history()).current.speech.status).toBe('inspected');
  await expect.poll(async () => (await history()).current.audioMapping.result?.status).toBe('mapped');
  const finalHistory = await history();

  // 一个来源失败时，另一个来源仍可完成；轮询不能停在整条的“需处理”状态。
  let remainingSpeechDone = false;
  await page.route(routePattern, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = structuredClone(finalHistory);
    const speech = response.current.speech;
    speech.status = 'needs_attention';
    speech.sources[0].result = null;
    speech.sources[0].taskStatus = 'failed';
    speech.sources[0].errorMessage = '验收：第一个来源识别失败';
    if (!remainingSpeechDone) {
      speech.sources[1].result = null;
      speech.sources[1].taskStatus = 'running';
    }
    response.history[0].speech = speech;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await panel.getByRole('button', { name: '重新读取（放弃未保存选择）' }).click();
  await expect(panel.getByText('验收：第一个来源识别失败', { exact: true })).toBeVisible();
  await expect(panel.getByText('等待检查结果…', { exact: true })).toBeVisible();
  await panel.getByLabel('镜头 1 选片').selectOption(`S25:${assets[0]}`);
  remainingSpeechDone = true;
  await expect(panel.getByLabel('原声检查结果').getByText('原片没有音轨。', { exact: true })).toHaveCount(1);
  await expect(panel.getByLabel('镜头 1 选片')).toHaveValue(`S25:${assets[0]}`);
  await page.unroute(routePattern);
  await panel.getByRole('button', { name: '重新读取（放弃未保存选择）' }).click();

  const stale = await fetch(endpoint(first.planId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    requestKey: 'old-window', expectedStageId: original.current.id, expectedOutputVersionId: null, expectedEditRevision: 0, overrides: [],
  }) });
  assert.equal(stale.status, 409);
  assert.equal((await history()).history.length, 3);

  // 草稿中通过真实页面保存统一替换，生成后在原审片工作台核对人工来源。
  const manualBatch = createBatchProduction(db, 'formula-ui', '统一替换页面验收', undefined, { planningMode: 'formula' });
  for (const [index, assetId] of assets.entries()) registerFormulaAssetBinding(db, 'formula-ui', manualBatch, { assetId, sourcePath: `S${25 + index}_清洁展示.mp4` });
  await importBook('materials', [
    ['逻辑编号', '画面描述', '核心卖点', '景别'],
    ['S29', '湿布擦拭', '清洁展示', '特写'], ['S25', '纸巾擦拭', '清洁展示', '中景'], ['S26', '效果展示', '清洁效果', '全景'],
  ], manualBatch);
  const manualScripts = await importBook('scripts', [
    ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', 2, 16, 'S29 S29', '清洁效果展示'],
  ], manualBatch);
  const manualUrl = `${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${manualBatch}`;
  await page.goto(manualUrl);
  const manualEditor = page.getByRole('region', { name: '缺号统一替换', exact: true });
  await manualEditor.getByRole('button', { name: '添加统一替换规则', exact: true }).click();
  await manualEditor.getByLabel('替换规则 1 原编号').selectOption('S29');
  await manualEditor.getByLabel('替换规则 1 替代编号').selectOption('S25');
  await manualEditor.getByLabel('替换规则 1 原因').fill('人工指定本批用擦拭画面补位');
  await manualEditor.getByLabel('替换规则 1 差异').fill('湿布变为纸巾\n特写变为中景');
  const manualRulesPath = `**/batches/${manualBatch}/formula/selection-rules?*`;
  await page.route(manualRulesPath, async route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：统一替换暂未保存' }) }) : route.continue());
  await page.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(page.getByRole('region', { name: '人工选片', exact: true }).getByRole('alert')).toHaveText('验收：统一替换暂未保存');
  await expect(manualEditor.getByLabel('替换规则 1 替代编号')).toHaveValue('S25');
  await expect(manualEditor.getByLabel('替换规则 1 差异')).toHaveValue('湿布变为纸巾\n特写变为中景');
  await page.unroute(manualRulesPath);
  await page.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(page.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(manualEditor.getByLabel('替换规则 1 原因')).toHaveValue('人工指定本批用擦拭画面补位');
  await manualEditor.screenshot({ path: path.join(proofs, 'manual-rules.png') });
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  await page.getByRole('button', { name: '保存人工选片', exact: true }).click();
  await expect(page.getByText('人工选片已保存，尚未开始制作。', { exact: true })).toBeVisible();
  const ruleResponse = await fetch(`${base}/api/batch-production/batches/${manualBatch}/formula/selection-rules?projectId=formula-ui`);
  assert.equal(ruleResponse.status, 200);
  const savedMappings = await ruleResponse.json();
  assert.equal(savedMappings.saved.rules.replacements[0].replacementCode, 'S25', '第二步保存单镜头设置不能清空第一步的统一替换');
  const manualSettings = await saveFormulaSettings(db, 'formula-ui', manualBatch, { expectedInputRevision: savedMappings.inputRevision,
    expectedSettingsRevision: 0, scriptsSessionId: manualScripts.id,
    settings: { selections: [{ key: '1:2', copies: 2 }], bgm: { mode: 'none', trackIds: [] } } });
  const manualRequest = await createFormulaGenerationRequest(db, 'formula-ui', manualBatch, { requestKey: 'manual-browser',
    settingsId: manualSettings.saved.id, expectedInputRevision: savedMappings.inputRevision });
  await expect.poll(async () => {
    const response = await fetch(`${base}/api/batch-production/batches/${manualBatch}/formula/outputs/${manualRequest.outputs[0].planId}/selection?projectId=formula-ui`);
    assert.equal(response.status, 200);
    return (await response.json()).current.result?.slots[0].reason;
  }, { timeout: 15_000 }).toBe('manual_replacement');
  await page.goto(manualUrl);
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect(panel.getByText('人工统一替换 · 待审', { exact: true })).toHaveCount(2);
  await expect(panel.getByText('自动替换 · 待审', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('人工指定本批用擦拭画面补位', { exact: true }).first()).toBeVisible();
  await expect(panel.getByText('湿布变为纸巾', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '有替换 2', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(proofs, 'manual-history.png'), fullPage: true });
  const voiceUrl = `${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${voiceBatch}`;
  await page.goto(voiceUrl);
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await page.getByRole('button', { name: '查看选片 / 重新选择', exact: true }).click();
  await expect(panel.getByText('配音已生成，可在下方逐段试听。', { exact: true })).toBeVisible();
  const dock = page.getByRole('region', { name: '成片实时预览', exact: true });
  await expect(dock.getByText('可编辑画面、原声、配音和背景音乐；包装与正式导出尚未完成。', { exact: true })).toBeVisible();
  const timelineVoice = dock.locator('audio[data-timeline-audio]');
  await expect(timelineVoice).toHaveCount(1);
  await expect.poll(() => timelineVoice.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => timelineVoice.evaluate(element => element.currentTime)).toBeGreaterThan(0.05);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  assert.equal(await timelineVoice.evaluate(element => element.paused), true);
  const timingSummary = panel.getByLabel('时长安排', { exact: true });
  await expect(timingSummary.getByText('正文 1.00 秒 + 封面 0.83 秒 = 总长 1.83 秒', { exact: true })).toBeVisible();
  await timingSummary.getByText('查看每个镜头取用的时间', { exact: true }).click();
  await expect(timingSummary.getByText('取原片 0.00–1.00 秒', { exact: true })).toBeVisible();
  await expect(panel.getByText('已配音 · 镜头 1 · 1.00 秒', { exact: true })).toBeVisible();
  const voicePlayer = panel.getByLabel('配音试听 narration-1');
  await voicePlayer.evaluate(element => element.play());
  await expect.poll(() => voicePlayer.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  assert.equal(await voicePlayer.evaluate(element => element.duration), 1);
  const voiceMediaUrl = await voicePlayer.getAttribute('src');
  const rangedVoice = await fetch(new URL(voiceMediaUrl, base), { headers: { Range: 'bytes=0-3' } });
  assert.equal(rangedVoice.status, 206); assert.equal(Buffer.from(await rangedVoice.arrayBuffer()).toString(), 'RIFF');
  const foreignVoice = new URL(voiceMediaUrl, base); foreignVoice.searchParams.set('projectId', 'foreign');
  assert.equal((await fetch(foreignVoice)).status, 404);
  await panel.getByRole('button', { name: '查看原片 1', exact: true }).click();
  await panel.locator('video').evaluate(element => element.play());
  await expect.poll(() => voicePlayer.evaluate(element => element.paused)).toBe(true);
  await voicePlayer.evaluate(element => { element.currentTime = 0; return element.play(); });
  await expect.poll(() => panel.locator('video').evaluate(element => element.paused)).toBe(true);
  await panel.getByRole('button', { name: '关闭原片预览', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await panel.screenshot({ path: path.join(proofs, `narration-${theme}.png`) });
  }
  const oldVoice = await voicePlayer.elementHandle();
  await page.getByRole('button', { name: '脚本与口播', exact: true }).click();
  assert.equal(await oldVoice.evaluate(element => element.paused), true, '离开审片页面必须停止旧试听');
  await oldVoice.dispose();
  await page.goto(`${base}/projects/formula-ui?tab=final-edit&mixcut=batch&batch=${mixedBatch}`);
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await page.getByRole('button', { name: '查看选片 / 重新选择', exact: true }).click();
  await expect(dock.locator('audio[data-timeline-audio]')).toHaveCount(2);
  await expect(page.getByRole('group', { name: '原声轨道', exact: true }).locator('[data-audio-clip-id]')).toHaveCount(1);
  await expect(page.getByRole('group', { name: '配音轨道', exact: true }).locator('[data-audio-clip-id]')).toHaveCount(1);
  await expect(page.getByText('时长 3.0s', { exact: true })).toBeVisible();
  const sourcePlayer = dock.locator('audio[data-timeline-audio^="source:"]');
  const ttsPlayer = dock.locator('audio[data-timeline-audio^="tts:"]');
  const slider = dock.getByRole('slider', { name: '播放位置', exact: true });
  const seekPreview = async seconds => {
    await slider.evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, seconds);
  };
  await expect.poll(() => sourcePlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await seekPreview(20 / 24 + 0.5);
  await expect.poll(() => sourcePlayer.evaluate(element => element.currentTime)).toBeCloseTo(5.5, 1);
  assert.equal(await sourcePlayer.evaluate(element => element.paused), true);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => sourcePlayer.evaluate(element => element.currentTime)).toBeGreaterThan(5.55);
  const sourceHandle = await sourcePlayer.elementHandle();
  await expect.poll(() => ttsPlayer.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  assert.equal(await sourceHandle.evaluate(element => element.paused), true, '进入配音时原声必须停止');
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  assert.ok(Math.abs(Number(await slider.inputValue()) - 3.8333333333333335) < 0.000001, '完整播放终点为三秒正文加一次片头');
  await seekPreview(20 / 24 + 0.25);
  await expect.poll(() => sourcePlayer.evaluate(element => element.currentTime)).toBeCloseTo(5.25, 1);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await panel.getByLabel('配音试听 narration-1').evaluate(element => element.play());
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  assert.equal(await sourcePlayer.evaluate(element => element.paused), true, '单段试听必须停止整条预览的时钟和声音');
  await sourcePlayer.evaluate(element => element.dispatchEvent(new Event('play')));
  assert.equal(await panel.getByLabel('配音试听 narration-1').evaluate(element => element.paused), false, '已暂停音源的迟到事件不能抢停新试听');
  await page.screenshot({ path: path.join(proofs, 'mixed-preview.png'), fullPage: true });
  const sourceUrl = new URL(await sourcePlayer.getAttribute('src'), base);
  const sourceRange = await fetch(sourceUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(sourceRange.status, 206);
  assert.match(sourceRange.headers.get('cache-control'), /no-store/);
  assert.equal((await sourceRange.arrayBuffer()).byteLength, 16);
  const foreignSourceUrl = new URL(sourceUrl); foreignSourceUrl.searchParams.set('projectId', 'foreign');
  assert.equal((await fetch(foreignSourceUrl)).status, 404);
  const unknownSourceUrl = new URL(sourceUrl); unknownSourceUrl.searchParams.set('mediaId', 'source:unknown');
  assert.equal((await fetch(unknownSourceUrl)).status, 404);
  const failSource = url => url.pathname.endsWith('/preview/media') && url.searchParams.get('kind') === 'audio'
    && url.searchParams.get('mediaId')?.startsWith('source:');
  await page.route(failSource, route => route.fulfill({ status: 503, body: 'fixture offline' }));
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect(dock.getByText('声音文件加载失败，请检查素材后重试。', { exact: true })).toBeVisible();
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await page.unroute(failSource);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => sourcePlayer.evaluate(element => element.currentTime)).toBeGreaterThan(5.1);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  assert.equal(await sourcePlayer.evaluate(element => element.paused), true, '文件恢复后重试可继续，并且仍可暂停');
  await expect(dock.getByText('声音文件加载失败，请检查素材后重试。', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(proofs, 'mixed-preview-dark.png'), fullPage: true });
  await sourceHandle.dispose();
  // 真实编辑器：原声选中关联画面，删除/撤销一起恢复；配音独立移动并持久化。
  const mixedPlanId = mixedRequest.outputs[0].planId;
  const editUrl = `${base}/api/batch-production/batches/${mixedBatch}/outputs/${mixedPlanId}/clips?projectId=formula-ui`;
  const arrangementUrl = `${base}/api/batch-production/batches/${mixedBatch}/outputs/${mixedPlanId}/arrangement?projectId=formula-ui`;
  const currentArrangement = async () => {
    const response = await fetch(arrangementUrl);
    assert.equal(response.status, 200);
    return response.json();
  };
  const beforeEditing = await currentArrangement();
  assert.equal(beforeEditing.editable, true);
  const linkedSource = page.locator('[data-audio-clip-id][data-linked-video-clip-id]');
  await expect(linkedSource).toHaveCount(1);
  await linkedSource.click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await currentArrangement()).audioPlan.clips.filter(clip => clip.kind === 'source').length).toBe(0);
  assert.equal((await currentArrangement()).clips.length, 1, '删原声块应选中并删除关联画面');
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect(linkedSource).toHaveCount(1);
  await expect.poll(async () => (await currentArrangement()).clips.length).toBe(2);
  const restored = await currentArrangement();
  assert.deepEqual(restored.audioPlan.clips, beforeEditing.audioPlan.clips);
  assert.deepEqual(restored.subtitleCues, beforeEditing.subtitleCues);
  const ttsBlock = page.locator('[data-audio-clip-id]:not([data-linked-video-clip-id])');
  await expect(ttsBlock).toHaveCount(1);
  await ttsBlock.scrollIntoViewIfNeeded();
  const sourceBox = await linkedSource.boundingBox();
  const ttsBox = await ttsBlock.boundingBox();
  assert(sourceBox && ttsBox);
  const halfSecondPx = sourceBox.width / 4;
  await page.mouse.move(ttsBox.x + ttsBox.width / 2, ttsBox.y + ttsBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(ttsBox.x + ttsBox.width / 2 + halfSecondPx, ttsBox.y + ttsBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await currentArrangement()).audioPlan.clips.find(clip => clip.kind === 'narration').timelineStartUs).toBe(2_500_000);
  await seekPreview(20 / 24 + 2.75);
  await expect.poll(() => ttsPlayer.evaluate(element => element.currentTime)).toBeCloseTo(0.25, 1);
  await ttsBlock.click();
  await seekPreview(20 / 24 + 3);
  await page.keyboard.press('Control+b');
  await expect.poll(async () => (await currentArrangement()).audioPlan.clips.filter(clip => clip.kind === 'narration').length).toBe(2);
  const splitVoice = (await currentArrangement()).audioPlan.clips.filter(clip => clip.kind === 'narration');
  assert.deepEqual(splitVoice.map(clip => [clip.sourceInUs, clip.sourceOutUs, clip.timelineStartUs, clip.timelineEndUs]),
    [[0, 500_000, 2_500_000, 3_000_000], [500_000, 1_000_000, 3_000_000, 3_500_000]]);
  await page.locator(`[data-audio-clip-id="${splitVoice[1].id}"]`).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await currentArrangement()).audioPlan.clips.filter(clip => clip.kind === 'narration').length).toBe(1);
  assert((await currentArrangement()).audioPlan.issues.some(issue => issue.code === 'speech_incomplete'));
  await expect(page.getByText('编辑截断或删除了需要保留的话语，请恢复完整声音后再确认', { exact: true })).toBeVisible();
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect.poll(async () => (await currentArrangement()).audioPlan.clips.filter(clip => clip.kind === 'narration').length).toBe(2);
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect(ttsBlock).toHaveCount(1);
  const savedEdit = await currentArrangement();
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  assert.deepEqual((await currentArrangement()).audioPlan, savedEdit.audioPlan);
  await expect.poll(() => ttsPlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => Number(await slider.getAttribute('max'))).toBeCloseTo(20 / 24 + 3.5, 4);
  await seekPreview(20 / 24 + 2.75);
  await expect.poll(() => ttsPlayer.evaluate(element => element.currentTime)).toBeCloseTo(0.25, 1);
  const staleEdit = await fetch(editUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    type: 'delete_audio_clip', track: 'narration', clipId: savedEdit.audioPlan.clips.find(clip => clip.kind === 'narration').id,
    expectedOutputVersionId: beforeEditing.outputVersionId, expectedEditRevision: beforeEditing.editRevision }) });
  assert.equal(staleEdit.status, 409, '旧页面不能覆盖新的时间轴修改');
  const inspector = page.getByRole('complementary', { name: '成片属性' });
  await inspector.getByRole('button', { name: '配音BGM', exact: true }).click();
  await inspector.getByRole('combobox').selectOption('formula-music');
  await expect(inspector.getByRole('checkbox', { name: '说话时压低音乐', exact: true })).toBeChecked();
  for (const name of ['背景音乐淡入时间', '背景音乐淡出时间']) {
    await inspector.getByRole('slider', { name, exact: true }).evaluate(element => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '0');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await inspector.getByRole('button', { name: '应用 BGM 更改', exact: true }).click();
  await expect.poll(async () => (await currentArrangement()).music.trackId).toBe('formula-music');
  const musicPlayer = dock.locator('audio[src*="kind=music"]');
  await expect(musicPlayer).toHaveCount(1);
  await expect.poll(() => musicPlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  const frozenMusicUrl = new URL(await musicPlayer.getAttribute('src'), base);
  const musicRange = await fetch(frozenMusicUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(musicRange.status, 206);
  assert.equal((await musicRange.arrayBuffer()).byteLength, 16);
  assert.match(musicRange.headers.get('cache-control'), /no-store/);
  const foreignMusic = new URL(frozenMusicUrl); foreignMusic.searchParams.set('projectId', 'foreign');
  assert.equal((await fetch(foreignMusic)).status, 404);
  await seekPreview(20 / 24 + 0.5);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => musicPlayer.evaluate(element => !element.paused && element.currentTime > 0.55)).toBe(true);
  // Observe the actual media volume against the visible playhead, without reading React state.
  const musicSamples = await musicPlayer.evaluate(audio => new Promise(resolve => {
    const started = performance.now(), result = [];
    const position = document.querySelector('input[aria-label="播放位置"]');
    const sample = () => {
      if (!audio.paused) result.push({ body: Number(position.value) - 20 / 24, gain: audio.volume });
      if (performance.now() - started > 4500) resolve(result); else requestAnimationFrame(sample);
    };
    sample();
  }));
  fs.writeFileSync(path.join(proofs, 'music-ducking-samples.json'), JSON.stringify(musicSamples, null, 2));
  const inWindow = (from, to) => {
    const found = musicSamples.filter(sample => sample.body >= from && sample.body <= to);
    assert(found.length >= 2, `必须实际播放并采集 ${from}–${to} 秒的音乐音量`);
    return found;
  };
  for (const [from, to] of [[0.8, 1.5], [2.65, 3.2]]) {
    assert(inWindow(from, to).every(sample => Math.abs(sample.gain - 0.050119) < 0.0005), '原声和配音窗口都应在 -18dB 基础上再降 8dB');
  }
  assert(inWindow(2.28, 2.38).every(sample => Math.abs(sample.gain - 0.125893) < 0.0005), '无旁白间隙恢复为所设音乐音量');
  assert(inWindow(2.08, 2.18).every(sample => sample.gain > 0.067 && sample.gain < 0.112), '说完后的音乐逐渐恢复');
  assert(inWindow(2.43, 2.47).every(sample => sample.gain > 0.064 && sample.gain < 0.113), '下一段说话前音乐提前渐弱');
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const duckingCheckbox = inspector.getByRole('checkbox', { name: '说话时压低音乐', exact: true });
  await duckingCheckbox.uncheck();
  await inspector.getByRole('button', { name: '应用 BGM 更改', exact: true }).click();
  await expect.poll(async () => (await currentArrangement()).music.ducking.enabled).toBe(false);
  await seekPreview(20 / 24 + 0.5);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => musicPlayer.evaluate(element => element.volume)).toBeCloseTo(0.125893, 4);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect(duckingCheckbox).toBeChecked();
  await expect.poll(async () => (await currentArrangement()).music.ducking.enabled).toBe(true);
  await inspector.getByRole('spinbutton', { name: '音乐再降低 dB', exact: true }).fill('12');
  await inspector.getByRole('spinbutton', { name: '音乐压低 ms', exact: true }).fill('50');
  await inspector.getByRole('spinbutton', { name: '音乐恢复 ms', exact: true }).fill('400');
  let releaseMusicSave;
  let pendingMusicSave;
  const saveResponseGate = new Promise(resolve => { releaseMusicSave = resolve; });
  const holdMusicSave = route => {
    if (route.request().method() !== 'POST') return route.continue();
    pendingMusicSave = (async () => {
      const response = await route.fetch();
      await saveResponseGate;
      await route.fulfill({ response });
    })();
    return pendingMusicSave;
  };
  await page.route(editUrl, holdMusicSave);
  try {
    await inspector.getByRole('button', { name: '应用 BGM 更改', exact: true }).click();
    await expect.poll(() => Boolean(pendingMusicSave)).toBe(true);
    await expect(inspector.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
    await expect(inspector.getByRole('combobox')).toBeDisabled();
    await expect(duckingCheckbox).toBeDisabled();
    await expect(inspector.getByRole('spinbutton', { name: '音乐再降低 dB', exact: true })).toBeDisabled();
  } finally {
    releaseMusicSave();
    await pendingMusicSave;
    await page.unroute(editUrl, holdMusicSave);
  }
  await expect.poll(async () => (await currentArrangement()).music.ducking).toEqual({ version: 1, enabled: true, reductionDb: 12, attackMs: 50, releaseMs: 400 });
  db.prepare("UPDATE final_edit_bgm_tracks SET status='archived' WHERE id='formula-music'").run();
  await inspector.getByRole('combobox').selectOption('');
  await inspector.getByRole('button', { name: '应用 BGM 更改', exact: true }).click();
  await expect.poll(async () => (await currentArrangement()).music.trackId).toBe(null);
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect.poll(async () => (await currentArrangement()).music.trackId).toBe('formula-music');
  await expect(inspector.getByRole('combobox')).toHaveValue('formula-music');
  await expect(musicPlayer).toHaveCount(1);
  assert.equal(new URL(await musicPlayer.getAttribute('src'), base).href, frozenMusicUrl.href);
  const musicWaveform = page.getByRole('group', { name: '背景音乐轨道', exact: true }).locator('[data-waveform-status]');
  await musicWaveform.scrollIntoViewIfNeeded();
  await expect(musicWaveform).toHaveAttribute('data-waveform-status', 'ready');
  // Disable the browser's media cache so this checks the audition's actual URL,
  // rather than requiring a second network request for an already buffered file.
  const auditionRequests = [];
  const observeAudition = async route => { auditionRequests.push(route.request().url()); await route.continue(); };
  await page.route('**/preview/media?**', observeAudition);
  await inspector.getByRole('button', { name: '试听', exact: true }).click();
  await expect.poll(() => auditionRequests.includes(frozenMusicUrl.href), { message: '当前曲目试听应使用已保存来源' }).toBe(true);
  await inspector.getByRole('button', { name: '停止试听', exact: true }).click();
  await page.unroute('**/preview/media?**', observeAudition);
  const failMusic = url => url.pathname.endsWith('/preview/media') && url.searchParams.get('kind') === 'music';
  await page.route(failMusic, route => route.fulfill({ status: 503, body: 'fixture music offline' }));
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect(dock.getByText('背景音乐加载失败，请检查音乐后点击播放重试。', { exact: true })).toBeVisible();
  await page.unroute(failMusic);
  await seekPreview(20 / 24 + 0.5);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => musicPlayer.evaluate(element => !element.paused && element.currentTime > 0.55)).toBe(true);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(dock.getByText('背景音乐加载失败，请检查音乐后点击播放重试。', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await page.getByRole('button', { name: '查看选片 / 重新选择', exact: true }).click();
  await inspector.getByRole('button', { name: '配音BGM', exact: true }).click();
  await expect(inspector.getByRole('combobox')).toHaveValue('formula-music');
  await musicWaveform.scrollIntoViewIfNeeded();
  await expect(musicWaveform).toHaveAttribute('data-waveform-status', 'ready');
  await expect(duckingCheckbox).toBeChecked();
  await expect(inspector.getByRole('spinbutton', { name: '音乐再降低 dB', exact: true })).toHaveValue('12');
  await expect(inspector.getByRole('spinbutton', { name: '音乐压低 ms', exact: true })).toHaveValue('50');
  await expect(inspector.getByRole('spinbutton', { name: '音乐恢复 ms', exact: true })).toHaveValue('400');
  await seekPreview(20 / 24 + 0.5);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => musicPlayer.evaluate(element => element.volume)).toBeCloseTo(0.031623, 4);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: path.join(proofs, `formula-music-${theme}.png`), fullPage: true });
  }
  // Public edit API chooses the source interval; real timeline gestures move/split it.
  const beforeMusicCut = await currentArrangement();
  const cutMusic = await fetch(editUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    type: 'trim_audio_clip', track: 'bgm', clipId: 'bgm-full', sourceStartUs: 5_000_000, sourceEndUs: 7_000_000,
    timelineStartUs: 0, timelineEndUs: 2_000_000,
    expectedOutputVersionId: beforeMusicCut.outputVersionId, expectedEditRevision: beforeMusicCut.editRevision }) });
  assert.equal(cutMusic.status, 200, await cutMusic.text());
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  const musicBlocks = page.getByRole('group', { name: '背景音乐轨道', exact: true }).locator('[data-audio-clip-id]');
  await expect(musicBlocks).toHaveCount(1);
  await musicBlocks.scrollIntoViewIfNeeded();
  const musicBox = await musicBlocks.boundingBox();
  assert(musicBox);
  await page.mouse.move(musicBox.x + musicBox.width / 2, musicBox.y + musicBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(musicBox.x + musicBox.width, musicBox.y + musicBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await currentArrangement()).audio.bgm[0].timelineStartUs).toBe(1_000_000);
  await musicBlocks.click();
  await seekPreview(20 / 24 + 2);
  await page.keyboard.press('Control+b');
  await expect(musicBlocks).toHaveCount(2);
  assert.deepEqual((await currentArrangement()).audio.bgm.map(clip => [clip.sourceStartUs, clip.sourceEndUs, clip.timelineStartUs, clip.timelineEndUs]),
    [[5_000_000, 6_000_000, 1_000_000, 2_000_000], [6_000_000, 7_000_000, 2_000_000, 3_000_000]]);
  await seekPreview(20 / 24 + 1.25);
  await expect.poll(() => musicPlayer.evaluate(element => element.currentTime), { message: '移动/分割后试听仍应取歌曲第 5.25 秒' }).toBeCloseTo(5.25, 1);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  const cutSamples = await musicPlayer.evaluate(audio => new Promise(resolve => {
    const started = performance.now(), result = [];
    const position = document.querySelector('input[aria-label="播放位置"]');
    const sample = () => {
      result.push({ body: Number(position.value) - 20 / 24, source: audio.currentTime, gain: audio.volume, seeking: audio.seeking });
      if (performance.now() - started > 4000) resolve(result); else requestAnimationFrame(sample);
    };
    sample();
  }));
  fs.writeFileSync(path.join(proofs, 'music-cut-samples.json'), JSON.stringify(cutSamples, null, 2));
  for (const [from, to] of [[1.4, 1.8], [2.1, 2.8]]) {
    const heard = cutSamples.filter(sample => sample.body >= from && sample.body <= to && sample.gain > 0);
    assert(heard.length >= 2, '必须实际播放音乐分割前后两段');
    assert(heard.every(sample => !sample.seeking && Math.abs(sample.source - sample.body - 4) < 0.12), '播放中的音乐取源必须跟随裁切映射');
  }
  const afterCut = cutSamples.filter(sample => sample.body > 3.1);
  assert(afterCut.length > 0 && afterCut.every(sample => sample.gain === 0), '删去的音乐尾部保持安静');
  await seekPreview(20 / 24 + 0.25);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => musicPlayer.evaluate(element => element.volume)).toBe(0);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect(musicBlocks).toHaveCount(2);
  await seekPreview(20 / 24 + 2.25);
  await expect.poll(() => musicPlayer.evaluate(element => element.currentTime)).toBeCloseTo(6.25, 1);
  await musicBlocks.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(proofs, 'formula-music-cut.png'), fullPage: true });
  const applyMusicEdit = async command => {
    const current = await currentArrangement();
    const response = await fetch(editUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      ...command, expectedOutputVersionId: current.outputVersionId, expectedEditRevision: current.editRevision }) });
    assert.equal(response.status, 200, await response.text());
  };
  await applyMusicEdit({ type: 'restore_arrangement', snapshot: { ...beforeMusicCut, musicTrackId: beforeMusicCut.music.trackId,
    musicSourceFingerprint: beforeMusicCut.formulaPreview.music.sourceFingerprint, musicGainDb: beforeMusicCut.music.gainDb,
    musicFadeInSec: 0, musicFadeOutSec: 0, musicDucking: beforeMusicCut.music.ducking, narrationGainDb: beforeMusicCut.narration.gainDb } });
  await applyMusicEdit({ type: 'trim_audio_clip', track: 'bgm', clipId: 'bgm-full', sourceStartUs: 7_500_000, sourceEndUs: 9_500_000,
    timelineStartUs: 1_000_000, timelineEndUs: 3_000_000 });
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect(musicBlocks).toHaveCount(1);
  await expect.poll(() => musicPlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await seekPreview(20 / 24 + 1.25);
  await expect.poll(() => musicPlayer.evaluate(element => element.currentTime)).toBeCloseTo(7.75, 1);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  const loopSamples = await musicPlayer.evaluate(audio => new Promise(resolve => {
    const started = performance.now(), result = [];
    const position = document.querySelector('input[aria-label="播放位置"]');
    const sample = () => {
      if (!audio.paused) result.push({ body: Number(position.value) - 20 / 24, source: audio.currentTime, gain: audio.volume });
      if (performance.now() - started > 4000) resolve(result); else requestAnimationFrame(sample);
    };
    sample();
  }));
  fs.writeFileSync(path.join(proofs, 'music-loop-samples.json'), JSON.stringify(loopSamples, null, 2));
  const wrapped = loopSamples.filter(sample => sample.body > 1.65 && sample.body < 2.8 && sample.gain > 0);
  assert(wrapped.length > 2 && wrapped.every(sample => Math.abs(sample.source - sample.body + 1.5) < 0.12), '跨过歌曲结尾后连续播放开头');
  await musicBlocks.click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await currentArrangement()).audio.bgm).toEqual([]);
  await expect(musicBlocks).toHaveCount(0);
  await seekPreview(20 / 24 + 1.25);
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => musicPlayer.evaluate(element => element.volume)).toBe(0);
  await dock.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect(musicBlocks).toHaveCount(1);
  const beforeProtection = await currentArrangement();
  await applyMusicEdit({ type: 'set_music_track', trackId: null });
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect.poll(() => sourcePlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await seekPreview(0);
  await page.evaluate(() => { window.__audioCapture.enabled = true; });
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const edgeCapture = await page.evaluate(() => { window.__audioCapture.enabled = false; return window.__audioCapture.frames; });
  fs.writeFileSync(path.join(proofs, 'audio-edge-samples.json'), JSON.stringify(edgeCapture));
  const edgeSamples = edgeCapture.flatMap(frame => frame.samples);
  const onset = edgeSamples.findIndex(sample => Math.abs(sample) > 0.001);
  assert(onset >= 0, '实际预览必须有声音');
  const firstMillisecond = edgeSamples.slice(onset, onset + Math.round(edgeCapture[0].rate / 1000));
  const onsetRms = Math.sqrt(firstMillisecond.reduce((sum, sample) => sum + sample ** 2, 0) / firstMillisecond.length);
  assert(onsetRms < 0.04, `实际预览的声音开头必须短渐入，不能突然跳到完整音量：${onsetRms}`);
  let sourceEnd = onset + Math.round(edgeCapture[0].rate * 2.2);
  while (sourceEnd > onset && Math.abs(edgeSamples[sourceEnd]) <= 0.001) sourceEnd--;
  const lastMillisecond = edgeSamples.slice(sourceEnd - Math.round(edgeCapture[0].rate / 1000) + 1, sourceEnd + 1);
  const tailRms = Math.sqrt(lastMillisecond.reduce((sum, sample) => sum + sample ** 2, 0) / lastMillisecond.length);
  assert(tailRms < 0.04, `原声进入无旁白间隙前应短渐出，不能突然切断完整音量：${tailRms}`);
  // Compare the same saved edit and media, per output channel (never mono downmix).
  const { renderBatchOutputVersion } = await import('../lib/batch-production/batch-renderer.ts');
  const rendered = await renderBatchOutputVersion({ db, projectId: 'formula-ui', batchId: mixedBatch,
    batchVersionId: mixedRequest.batchVersionId, planId: mixedPlanId, outputVersionId: beforeProtection.outputVersionId,
    outputSize: { width: 160, height: 160 } });
  const decodedPath = path.join(root, 'preview-comparison.f32');
  await runFfmpeg(['-i', rendered.videoAbsolutePath, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', '-y', decodedPath]);
  const decodedBytes = fs.readFileSync(decodedPath);
  const pcm = new Float32Array(decodedBytes.buffer, decodedBytes.byteOffset, decodedBytes.length / 4);
  const rms = values => Math.sqrt(values.reduce((sum, sample) => sum + sample ** 2, 0) / values.length);
  const levelRatios = [];
  for (const channel of [0, 1]) {
    const browserOriginal = edgeCapture.filter(frame => frame.body > 0.3 && frame.body < 0.7)
      .flatMap(frame => channel === 0 ? frame.samples : frame.rightSamples);
    const renderedOriginal = Array.from(pcm.slice(Math.round((20 / 24 + 0.3) * 48_000) * 2,
      Math.round((20 / 24 + 0.7) * 48_000) * 2)).filter((_, index) => index % 2 === channel);
    assert(browserOriginal.length > 2000);
    const levelRatio = rms(renderedOriginal) / rms(browserOriginal);
    assert(levelRatio > 0.95 && levelRatio < 1.05, `同一份原声的试听与 MP4 每个声道的电平应一致：${channel} / ${levelRatio}`);
    levelRatios.push(levelRatio);
  }
  await applyMusicEdit({ type: 'split', clipId: beforeProtection.clips[0].clipId, offsetUs: 1_000_000 });
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await expect.poll(() => sourcePlayer.first().evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await seekPreview(0);
  await page.evaluate(() => { window.__audioCapture.enabled = true; });
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const splitCapture = await page.evaluate(() => { window.__audioCapture.enabled = false; return window.__audioCapture.frames; });
  fs.writeFileSync(path.join(proofs, 'audio-split-samples.json'), JSON.stringify(splitCapture));
  const splitSamples = splitCapture.flatMap(frame => frame.samples);
  const splitOnset = splitSamples.findIndex(sample => Math.abs(sample) > 0.001);
  const splitRate = splitCapture[0].rate, windowLength = Math.round(splitRate * 0.002);
  assert(splitOnset >= 0);
  for (let offset = Math.round(splitRate * 0.2); offset < splitRate * 1.8; offset += windowLength) {
    assert(rms(splitSamples.slice(splitOnset + offset, splitOnset + offset + windowLength)) > 0.03,
      `同一句原声的分割点不得引入停顿或额外淡入：${offset / splitRate}s`);
  }
  await applyMusicEdit({ type: 'restore_arrangement', snapshot: { ...beforeProtection, musicTrackId: beforeProtection.music.trackId,
    musicSourceFingerprint: beforeProtection.formulaPreview.music.sourceFingerprint, musicGainDb: beforeProtection.music.gainDb,
    musicFadeInSec: 0, musicFadeOutSec: 0, musicDucking: beforeProtection.music.ducking, narrationGainDb: beforeProtection.narration.gainDb } });
  await applyMusicEdit({ type: 'set_narration_gain', gainDb: 10 });
  await page.reload();
  await page.getByRole('button', { name: '检查成片', exact: true }).click();
  await seekPreview(20 / 24 + 2.6);
  await page.evaluate(() => { window.__audioCapture.enabled = true; });
  await dock.getByRole('button', { name: '播放', exact: true }).click();
  await expect(dock.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const outputCapture = await page.evaluate(() => { window.__audioCapture.enabled = false; return window.__audioCapture.frames; });
  fs.writeFileSync(path.join(proofs, 'audio-protection-samples.json'), JSON.stringify(outputCapture));
  const capturedVoice = outputCapture.filter(frame => frame.body > 2.8 && frame.body < 3.2).flatMap(frame => [...frame.samples, ...frame.rightSamples]);
  assert(capturedVoice.length > 2000, '应采集实际声音输出，不能只读取音量设置');
  const outputPeak = capturedVoice.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
  assert(outputPeak > 0.7 && outputPeak < 0.91, `实际预览输出必须限制过大峰值，不能过载或静音：${outputPeak}`);
  fs.writeFileSync(path.join(proofs, 'audio-quality-summary.json'), JSON.stringify({ onsetRms, tailRms, outputPeak, levelRatios,
    sampleRate: edgeCapture[0].rate, splitContinuity: 'passed' }, null, 2));
  const beforeDisabling = await currentArrangement();
  await stopServer();
  base = await startServer(false);
  const disabledArrangement = await fetch(`${base}/api/batch-production/batches/${mixedBatch}/outputs/${mixedPlanId}/arrangement?projectId=formula-ui`);
  assert.equal(disabledArrangement.status, 200);
  const disabledView = await disabledArrangement.json();
  assert.equal(disabledView.editable, false);
  assert.deepEqual(disabledView.audioPlan, beforeDisabling.audioPlan, '关闭公式能力仍保留最新编辑及其修订');
  assert.equal(disabledView.editRevision, beforeDisabling.editRevision);
  const disabledEdit = await fetch(`${base}/api/batch-production/batches/${mixedBatch}/outputs/${mixedPlanId}/clips?projectId=formula-ui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'delete', clipId: disabledView.clips[0].clipId,
      expectedOutputVersionId: disabledView.outputVersionId, expectedEditRevision: disabledView.editRevision }) });
  assert.equal(disabledEdit.status, 503, '关闭能力不能从通用编辑接口继续写公式版本');
  const blocked = await fetch(endpoint(first.planId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 503);
  const ordinary = await fetch(`${base}/api/batch-production/batches`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'formula-ui', name: '关闭公式后普通仍可创建' }) });
  assert.equal(ordinary.status, 201);
  assert.deepEqual(readFormulaSelectionHistory(db, 'formula-ui', batchId, first.planId).history, finalHistory.history);
  assert.deepEqual(errors, []);
  console.log('公式浏览器：选片/原声配音编辑、音乐裁切/移动/分割/循环/删空/刷新、压低/调参/撤销/加载重试、并发冲突和关闭能力隔离通过');
  }
} catch (error) {
  console.error(error);
  fs.writeFileSync(path.join(proofs, 'failure-network.json'), JSON.stringify({ pending: [...pendingApi.values()], failed: failedApi }, null, 2));
  if (page) {
    await page.screenshot({ path: path.join(proofs, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(proofs, 'failure.txt'), await page.locator('body').innerText().catch(() => '页面不可读'));
  }
  console.error(output.join('').slice(-4000));
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  db?.close();
  (await import('../lib/db.ts')).closeDb();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
