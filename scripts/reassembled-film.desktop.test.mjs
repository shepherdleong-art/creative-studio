// FILM_DESKTOP_FIXTURE=/isolated/test/root/fixture.json node scripts/reassembled-film.desktop.test.mjs
// Starts its own Electron + standalone service and shuts down only that instance.
// FILM_DESKTOP_APP_ROOT selects a real portable payload (including bundled Node/Electron).
// FILM_DESKTOP_RESTART=1 interrupts a running export and verifies same-job recovery.
// FILM_DESKTOP_EVIDENCE selects a new evidence directory for each acceptance run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { _electron as electron, chromium } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_DESKTOP_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('reassembled-P1-'), 'Only isolated test roots are allowed');
const evidence = path.resolve(process.env.FILM_DESKTOP_EVIDENCE || 'outputs/reassembled-p1-desktop');
fs.mkdirSync(evidence, { recursive: true });
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const nodePath = process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node') : process.execPath;
const appEnv = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: nodePath,
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete appEnv[key];
const launch = () => electron.launch({
  args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-profile')}`],
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}),
  cwd: appRoot,
  env: appEnv, timeout: 60000,
});
let app = await launch();
let testProcess = app.process();
app.on('close', () => console.log('ELECTRON_CLOSED'));
testProcess.on('exit', (code, signal) => console.log('ELECTRON_EXIT', code, signal));
let browser;
let ownedState;
try {
  let page = await app.firstWindow({ timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.minimize(); });
  const capture = async (name) => {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.showInactive(); });
    try { await page.screenshot({ path: path.join(evidence, name), fullPage: true, timeout: 10000 }); }
    finally { await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.minimize(); }); }
  };
  page.on('close', () => console.log('PAGE_CLOSED'));
  page.on('crash', () => console.log('PAGE_CRASH'));
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  const state = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
  ownedState = state;
  let origin = state.origin;
  if (process.env.FILM_DESKTOP_SMOKE === '1') {
    await page.goto(`${origin}/projects/p1-film?tab=final-edit&filmGroup=${fixture.groupId}&filmShotSet=${fixture.shotSetId}`);
    await page.getByTestId('film-editor').waitFor();
    await page.getByTestId('film-editor').locator('video').evaluate(async video => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('[data-testid=film-editor] video').currentTime > .2);
    await capture('editor-final.png');
    console.log('PASS final desktop build, native preview playback and test cleanup');
  } else {
  const runCli = (...args) => JSON.parse(execFileSync(nodePath, [path.join(appRoot, 'scripts/reassembled-workbench.mjs'), ...args], { encoding: 'utf8', windowsHide: true }));
  assert.equal(runCli('doctor', fixture.root).instanceId, state.instanceId);
  const imported = runCli('import', fixture.root, fixture.manifest);
  assert.equal(imported.bindingId || imported.id, fixture.bindingId);
  runCli('review', fixture.root, fixture.bindingId);
  const loaded = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
  for (const job of loaded.jobs.filter(j => ['queued','running'].includes(j.status))) {
    const deadline = Date.now() + 300000;
    let recovered = false;
    while (Date.now() < deadline) {
      const current = await (await page.request.get(`${origin}/api/final-edit-jobs/${job.id}`)).json();
      if (current.status === 'succeeded') { recovered = true; console.log('PASS restart recovery', job.id); break; }
      if (!['queued','running'].includes(current.status)) throw new Error(`Recovery failed: ${current.errorMessage || current.status}`);
      await page.waitForTimeout(1000);
    }
    assert.ok(recovered, `Recovery timed out: ${job.id}`);
  }
  browser = await chromium.launch({ headless: true });
  const review = await browser.newPage();
  await review.goto(`${origin}/api/reassembled-films/${fixture.bindingId}/review`);
  await review.locator('video').evaluate(async el => { el.muted = true; await el.play(); });
  await review.waitForFunction(() => document.querySelector('video').currentTime > .2);
  await review.screenshot({ path: path.join(evidence, 'review-before.png'), fullPage: true });
  await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`);
  const before = await review.locator('[data-delivery-version]').getAttribute('data-delivery-version');
  // Real review-page click writes the narrow inbox; the real Electron main process navigates itself.
  await review.getByRole('link', { name: '在工作台编辑这条成片' }).click();
  await page.waitForURL(new RegExp(`filmGroup=${fixture.groupId}`), { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.minimize(); });
  await page.getByTestId('film-editor').waitFor({ timeout: 30000 });
  await page.getByLabel('选择镜头', { exact: true }).selectOption('O01');
  const currentGroup = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
  const currentVideo = currentGroup.variants[0].timeline.clips.find(c => c.id === 'O01').videoJobId;
  const alternative = currentGroup.reassembled.candidates.find(c => c.clipId === 'O01' && c.videoJobId !== currentVideo);
  await page.getByLabel('已有候选', { exact: true }).selectOption(alternative.videoJobId);
  await page.getByRole('button', { name: '替换镜头', exact: true }).click();
  await page.getByTestId('film-message').filter({ hasText: '镜头修改已保存' }).waitFor();
  await page.getByRole('button', { name: '调整截取位置', exact: true }).click();
  const trimSlider = page.getByRole('slider', { name: '移动截取选框' });
  await trimSlider.focus();
  await trimSlider.press('ArrowRight');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await trimSlider.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '后移', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="选择镜头"]')?.selectedOptions[0]?.textContent === '2. O01');
  const edited = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
  const editedClip = edited.variants[0].timeline.clips.find(c => c.id === 'O01');
  assert.equal(editedClip.sourceInFrame, 1);
  assert.equal(editedClip.videoJobId, alternative.videoJobId);
  assert.equal(await page.getByRole('button', { name: '确认本版画面与包装' }).count(), 0);
  await capture('editor-changed.png');
  await page.getByRole('button', { name: '导出新版本', exact: true }).click();
  await page.getByRole('button', { name: '导出新版本（含原包装）', exact: true }).click();
  let resumedJobId = null;
  if (process.env.FILM_DESKTOP_RESTART === '1') {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const running = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
      const pending = running.jobs.find(j => j.kind === 'render' && j.status === 'running' && j.renderRevision?.variantRevision === edited.variants[0].revision);
      if (pending) { resumedJobId = pending.id; break; }
      await page.waitForTimeout(200);
    }
    assert.ok(resumedJobId, 'interrupt a real running job');
    await fetch(`${origin}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(20000) }).catch(() => {});
    const stoppedBy = Date.now() + 30000;
    while (testProcess.exitCode === null && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(testProcess.exitCode, 0, 'test desktop should shut down gracefully');
    const db = new Database(path.join(fixture.root, 'data/workbench.db'), { readonly: true });
    try { assert.equal(db.prepare('SELECT status FROM final_edit_jobs WHERE id=?').get(resumedJobId).status, 'queued'); }
    finally { db.close(); }
    app = await launch(); testProcess = app.process();
    page = await app.firstWindow({ timeout: 60000 });
    await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
    ownedState = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
    assert.notEqual(ownedState.instanceId, state.instanceId);
    origin = ownedState.origin;
    await page.request.get(`${origin}/api/final-edit-jobs/${resumedJobId}`);
    runCli('review', fixture.root, fixture.bindingId);
    await review.goto(`${origin}/api/reassembled-films/${fixture.bindingId}/review`);
    await review.getByRole('link', { name: '在工作台编辑这条成片' }).click();
    await page.waitForURL(new RegExp(`filmGroup=${fixture.groupId}`), { timeout: 30000 });
    await page.getByRole('button', { name: '导出新版本', exact: true }).click();
    console.log('PASS interrupted real render returned to queued; resumed same job', resumedJobId);
  }
  let exported = false;
  const exportDeadline = Date.now() + 300000;
  while (Date.now() < exportDeadline) {
    const current = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
    const job = current.jobs.find(j => j.kind === 'render' && j.renderRevision?.variantRevision === edited.variants[0].revision);
    if (job?.status === 'failed') throw new Error(`Export failed: ${job.errorMessage}`);
    if (job?.status === 'succeeded') { exported = true; break; }
    await page.waitForTimeout(1000);
  }
  assert.ok(exported, 'export timed out');
  await page.getByTestId('mixcut-export-status-card').filter({ hasText: '当前修改已导出' }).waitFor({ timeout: 15000 });
  await capture('export-complete.png');
  await review.reload();
  assert.equal(Number(await review.locator('[data-delivery-version]').getAttribute('data-delivery-version')), Number(before) + 1);
  await review.locator('video').evaluate(async el => { el.muted = true; await el.play(); });
  await review.waitForFunction(() => document.querySelector('video').currentTime > .2);
  await review.screenshot({ path: path.join(evidence, 'review-after.png'), fullPage: true });
  const delivered = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
  const completedRow = delivered.jobs.find(j => j.status === 'succeeded' && j.kind === 'render' && j.renderRevision?.variantRevision === edited.variants[0].revision);
  assert.ok(completedRow, 'new delivery must have a succeeded job');
  if (resumedJobId) assert.equal(completedRow.id, resumedJobId);
  const completed = await (await page.request.get(`${origin}/api/final-edit-jobs/${completedRow.id}`)).json();
  assert.ok(completed.output.videoFilename.endsWith(`-v${Number(before) + 1}.mp4`));
  const renderedFile = path.join(fixture.root, 'storage', completed.output.videoRelativePath);
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(renderedFile), 'render-manifest.json'), 'utf8'));
  for (const file of [manifest.tools.runtime.packagingDir, manifest.tools.runtime.node, manifest.tools.runtime.chrome, ...Object.values(manifest.tools.paths)]) {
    const relative = path.relative(appRoot, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `runtime must come from tested application: ${file}`);
  }
  const spec = JSON.parse(fs.readFileSync(path.join(path.dirname(renderedFile), 'spec.json'), 'utf8'));
  assert.equal(spec.shots[1].id, 'O01'); assert.equal(spec.shots[1].inSec, 1 / 24);
  const importedManifest = JSON.parse(fs.readFileSync(fixture.manifest, 'utf8'));
  const originalSpec = JSON.parse(fs.readFileSync(path.join(importedManifest.root, importedManifest.specFile), 'utf8'));
  assert.deepEqual(spec.template, originalSpec.template, 'P1 must retain the imported template');
  if (process.env.FILM_EXPECT_TEMPLATE) assert.equal(spec.template.id, process.env.FILM_EXPECT_TEMPLATE);
  assert.deepEqual(spec.canvas, originalSpec.canvas);
  assert.deepEqual(spec.packaging, originalSpec.packaging, 'P1 must freeze packaging settings and selling-point timing');
  assert.deepEqual(spec.subtitles, originalSpec.subtitles, 'P1 must freeze subtitles');
  const originalAudio = structuredClone(originalSpec.audio);
  for (const voice of originalAudio.voices) voice.file = voice.file.split(path.sep).join('/');
  originalAudio.music.file = originalAudio.music.file.split(path.sep).join('/');
  assert.deepEqual(spec.audio, originalAudio, 'P1 must freeze audio');
  const checks = JSON.parse(fs.readFileSync(path.join(path.dirname(renderedFile), 'checks.json'), 'utf8'));
  assert.equal(checks.ok, true); assert.equal(checks.checks.length, 12);
  assert.ok(checks.checks.every(check => check.ok));
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const deliveredVideo = path.join(fixture.delivery, completed.output.videoFilename);
  assert.equal(sha256(deliveredVideo), manifest.outputs.videoSha256, 'external delivery matches verified render');
  assert.equal(sha256(path.join(importedManifest.root, importedManifest.specFile)), importedManifest.files[importedManifest.specFile], 'original spec stays unchanged');
  fs.copyFileSync(path.join(path.dirname(renderedFile), 'render-manifest.json'), path.join(evidence, 'render-manifest.json'));
  fs.copyFileSync(path.join(path.dirname(renderedFile), 'checks.json'), path.join(evidence, 'checks.json'));
  fs.writeFileSync(path.join(evidence, 'desktop-result.json'), JSON.stringify({ ok: true, template: spec.template, frozenPackagingAudioSubtitles: true, technicalChecks: checks.checks.length, deliveredVideo, fixture, appRoot, origin, fromVersion: Number(before), toVersion: Number(before) + 1, nativeNavigation: true, sourceInFrame: 1, reordered: true, directExportWithoutConfirmation: true, playback: true, resumedJobId, runtime: manifest.tools, video: renderedFile }, null, 2));
  console.log('PASS actual Electron review → fifth step → replace shot → direct export → updated review/player');
  }
} catch (error) {
  const page = app.windows()[0];
  if (page) { await page.screenshot({ path: path.join(evidence, 'desktop-failure.png'), fullPage: true, timeout: 3000 }).catch(() => {}); console.log((await page.locator('body').innerText().catch(() => '')).slice(-9000)); }
  throw error;
} finally {
  // Only the private fixture instance created above may be stopped. Stop its
  // service before app.quit/destroy (Playwright can intercept those on macOS).
  if (ownedState) {
    const stateFile = path.join(fixture.root, 'storage/run/electron-service.json');
    if (fs.existsSync(stateFile)) {
      const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(current.instanceId, ownedState.instanceId);
      await fetch(`${ownedState.origin}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
    }
  }
  await browser?.close();
  const deadline = Date.now() + 25000;
  while (testProcess.exitCode === null && testProcess.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (testProcess.exitCode === null && testProcess.signalCode === null) { console.log('Test shell cleanup timeout; stopping owned test process'); testProcess.kill('SIGKILL'); }
}
assert.equal(testProcess.exitCode, 0, 'desktop must exit cleanly');
assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')), 'private service state must be cleared');
fs.writeFileSync(path.join(evidence, 'cleanup.json'), JSON.stringify({ exitCode: 0, stateCleared: true }));
console.log('PASS desktop exit 0 and private service state cleared');
