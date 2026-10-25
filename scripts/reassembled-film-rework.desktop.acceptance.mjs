// Windows Electron acceptance with real local queues and loopback-only synthetic providers.
// FILM_P2_FIXTURE must be a fresh disposable P1 fixture under outputs/2026-10-19-p2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { _electron as electron } from '@playwright/test';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_P2_FIXTURE, 'utf8'));
assert.ok(fixture.root.includes('2026-10-19-p2') && fixture.root.includes('reassembled-P1-'));
const evidence = path.join(fixture.root, 'p2-desktop'); fs.mkdirSync(evidence);
const db = new Database(path.join(fixture.root, 'data/workbench.db'));
const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId);
const originalCandidates = JSON.parse(binding.candidatesJson);
const clipId = originalCandidates[0].clipId;
const sourceImageId = db.prepare('SELECT latestGeneratedImageId FROM shots WHERE id=?').get(originalCandidates[0].shotId).latestGeneratedImageId;
const originalVideo = db.prepare('SELECT localVideoPath FROM video_jobs WHERE id=?').get(originalCandidates.find(c => c.clipId === clipId && c.file.includes('alternative')).videoJobId).localVideoPath;
const fakeVideo = fs.readFileSync(originalVideo);
const fakeImage = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#287c60' } }).png().toBuffer();
const requests = [];
let imageCount = 0, videoCount = 0, heldImage;
let fakeOrigin;
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ method: request.method, path: request.url });
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.url === '/v1/images/edits' && request.method === 'POST') {
    imageCount++;
    assert.ok(body.includes('本机合成分镜')); // Real adapter multipart, not a route stub.
    const complete = () => json({ data: [{ b64_json: fakeImage.toString('base64') }] });
    if (imageCount === 2) heldImage = complete; else complete();
  } else if (request.url === '/v1/videos' && request.method === 'POST') {
    const input = JSON.parse(body); videoCount++;
    assert.equal(input.prompt, '本机合成视频，固定平移'); assert.equal(input.seconds, '8');
    assert.ok(input.images[0].startsWith(fakeOrigin));
    json({ id: 'p2-local-video', status: 'queued' });
  } else if (request.url === '/v1/videos/p2-local-video') {
    json({ id: 'p2-local-video', status: 'completed', metadata: { url: fakeOrigin + '/synthetic.mp4' } });
  } else if (request.url === '/synthetic.mp4') { response.setHeader('Content-Type', 'video/mp4'); response.end(fakeVideo); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fakeOrigin = `http://127.0.0.1:${server.address().port}`;
db.prepare("UPDATE providers SET enabled=0,apiKey=''").run();
db.prepare("UPDATE video_providers SET enabled=0,apiKey=''").run();
db.prepare("UPDATE providers SET enabled=1,apiKey='local-synthetic',baseUrl=?,model='synthetic-image',type='openai-compatible' WHERE id='p1-fixture'").run(fakeOrigin);
db.prepare("UPDATE video_providers SET enabled=1,apiKey='local-synthetic',baseUrl=?,defaultModel='synthetic-video' WHERE id='p1-video'").run(fakeOrigin);
// P1 leaves a reserved export to exercise recovery. This test exercises its own export.
db.prepare("UPDATE final_edit_jobs SET status='cancelled' WHERE status IN ('queued','running')").run();
db.prepare("DELETE FROM final_edit_film_deliveries WHERE status='reserved'").run();
const other = originalCandidates.find(c => c.clipId !== clipId);
db.prepare("INSERT INTO jobs(id,projectId,inputImageId,providerId,model,prompt) VALUES ('p2-unrelated-image',?,?, 'p1-fixture','synthetic-image','MUST NOT SUBMIT')").run(binding.projectId, sourceImageId);
db.prepare("INSERT INTO video_jobs(id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec) VALUES ('p2-unrelated-video',?,?,?,?,'p1-video','synthetic-video','MUST NOT SUBMIT',8)").run(binding.projectId, binding.shotSetId, other.shotId, sourceImageId);
const oldHashes = fs.readdirSync(fixture.delivery).filter(name => /\.(mp4|jpg)$/.test(name)).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(fixture.delivery, name))).digest('hex')]);
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const appEnv = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.root, CREATIVE_STUDIO_NODE: process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath, CREATIVE_STUDIO_PUBLIC_BASE_URL: fakeOrigin,
  CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of Object.keys(appEnv)) if (key.startsWith('CREATIVE_STUDIO_COS_')) appEnv[key] = '';
