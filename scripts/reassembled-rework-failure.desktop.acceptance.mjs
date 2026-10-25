// Actual Electron/CLI/API/queues, loopback failures only; requires completed real handoff fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const fixture = read(process.env.FILM_REAL_FIXTURE);
assert.ok(fixture.root.includes('2026-10-19-real-handoff') && fixture.historicalReuse && fixture.paidCalls === 0);
const handoff = read(path.join(fixture.root, 'handoff-result.json'));
const evidence = fs.mkdtempSync(path.join(fixture.root, 'failure-queue-'));
const db = new Database(path.join(fixture.dataRoot, 'data/workbench.db'));
db.prepare('UPDATE providers SET enabled=0').run();
db.prepare('UPDATE video_providers SET enabled=0').run();
let images = 0, videos = 0;
const server = http.createServer((req, res) => {
  req.resume();
  if (req.method === 'POST' && req.url === '/v1/images/edits') images++;
  else if (req.method === 'POST' && req.url === '/v1/videos') videos++;
  else { res.writeHead(404); res.end(); return; }
  res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'local uncertain submit fixture' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fake = `http://127.0.0.1:${server.address().port}`;
const providerId = `failure-${randomUUID()}`;
db.prepare("INSERT INTO providers(id,name,type,baseUrl,apiKey,model,enabled) VALUES(?, '本地失败验收', 'openai-compatible', ?, 'fixture-only', 'synthetic-image', 1)").run(providerId, fake);
db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,baseUrl,apiKey,defaultModel,enabled) VALUES(?, '本地失败验收', 'openai-video','','','',?,'fixture-only','synthetic-video',1)").run(providerId, fake);
const appRoot = path.resolve(process.env.FILM_DESKTOP_APP_ROOT || '.');
const node = process.env.FILM_DESKTOP_APP_ROOT ? path.join(appRoot, 'node-runtime/node.exe') : process.execPath;
const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: fixture.dataRoot, CREATIVE_STUDIO_NODE: node, CREATIVE_STUDIO_PUBLIC_BASE_URL: fake, CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0', CREATIVE_STUDIO_CANVAS_ENABLE: '0' };
for (const key of Object.keys(env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) env[key] = '';
for (const key of ['CREATIVE_STUDIO_COS_SECRET_ID','CREATIVE_STUDIO_COS_SECRET_KEY','CREATIVE_STUDIO_COS_DOMAIN']) env[key] = '';
for (const key of ['CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE']) delete env[key];
const exec = promisify(execFile);
const cli = async (...args) => JSON.parse((await exec(node, [path.join(appRoot, 'scripts/reassembled-workbench.mjs'), ...args], { env, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout);
const wait = async fn => { const end = Date.now() + 60000; while (Date.now() < end) { const x = await fn(); if (x) return x; await new Promise(r => setTimeout(r, 300)); } throw new Error('Timeout'); };
const app = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(evidence, 'electron')}`], cwd: appRoot, env, timeout: 60000,
  ...(process.env.FILM_DESKTOP_APP_ROOT ? { executablePath: path.join(appRoot, 'node_modules/electron/dist/electron.exe') } : {}) });
const handle = app.process(); let state, result;
try {
  const page = await app.firstWindow(); await page.waitForURL(/127\.0\.0\.1/, { timeout: 60000 });
  state = read(path.join(fixture.dataRoot, 'storage/run/electron-service.json'));
  const before = await cli('current', fixture.dataRoot, handoff.groupId);
  const clipId = 'v01-Q2-D01';
  const otherShots = () => db.prepare('SELECT * FROM shots WHERE shotSetId=? ORDER BY id').all(handoff.shotSetId);
  const originalShots = otherShots();
  const receipts = [];
  for (const kind of ['image', 'video']) {
    const view = await cli('shot', fixture.dataRoot, handoff.groupId, clipId);
    const command = { type: `generate_${kind}`, requestId: randomUUID(), expectedRevision: view.revision, providerId, model: `synthetic-${kind}`, prompt: '仅本地模拟不确定提交',
      ...(kind === 'image' ? { inputImageId: view.sourceImageId, referenceImageIds: [view.currentImageId], size: '1024x1024', quality: 'standard' } : { imageId: view.currentImageId, durationSec: 5 }) };
    const file = path.join(evidence, `${kind}-command.json`); fs.writeFileSync(file, JSON.stringify(command));
    const receipt = await cli('rework', fixture.dataRoot, handoff.groupId, clipId, file);
    const table = kind === 'image' ? 'jobs' : 'video_jobs';
    const job = await wait(() => { const j = db.prepare(`SELECT status,attempt,errorMessage FROM ${table} WHERE id=?`).get(receipt.jobId); return j?.status === 'failed' && j; });
    assert.equal(job.attempt, 1); assert.match(job.errorMessage, /停止自动重发/);
    assert.deepEqual(await cli('rework', fixture.dataRoot, handoff.groupId, clipId, file), receipt);
    receipts.push({ kind, receipt, job });
  }
  assert.equal(images, 1); assert.equal(videos, 1);
  const after = await cli('current', fixture.dataRoot, handoff.groupId);
  for (const key of ['revision','clips','content','originalContent','history','proposals','candidates','deliveryVersion','deliveredRevision']) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(otherShots(), originalShots);
  // UI navigation uses the editor's actual link, avoiding assumptions about its deep-link parameter.
  await page.goto(`${state.origin}/projects/${handoff.production.projectId}?tab=final-edit&filmGroup=${handoff.groupId}&filmShotSet=${handoff.shotSetId}`);
  await page.getByTestId('film-editor').waitFor({ timeout: 60000 });
  await page.getByLabel('选择镜头', { exact: true }).selectOption(clipId);
  await page.getByRole('link', { name: '返工这个镜头' }).click();
  await page.getByTestId('film-rework').waitFor();
  await page.getByText(/停止自动重发/).first().waitFor();
  await page.getByText(/停止自动重发/).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'failure-ui.png') });
  result = { ok: true, paidCalls: 0, appRoot, evidence, imageSubmits: images, videoSubmits: videos, receipts, replayDidNotResubmit: true, allShotsAndFilmContentPreserved: true };
} finally {
  if (state) { const health = await fetch(state.origin + '/api/desktop/health').then(r => r.json()).catch(() => null); if (health?.instanceId === state.instanceId) await fetch(state.origin + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {}); }
  await wait(() => handle.exitCode !== null || handle.signalCode !== null).catch(() => handle.kill('SIGKILL'));
  db.prepare('UPDATE providers SET enabled=0 WHERE id=?').run(providerId); db.prepare('UPDATE video_providers SET enabled=0 WHERE id=?').run(providerId); db.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
assert.equal(handle.exitCode, 0); assert.ok(!fs.existsSync(path.join(fixture.dataRoot, 'storage/run/electron-service.json')));
fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS actual rework failure queues:', evidence);
