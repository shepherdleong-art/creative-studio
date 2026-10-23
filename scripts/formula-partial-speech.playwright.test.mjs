/** 原声整句覆盖的审片对照；公共领域入口准备真实合成媒体，浏览器读取实际已保存结果。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { chromium, expect } from '@playwright/test';

const standalone = process.env.FORMULA_BROWSER_SERVER;
assert(standalone, '请显式指定已构建的隔离 FORMULA_BROWSER_SERVER');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-partial-speech-browser-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = '';
process.env.FINAL_EDIT_ALIGNMENT_API_KEY = '';
const manualAudio = process.argv.includes('--manual-audio');
const semanticSource = process.argv.includes('--semantic-source');
const textRoles = process.argv.includes('--text-roles');
const manualMediaSpeechApi = process.argv.includes('--manual-media-speech-api');
const manualMediaSpeechUi = process.argv.includes('--manual-media-speech-ui');
const manualTtsUi = process.argv.includes('--manual-tts-ui');
const manualMediaApi = process.argv.includes('--manual-media-api') || manualMediaSpeechApi;
const manualMediaUi = process.argv.includes('--manual-media-ui');
const manualDeviations = process.argv.includes('--manual-deviations') || manualMediaApi || manualMediaUi || manualMediaSpeechUi || manualTtsUi;
assert([manualAudio, semanticSource, textRoles, manualDeviations].filter(Boolean).length <= 1);
const proofs = path.resolve(manualTtsUi ? 'outputs/formula-manual-tts-browser' : manualMediaSpeechUi ? 'outputs/formula-manual-media-speech-ui' : manualMediaUi ? 'outputs/formula-manual-media-ui' : manualMediaSpeechApi ? 'outputs/formula-manual-media-speech-browser'
  : manualMediaApi ? 'outputs/formula-manual-media-browser' : manualAudio ? 'outputs/formula-manual-audio-browser'
  : manualDeviations ? 'outputs/formula-manual-deviations-browser' : textRoles ? 'outputs/formula-text-roles-browser' : semanticSource ? 'outputs/formula-semantic-speech-browser' : 'outputs/formula-partial-speech-browser');
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
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt,workflowType,productCode) VALUES ('partial-ui','原声对照验收','fixture','fixture','','complex_product','PARTIAL')").run();
  const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
  const { registerManagedCopy } = await import('../lib/batch-production/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/batch-production/formula/material-bindings.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/batch-production/formula/import-store.ts');
  const { readFormulaManualSpeech, saveFormulaManualSpeech } = await import('../lib/batch-production/formula/manual-speech.ts');
  const { saveFormulaSettings } = await import('../lib/batch-production/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/batch-production/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/batch-production/formula/generation.ts');
  const { createFormulaStageExecutor } = await import('../lib/batch-production/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/batch-production/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/batch-production/runner.ts');
  const { getBatchWorkspace } = await import('../lib/batch-production/batch-workspace.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const source = path.join(root, 'VO1.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
    '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', source]);
  const batchId = createBatchProduction(db, 'partial-ui', '完整保留原声', undefined, { planningMode: 'formula' });
  const assetId = await registerManagedCopy(db, 'partial-ui', { sourcePath: source });
  registerFormulaAssetBinding(db, 'partial-ui', batchId, { assetId, sourcePath: 'VO1_原声.mp4' });
  if (manualDeviations) for (const [index, color] of ['red', 'blue'].entries()) {
    const file = path.join(root, `G${index + 1}.mp4`);
    await runFfmpeg(['-f', 'lavfi', '-i', `color=${color}:s=64x64:r=24:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
    const id = await registerManagedCopy(db, 'partial-ui', { sourcePath: file });
    registerFormulaAssetBinding(db, 'partial-ui', batchId, { assetId: id, sourcePath: `G${index + 1}_展示.mp4` });
  }
  const inputRevision = manualDeviations ? 3 : 1;
  const book = new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
    [12, '抖音', manualTtsUi ? 2 : manualDeviations ? 3 : 1, manualDeviations ? 7 : 3, manualTtsUi ? 'G1 G2' : manualDeviations ? 'VO1 G1 G2' : 'VO1', manualAudio ? '容易清洁。拍摄备注。' : textRoles ? '好擦洗。【花字：加宽坐面】【备注：镜头慢推】' : semanticSource ? '容易清洁。' : '好擦洗。']]);
  const imported = await createFormulaImportSession(db, 'partial-ui', batchId, { kind: 'scripts', filename: '脚本.xlsx',
    bytes: Buffer.from(await book.xlsx.writeBuffer()), expectedRevision: inputRevision });
  confirmFormulaImportSession(db, 'partial-ui', batchId, imported.id, { expectedRevision: inputRevision, excludedKeys: [] });
  const sourceView = readFormulaManualSpeech(db, 'partial-ui', batchId);
  await saveFormulaManualSpeech(db, 'partial-ui', batchId, { assetId, contentFingerprint: sourceView.items.find(item => item.assetId === assetId).contentFingerprint,
    expectedInputRevision: inputRevision + 1, expectedSpeechRevision: 0, mode: 'speech', confirmed: true,
    segments: [{ text: '好擦洗。', startUs: 125_000, endUs: 1_250_000 }, { text: '靠背也舒服。', startUs: 1_500_000, endUs: 2_875_000 }] });
  const production = defaultFormulaProductionSettings();
  production.audio = { mode: 'mixed', tts: null }; production.packaging = textRoles
    ? { mode: 'uniform', templateIds: ['overlay-minimal'] } : { mode: 'none', templateIds: [] };
  const originalFetch = globalThis.fetch;
  if (manualTtsUi) {
    process.env.FINAL_EDIT_ALIGNMENT_BASE_URL = 'https://alignment.example';
    process.env.FINAL_EDIT_ALIGNMENT_API_KEY = 'fixture';
    db.prepare(`UPDATE final_edit_tts_providers SET enabled=1,apiKey='fixture',keyEnv='',baseUrl='https://voice.example' WHERE id='vapi-qwen3-tts'`).run();
    const audio = path.join(root, 'tts.wav');
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', audio]);
    globalThis.fetch = async url => String(url).endsWith('/audio/speech')
      ? Response.json({ output: { audio: { data: fs.readFileSync(audio).toString('base64') } } })
      : Response.json({ words: [{ word: '好擦洗。', start: 0.125, end: 0.875 }] });
    production.audio = { mode: 'narration', tts: { providerId: 'vapi-qwen3-tts', voice: 'Cherry', speed: 1 } };
  }
  const settings = await saveFormulaSettings(db, 'partial-ui', batchId, { expectedInputRevision: inputRevision + 2, expectedSettingsRevision: 0,
    scriptsSessionId: imported.id, settings: { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] }, production } });
  const generated = await createFormulaGenerationRequest(db, 'partial-ui', batchId,
    { requestKey: 'partial', settingsId: settings.saved.id, expectedInputRevision: inputRevision + 2 });
  await runPendingOnce({ db, workerId: 'partial-fixture', log: () => {}, executors: [
    createFormulaStageExecutor(async () => manualAudio || manualTtsUi ? null : ({ id: 'fixture', name: '外部文本响应夹具', model: 'fixture', async complete(input) {
      const prompt = JSON.parse(input.userPrompt);
      if (prompt.task === 'verify_text_roles') return { checks: [], duplicateNarration: false, roleChecks: [
        { blockId: 'text-2', kind: 'on_screen', verdict: 'confirmed', reason: '原文明确标为花字。' },
        { blockId: 'text-3', kind: 'reference', verdict: 'confirmed', reason: '原文是拍摄备注。' },
      ] };
      if (prompt.task === 'verify_source_coverage') return { checks: [{ blockId: 'text-1', verdict: 'covered',
        reason: '好擦洗表达容易清洁，没有增加产品事实。' }], duplicateNarration: false };
      return { blocks: [{ text: semanticSource ? '容易清洁。' : '好擦洗。', kind: 'source', slotId: prompt.sources[0].slotId,
        ...(semanticSource ? { sourceText: '好擦洗。' } : {}) },
        ...(textRoles ? [{ text: '【花字：加宽坐面】', kind: 'on_screen', slotId: prompt.sources[0].slotId, displayText: '加宽坐面' },
          { text: '【备注：镜头慢推】', kind: 'reference' }] : [])] };
    } })), createBatchRenderExecutor(),
  ] });
  globalThis.fetch = originalFetch;
  assert.equal(getBatchWorkspace(db, 'partial-ui', batchId).formulaGeneration.ready, manualAudio ? 0 : 1,
    JSON.stringify(getBatchWorkspace(db, 'partial-ui', batchId).cards.map(card => card.blockers)));
  if (manualDeviations && !manualMediaApi && !manualMediaUi && !manualMediaSpeechUi && !manualTtsUi) {
    const { applyBatchOutputClipEdit, getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
    const planId = generated.outputs[0].planId;
    const view = () => getBatchOutputArrangementView(db, 'partial-ui', batchId, planId);
    const original = view();
    const edit = command => applyBatchOutputClipEdit(db, 'partial-ui', batchId, planId,
      { ...command, expectedEditRevision: view().editRevision, expectedOutputVersionId: view().outputVersionId });
    edit({ type: 'delete', clipId: original.clips[1].clipId });
    edit({ type: 'move_clip', clipId: original.clips[0].clipId, startUs: original.clips[2].timelineEndUs });
    edit({ type: 'move_clip', clipId: original.clips[0].clipId, startUs: view().clips[0].timelineEndUs });
    await runPendingOnce({ db, workerId: 'deviation-check', log: () => {}, executors: [createFormulaStageExecutor(), createBatchRenderExecutor()] });
    assert.equal(getBatchWorkspace(db, 'partial-ui', batchId).formulaGeneration.ready, 1);
  }
  db.close(); db = undefined;
  let base = await start();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
  const open = async (ready = !manualAudio) => {
    await page.goto(`${base}/projects/partial-ui?tab=final-edit&mixcut=batch&batch=${batchId}`);
    await page.getByRole('button', { name: '检查成片', exact: true }).click();
    if (ready) await page.getByRole('button', { name: '查看选片 / 重新选择', exact: true }).click();
    await expect(page.getByRole('region', { name: '公式选片记录' })).toBeVisible();
  };
  await open();
  if (manualTtsUi) {
    const planId = generated.outputs[0].planId;
    const endpoint = `/api/batch-production/batches/${batchId}/outputs/${planId}`;
    const read = async () => {
      const response = await page.request.get(`${base}${endpoint}/arrangement?projectId=partial-ui`);
      assert.equal(response.status(), 200); return response.json();
    };
    const before = await read();
    assert.equal(before.audioPlan.clips[0].kind, 'narration');
    const pool = page.getByRole('region', { name: '素材池', exact: true });
    await pool.getByRole('button', { name: /正文素材库/ }).click();
    const name = before.poolAssets.find(asset => asset.assetId === assetId).displayName;
    const targetName = before.poolAssets.find(asset => asset.assetId === before.clips[0].assetId).displayName;
    await pool.locator('article[draggable="true"]').filter({ hasText: name })
      .dragTo(page.getByRole('region', { name: '统一时间轴', exact: true }).getByText(targetName, { exact: true }).last().locator('../..'));
    const monitor = page.getByRole('region', { name: '人工素材取用', exact: true });
    await monitor.getByRole('radio', { name: '保留原声', exact: true }).check();
    await monitor.getByRole('textbox', { name: '实际台词 1', exact: true }).fill('好擦洗。');
    await monitor.getByRole('spinbutton', { name: '台词 1 开始秒', exact: true }).fill('0.125');
    await monitor.getByRole('spinbutton', { name: '台词 1 结束秒', exact: true }).fill('1.25');
    const confirm = monitor.getByRole('checkbox', { name: /我已试听/ });
    await confirm.check();
    const apply = monitor.getByRole('button', { name: '替换画面并保留原声', exact: true });
    await expect(apply).toBeDisabled();
    const replaceTts = monitor.getByRole('checkbox', { name: '替代这段配音：好擦洗。', exact: true });
    await expect(replaceTts).not.toBeChecked();
    await replaceTts.check();
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    await expect(apply).toBeEnabled();
    await expect.poll(() => monitor.locator('video').evaluate(video => video.muted)).toBe(false);
    await monitor.locator('video').evaluate(video => video.play());
    await expect.poll(() => monitor.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.3);
    await monitor.locator('video').evaluate(video => video.pause());
    await monitor.locator('[aria-label="原声台词填写"]').evaluate(element => { element.scrollTop = 0; });
    await monitor.screenshot({ path: path.join(proofs, 'replace-tts-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await monitor.screenshot({ path: path.join(proofs, 'replace-tts-dark.png'), animations: 'disabled' });
    await apply.click(); await expect(monitor).toBeHidden();
    const after = await read();
    assert.deepEqual(after.audioPlan.clips.map(clip => clip.kind), ['source']);
    assert.deepEqual(after.audioPlan.issues, []);
    assert.deepEqual(after.subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]), [['好擦洗。', 125_000, 1_250_000]]);
    await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
    await expect.poll(async () => (await read()).audioPlan.clips[0].kind).toBe('narration');
    await page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).click();
    await expect.poll(async () => (await read()).audioPlan.clips[0].kind).toBe('source');
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    const issues = page.getByTestId('batch-review-issues'); await issues.locator('summary').click();
    await expect(issues).toContainText('替代配音：好擦洗。');
    await page.close(); await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    assert.deepEqual((await read()).audioPlan.clips, after.audioPlan.clips);
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', explicitNarrationReplacement: true,
      confirmationReset: true, linkedSubtitles: true, undoRedo: true, reviewReady: true, restartRestored: true }, null, 2));
  } else if (manualMediaSpeechUi) {
    const planId = generated.outputs[0].planId;
    const endpoint = `/api/batch-production/batches/${batchId}/outputs/${planId}`;
    const read = async () => {
      const response = await page.request.get(`${base}${endpoint}/arrangement?projectId=partial-ui`);
      assert.equal(response.status(), 200); return response.json();
    };
    const before = await read();
    const voice = path.join(root, '新口播.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=yellow:s=64x64:r=24:d=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
      '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', '-y', voice]);
    const pool = page.getByRole('region', { name: '素材池', exact: true });
    await pool.getByRole('button', { name: /正文素材库/ }).click();
    const uploaded = page.waitForResponse(response => response.url().includes('/assets/import') && response.request().method() === 'POST');
    await pool.locator('input[type="file"]').setInputFiles(voice);
    const uploadResponse = await uploaded;
    assert.equal(uploadResponse.status(), 200, await uploadResponse.text());
    await expect(pool.getByText('新口播.mp4', { exact: true })).toBeVisible();
    const material = pool.locator('article[draggable="true"]').filter({ hasText: '新口播.mp4' });
    const targetName = before.poolAssets.find(asset => asset.assetId === before.clips[0].assetId).displayName;
    const drag = () => material.dragTo(page.getByRole('region', { name: '统一时间轴', exact: true }).getByText(targetName, { exact: true }).last().locator('../..'));
    await drag();
    const monitor = page.getByRole('region', { name: '人工素材取用', exact: true });
    await monitor.getByRole('radio', { name: '保留原声', exact: true }).check();
    await monitor.getByRole('textbox', { name: '实际台词 1', exact: true }).fill('取消的台词');
    await monitor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(monitor).toBeHidden();
    assert.equal((await read()).editRevision, before.editRevision);
    await drag();
    await monitor.getByRole('radio', { name: '保留原声', exact: true }).check();
    await expect(monitor.getByRole('textbox', { name: '实际台词 1', exact: true })).toHaveValue('');
    await expect(monitor).toContainText('替换前台词');
    await expect(monitor).toContainText('好擦洗。');
    await expect(monitor).toContainText('靠背也舒服。');
    const slider = monitor.getByRole('slider', { name: '移动截取选框', exact: true });
    await expect(slider).toHaveAttribute('aria-disabled', 'false');
    await expect.poll(() => monitor.locator('video').evaluate(video => video.muted)).toBe(false);
    await monitor.locator('video').evaluate(video => video.play());
    await expect.poll(() => monitor.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.4);
    await monitor.locator('video').evaluate(video => video.pause());
    for (let i = 0; i < 6; i++) await slider.press('ArrowRight');
    await monitor.getByRole('textbox', { name: '实际台词 1', exact: true }).fill('好擦洗。');
    await monitor.getByRole('spinbutton', { name: '台词 1 开始秒', exact: true }).fill('0.375');
    await monitor.getByRole('spinbutton', { name: '台词 1 结束秒', exact: true }).fill('1.5');
    await monitor.getByRole('button', { name: '添加一句台词', exact: true }).click();
    await monitor.getByRole('textbox', { name: '实际台词 2', exact: true }).fill('靠背也舒服。');
    await monitor.getByRole('spinbutton', { name: '台词 2 开始秒', exact: true }).fill('1.75');
    await monitor.getByRole('spinbutton', { name: '台词 2 结束秒', exact: true }).fill('3.125');
    const apply = monitor.getByRole('button', { name: '替换画面并保留原声', exact: true });
    await expect(apply).toBeDisabled();
    const confirm = monitor.getByRole('checkbox', { name: /我已试听/ });
    await confirm.check();
    await slider.press('ArrowRight');
    await expect(confirm).not.toBeChecked();
    await slider.press('ArrowLeft');
    await confirm.check();
    await monitor.getByRole('spinbutton', { name: '台词 2 开始秒', exact: true }).fill('1.25');
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    await expect(apply).toBeDisabled(); // Overlapping sentences cannot be accepted by ticking the confirmation.
    await monitor.getByRole('spinbutton', { name: '台词 2 开始秒', exact: true }).fill('1.75');
    await confirm.check();
    await monitor.getByRole('radio', { name: '静音', exact: true }).check();
    await expect.poll(() => monitor.locator('video').evaluate(video => video.muted)).toBe(true);
    await monitor.getByRole('radio', { name: '保留原声', exact: true }).check();
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    await expect(apply).toBeEnabled();
    await monitor.locator('[aria-label="原声台词填写"]').evaluate(element => { element.scrollTop = 0; });
    await monitor.screenshot({ path: path.join(proofs, 'speech-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await monitor.screenshot({ path: path.join(proofs, 'speech-dark.png'), animations: 'disabled' });
    await confirm.scrollIntoViewIfNeeded();
    await monitor.screenshot({ path: path.join(proofs, 'confirmation-dark.png'), animations: 'disabled' });
    const requests = [];
    const editRoute = `**${endpoint}/clips?*`;
    await page.route(editRoute, async route => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        await route.abort('failed');
      } else await route.continue();
    });
    await apply.click();
    await expect(monitor.getByRole('alert')).toContainText('可重试同一次保存');
    await expect(monitor.getByRole('textbox', { name: '实际台词 1', exact: true })).toBeDisabled();
    await expect(monitor.getByRole('radio', { name: '保留原声', exact: true })).toBeDisabled();
    await monitor.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(monitor).toBeHidden();
    await page.unroute(editRoute);
    assert.deepEqual(requests[1], requests[0]);
    const after = await read();
    assert.equal(after.editRevision, before.editRevision + 1);
    assert.notEqual(after.clips[0].assetId, before.clips[0].assetId);
    assert.equal(after.clips[0].sourceStartUs, 250_000);
    assert.notEqual(after.audioPlan.clips[0].mediaId, before.audioPlan.clips[0].mediaId);
    assert.deepEqual(after.subtitleCues.slice(0, 2).map(cue => [cue.text, cue.startUs, cue.endUs, cue.timingSource]),
      [['好擦洗。', 125_000, 1_250_000, 'manual'], ['靠背也舒服。', 1_500_000, 2_875_000, 'manual']]);
    await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
    await expect.poll(async () => (await read()).audioPlan.clips[0].mediaId).toBe(before.audioPlan.clips[0].mediaId);
    await page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).click();
    await expect.poll(async () => (await read()).audioPlan.clips[0].mediaId).toBe(after.audioPlan.clips[0].mediaId);
    const beforeInsert = await read();
    await material.dragTo(page.getByRole('region', { name: '统一时间轴', exact: true }).getByText('+追加', { exact: true }));
    await monitor.getByRole('radio', { name: '保留原声', exact: true }).check();
    await monitor.getByRole('spinbutton', { name: '取用时长（秒）', exact: true }).fill('1.5');
    await monitor.getByRole('textbox', { name: '实际台词 1', exact: true }).fill('坐得稳。');
    await monitor.getByRole('spinbutton', { name: '台词 1 开始秒', exact: true }).fill('0.125');
    await monitor.getByRole('spinbutton', { name: '台词 1 结束秒', exact: true }).fill('1.25');
    await confirm.check();
    await monitor.getByRole('spinbutton', { name: '取用时长（秒）', exact: true }).fill('1');
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    await expect(monitor.getByRole('button', { name: '插入画面并保留原声', exact: true })).toBeDisabled();
    await monitor.getByRole('spinbutton', { name: '取用时长（秒）', exact: true }).fill('1.5');
    await confirm.check();
    await monitor.getByRole('button', { name: '插入画面并保留原声', exact: true }).click();
    await expect(monitor).toBeHidden();
    const inserted = await read();
    assert.equal(inserted.clips.length, beforeInsert.clips.length + 1);
    assert.equal(inserted.audioPlan.clips.length, beforeInsert.audioPlan.clips.length + 1);
    assert.deepEqual(inserted.audioPlan.clips.slice(0, beforeInsert.audioPlan.clips.length), beforeInsert.audioPlan.clips);
    assert.equal(inserted.subtitleCues.at(-1).text, '坐得稳。');
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    const issues = page.getByTestId('batch-review-issues'); await issues.locator('summary').click();
    await expect(issues).toContainText('人工核对原声');
    await expect(issues).toContainText('实际台词：坐得稳。');
    await page.close(); await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    const restored = await read();
    assert.deepEqual(restored.clips, inserted.clips);
    assert.deepEqual(restored.audioPlan, inserted.audioPlan);
    assert.deepEqual(restored.sourceSpeechByClipId, inserted.sourceSpeechByClipId);
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', upload: true, drag: true, sourceSpeech: true,
      transcript: true, confirmationRequired: true, undoRedo: true, cancelUnchanged: true, previewUnmuted: true,
      confirmationReset: true, invalidSpeechGuard: true, lostReplyRetryUndo: true, sourceInsertion: true, reviewReady: true, restartRestored: true }, null, 2));
  } else if (manualMediaUi) {
    await page.getByRole('button', { name: /正文素材库/ }).click();
    const planId = generated.outputs[0].planId;
    const endpoint = `/api/batch-production/batches/${batchId}/outputs/${planId}`;
    const read = async () => {
      const response = await page.request.get(`${base}${endpoint}/arrangement?projectId=partial-ui`);
      assert.equal(response.status(), 200); return response.json();
    };
    const before = await read();
    const target = before.clips[1], replacement = before.clips[2];
    const targetName = before.poolAssets.find(asset => asset.assetId === target.assetId).displayName;
    const replacementName = before.poolAssets.find(asset => asset.assetId === replacement.assetId).displayName;
    const voiceName = before.poolAssets.find(asset => asset.assetId === before.clips[0].assetId).displayName;
    const drag = async () => page.locator('article[draggable="true"]').filter({ hasText: replacementName })
      .dragTo(page.getByRole('region', { name: '统一时间轴', exact: true }).getByText(targetName, { exact: true }).last().locator('../..'));
    const monitor = page.getByRole('region', { name: '人工素材取用', exact: true });
    await page.locator('article[draggable="true"]').filter({ hasText: replacementName })
      .dragTo(page.getByRole('region', { name: '统一时间轴', exact: true }).getByText(voiceName, { exact: true }).last().locator('../..'));
    await expect(monitor).toContainText('原镜头含需要保留的台词');
    await expect(monitor.getByRole('button', { name: '替换画面并静音', exact: true })).toBeDisabled();
    await monitor.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual((await read()).clips, before.clips);
    await drag();
    await expect(monitor).toBeVisible();
    assert.equal((await read()).editRevision, before.editRevision, '拖入后先预览，不能先保存一份默认从头截取的编辑');
    await monitor.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual((await read()).clips, before.clips);
    await drag();
    const slider = monitor.getByRole('slider', { name: '移动截取选框', exact: true });
    await expect(slider).toHaveAttribute('aria-disabled', 'false');
    await slider.focus();
    for (let i = 0; i < 6; i++) await slider.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '0.25');
    await expect.poll(() => monitor.locator('video').evaluate(video => !video.seeking && video.readyState >= 2 && video.currentTime === 0.25)).toBe(true);
    await monitor.screenshot({ path: path.join(proofs, 'range-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await monitor.screenshot({ path: path.join(proofs, 'range-dark.png'), animations: 'disabled' });
    await monitor.getByRole('button', { name: '替换画面并静音', exact: true }).click();
    await expect(monitor).toBeHidden();
    const after = await read();
    assert.equal(after.clips[1].sourceStartUs, 250_000);
    assert.equal(after.clips[1].assetId, replacement.assetId);
    assert.ok(after.clips[1].formulaSourceId);
    await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
    await expect.poll(async () => (await read()).clips[1].assetId).toBe(target.assetId);
    await page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).click();
    await expect.poll(async () => (await read()).clips[1].sourceStartUs).toBe(250_000);
    await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
    await expect.poll(async () => (await read()).clips[1].assetId).toBe(target.assetId);
    const beforeLostReply = await read();
    await drag();
    await expect(slider).toHaveAttribute('aria-disabled', 'false');
    await slider.focus();
    for (let i = 0; i < 6; i++) await slider.press('ArrowRight');
    const requests = [];
    const editRoute = `**${endpoint}/clips?*`;
    await page.route(editRoute, async route => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        await route.abort('failed'); // The server committed; only its reply was lost.
      } else await route.continue();
    });
    await monitor.getByRole('button', { name: '替换画面并静音', exact: true }).click();
    await expect(monitor.getByRole('alert')).toContainText('可重试同一次保存');
    await expect(slider).toHaveAttribute('aria-valuenow', '0.25');
    await expect(slider).toHaveAttribute('aria-disabled', 'true');
    await monitor.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(monitor).toBeHidden();
    assert.equal((await read()).editRevision, beforeLostReply.editRevision + 1);
    assert.deepEqual(requests[1], requests[0], '重试必须沿用最初选定的素材、区间和请求身份');
    await page.unroute(editRoute);
    await expect(page.getByRole('button', { name: '撤销 (⌘Z)', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
    await expect.poll(async () => (await read()).clips[1].assetId).toBe(target.assetId);
    const beforeInsert = await read();
    await page.locator('article[draggable="true"]').filter({ hasText: voiceName })
      .dragTo(page.getByRole('region', { name: '统一时间轴', exact: true }).getByText('+追加', { exact: true }));
    await expect(monitor).toBeVisible();
    assert.equal((await read()).editRevision, beforeInsert.editRevision);
    await expect(monitor.getByRole('spinbutton', { name: '取用时长（秒）', exact: true })).toBeEnabled();
    await monitor.getByRole('spinbutton', { name: '取用时长（秒）', exact: true }).fill('0.5');
    await expect(slider).toHaveAttribute('aria-disabled', 'false');
    await slider.focus();
    for (let i = 0; i < 6; i++) await slider.press('ArrowRight');
    await monitor.getByRole('checkbox', { name: '保护一段完整动作', exact: true }).check();
    await monitor.getByRole('spinbutton', { name: '动作开始（源视频秒）', exact: true }).fill('0.375');
    await monitor.getByRole('spinbutton', { name: '动作结束（源视频秒）', exact: true }).fill('0.9');
    await expect(monitor.getByRole('button', { name: '插入画面并静音', exact: true })).toBeDisabled();
    await expect(monitor.getByRole('alert')).toContainText('完整落在取用区间内');
    await monitor.getByRole('spinbutton', { name: '动作结束（源视频秒）', exact: true }).fill('0.625');
    await monitor.locator('video').evaluate(video => video.play());
    await expect.poll(() => monitor.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.4);
    await monitor.locator('video').evaluate(video => video.pause());
    await slider.focus(); await slider.press('ArrowRight'); await slider.press('ArrowLeft');
    await expect.poll(() => monitor.locator('video').evaluate(video => !video.seeking && video.readyState >= 2 && video.currentTime === 0.25)).toBe(true);
    await monitor.screenshot({ path: path.join(proofs, 'insert-dark.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await monitor.screenshot({ path: path.join(proofs, 'insert-light.png'), animations: 'disabled' });
    await monitor.getByRole('button', { name: '插入画面并静音', exact: true }).click();
    await expect(monitor).toBeHidden();
    const inserted = await read();
    assert.equal(inserted.clips.length, beforeInsert.clips.length + 1);
    assert.equal(inserted.clips.at(-1).sourceStartUs, 250_000);
    assert.equal(inserted.clips.at(-1).sourceEndUs, 750_000);
    assert.ok(inserted.clips.at(-1).formulaSourceId);
    assert.deepEqual(inserted.audioPlan.clips, beforeInsert.audioPlan.clips, '插入带声音视频并选静音，不增加原声，也不移动已有声音');
    assert(inserted.reviewContext.issues.some(issue => issue.details.some(detail => detail.includes('保护动作'))));
    await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
    await expect.poll(async () => (await read()).clips.length).toBe(beforeInsert.clips.length);
    await page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).click();
    await expect.poll(async () => (await read()).clips.at(-1).formulaSourceId).toBe(inserted.clips.at(-1).formulaSourceId);
    await page.close(); await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    assert.deepEqual((await read()).clips, inserted.clips);
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', actualDrag: true,
      cancelUnchanged: true, nonzeroOffset: true, undoRedo: true, lostReplyRetryUndo: true,
      insertMutedRange: true, protectedAction: true, requiredVoiceGuard: true, restartRestored: true }, null, 2));
    console.log('人工素材界面：实际拖放、取消不保存、非零入点、应用和撤销重做通过');
  } else if (manualMediaApi) {
    const planId = generated.outputs[0].planId;
    const endpoint = `/api/batch-production/batches/${batchId}/outputs/${planId}`;
    const read = async () => {
      const response = await page.request.get(`${base}${endpoint}/arrangement?projectId=partial-ui`);
      assert.equal(response.status(), 200); return response.json();
    };
    const before = await read();
    const target = before.clips[1], replacement = before.clips[2];
    const payload = { type: 'replace', clipId: target.clipId, assetId: replacement.assetId,
      expectedOutputVersionId: before.outputVersionId, expectedEditRevision: before.editRevision, requestKey: 'browser-manual-media',
      formulaMedia: { contentFingerprint: replacement.contentFingerprint, inUs: 0, outUs: target.sourceEndUs - target.sourceStartUs,
        protected: null, sound: 'mute', segments: [], confirmed: true } };
    const post = data => page.request.post(`${base}${endpoint}/clips?projectId=partial-ui`, { data });
    const denied = await post({ ...payload, formulaMedia: { ...payload.formulaMedia, confirmed: false } });
    assert.equal(denied.status(), 400);
    const changed = await post(payload);
    assert.equal(changed.status(), 200, await changed.text());
    const after = await read();
    assert.equal(after.clips[1].assetId, replacement.assetId);
    assert.ok(after.clips[1].formulaSourceId);
    assert.equal((await post(payload)).status(), 200);
    assert.equal((await read()).editRevision, after.editRevision);
    const media = await page.request.get(base + after.formulaPreview.assetsById[replacement.assetId].originalUrl, { headers: { Range: 'bytes=0-255' } });
    assert.equal(media.status(), 206);
    assert.equal((await media.body()).length, 256);
    let finalSaved = after;
    if (manualMediaSpeechApi) {
      const voice = before.clips[0];
      const spokenPayload = { type: 'insert', afterClipId: after.clips.at(-1).clipId, assetId: voice.assetId,
        expectedOutputVersionId: after.outputVersionId, expectedEditRevision: after.editRevision, requestKey: 'browser-spoken-insert',
        formulaMedia: { contentFingerprint: voice.contentFingerprint, inUs: 0, outUs: 3_000_000, protected: null,
          sound: 'source', confirmed: true, speechConfirmed: true,
          segments: [{ text: '好擦洗。', startUs: 125_000, endUs: 1_250_000 }, { text: '靠背也舒服。', startUs: 1_500_000, endUs: 2_875_000 }] } };
      assert.equal((await post({ ...spokenPayload, formulaMedia: { ...spokenPayload.formulaMedia, speechConfirmed: false } })).status(), 400);
      const spokenResponse = await post(spokenPayload);
      assert.equal(spokenResponse.status(), 200, await spokenResponse.text());
      finalSaved = await read();
      const sound = finalSaved.formulaPreview.audioTimeline.clips.find(clip => clip.id !== before.audioPlan.clips[0].id);
      assert(sound);
      const soundResponse = await page.request.get(base + sound.url, { headers: { Range: 'bytes=0-255' } });
      assert.equal(soundResponse.status(), 206); assert.equal((await soundResponse.body()).length, 256);
      assert.equal((await post(spokenPayload)).status(), 200);
      assert.equal((await read()).editRevision, finalSaved.editRevision);
    }
    await open(true);
    const issues = page.getByTestId('batch-review-issues'); await issues.locator('summary').click();
    await expect(issues).toContainText('人工换片');
    await expect(issues).toContainText('人工选定区间');
    await expect(issues).toContainText('新素材原声静音');
    await expect(issues).not.toContainText('镜头 2（G1）使用系统安排');
    if (manualMediaSpeechApi) {
      await expect(issues).toContainText('人工核对原声');
      await expect(issues).toContainText('实际台词：靠背也舒服。');
      await expect(page.getByRole('group', { name: '原声轨道', exact: true })).toContainText('原声 · 随画面');
    }
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    await issues.screenshot({ path: path.join(proofs, 'manual-media-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await issues.screenshot({ path: path.join(proofs, 'manual-media-dark.png'), animations: 'disabled' });
    await page.close(); await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    const restored = await read();
    assert.deepEqual(restored.clips, finalSaved.clips);
    assert.deepEqual(restored.audioPlan, finalSaved.audioPlan);
    assert.equal((await post(payload)).status(), 200);
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', apiVerified: true,
      replayIdempotent: true, controlledMediaRange: true, restartRestored: true,
      manualSourceSound: manualMediaSpeechApi,
      scope: '此用例仅验 API 和审片提示；填写及试听确认界面另由 --manual-media-speech-ui 验证' }, null, 2));
    console.log('人工素材 API：确认校验、换片保存、幂等重试、受控预览、审片提示和重启恢复通过');
  } else if (manualDeviations) {
    const issues = page.getByTestId('batch-review-issues');
    await expect(page.getByText('人工改编 · 待审。', { exact: false })).toBeVisible();
    await issues.locator('summary').click();
    await expect(issues).toContainText('人工删除');
    await expect(issues).toContainText('G1');
    await expect(issues).toContainText('人工换序');
    await expect(issues).toContainText('原公式：VO1 → G1 → G2');
    await expect(issues).toContainText('当前保留镜头：G2 → VO1');
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    await issues.scrollIntoViewIfNeeded();
    await issues.screenshot({ path: path.join(proofs, 'deviations-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await issues.screenshot({ path: path.join(proofs, 'deviations-dark.png'), animations: 'disabled' });
    await page.close(); await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    await open(true);
    const restored = page.getByTestId('batch-review-issues'); await restored.locator('summary').click();
    await expect(restored).toContainText('人工删除');
    await expect(restored).toContainText('当前保留镜头：G2 → VO1');
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', deletedSlotVisible: true,
      reorderedSlotsVisible: true, restartRestored: true, ready: 1 }, null, 2));
    console.log('人工改编浏览器：删除/换序对照、双主题、重启恢复及可审片通过');
  } else if (textRoles) {
    const mapping = page.getByRole('region', { name: '公式选片记录' }).getByLabel('原声与配音分配');
    await expect(mapping).toContainText('画面花字 · 镜头 1');
    await expect(mapping).toContainText('加宽坐面');
    await expect(mapping).toContainText('镜头慢推');
    await expect(mapping).not.toContainText('脚本文案已由原声覆盖');
    await page.getByRole('button', { name: '人工分配声音用途', exact: true }).click();
    const editor = page.getByRole('region', { name: '人工声音用途编辑', exact: true });
    await expect(editor.getByLabel('文案段 2 用途', { exact: true })).toHaveValue(`screen:${generated.outputs[0].slots[0].slotId}`);
    await expect(editor.getByLabel('文案段 2 花字正文', { exact: true })).toHaveValue('加宽坐面');
    await expect(editor.getByLabel('文案段 3 用途', { exact: true })).toHaveValue('reference');
    await editor.getByRole('checkbox', { name: '我已试听并核对用途，原声字幕按实际台词保留', exact: true }).check();
    const saved = page.waitForResponse(response => response.url().includes('/manual-audio?') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: '保存并重做这条', exact: true }).click();
    assert.equal((await saved).status(), 200);
    await expect.poll(async () => (await (await fetch(`${base}/api/batch-production/batches/${batchId}/workspace?projectId=partial-ui`)).json()).formulaGeneration?.ready,
      { timeout: 60_000 }).toBe(1);
    await page.close(); await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    await open(true);
    await page.getByRole('button', { name: '人工分配声音用途', exact: true }).click();
    const restored = page.getByRole('region', { name: '人工声音用途编辑', exact: true });
    await expect(restored.getByLabel('文案段 2 花字正文', { exact: true })).toHaveValue('加宽坐面');
    await expect(restored.getByLabel('文案段 3 用途', { exact: true })).toHaveValue('reference');
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    await restored.scrollIntoViewIfNeeded();
    await restored.screenshot({ path: path.join(proofs, 'roles-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await restored.screenshot({ path: path.join(proofs, 'roles-dark.png'), animations: 'disabled' });
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', automaticRoles: true,
      manualPreserved: true, restartRestored: true, ready: 1 }, null, 2));
    console.log('花字用途浏览器：自动分配、人工保存不丢字、重启恢复及双主题通过');
  } else
  if (manualAudio) {
    await page.getByRole('button', { name: '人工分配声音用途', exact: true }).click();
    let editor = page.getByRole('region', { name: '人工声音用途编辑', exact: true });
    await editor.getByRole('button', { name: '按句重新拆分', exact: true }).click();
    await expect(editor.getByLabel('文案段 1', { exact: true })).toHaveValue('容易清洁。');
    await editor.getByLabel('文案段 1 用途', { exact: true }).selectOption(`source:${generated.outputs[0].slots[0].slotId}`);
    await editor.getByLabel('文案段 2 用途', { exact: true }).selectOption('reference');
    await editor.getByRole('checkbox', { name: '我已试听并核对用途，原声字幕按实际台词保留', exact: true }).check();
    let accepted;
    await page.route('**/manual-audio?*', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200); accepted = await response.json();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收：声音用途保存回复丢失' }) });
    });
    await editor.getByRole('button', { name: '保存并重做这条', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('回复丢失');
    await page.unroute('**/manual-audio?*');
    const retried = page.waitForResponse(response => response.url().includes('/manual-audio?') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: '保存并重做这条', exact: true }).click();
    assert.equal((await (await retried).json()).selectionStageId, accepted.selectionStageId);
    await expect.poll(async () => (await (await fetch(`${base}/api/batch-production/batches/${batchId}/workspace?projectId=partial-ui`)).json()).formulaGeneration?.ready,
      { timeout: 60_000 }).toBe(1);
    await page.close(); page = undefined; await stop(); base = await start();
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.setDefaultTimeout(15_000);
    await open(true);
    const mapping = page.getByRole('region', { name: '公式选片记录' }).getByLabel('原声与配音分配');
    await expect(mapping).toContainText('已人工分配声音用途');
    await expect(mapping).toContainText('脚本文案：容易清洁。');
    await expect(mapping).toContainText('实际台词：好擦洗。靠背也舒服。');
    await expect(mapping).toContainText('拍摄备注。');
    await page.getByRole('button', { name: '人工分配声音用途', exact: true }).click();
    editor = page.getByRole('region', { name: '人工声音用途编辑', exact: true });
    await expect(editor.getByLabel('文案段 2 用途', { exact: true })).toHaveValue('reference');
    await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
    await editor.scrollIntoViewIfNeeded();
    await editor.screenshot({ path: path.join(proofs, 'manual-light.png'), animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await editor.screenshot({ path: path.join(proofs, 'manual-dark.png'), animations: 'disabled' });
    fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', noModelRecovery: true,
      lostReplyRetry: true, restartRestored: true, comparison: true, ready: 1 }, null, 2));
    console.log('人工声音用途浏览器：无模型恢复、真实保存重试、重启恢复、台词对照与可审片通过');
  } else {
  const mapping = page.getByRole('region', { name: '公式选片记录' }).getByLabel('原声与配音分配');
  await expect(mapping).toContainText(semanticSource ? '脚本文案：容易清洁。' : '脚本文案：好擦洗。');
  if (semanticSource) await expect(mapping).toContainText('模型核对认为原声已表达这段文案');
  await expect(mapping).toContainText('实际台词：好擦洗。靠背也舒服。');
  await expect(mapping).toContainText('整段原声保留');
  await expect(mapping).toContainText('声音和字幕已排入时间线');
  await expect(mapping).not.toContainText('时间编排仍待完成');
  await expect(page.getByRole('checkbox', { name: '选择成片 1', exact: true })).toBeEnabled();
  await mapping.scrollIntoViewIfNeeded();
  await mapping.screenshot({ path: path.join(proofs, 'comparison-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await mapping.screenshot({ path: path.join(proofs, 'comparison-dark.png'), animations: 'disabled' });
  await open();
  await expect(mapping).toContainText('实际台词：好擦洗。靠背也舒服。');
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'passed', requestId: generated.id,
    semanticSource, comparison: true, fullSourceRetained: true, refreshRestored: true }, null, 2));
  console.log('原声整句覆盖浏览器：原文/实际台词对照、待审提醒、双主题和刷新恢复通过');
  }
} catch (error) {
  fs.writeFileSync(path.join(proofs, 'summary.json'), JSON.stringify({ status: 'failed', message: String(error) }, null, 2));
  if (page) { await page.screenshot({ path: path.join(proofs, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(proofs, 'failure.txt'), await page.locator('body').innerText().catch(() => '页面不可读')); }
  console.error(logs.join('').slice(-1500)); throw error;
} finally {
  await browser?.close(); await stop(); db?.close(); (await import('../lib/db.ts')).closeDb();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
}