for (const key of ['CREATIVE_STUDIO_COS_SECRET_ID', 'CREATIVE_STUDIO_COS_SECRET_KEY', 'CREATIVE_STUDIO_COS_DOMAIN']) appEnv[key] = '';
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT', 'CREATIVE_STUDIO_PACKAGING_DIR', 'CREATIVE_STUDIO_PACKAGING_NODE', 'CREATIVE_STUDIO_FFMPEG', 'CREATIVE_STUDIO_FFPROBE']) delete appEnv[key];
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(fixture.root, 'electron-p2')}`], cwd: appRoot, env: appEnv, timeout: 60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}) });
const processHandle = app.process();
let ownedState;
const waitFor = async (predicate, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 400)); }
  throw new Error('Acceptance condition timed out');
};
try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.minimize(); });
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  ownedState = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage/run/electron-service.json'), 'utf8'));
  const origin = ownedState.origin;
  const api = `/api/final-edit-groups/${binding.groupId}/rework/${clipId}`;
  const get = async url => (await page.request.get(origin + url)).json();
  const humanPost = (url, body, method = 'POST') => page.evaluate(async ({ url, body, method }) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { url, body, method });
  await page.goto(`${origin}/projects/${binding.projectId}?tab=final-edit&filmGroup=${binding.groupId}&filmShotSet=${binding.shotSetId}`);
  await page.getByTestId('film-editor').waitFor({ timeout: 60000 });
  const before = await get(`/api/final-edit-groups/${binding.groupId}`);
  await page.getByRole('link', { name: '返工这个镜头' }).click();
  await page.getByTestId('film-rework').waitFor();
  await page.getByLabel('返工供应商').selectOption('p1-fixture');
  await page.getByLabel('返工提示词').fill('本机合成分镜，保留用户指定细节');
  await page.getByRole('button', { name: '生成该镜头分镜候选', exact: true }).click();
  await waitFor(async () => (await get(api)).imageJobs.some(j => j.status === 'succeeded'));
  await page.getByRole('button', { name: '采用这张分镜图' }).first().click();
  const adopted = await waitFor(async () => { const v = await get(api); return v.currentImageId !== sourceImageId && v; });
  const chosenImage = adopted.currentImageId;
  await page.getByRole('button', { name: '生成该镜头分镜候选', exact: true }).click();
  await waitFor(() => heldImage);
  const waiting = await get(api);
  const restore = await humanPost(api, { type: 'select_image', imageId: sourceImageId, expectedRevision: waiting.revision, requestId: randomUUID() });
  assert.equal(restore.status, 200);
  heldImage(); heldImage = null;
  await waitFor(async () => (await get(api)).imageJobs.filter(j => j.status === 'succeeded').length === 2);
  assert.equal((await get(api)).currentImageId, sourceImageId, 'late real queue completion must not undo human selection');
  // An old tab must keep its unsaved prompt and reject the write, even if polling refreshed the view.
  await page.getByLabel('返工提示词').fill('本机合成分镜，未保存人工草稿');
  await page.getByRole('button', { name: '生成该镜头分镜候选', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '镜头已变化' }).waitFor();
  assert.equal(await page.getByLabel('返工提示词').inputValue(), '本机合成分镜，未保存人工草稿');
  assert.equal(imageCount, 2, 'stale write must never submit a provider request');
  const latest = await get(api);
  assert.equal((await humanPost(api, { type: 'select_image', imageId: chosenImage, expectedRevision: latest.revision, requestId: randomUUID() })).status, 200);
  const capability = await get('/api/reassembled-films/capabilities');
  assert.ok(capability.capabilities.includes('shot-rework-candidates/1'));
  const cli = path.join(appRoot, 'scripts/reassembled-workbench.mjs');
  const cliView = JSON.parse(execFileSync(appEnv.CREATIVE_STUDIO_NODE, [cli, 'shot', fixture.root, binding.groupId, clipId], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  assert.equal(cliView.currentImageId, chosenImage);
  const agentHeaders = { 'x-reassembled-token': fs.readFileSync(path.join(fixture.root, 'storage/run/reassembled-agent-token'), 'utf8').trim(), 'x-desktop-instance': capability.instanceId, 'x-data-identity': capability.dataIdentity };
  const forbidden = await page.request.patch(`${origin}/api/final-edit-variants/${binding.variantId}`, { headers: agentHeaders, data: { type: 'reorder_clips', expectedRevision: before.variants[0].revision, orderedClipIds: before.variants[0].timeline.clips.map(c => c.id).reverse() } });
  assert.equal(forbidden.status(), 409);
  for (const [url, method, body] of [[`/api/shot-sets/${binding.shotSetId}`, 'PATCH', { shotId: originalCandidates[0].shotId, selectedImageAssetId: sourceImageId }], [`/api/shot-sets/${binding.shotSetId}/apply-scene`, 'POST', {}], [`/api/shot-sets/${binding.shotSetId}/video-jobs`, 'POST', {}], [`/api/shot-sets/${binding.shotSetId}/video-jobs/batch`, 'POST', {}]]) assert.equal((await humanPost(url, body, method)).status, 409);
  await page.getByRole('link', { name: '生成该镜头视频', exact: true }).click();
  await page.getByLabel('返工供应商').selectOption('p1-video');
  await page.getByLabel('返工提示词').fill('本机合成视频，固定平移');
  await page.getByLabel('返工视频时长').selectOption('8');
  await page.getByRole('button', { name: '用当前分镜图生成视频候选', exact: true }).click();
  const video = await waitFor(async () => (await get(api)).videoJobs.find(j => j.prompt === '本机合成视频，固定平移' && j.status === 'succeeded'));
  assert.equal(video.sourceImageId, chosenImage);
  await page.getByLabel('返工视频候选').selectOption(video.id);
  await page.getByRole('button', { name: '登记到第五步候选' }).click();
  await waitFor(async () => (await get(api)).registeredVideoIds.includes(video.id));
  assert.deepEqual((await get(`/api/final-edit-groups/${binding.groupId}`)).variants, before.variants);
  await page.getByRole('link', { name: '返回第五步替换镜头' }).click();
  await page.getByTestId('film-editor').waitFor();
  assert.equal(await page.getByLabel('选择镜头', { exact: true }).inputValue(), clipId);
  await page.getByLabel('已有候选', { exact: true }).selectOption(video.id);
  await page.getByRole('button', { name: '替换镜头', exact: true }).click();
  await page.getByTestId('film-message').filter({ hasText: '镜头修改已保存' }).waitFor();
  const edited = await get(`/api/final-edit-groups/${binding.groupId}`);
  assert.deepEqual(edited.variants[0].timeline.clips.filter(c => c.id !== clipId), before.variants[0].timeline.clips.filter(c => c.id !== clipId));
  for (const key of ['script', 'subtitleCues', 'packaging', 'textStyles', 'coverTitle']) assert.deepEqual(edited[key], before[key]);
  await page.getByRole('button', { name: '导出新版本', exact: true }).click();
  await page.getByRole('button', { name: '导出新版本（含原包装）', exact: true }).click();
  const completed = await waitFor(async () => {
    const jobs = (await get(`/api/final-edit-groups/${binding.groupId}`)).jobs.filter(j => j.kind === 'render' && j.renderRevision?.variantRevision === edited.variants[0].revision);
    const failed = jobs.find(j => j.status === 'failed');
    assert.ok(!failed, failed?.errorMessage || 'preview failed');
    return jobs.find(j => j.status === 'succeeded');
  }, 600000);
  const output = await get(`/api/final-edit-jobs/${completed.id}`);
  const checks = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage', path.dirname(output.output.videoRelativePath), 'checks.json'), 'utf8'));
  assert.equal(checks.ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.root, 'storage', path.dirname(output.output.videoRelativePath), 'render-manifest.json'), 'utf8'));
  for (const file of [manifest.tools.runtime.packagingDir, manifest.tools.runtime.node, manifest.tools.runtime.chrome, ...Object.values(manifest.tools.paths)]) {
    const relative = path.relative(appRoot, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Tool must belong to tested application: ${file}`);
  }
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='p2-unrelated-image'").get().status, 'pending');
  assert.equal(db.prepare("SELECT status FROM video_jobs WHERE id='p2-unrelated-video'").get().status, 'pending');
  assert.equal(imageCount, 2); assert.equal(videoCount, 1);
  for (const [name, hash] of oldHashes) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(fixture.delivery, '旧版', name))).digest('hex'), hash);
  assert.ok(fs.existsSync(path.join(fixture.delivery, output.output.videoFilename)));
  await page.getByRole('button', { name: '取消导出任务', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.showInactive(); });
  await page.screenshot({ path: path.join(evidence, 'fifth-step.png'), fullPage: true });
  const result = { ok: true, realQueues: true, paidCalls: 0, imageCount, videoCount, requests, untouchedPendingJobs: true, lateResultProtected: true, staleDraftPreserved: true, agentWriteDenied: true, legacyWritesDenied: true, otherShotsFrozen: true, oldDeliveryHashes: oldHashes, technicalChecks: checks.checks.length, fixture, appRoot, videoJobId: video.id, preview: output.output };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PASS real Electron P2 image → video → candidate → local replacement → packaged delivery');
} catch (error) {
  const page = app.windows()[0];
  if (page) { console.log((await page.locator('body').innerText().catch(() => '')).slice(-5000)); await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 3000 }).catch(() => {}); }
  fs.writeFileSync(path.join(evidence, 'requests.json'), JSON.stringify(requests));
  throw error;
} finally {
  heldImage?.();
  if (ownedState) await fetch(`${ownedState.origin}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
  await waitFor(() => processHandle.exitCode !== null || processHandle.signalCode !== null, 25000).catch(() => processHandle.kill('SIGKILL'));
  db.close(); await new Promise(resolve => server.close(resolve));
}
assert.equal(processHandle.exitCode, 0);
assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')));
console.log('PASS private desktop clean exit');
