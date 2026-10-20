// Actual Windows Electron acceptance; isolated synthetic fixtures, no suppliers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_EDITING_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('2026-10-19-film-editing') && fixture.root.includes('reassembled-P1-'));
const source = path.resolve(process.env.FILM_EXTERNAL_SOURCE);
assert.ok(source.includes('2026-10-19-film-editing') && source.endsWith('motion.mp4'));
const evidence = fs.mkdtempSync(path.join(fixture.root, 'editing-desktop-'));
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
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-editing')}`], cwd: appRoot, env, timeout: 60000,
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
  assert.ok(identity.capabilities.includes('film-fixed-duration-speed/1') && identity.capabilities.includes('film-external-candidates/1'));
  const human = async (url, command) => page.evaluate(async ({ url, command }) => {
    const response = await fetch(url, { method: url.includes('/rework/') ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  }, { url, command });
  const before = await get(groupUrl), clipId = before.variants[0].timeline.clips[0].id;
  await page.getByRole('button', { name: '调整镜头速度', exact: true }).click();
  await page.getByLabel('镜头倍速', { exact: true }).fill('0.5');
  await page.getByRole('button', { name: '取消速度修改', exact: true }).click();
  assert.equal((await get(groupUrl)).variants[0].revision, before.variants[0].revision);
  await page.getByRole('button', { name: '调整镜头速度', exact: true }).click();
  await page.getByLabel('镜头倍速', { exact: true }).fill('0.5');
  const manual = structuredClone(before.reassembled.content); manual.subtitles[0].text = '人工字幕跨变速和替换保留'; manual.music.gainDb -= 2;
  assert.equal((await human(`/api/final-edit-variants/${binding.variantId}`, { type: 'set_film_content', expectedRevision: before.variants[0].revision, content: manual })).status, 200);
  await page.getByRole('button', { name: '保存镜头速度', exact: true }).click();
  await page.getByTestId('film-message').filter({ hasText: '草稿已被其他操作更新' }).waitFor();
  assert.equal(await page.getByLabel('镜头倍速', { exact: true }).inputValue(), '0.5');
  assert.deepEqual((await get(groupUrl)).reassembled.content, manual);
  await page.getByRole('button', { name: '取消速度修改', exact: true }).click();
  await page.getByRole('button', { name: '调整镜头速度', exact: true }).click();
  await page.getByLabel('镜头倍速', { exact: true }).fill('0.5');
  await page.getByRole('button', { name: '保存镜头速度', exact: true }).click();
  await page.getByRole('form', { name: '镜头定长变速', exact: true }).waitFor({ state: 'hidden' });
  const sped = await get(groupUrl); assert.equal(sped.variants[0].timeline.clips[0].playbackRate, .5);
  const openExternal = () => page.getByRole('button', { name: '添加新视频候选', exact: true }).click();
  await openExternal();
  await page.getByLabel('上传新视频', { exact: true }).setInputFiles(source);
  await page.getByRole('region', { name: '登记外部视频候选', exact: true }).getByRole('status').filter({ hasText: '上传成功' }).waitFor({ timeout: 90000 });
  const assetId = await page.getByLabel('本组外部视频', { exact: true }).inputValue(); assert.ok(assetId);
  assert.deepEqual((await get(groupUrl)).variants, sped.variants);
  const reworkUrl = `${groupUrl}/rework/${clipId}`, shot = await get(reworkUrl);
  assert.equal((await human(reworkUrl, { type: 'select_image', requestId: randomUUID(), expectedRevision: shot.revision, imageId: shot.importedImageId })).status, 200);
  await page.getByRole('button', { name: '登记为本镜头候选', exact: true }).click();
  await page.getByRole('region', { name: '登记外部视频候选', exact: true }).getByRole('status').filter({ hasText: '镜头已变化' }).waitFor();
  assert.equal(await page.getByLabel('本组外部视频', { exact: true }).inputValue(), assetId);
  assert.equal(await page.getByLabel('外部视频审核终点', { exact: true }).inputValue(), '12');
  await page.getByRole('button', { name: '关闭素材登记', exact: true }).click();
  await openExternal(); await page.getByLabel('本组外部视频', { exact: true }).selectOption(assetId);
  const uploadedPreview = page.getByRole('region', { name: '登记外部视频候选', exact: true }).locator('video');
  await wait(() => uploadedPreview.evaluate(video => video.readyState >= 2 && video.videoWidth > 0));
  await uploadedPreview.evaluate(async video => { video.muted = true; await video.play(); });
  await wait(() => uploadedPreview.evaluate(video => video.currentTime > .1)); await uploadedPreview.evaluate(video => video.pause());
  await page.getByRole('button', { name: '登记为本镜头候选', exact: true }).click();
  await page.getByRole('region', { name: '登记外部视频候选', exact: true }).waitFor({ state: 'hidden', timeout: 90000 });
  const registered = await get(groupUrl); assert.deepEqual(registered.variants, sped.variants);
  await page.getByLabel('已有候选', { exact: true }).selectOption(`external-asset-${assetId}`);
  await page.getByRole('button', { name: '替换镜头', exact: true }).click();
  await wait(async () => (await get(groupUrl)).variants[0].timeline.clips[0].videoJobId === `external-asset-${assetId}`);
  await page.reload(); await page.getByTestId('film-editor').waitFor();
  await page.getByRole('button', { name: '调整镜头速度', exact: true }).click();
  assert.equal(await page.getByLabel('镜头倍速', { exact: true }).inputValue(), '0.5');
  await page.getByLabel('镜头倍速', { exact: true }).fill('2');
  await page.getByRole('button', { name: '保存镜头速度', exact: true }).click();
  await page.getByRole('form', { name: '镜头定长变速', exact: true }).waitFor({ state: 'hidden' });
  const edited = await get(groupUrl);
  assert.equal(edited.variants[0].timeline.clips[0].playbackRate, 2);
  assert.deepEqual(edited.variants[0].timeline.clips.slice(1), before.variants[0].timeline.clips.slice(1));
  assert.deepEqual(edited.reassembled.content, manual);
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
  assert.equal(spec.shots[0].rate, 2); assert.match(spec.shots[0].file, /rework/);
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
  result = { ok: true, paidCalls: 0, appRoot, fixture, speedConflictDraftPreserved: true, uploadConflictDraftPreserved: true, externalPreviewPlays: true, explicitAdoption: true, noSupplierJobs: true, manualContentPreserved: true, otherShotsUnchanged: true, oldHashes, output, checks: checks.checks };
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
console.log('PASS desktop speed/upload/candidate/explicit replacement/manual isolation and delivery', evidence);
