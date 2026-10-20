// Actual Windows Electron acceptance; isolated synthetic fixtures, no suppliers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_DURATION_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('2026-10-19-film-duration') && fixture.root.includes('reassembled-P1-'));
const evidence = fs.mkdtempSync(path.join(fixture.root, 'duration-desktop-'));
const db = new Database(path.join(fixture.root, 'data/workbench.db'));
db.prepare("UPDATE providers SET enabled=0").run(); db.prepare("UPDATE video_providers SET enabled=0").run();
db.prepare("UPDATE final_edit_jobs SET status='cancelled' WHERE status IN ('queued','running')").run();
db.prepare("DELETE FROM final_edit_film_deliveries WHERE status='reserved'").run();
const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const oldHashes = fs.readdirSync(fixture.delivery).filter(name => /\.(mp4|jpg)$/.test(name)).map(name => [name, hash(path.join(fixture.delivery, name))]);
const jobsBefore = db.prepare('SELECT id FROM video_jobs ORDER BY id').all();
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath,
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete env[key];
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-duration')}`], cwd: appRoot, env, timeout: 60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}) });
const handle = app.process();
const wait = async (predicate, timeout = 90000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('Acceptance timed out'); };
let state, result;
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  state = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
  const get = async url => { const response = await page.request.get(state.origin + url); assert.ok(response.ok(), `${url}: ${response.status()}`); return response.json(); };
  const groupUrl = `/api/final-edit-groups/${binding.groupId}`;
  await page.goto(`${state.origin}/projects/${binding.projectId}?tab=final-edit&filmGroup=${binding.groupId}&filmShotSet=${binding.shotSetId}`);
  await page.getByTestId('film-editor').waitFor({ timeout: 60000 });
  fs.writeFileSync(path.join(evidence, 'initial-ui.txt'), await page.locator('body').ariaSnapshot());
  const identity = await get('/api/reassembled-films/capabilities');
  assert.ok(identity.capabilities.includes('film-ripple-duration/1'));
  const human = async command => page.evaluate(async ({ url, command }) => {
    const response = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  }, { url: `/api/final-edit-variants/${binding.variantId}`, command });
  const before = await get(groupUrl), first = before.variants[0].timeline.clips[0];
  const initialFrames = first.timelineOutFrame - first.timelineInFrame;
  const openDuration = () => page.getByRole('button', { name: '调整镜头时长', exact: true }).click();
  const framesInput = page.getByLabel('镜头时长帧数', { exact: true });
  const saveDuration = () => page.getByRole('button', { name: '保存镜头时长', exact: true }).click();
  const durationForm = page.getByRole('form', { name: '镜头时长调整', exact: true });
  await openDuration(); await framesInput.fill(String(initialFrames + 24));
  await page.getByRole('button', { name: '取消时长修改', exact: true }).click();
  assert.equal((await get(groupUrl)).variants[0].revision, before.variants[0].revision);
  await openDuration(); await framesInput.fill(String(initialFrames + 24));
  const manual = structuredClone(before.reassembled.content); manual.subtitles[0].text = '人工字幕跨时长与截取修改保留'; manual.music.gainDb -= 2;
  assert.equal((await human({ type: 'set_film_content', expectedRevision: before.variants[0].revision, content: manual })).status, 200);
  await saveDuration();
  await page.getByTestId('film-message').filter({ hasText: '草稿已被其他操作更新' }).waitFor();
  assert.equal(await framesInput.inputValue(), String(initialFrames + 24));
  assert.deepEqual((await get(groupUrl)).reassembled.content, manual);
  await page.getByRole('button', { name: '取消时长修改', exact: true }).click();
  await page.getByRole('button', { name: '调整截取位置', exact: true }).click();
  await page.getByRole('slider', { name: '移动截取选框', exact: true }).press('ArrowRight');
  const trimBefore = await get(groupUrl); manual.music.gainDb -= 1;
  assert.equal((await human({ type: 'set_film_content', expectedRevision: trimBefore.variants[0].revision, content: manual })).status, 200);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByTestId('film-message').filter({ hasText: '草稿已被其他操作更新' }).waitFor();
  assert.ok(await page.getByRole('slider', { name: '移动截取选框', exact: true }).isVisible());
  assert.deepEqual((await get(groupUrl)).variants[0].timeline.clips, before.variants[0].timeline.clips);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await openDuration(); await framesInput.fill('10000');
  const invalidBefore = await get(groupUrl); await saveDuration();
  await page.getByTestId('film-message').filter({ hasText: /素材/ }).waitFor();
  assert.equal(await framesInput.inputValue(), '10000');
  assert.deepEqual((await get(groupUrl)).variants, invalidBefore.variants);
  await framesInput.fill(String(initialFrames + 24)); await saveDuration();
  await durationForm.waitFor({ state: 'hidden' });
  const extended = await get(groupUrl), extendedVariant = extended.variants[0];
  assert.equal(extendedVariant.timeline.bodyFrames, before.variants[0].timeline.bodyFrames + 24);
  assert.deepEqual(extendedVariant.timeline.clips.slice(1), before.variants[0].timeline.clips.slice(1).map(c => ({ ...c, timelineInFrame: c.timelineInFrame + 24, timelineOutFrame: c.timelineOutFrame + 24 })));
  assert.deepEqual(extended.reassembled.content, manual);
  await openDuration(); await framesInput.fill(String(initialFrames - 12)); await saveDuration(); await durationForm.waitFor({ state: 'hidden' });
  assert.equal((await get(groupUrl)).variants[0].timeline.bodyFrames, before.variants[0].timeline.bodyFrames - 12);
  await page.getByLabel('历史编辑', { exact: true }).selectOption(String(extendedVariant.revision));
  await page.getByRole('button', { name: '恢复所选编辑版本', exact: true }).click();
  await wait(async () => (await get(groupUrl)).variants[0].timeline.bodyFrames === extendedVariant.timeline.bodyFrames);
  await page.reload(); await page.getByTestId('film-editor').waitFor(); await openDuration();
  assert.equal(await framesInput.inputValue(), String(initialFrames + 24));
  await page.getByRole('button', { name: '取消时长修改', exact: true }).click();
  const edited = await get(groupUrl);
  assert.deepEqual(edited.variants[0].timeline, extendedVariant.timeline);
  assert.deepEqual(edited.reassembled.content, manual);
  assert.equal(edited.totalDurationUs, Math.round((extendedVariant.timeline.bodyFrames + 20) / 24 * 1e6));
  assert.deepEqual(db.prepare('SELECT id FROM video_jobs ORDER BY id').all(), jobsBefore);
  await page.getByRole('button', { name: '导出新版本', exact: true }).click();
  await page.getByRole('button', { name: '导出新版本（含当前包装）', exact: true }).click();
  const completed = await wait(async () => {
    const jobs = (await get(groupUrl)).jobs.filter(job => job.kind === 'render' && job.renderRevision?.variantRevision === edited.variants[0].revision);
    const failed = jobs.find(job => job.status === 'failed'); assert.ok(!failed, failed?.errorMessage);
    return jobs.find(job => job.status === 'succeeded');
  }, 600000);
  const output = (await get(`/api/final-edit-jobs/${completed.id}`)).output;
  const runDir = path.join(fixture.root, 'storage', path.dirname(output.videoRelativePath));
  const spec = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
  assert.equal(spec.canvas.frames, edited.variants[0].timeline.bodyFrames + 20);
  assert.equal(spec.shots[0].endFrame - spec.shots[0].startFrame, initialFrames + 24);
  assert.equal(spec.subtitles[0].text, manual.subtitles[0].text);
  const checks = JSON.parse(fs.readFileSync(path.join(runDir, 'checks.json'), 'utf8')); assert.equal(checks.ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'render-manifest.json'), 'utf8'));
  for (const file of [manifest.tools.runtime.packagingDir, manifest.tools.runtime.node, manifest.tools.runtime.chrome, ...Object.values(manifest.tools.paths)]) {
    const relative = path.relative(appRoot, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Runtime must belong to tested application: ${file}`);
  }
  for (const [name, fingerprint] of oldHashes) assert.equal(hash(path.join(fixture.delivery, '旧版', name)), fingerprint);
  assert.equal(hash(path.join(fixture.delivery, output.videoFilename)), manifest.outputs.videoSha256);
  await page.getByRole('button', { name: '取消导出任务', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.restore(); window.showInactive(); } });
  await page.screenshot({ path: path.join(evidence, 'delivery.png'), fullPage: true, timeout: 15000 });
  const delivered = await get(groupUrl);
  assert.equal(delivered.reassembled.deliveryVersion, 2);
  await page.goto(state.origin + delivered.reassembled.reviewUrl);
  const reviewVideo = page.locator('video');
  await wait(() => reviewVideo.evaluate(video => video.readyState >= 2 && video.videoWidth > 0));
  const duration = await reviewVideo.evaluate(video => video.duration);
  assert.ok(Math.abs(duration - spec.canvas.frames / 24) < .1, `Review must play the new ${spec.canvas.frames}-frame version: ${duration}`);
  await reviewVideo.evaluate(async video => { video.muted = true; await video.play(); });
  await wait(() => reviewVideo.evaluate(video => video.currentTime > .1));
  await reviewVideo.evaluate(video => video.pause());
  await page.screenshot({ path: path.join(evidence, 'review-v2.png'), fullPage: true, timeout: 15000 });
  result = { ok: true, paidCalls: 0, appRoot, fixture, durationConflictDraftPreserved: true, trimConflictDraftPreserved: true, invalidDurationRejected: true, restored: true, frames: spec.canvas.frames, reviewNewVersionPlays: true, noSupplierJobs: true, manualContentPreserved: true, otherSourceRangesUnchanged: true, oldHashes, output, checks: checks.checks };
} catch (error) {
  const page = app.windows()[0]; if (page) { fs.writeFileSync(path.join(evidence, 'failure-ui.txt'), await page.locator('body').ariaSnapshot().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 3000 }).catch(() => {}); }
  throw error;
} finally {
  if (state) {
    const health = await fetch(state.origin + '/api/desktop/health').then(response => response.json()).catch(() => null);
    if (health?.instanceId === state.instanceId) await fetch(state.origin + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  await wait(() => handle.exitCode !== null || handle.signalCode !== null, 30000).catch(() => handle.kill('SIGKILL'));
  db.close();
}
assert.equal(handle.exitCode, 0);
assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')));
fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
console.log('PASS desktop duration/trim conflicts, dependency gates, shorten/extend/restore and delivery', evidence);
