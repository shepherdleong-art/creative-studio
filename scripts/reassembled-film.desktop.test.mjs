// FILM_DESKTOP_FIXTURE=/isolated/test/root/fixture.json node scripts/reassembled-film.desktop.test.mjs
// Starts its own source Electron shell + standalone service and shuts down only that instance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron, chromium } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_DESKTOP_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('reassembled-P1-'), 'Only isolated test roots are allowed');
const evidence = path.resolve('outputs/2026-10-17-reassembled-p1');
const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(fixture.root, 'electron-profile')}`], env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: process.execPath }, timeout: 60000 });
const testProcess = app.process();
app.on('close', () => console.log('ELECTRON_CLOSED'));
testProcess.on('exit', (code, signal) => console.log('ELECTRON_EXIT', code, signal));
let browser;
let ownedState;
try {
  const page = await app.firstWindow({ timeout: 60000 });
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
  const origin = state.origin;
  if (process.env.FILM_DESKTOP_SMOKE === '1') {
    await page.goto(`${origin}/projects/p1-film?tab=final-edit&filmGroup=${fixture.groupId}&filmShotSet=${fixture.shotSetId}`);
    await page.getByTestId('film-editor').waitFor();
    await page.getByTestId('film-editor').locator('video').evaluate(async video => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('[data-testid=film-editor] video').currentTime > .2);
    await capture('editor-final.png');
    console.log('PASS final desktop build, native preview playback and test cleanup');
  } else {
  const runCli = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/reassembled-workbench.mjs', ...args], { encoding: 'utf8' }));
  assert.equal(runCli('doctor', fixture.root).instanceId, state.instanceId);
  const imported = runCli('import', fixture.root, fixture.manifest);
  assert.equal(imported.bindingId || imported.id, fixture.bindingId);
  runCli('review', fixture.root, fixture.bindingId);
  const loaded = await (await page.request.get(`${origin}/api/final-edit-groups/${fixture.groupId}`)).json();
  for (const job of loaded.jobs.filter(j => ['queued','running'].includes(j.status))) {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const current = await (await page.request.get(`${origin}/api/final-edit-jobs/${job.id}`)).json();
      if (current.status === 'succeeded') { console.log('PASS restart recovery', job.id); break; }
      if (!['queued','running'].includes(current.status)) throw new Error(`Recovery failed: ${current.errorMessage || current.status}`);
      await page.waitForTimeout(1000);
    }
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
  assert.equal(await page.getByRole('button', { name: '确认本版画面与包装' }).count(), 0);
  await capture('editor-changed.png');
  await page.getByRole('button', { name: '导出新版本', exact: true }).click();
  await page.getByRole('button', { name: '导出新版本（含原包装）', exact: true }).click();
  await page.getByTestId('mixcut-export-status-card').filter({ hasText: '当前修改已导出' }).waitFor({ timeout: 300000 });
  await capture('export-complete.png');
  await review.reload();
  assert.equal(Number(await review.locator('[data-delivery-version]').getAttribute('data-delivery-version')), Number(before) + 1);
  await review.locator('video').evaluate(async el => { el.muted = true; await el.play(); });
  await review.waitForFunction(() => document.querySelector('video').currentTime > .2);
  await review.screenshot({ path: path.join(evidence, 'review-after.png'), fullPage: true });
  fs.writeFileSync(path.join(evidence, 'desktop-result.json'), JSON.stringify({ ok: true, fixture, origin, fromVersion: Number(before), toVersion: Number(before) + 1, nativeNavigation: true, directExportWithoutConfirmation: true, playback: true }, null, 2));
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
    const current = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
    assert.equal(current.instanceId, ownedState.instanceId);
    await fetch(`${ownedState.origin}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  await browser?.close();
  const deadline = Date.now() + 25000;
  while (testProcess.exitCode === null && testProcess.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (testProcess.exitCode === null && testProcess.signalCode === null) { console.log('Test shell cleanup timeout; stopping owned test process'); testProcess.kill('SIGKILL'); }
}
